"""Launcher settings composition with private files and a fake Claude process."""
import home_guard  # noqa: F401
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "bin/shepherdr-claude-settings"
MODULE = runpy.run_path(str(SCRIPT))
compose, merge, jsonc = (MODULE[n] for n in ("compose", "merge", "jsonc"))
SettingsError = MODULE["SettingsError"]
BASE = {"env": {"ANTHROPIC_BASE_URL": "https://gateway.example/anthropic",
                "ANTHROPIC_AUTH_TOKEN": "fixture-credential"},
        "model": "provider/model", "modelPicker": {"options": [{"model": "provider/model"}]}}


class Compose(unittest.TestCase):
    def test_magpie_route_survives_caller_ui_permissions_and_hooks(self):
        ui = {"fastMode": False, "statusLine": {"type": "command", "command": "status"},
              "permissions": {"allow": ["Bash(hello)"]},
              "hooks": {"PermissionRequest": [{"hooks": [{"type": "command", "command": "ask"}]}]}}
        result, argv = compose(BASE, ["--model", "chosen/model", "--settings", json.dumps(ui), "--resume", "S1"])
        self.assertEqual(result["env"]["ANTHROPIC_BASE_URL"], BASE["env"]["ANTHROPIC_BASE_URL"])
        self.assertEqual(result["env"]["ANTHROPIC_API_KEY"], "")
        self.assertEqual(result["env"]["CLAUDE_CODE_USE_BEDROCK"], "")
        self.assertEqual(result["hooks"], ui["hooks"])
        self.assertEqual(result["permissions"], ui["permissions"])
        self.assertEqual(argv, ["--model", "chosen/model", "--resume", "S1"])

    def test_file_inline_equals_and_last_caller_settings_match_claude(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory, "settings.json")
            p.write_text('{// comment\n"permissions":{"allow":["A"],"deny":["B"],},}')
            result, _ = compose(BASE, ["--settings", str(p)])
            self.assertEqual(result["permissions"], {"allow": ["A"], "deny": ["B"]})
            result, argv = compose(BASE, ["--settings", str(p), '--settings={"permissions":{"allow":["C"]}}', "hi"])
        self.assertEqual(result["permissions"], {"allow": ["C"]})
        self.assertEqual(argv, ["hi"])
        result, _ = compose(BASE, ["--settings", "/ignored-missing-file", "--settings", "{}"])
        self.assertNotIn("permissions", result)

    def test_conflicting_explicit_routes_auth_and_provider_switches_are_refused(self):
        for name, value in [("ANTHROPIC_BASE_URL", "https://another.example"),
                            ("ANTHROPIC_AUTH_TOKEN", "another-fixture"),
                            ("CLAUDE_CODE_USE_BEDROCK", "1")]:
            with self.subTest(name=name), self.assertRaisesRegex(SettingsError, name):
                compose(BASE, ["--settings", json.dumps({"env": {name: value}})])

    def test_proxy_certificates_and_unrelated_env_are_preserved(self):
        env = {"HTTPS_PROXY": "http://proxy.example", "NO_PROXY": "internal.example",
               "NODE_EXTRA_CA_CERTS": "/fixture/ca.pem", "OTHER": "keep"}
        result, _ = compose(BASE, ["--settings", json.dumps({"env": env})])
        for name, value in env.items():
            self.assertEqual(result["env"][name], value)
        self.assertNotIn("ANTHROPIC_API_KEY", BASE["env"])
        base = {"env": {**BASE["env"], "HTTPS_PROXY": "http://old-proxy.example"}}
        result, _ = compose(base, ["--settings", json.dumps({"env": env})])
        self.assertEqual(result["env"]["HTTPS_PROXY"], env["HTTPS_PROXY"])

    def test_invalid_missing_or_unreadable_settings_fail_closed(self):
        for args in [["--settings"], ["--settings", "/missing/settings.json"],
                     ["--settings", '{"env":[] }'], ["--settings", '{bad}']]:
            with self.subTest(args=args), self.assertRaises(SettingsError):
                compose(BASE, args)
        with self.assertRaises(SettingsError):
            compose({}, [])
        for env in [{"CLAUDE_CODE_USE_BEDROCK": "1"}, {"ANTHROPIC_API_KEY": "another-fixture"}]:
            with self.assertRaises(SettingsError):
                compose({"env": {**BASE["env"], **env}}, [])

    def test_separator_and_string_content_are_preserved(self):
        self.assertEqual(compose(BASE, ["--", "--settings", "literal"])[1], ["--", "--settings", "literal"])
        self.assertEqual(jsonc('{"x":"https://example/x//y/*z*/,}",}')["x"], "https://example/x//y/*z*/,}")
        self.assertEqual(jsonc('{"a":1,/* trailing */}'), {"a": 1})

    def test_array_and_special_settings_merges_match_claude(self):
        self.assertEqual(merge({"a": ["A"]}, {"a": ["A", "B"]}), {"a": ["A", "B"]})
        self.assertEqual(merge({"fallbackModel": ["A"]}, {"fallbackModel": ["B"]}), {"fallbackModel": ["B"]})
        self.assertEqual(merge({"modelPicker": {"options": ["A"]}}, {"modelPicker": {"options": ["B"]}}),
                         {"modelPicker": {"options": ["B"]}})


class PrivateFile(unittest.TestCase):
    def test_child_gets_one_private_file_no_credential_in_argv_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base.json"
            base.write_text(json.dumps(BASE))
            capture = root / "capture.py"
            capture.write_text('''import json,os,stat,sys
args=sys.argv[1:];p=args[args.index('--settings')+1]
d=json.load(open(p))
print(json.dumps({'count':args.count('--settings'),'mode':stat.S_IMODE(os.stat(p).st_mode),
 'dir_mode':stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode),'path':p,
 'credential_in_argv':any('fixture-credential' in a for a in args),
 'base':d['env']['ANTHROPIC_BASE_URL'],'proxy':os.environ.get('HTTPS_PROXY'),'fast':d['fastMode']}))
sys.exit(7)
''')
            child = root / "claude"
            child.write_text("#!/bin/sh\nexec " + sys.executable + " " + str(capture) + ' "$@"\n')
            child.chmod(0o700)
            env = dict(os.environ, ANTHROPIC_BASE_URL="https://cdnd.example", HTTPS_PROXY="fixture-proxy")
            result = subprocess.run([sys.executable, str(SCRIPT), "magpie", "--base", str(base), "--", str(child),
                                     "--settings", '{"fastMode":false}'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 7, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual((data["count"], data["mode"], data["dir_mode"], data["credential_in_argv"]), (1, 0o600, 0o700, False))
            self.assertEqual(data["base"], BASE["env"]["ANTHROPIC_BASE_URL"])
            self.assertEqual(data["proxy"], "fixture-proxy")
            self.assertFalse(data["fast"])
            self.assertFalse(Path(data["path"]).exists())

    def test_termination_reaches_child_and_removes_private_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base.json"
            base.write_text(json.dumps(BASE))
            marker = root / "started"
            capture = root / "wait.py"
            capture.write_text('''import pathlib,sys,time
args=sys.argv[1:]
pathlib.Path(__file__).with_name('started').write_text(args[args.index('--settings')+1])
time.sleep(30)
''')
            child = root / "claude"
            child.write_text("#!/bin/sh\nexec " + sys.executable + " " + str(capture) + ' "$@"\n')
            child.chmod(0o700)
            proc = subprocess.Popen([sys.executable, str(SCRIPT), "magpie", "--base", str(base), "--", str(child)],
                                    env=dict(os.environ), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    start_new_session=True)
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(marker.exists())
                path = Path(marker.read_text())
                self.assertTrue(path.exists())
                proc.terminate()
                self.assertEqual(proc.wait(timeout=5), 128 + signal.SIGTERM)
                self.assertFalse(path.exists())
            finally:
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()

    def test_old_duplicate_flags_hit_cdnd_and_composed_settings_hit_magpie(self):
        hits, servers = [], []

        class Receiver(BaseHTTPRequestHandler):
            def do_POST(self):
                hits.append(self.server.route)
                self.rfile.read(int(self.headers.get("content-length", "0")))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        try:
            for name in ("cdnd", "magpie"):
                server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
                server.route = name
                servers.append(server)
                threading.Thread(target=server.serve_forever, daemon=True).start()
            cdnd, magpie = ("http://127.0.0.1:" + str(s.server_port) for s in servers)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                base = root / "base.json"
                base.write_text(json.dumps({"env": {"ANTHROPIC_BASE_URL": magpie,
                                                     "ANTHROPIC_AUTH_TOKEN": "fixture-credential"}}))
                capture = root / "request.py"
                capture.write_text('''import json,os,sys,urllib.request
args=sys.argv[1:];value=None
for i,a in enumerate(args):
 if a=='--settings':value=args[i+1]
 elif a.startswith('--settings='):value=a.split('=',1)[1]
settings=json.loads(value) if value.startswith('{') else json.load(open(value))
url=(settings.get('env') or {}).get('ANTHROPIC_BASE_URL',os.environ['ANTHROPIC_BASE_URL'])
assert url.startswith('http://127.0.0.1:')
urllib.request.urlopen(urllib.request.Request(url,data=b'{}'),timeout=3).read()
''')
                child = root / "claude"
                child.write_text("#!/bin/sh\nexec " + sys.executable + " " + str(capture) + ' "$@"\n')
                child.chmod(0o700)
                env = dict(os.environ, ANTHROPIC_BASE_URL=cdnd, NO_PROXY="127.0.0.1")
                caller = ["--settings", '{"fastMode":false}']
                old = subprocess.run([str(child), "--settings", str(base), *caller], env=env, capture_output=True, text=True)
                self.assertEqual(old.returncode, 0, old.stderr)
                self.assertEqual(hits, ["cdnd"])
                fixed = subprocess.run([sys.executable, str(SCRIPT), "magpie", "--base", str(base), "--", str(child), *caller],
                                       env=env, capture_output=True, text=True)
                self.assertEqual(fixed.returncode, 0, fixed.stderr)
                self.assertEqual(hits, ["cdnd", "magpie"])
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()


LAUNCHERS = SCRIPT.parent / "claude-launchers"
CAPTURE = """import json,os,sys
a=sys.argv[1:]
v=a[a.index('--settings')+1] if '--settings' in a else None
d=(json.loads(v) if v.startswith('{') else json.load(open(v))) if v else None
print(json.dumps({'argv':a,'settings':d,'url':os.environ.get('ANTHROPIC_BASE_URL'),
 'token':os.environ.get('ANTHROPIC_AUTH_TOKEN')}))
"""
FAKE_MAGPIE = """#!/bin/sh
[ "$1" = claude ] && [ "$2" = run ] || exit 64
shift 2
d=$(mktemp -d)
printf '{"env":{"ANTHROPIC_BASE_URL":"%s","ANTHROPIC_AUTH_TOKEN":"fixture-credential"}}' "$FAKE_MAGPIE_URL" > "$d/settings.json"
claude --settings "$d/settings.json" "$@"
status=$?
rm -f "$d/settings.json"
rmdir "$d"
exit $status
"""


def script(path, text):
    path.write_text(text)
    path.chmod(0o700)


class Scratch(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.root = Path(self._dir.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        script(self.bin / "capture.py", CAPTURE)
        script(self.bin / "claude", "#!/bin/sh\nexec " + sys.executable + " " + str(self.bin / "capture.py") + ' "$@"\n')
        self.env = dict(os.environ, HOME=str(self.root), PATH=str(self.bin) + ":/usr/bin:/bin",
                        FAKE_MAGPIE_URL="https://gateway.example/anthropic")
        for name in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"):
            self.env.pop(name, None)

    def run_script(self, argv, **extra):
        return subprocess.run(argv, env={**self.env, **extra}, capture_output=True, text=True)


class Mgp(Scratch):
    def setUp(self):
        super().setUp()
        self.launchers = self.root / "launchers"
        (self.launchers / "claude-mgp-shim").mkdir(parents=True)
        for name in ("claude-mgp", "claude-mgp-shim/claude"):
            shutil.copy(LAUNCHERS / name, self.launchers / name)
        shutil.copy(SCRIPT, self.launchers / "shepherdr-claude-settings")
        for path in (self.launchers / "claude-mgp", self.launchers / "claude-mgp-shim/claude",
                     self.launchers / "shepherdr-claude-settings"):
            path.chmod(0o700)
        script(self.bin / "magpie", FAKE_MAGPIE)
        self.env["SHEPHERDR_CLAUDE_LAUNCHERS"] = str(self.launchers)
        self.mgp = str(self.launchers / "claude-mgp")

    def test_herdr_settings_after_magpie_keep_route_and_ui(self):
        ui = {"fastMode": False, "statusLine": {"type": "command", "command": "status"},
              "hooks": {"PermissionRequest": [{"hooks": [{"type": "command", "command": "ask"}]}]}}
        result = self.run_script([self.mgp, "--model", "m", "--settings", json.dumps(ui), "--resume", "S1"])
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["argv"][0], "--settings")
        self.assertEqual(data["argv"].count("--settings"), 1)
        self.assertEqual(data["argv"][2:], ["--model", "m", "--resume", "S1"])
        env = data["settings"]["env"]
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "https://gateway.example/anthropic")
        self.assertEqual(env["ANTHROPIC_AUTH_TOKEN"], "fixture-credential")
        for key, value in ui.items():
            self.assertEqual(data["settings"][key], value)
        self.assertNotIn("fixture-credential", " ".join(data["argv"]))

    def test_shim_receives_magpie_file_first_then_caller_args(self):
        script(self.launchers / "shepherdr-claude-settings", '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        result = self.run_script([self.mgp, "--settings", '{"fastMode":false}', "hi"])
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[:2], ["magpie", "--base"])
        self.assertTrue(lines[2].endswith("settings.json"))
        self.assertEqual(lines[3:5], ["--", str(self.bin / "claude")])
        self.assertEqual(lines[5:], ["--settings", '{"fastMode":false}', "hi"])

    def test_caller_route_conflict_still_errors_without_secrets(self):
        result = self.run_script([self.mgp, "--settings",
                                  json.dumps({"env": {"ANTHROPIC_BASE_URL": "https://other.example"}})])
        self.assertEqual(result.returncode, 2)
        self.assertIn("ANTHROPIC_BASE_URL", result.stderr)
        self.assertNotIn("fixture-credential", result.stderr + result.stdout)

    def test_exit_status_passes_through(self):
        script(self.bin / "claude", "#!/bin/sh\nexit 9\n")
        self.assertEqual(self.run_script([self.mgp]).returncode, 9)

    def test_requests_reach_magpie_route_not_process_env_route(self):
        hits = []

        class Receiver(BaseHTTPRequestHandler):
            def do_POST(self):
                hits.append(self.server.route)
                self.rfile.read(int(self.headers.get("content-length", "0")))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        servers = []
        try:
            for name in ("cdnd", "magpie"):
                server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
                server.route = name
                servers.append(server)
                threading.Thread(target=server.serve_forever, daemon=True).start()
            cdnd, magpie = ("http://127.0.0.1:" + str(s.server_port) for s in servers)
            script(self.bin / "request.py", "import json,sys,urllib.request\n"
                   "a=sys.argv[1:];s=json.load(open(a[a.index('--settings')+1]))\n"
                   "urllib.request.urlopen(urllib.request.Request(s['env']['ANTHROPIC_BASE_URL'],data=b'{}'),timeout=3).read()\n")
            script(self.bin / "claude", "#!/bin/sh\nexec " + sys.executable + " " + str(self.bin / "request.py") + ' "$@"\n')
            result = self.run_script([self.mgp, "--settings", '{"fastMode":false}'],
                                     FAKE_MAGPIE_URL=magpie, ANTHROPIC_BASE_URL=cdnd, NO_PROXY="127.0.0.1")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(hits, ["magpie"])
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()

    def test_fails_loudly_when_settings_is_not_first(self):
        for body in ('claude --model x --settings "$d/settings.json" "$@"', 'claude "$@"', 'claude --settings'):
            with self.subTest(body=body):
                script(self.bin / "magpie", "#!/bin/sh\nshift 2\nd=x\n" + body + "\n")
                result = self.run_script([self.mgp, "hi"])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("--settings", result.stderr)
                self.assertNotIn("fixture-credential", result.stderr)

    def test_fails_when_real_claude_or_magpie_is_missing(self):
        (self.bin / "claude").unlink()
        result = self.run_script([self.mgp])
        self.assertEqual(result.returncode, 127)
        self.assertIn("Claude", result.stderr)
        script(self.bin / "claude", "#!/bin/sh\nexit 0\n")
        (self.bin / "magpie").unlink()
        result = self.run_script([self.mgp])
        self.assertEqual(result.returncode, 127)
        self.assertIn("magpie", result.stderr)

    def test_recursion_is_refused(self):
        (self.bin / "claude").unlink()
        result = self.run_script([self.mgp], PATH=str(self.launchers / "claude-mgp-shim") + ":" + self.env["PATH"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("recursion", result.stderr)
        shim = str(self.launchers / "claude-mgp-shim/claude")
        result = self.run_script([shim, "--settings", "x"], SHEPHERDR_CLAUDE_REAL=shim,
                                 SHEPHERDR_CLAUDE_SETTINGS_HELPER=str(self.launchers / "shepherdr-claude-settings"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("recursion", result.stderr)

    def test_magpie_path_can_be_overridden(self):
        script(self.root / "other-magpie", "#!/bin/sh\necho other\n")
        result = self.run_script([self.mgp], SHEPHERDR_MAGPIE=str(self.root / "other-magpie"))
        self.assertEqual(result.stdout.strip(), "other")

    def test_launcher_scripts_parse_in_bash(self):
        for name in ("claude-mgp", "claude-mgp-shim/claude"):
            self.assertEqual(subprocess.run(["bash", "-n", str(LAUNCHERS / name)]).returncode, 0)


@unittest.skipUnless(shutil.which("zsh"), "Cdnd launcher requires zsh")
class Cdnd(Scratch):
    def setUp(self):
        super().setUp()
        self.file = self.root / "cdnd.env"
        self.file.write_text("export ANTHROPIC_BASE_URL=https://cdnd.example\n"
                             "ANTHROPIC_AUTH_TOKEN='fixture-credential'\n")
        self.file.chmod(0o600)
        self.env["CLAUDE_CDND_ENV"] = str(self.file)
        self.env["CLAUDE_CDND_CLAUDE"] = str(self.bin / "claude")
        self.cdnd = str(LAUNCHERS / "claude-cdnd")

    def test_process_env_route_is_kept_and_settings_pass_through_untouched(self):
        caller = '{"fastMode":false}'
        result = self.run_script([self.cdnd, "--settings", caller, "hi"],
                                 ANTHROPIC_BASE_URL="https://wrong.example")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual((data["url"], data["token"]), ("https://cdnd.example", "fixture-credential"))
        self.assertEqual(data["argv"], ["--settings", caller, "hi"])

    def test_missing_unreadable_or_incomplete_file_errors_without_secrets(self):
        for text in ("ANTHROPIC_AUTH_TOKEN=fixture-credential\n", "ANTHROPIC_BASE_URL=https://cdnd.example\n"):
            self.file.write_text(text)
            result = self.run_script([self.cdnd])
            self.assertEqual(result.returncode, 1)
            self.assertIn("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN", result.stderr)
            self.assertNotIn("fixture-credential", result.stderr)
        self.file.unlink()
        result = self.run_script([self.cdnd])
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot read", result.stderr)

    def test_script_parses_in_zsh(self):
        self.assertEqual(subprocess.run(["zsh", "-n", self.cdnd]).returncode, 0)


if __name__ == "__main__":
    unittest.main()
