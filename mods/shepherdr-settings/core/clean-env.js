// Agents never inherit a parent Claude Code session (SHEP-86). herdr-core's holder keeps the environment of whatever
// started it, and every terminal it runs gets that: a holder started from inside Claude Code hands each agent
// CLAUDECODE, CLAUDE_PID and CLAUDE_CODE_CHILD_SESSION, SESSION_ID, MESSAGING_*… Claude Code then turns transcript
// saving off ("inherited CLAUDE_CODE_CHILD_SESSION marker", the web Chat can't find the conversation) and skips the
// folder-trust prompt. hc can only add variables, never remove them, so each launch starts with this shell line:
// it unsets CLAUDECODE, CLAUDE_PID and CLAUDE_CODE_*, keeping the person's own Claude Code config
// (CLAUDE_CODE_USE_BEDROCK, _SKIP_*, _DISABLE_*, _OAUTH_TOKEN…, and CLAUDE_CONFIG_DIR, which never matches).
// POSIX sh (sed -E and grep -E work on GNU and macOS). The same line is in herdr-task (launch.py CLEAN_ENV) and
// mods/coordinator/restart.sh; test/test_repo.py keeps them equal.
export const CLEAN_ENV = `for v in $(env | sed -nE 's/^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_[A-Za-z0-9_]+)=.*/\\1/p' | grep -vE '^CLAUDE_CODE_(USE|SKIP|DISABLE|ENABLE|MAX|OAUTH|CLIENT|API)_'); do unset "$v"; done;`;

// Where agent CLIs install, after the holder's own PATH (which keeps its order): a holder started over ssh, as on a
// linked Mac, has only /usr/bin:/bin:/usr/sbin:/sbin, and claude's native installer, hc and herdr-task live in
// ~/.local/bin, Homebrew's in /opt/homebrew/bin or /usr/local/bin (GitHub #839: "exec: claude: not found").
export const AGENT_PATH = `PATH="\${PATH:+$PATH:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"; export PATH;`;

// The login shell loads proxy and certificate settings even when launchd started the holder.
// It execs sh so the cleanup and agent command keep POSIX semantics on every machine.
// macOS sh invents an unexported SHELL; only use the holder's exported value.
export const LOGIN_SHELL = `if [ -n "\${SHELL:-}" ] && [ -f "$SHELL" ] && [ -x "$SHELL" ] && env | grep -q '^SHELL='; then exec "$SHELL" -lc 'exec "$@"' herdr-login sh -c`;

const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
export const loginCommand = (cmd) => `${LOGIN_SHELL} ${quote(cmd)} "$0" "$@"; fi; ${cmd}`;

/** Probe a command in the same login environment used to start agents. */
export const commandCheck = (command) => loginCommand(`${AGENT_PATH} command -v ${quote(command)} >/dev/null 2>&1`);

/** A template's command loads login settings, clears session markers, and execs the agent. */
export const cleanCommand = (cmd) => loginCommand(`${CLEAN_ENV} ${AGENT_PATH} exec ${String(cmd).trim().replace(/^exec\s+/, "")}`);
