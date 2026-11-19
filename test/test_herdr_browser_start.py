"""herdr-browser after a browser that can't start (SHEP-85). agent-browser starts Chrome again for any command, `close`
included, so one Chrome that couldn't start crashed again on every later command (on a Mac, each crash a "Google
Chrome quit unexpectedly" dialog). Now the first failure is kept with why, later commands fail at once with it until
its cause changes or `close` asks for a new try, and `close` never starts a browser. A caller whose sandbox blocks the
window server Chrome needs (a Codex agent in its sandbox on a Mac) starts nothing and says why. Throwaway homes;
agent-browser, its daemon and the window-server probe are stand-ins."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HB = os.path.join(ROOT, "bin", "herdr-browser")

# agent-browser: logs each call, starts its "daemon" for the session when none runs (as the real one does), and
# fails to start Chrome while the mode file says so
FAKE_AGENT_BROWSER = """#!/bin/sh
case "$1" in
  --version) echo "agent-browser 0.41.1"; exit 0 ;;
  doctor) echo '{"checks":[{"id":"chrome.installed","status":"pass"}]}'; exit 0 ;;
esac
s=; prev=
for a; do [ "$prev" = --session ] && s=$a; prev=$a; done
echo "$* | outside=${HERDR_BROWSER_OUTSIDE-} scope=${HC_SCOPE-} args=${AGENT_BROWSER_ARGS-} proxy=${HTTPS_PROXY-}" >> "@TMP@/ab.log"
d=$AGENT_BROWSER_SOCKET_DIR
if [ -n "$s" ] && ! kill -0 "$(cat "$d/$s.pid" 2>/dev/null)" 2>/dev/null; then
  mkdir -p "$d"
  nohup /bin/sh "@TMP@/$(cat "@TMP@/daemon")" >/dev/null 2>&1 &
  echo $! > "$d/$s.pid"
fi
if [ "$(cat "@TMP@/mode")" = fail ]; then
  echo "✗ Chrome exited early (exit code: unknown) without writing DevToolsActivePort" >&2
  exit 1
fi
echo "ok $*"
"""
# its daemon without a browser, and with one (Chrome runs as the daemon's child)
DAEMON_IDLE = 'exec python3 -c "import time; time.sleep(300)" agent-browser-daemon\n'
DAEMON_UP = "sleep 300 &\nwait\n"
# the window-server probe: 1 for this caller while FAKE_INSIDE is set (it isn't, outside), and for listed pids
FAKE_PROBE = """#!/bin/sh
grep -qx "$1" "@TMP@/blocked" 2>/dev/null && { echo 1; exit 0; }
[ -n "${FAKE_INSIDE-}" ] && echo 1 || echo 0
"""


class BrowserStart(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="shepherdr-start-")
        self.home = os.path.join(self.tmp, "home")
        self.bin = os.path.join(self.tmp, "bin")
        self.sock = os.path.join(self.tmp, "sock")
        self.tmpdir = os.path.join(self.tmp, "t")
        for d in (self.home, self.bin, self.tmpdir):
            os.makedirs(d)
        self.ab = self.script(os.path.join(self.tmp, "agent-browser"), FAKE_AGENT_BROWSER)
        self.probe = self.script(os.path.join(self.tmp, "probe"), FAKE_PROBE)
        self.script(os.path.join(self.tmp, "agent-browser-daemon"), DAEMON_IDLE)
        self.script(os.path.join(self.tmp, "agent-browser-daemon-up"), DAEMON_UP)
        self.daemon("agent-browser-daemon")
        self.mode("ok")
        self.broken = os.path.join(self.home, ".herdr", "browser", "a-1.broken")

    def tearDown(self):
        for f in os.listdir(self.sock) if os.path.isdir(self.sock) else []:
            if f.endswith(".pid"):
                with open(os.path.join(self.sock, f)) as pf:
                    self.kill(pf.read().strip())
        shutil.rmtree(self.tmp, ignore_errors=True)

    def kill(self, pid):
        try:
            os.kill(int(pid), signal.SIGKILL)
        except (OSError, ValueError):
            pass
        subprocess.run(["pkill", "-KILL", "-P", str(pid)], capture_output=True)

    def script(self, path, text):
        with open(path, "w") as f:
            f.write(text.replace("@TMP@", self.tmp))
        os.chmod(path, 0o755)
        return path

    def mode(self, m):
        with open(os.path.join(self.tmp, "mode"), "w") as f:
            f.write(m)

    def daemon(self, name):
        with open(os.path.join(self.tmp, "daemon"), "w") as f:
            f.write(name)

    def calls(self):
        try:
            with open(os.path.join(self.tmp, "ab.log")) as f:
                return [line for line in f.read().splitlines() if " --session " in line or line.startswith("--session")]
        except OSError:
            return []

    def pid(self):
        try:
            with open(os.path.join(self.sock, "herdr-a-1.pid")) as f:
                return int(f.read().strip())
        except (OSError, ValueError):
            return None

    def alive(self, pid):
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        # a stopped child stays a zombie until reaped: only a running one counts
        st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return bool(st) and not st.startswith("Z")

    def run_hb(self, *args, extra=None):
        env = {"HOME": self.home, "PATH": f"{self.bin}:/usr/bin:/bin", "HERDR_BROWSER_BIN": self.ab,
               "AGENT_BROWSER_SOCKET_DIR": self.sock, "HERDR_BROWSER_GUI_PROBE": self.probe, "TMPDIR": self.tmpdir,
               # no AppArmor restriction (this machine's real sysctl must not decide the tests)
               "HERDR_BROWSER_USERNS_SYSCTL": os.path.join(self.tmp, "no-such-sysctl"), **(extra or {})}
        return subprocess.run(["sh", HB, *args], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL,
                              timeout=60, cwd=self.tmp)

    def fail_once(self):
        self.mode("fail")
        p = self.run_hb("--task", "a#1", "open", "x")
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("herdr-browser: This task's browser couldn't start: Chrome exited early (exit code: unknown) "
                      "without writing DevToolsActivePort.", p.stderr)
        self.assertEqual(len(self.calls()), 1)
        return p

    def test_a_failed_start_is_not_tried_again(self):
        self.fail_once()
        self.assertTrue(os.path.exists(self.broken))
        pid = self.pid()
        self.assertTrue(pid is None or not self.alive(pid), "the daemon that couldn't start Chrome is ended")
        # the agent's next commands, and Herdr's own (the Browser view's), fail at once without agent-browser
        for args in (["snapshot", "-i"], ["--own", "session", "list"], ["--own", "stream", "status", "--json"]):
            with self.subTest(args=args):
                p = self.run_hb("--task", "a#1", *args)
                self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
                self.assertIn("herdr-browser: This task's browser couldn't start: Chrome exited early", p.stderr)
                self.assertIn("won't try again", p.stderr)
        self.assertEqual(len(self.calls()), 1, "no command after the failure reached agent-browser")

    def test_a_new_cause_tries_again(self):
        self.fail_once()
        self.mode("ok")
        other = os.path.join(self.tmp, "other-chrome")
        self.script(other, "#!/bin/sh\n")
        p = self.run_hb("--task", "a#1", "open", "x", extra={"AGENT_BROWSER_EXECUTABLE_PATH": other})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("ok --session herdr-a-1", p.stdout)
        self.assertFalse(os.path.exists(self.broken))

    def test_close_asks_for_a_new_try_but_the_tick_does_not(self):
        self.fail_once()
        p = self.run_hb("--own", "--task", "a#1", "close")  # herdr-task's tick
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(os.path.exists(self.broken), "Herdr's own close keeps the failure")
        p = self.run_hb("--task", "a#1", "close")  # the agent or the person
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse(os.path.exists(self.broken))
        self.mode("ok")
        p = self.run_hb("--task", "a#1", "open", "x")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(len(self.calls()), 2)

    def test_close_without_a_daemon_starts_nothing(self):
        p = self.run_hb("--task", "a#1", "close")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("Browser closed", p.stdout)
        self.assertEqual(self.calls(), [], "agent-browser's close would start Chrome first")
        self.assertIsNone(self.pid())

    def test_close_with_a_daemon_but_no_browser_ends_it_without_agent_browser(self):
        self.run_hb("--task", "a#1", "get", "url")
        pid = self.pid()
        self.assertTrue(pid and self.alive(pid))
        p = self.run_hb("--own", "--task", "a#1", "close")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(len(self.calls()), 1, "close didn't go to agent-browser")
        self.assertFalse(self.alive(pid), "its daemon was ended")

    def test_close_with_a_browser_up_goes_to_agent_browser(self):
        self.daemon("agent-browser-daemon-up")
        self.run_hb("--task", "a#1", "get", "url")
        time.sleep(0.3)  # its Chrome stand-in starts
        p = self.run_hb("--task", "a#1", "close")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("ok --session herdr-a-1 --profile", p.stdout)
        self.assertTrue(self.calls()[-1].endswith("close | outside= scope= args=--force-prefers-reduced-motion proxy="),
                        self.calls())

    def test_in_a_sandbox_nothing_starts(self):
        p = self.run_hb("--task", "a#1", "open", "x", extra={"FAKE_INSIDE": "1"})
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        self.assertIn("this agent runs in a sandbox that blocks the window server Chrome needs", p.stderr)
        self.assertIn("Full access", p.stderr)
        self.assertEqual(self.calls(), [], "Chrome would abort there")
        self.assertFalse(os.path.exists(self.broken), "not a failure of the browser: another caller may start it")

    def test_a_daemon_started_inside_a_sandbox_is_ended_first(self):
        self.run_hb("--task", "a#1", "get", "url")
        old = self.pid()
        with open(os.path.join(self.tmp, "blocked"), "w") as f:
            f.write(f"{old}\n")
        p = self.run_hb("--task", "a#1", "get", "url")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertFalse(self.alive(old), "it could never start Chrome")
        self.assertNotEqual(self.pid(), old)

    def test_check_starts_chrome_once_and_cleans_up(self):
        p = self.run_hb("--check")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("herdr-browser: the task browser starts here", p.stdout)
        self.mode("fail")
        p = self.run_hb("--check")
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("herdr-browser: Chrome can't start here: Chrome exited early", p.stderr)
        self.assertIn("Fix it:", p.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        self.assertTrue(all("--session herdr-check --profile " in c for c in calls), calls)
        self.assertFalse(os.path.exists(self.sock), "the check's own session, not the task's")
        self.assertEqual(os.listdir(self.tmpdir), [], "its scratch profile is removed")

    def test_check_from_inside_a_sandbox_says_so(self):
        p = self.run_hb("--check", extra={"FAKE_INSIDE": "1"})
        self.assertEqual(p.returncode, 1)
        self.assertIn("sandbox blocks the window server", p.stderr)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
