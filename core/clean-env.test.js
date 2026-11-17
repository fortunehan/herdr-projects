import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AGENT_PATH, CLEAN_ENV, cleanCommand, loginCommand, commandCheck } from "./clean-env.js";

// SHEP-86: an Assistant's one-off template command runs under sh -c in the holder's environment. Fake values only.
const spawn = (argv, options) => Bun.spawnSync(["/usr/bin/env", "-i", ...Object.entries(options.env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`), ...argv]);

const parent = { PATH: process.env.PATH, CLAUDECODE: "1", CLAUDE_PID: "4242", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "fake-session",
  CLAUDE_CODE_MESSAGING_TOKEN: "fake-token", CLAUDE_CONFIG_DIR: "/tmp/fake-claude", CLAUDE_CODE_USE_BEDROCK: "1", FAKE_OTHER: "x" };

test("launcher probes find commands supplied by the login profile without starting them", () => {
  const home = mkdtempSync(`${tmpdir()}/launcher-check-`);
  try {
    mkdirSync(`${home}/tools`);
    const shell = `${home}/login-shell`;
    writeFileSync(shell, '#!/bin/sh\nPATH="$HOME/tools:$PATH"; export PATH\nshift\nexec /bin/sh -c "$@"\n', { mode: 0o755 });
    writeFileSync(`${home}/tools/claude-cdnd`, '#!/bin/sh\ntouch "$HOME/started"\n', { mode: 0o755 });
    const env = { HOME: home, PATH: "/usr/bin:/bin", SHELL: shell };
    expect(spawn(["/bin/sh", "-c", commandCheck("claude-cdnd")], { env }).exitCode).toBe(0);
    expect(spawn(["/bin/sh", "-c", commandCheck(`${home}/missing/claude-cdnd`)], { env }).exitCode).not.toBe(0);
    expect(existsSync(`${home}/started`)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("an Assistant's command runs without a parent Claude Code session's markers, keeping the person's config", () => {
  const r = spawn(["sh", "-c", cleanCommand("env")], { env: parent });
  const env = Object.fromEntries(r.stdout.toString().trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  for (const k of ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN"]) expect(env[k]).toBeUndefined();
  expect([env.CLAUDE_CONFIG_DIR, env.CLAUDE_CODE_USE_BEDROCK, env.FAKE_OTHER]).toEqual(["/tmp/fake-claude", "1", "x"]);
});

test("the agent is exec'd once, whether the template's command had exec or not", () => {
  expect(cleanCommand("claude --model opus")).toBe(loginCommand(`${CLEAN_ENV} ${AGENT_PATH} exec claude --model opus`));
  expect(cleanCommand("exec claude")).toBe(cleanCommand("claude"));
});

const settings = {
  HTTP_PROXY: "http://127.0.0.1:12345", HTTPS_PROXY: "http://127.0.0.1:12345", ALL_PROXY: "http://127.0.0.1:12345", NO_PROXY: "localhost,internal.test",
  http_proxy: "http://127.0.0.1:12345", https_proxy: "http://127.0.0.1:12345", all_proxy: "http://127.0.0.1:12345", no_proxy: "localhost,internal.test",
  SSL_CERT_FILE: "/tmp/test-ca.crt", REQUESTS_CA_BUNDLE: "/tmp/test-requests.crt", NODE_EXTRA_CA_CERTS: "/tmp/test-node.crt",
};

test("login settings reach the agent; session cleanup and PATH ordering apply after the profile", () => {
  const home = mkdtempSync(`${tmpdir()}/clean-env-login-`);
  try {
    const profile = Object.entries({ ...settings, CLAUDE_CODE_SESSION_ID: "profile-session", PATH: "/usr/bin:/bin" })
      .map(([k, v]) => `export ${k}='${v}'`).join("\n");
    writeFileSync(`${home}/.profile`, profile);
    // A deterministic login-shell stand-in avoids host-wide /etc/profile changing HOME in CI.
    const shell = `${home}/login-shell`;
    writeFileSync(shell, '#!/bin/sh\n[ "$1" = -lc ] || exit 99\n. "$HOME/.profile"\nshift\nexec /bin/sh -c "$@"\n', { mode: 0o755 });
    for (const SHELL of [shell, "/bin/zsh", ...(process.platform === "darwin" ? ["/bin/bash"] : [])]) {
      if (!existsSync(SHELL)) continue;
      writeFileSync(`${home}/.zshenv`, profile);
      writeFileSync(`${home}/.zprofile`, profile);
      writeFileSync(`${home}/.bash_profile`, profile);
      const r = spawn(["/bin/sh", "-c", cleanCommand("env")], { env: { ...parent, HOME: home, SHELL } });
      expect(r.exitCode).toBe(0);
      const env = Object.fromEntries(r.stdout.toString().trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
      for (const [k, v] of Object.entries(settings)) expect(env[k]).toBe(v);
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.PATH).toBe(`/usr/bin:/bin:${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin`);
      const args = ["a'b", "$literal", "two words", "", "semi;colon"];
      const quoted = spawn(["/bin/sh", "-c", cleanCommand('"$@"'), "review", "/usr/bin/printf", "<%s>\n", ...args], { env: { HOME: home, SHELL, PATH: "/usr/bin:/bin" } });
      expect(quoted.stdout.toString()).toBe(args.map((a) => `<${a}>\n`).join(""));
      const pid = spawn(["/bin/sh", "-c", `expected=$$; export expected; ${cleanCommand('/bin/sh -c \'test "$$" = "$expected"\'')}`], { env: { HOME: home, SHELL, PATH: "/usr/bin:/bin" } });
      expect(pid.exitCode).toBe(0);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("missing, nonexistent and non-executable login shells keep the plain-sh fallback", () => {
  const home = mkdtempSync(`${tmpdir()}/clean-env-fallback-`);
  try {
    writeFileSync(`${home}/not-executable`, "exit 99\n");
    for (const SHELL of [undefined, "", `${home}/missing`, `${home}/not-executable`, home]) {
      const r = spawn(["/bin/sh", "-c", cleanCommand("env")], { env: { ...parent, HOME: home, PATH: "/usr/bin:/bin", SHELL } });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).not.toContain("CLAUDECODE=");
      expect(r.stdout.toString()).not.toContain("CLAUDE_CODE_SESSION_ID=");
      expect(r.stdout.toString()).toContain(`PATH=/usr/bin:/bin:${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin\n`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a holder started over ssh (PATH only /usr/bin:/bin) still finds an agent in ~/.local/bin (GitHub #839)", () => {
  const home = mkdtempSync(`${tmpdir()}/clean-env-`);
  try {
    mkdirSync(`${home}/.local/bin`, { recursive: true });
    writeFileSync(`${home}/.local/bin/fake-agent`, "#!/bin/sh\necho started \"$@\"\n", { mode: 0o755 });
    const r = spawn(["/bin/sh", "-c", cleanCommand("fake-agent --model opus")], { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    expect([r.exitCode, r.stdout.toString().trim()]).toEqual([0, "started --model opus"]);
    // the holder's own PATH comes first: an agent it already finds is the one that runs
    const own = `${home}/own`;
    mkdirSync(own);
    writeFileSync(`${own}/fake-agent`, "#!/bin/sh\necho own\n", { mode: 0o755 });
    expect(spawn(["/bin/sh", "-c", cleanCommand("fake-agent")], { env: { HOME: home, PATH: `${own}:/usr/bin:/bin` } }).stdout.toString().trim()).toBe("own");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
