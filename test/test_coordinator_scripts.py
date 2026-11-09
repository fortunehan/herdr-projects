"""The coordinator mod's shell helpers on macOS: no setsid, /bin/bash 3.2 (eliasstravik/shepherdr#736)."""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASH = "/bin/bash"


def detach_command():
    src = (ROOT / "lib/coordinator.js").read_text()
    m = re.search(r"const DETACH = '([^']*)'\s*\+\s*'([^']*)';", src)
    assert m, "DETACH not found in lib/coordinator.js"
    return m.group(1) + m.group(2)


def write(path, text, mode=0o755):
    path.write_text(text)
    path.chmod(mode)


class Detach(unittest.TestCase):
    """script() in lib/coordinator.js: the menu's launcher for mods/coordinator/*.sh."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for tool in ("bash", "nohup", "sleep"):
            os.symlink(shutil.which(tool), self.bin / tool)
        self.out = self.tmp / "out"
        self.helper = self.tmp / "helper.sh"
        write(self.helper, f'sleep 1\nprintf "%s|" "$@" >"{self.out}"\n')

    def launch(self, script):
        start = time.monotonic()
        r = subprocess.run([BASH, "-c", detach_command(), str(script), "a b", "c"],
                           env={"PATH": str(self.bin), "HOME": str(self.tmp)}, capture_output=True, text=True, timeout=10)
        return r, time.monotonic() - start

    def wait_out(self):
        for _ in range(50):
            if self.out.exists() and self.out.read_text():
                return self.out.read_text()
            time.sleep(0.1)
        return None

    def test_without_setsid_the_helper_runs_detached(self):
        r, took = self.launch(self.helper)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLess(took, 0.9, "the launcher waited for the helper")
        self.assertEqual(self.wait_out(), "a b|c|")

    def test_with_setsid_it_is_used(self):
        used = self.tmp / "setsid-used"
        write(self.bin / "setsid", f'#!{BASH}\n[ "$1" = -f ] && shift\n: >"{used}"\n"$@" &\n')
        r, took = self.launch(self.helper)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLess(took, 0.9)
        self.assertEqual(self.wait_out(), "a b|c|")
        self.assertTrue(used.exists())

    def test_a_missing_helper_fails(self):
        r, _ = self.launch(self.tmp / "nope.sh")
        self.assertEqual(r.returncode, 127)


@unittest.skipUnless(shutil.which("jq"), "restart.sh needs jq")
class RestartArgv(unittest.TestCase):
    """restart.sh reads the new agent's argv without bash 4's mapfile."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.home = self.tmp / "home"
        (self.home / ".config/herdr-core/templates").mkdir(parents=True)
        self.log = self.tmp / "hc.log"
        info = {"labels": {"herdr.space": "sp1", "herdr.tab": "tab1"}, "cwd": str(self.tmp), "status": {"app": "other"}}
        write(self.bin / "hc", f"""#!{BASH}
printf '%s\\n' "$*" >>"{self.log}"
case $1 in
  get) echo '{json.dumps(info)}' ;;
  run) for a; do case $a in herdr-handoff-*) cat "{self.home}/.config/herdr-core/templates/$a.md" >>"{self.log}" ;; esac; done
       printf '%s\\n' "$@" >"{self.tmp}/run-args"
       echo '{{"address":"t9","first_message":{{"sent":true}}}}' ;;
esac
""")

    def restart(self, argv, **env):
        e = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.home), "HERDR_APP_HOME": str(self.tmp / "app"), **env}
        return subprocess.run([BASH, str(ROOT / "mods/coordinator/restart.sh"), "t1", json.dumps(argv)],
                              env=e, capture_output=True, text=True, timeout=30)

    def test_resume_keeps_each_argument_whole(self):
        r = self.restart(["claude", "--resume", "id with space"], HERDR_RESTART_RESUME="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        args = (self.tmp / "run-args").read_text().splitlines()
        self.assertEqual(args[args.index("--") + 1:], ["claude", "--resume", "id with space"])
        self.assertIn("herdr.agent=claude", args)
        self.assertIn("kill t1", self.log.read_text())

    def test_switch_to_codex_gets_its_handoff_template(self):
        r = self.restart(["codex", "-m", "gpt 5"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        log = self.log.read_text()
        self.assertIn(r"command: codex -m gpt\ 5 --no-daemon", log)
        self.assertIn("herdr.agent=codex", log)

    def test_an_empty_argv_fails(self):
        r = self.restart([], HERDR_RESTART_RESUME="1")
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("kill t1", self.log.read_text())


if __name__ == "__main__":
    unittest.main()
