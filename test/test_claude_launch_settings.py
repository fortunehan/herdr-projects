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

    def test_file_inline_equals_and_multiple_settings_are_folded_once(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory, "settings.json")
            p.write_text('{// comment\n"permissions":{"allow":["A"],"deny":["B"],},}')
            result, argv = compose(BASE, ["--settings", str(p), '--settings={"permissions":{"allow":["C"]}}', "hi"])
        self.assertEqual(result["permissions"], {"allow": ["A", "C"], "deny": ["B"]})
        self.assertEqual(argv, ["hi"])

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

    @unittest.skipUnless(shutil.which("zsh"), "Cdnd launcher requires zsh")
    def test_cdnd_launcher_pins_route_with_bare_file_and_equals_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper = root / "shepherdr-claude-settings"
            shutil.copyfile(SCRIPT, helper)
            helper.chmod(0o700)
            (root / ".zshenv").write_text("export ANTHROPIC_BASE_URL=https://cdnd.example\n"
                                          "export ANTHROPIC_AUTH_TOKEN=fixture-credential\n")
            capture = root / "capture.py"
            capture.write_text('''import json,sys
a=sys.argv[1:];assert a.count('--settings')==1
d=json.load(open(a[a.index('--settings')+1]))
assert d['env']['ANTHROPIC_BASE_URL']=='https://cdnd.example'
assert d['env']['ANTHROPIC_API_KEY']==''
assert 'fixture-credential' not in ' '.join(a)
print('cdnd')
''')
            child = root / "claude"
            child.write_text("#!/bin/sh\nexec " + sys.executable + " " + str(capture) + ' "$@"\n')
            child.chmod(0o700)
            file = root / "caller.json"
            file.write_text('{"fastMode":false}')
            env = dict(os.environ, HOME=str(root), SHEPHERDR_CLAUDE_LAUNCHERS=str(root),
                       CLAUDE_CDND_CLAUDE=str(child), ANTHROPIC_BASE_URL="https://magpie.example")
            wrapper = SCRIPT.parent / "claude-launchers/claude-cdnd"
            for argv in ([], ["--settings", str(file)], ['--settings={"fastMode":false}']):
                with self.subTest(argv=argv):
                    result = subprocess.run([str(wrapper), *argv], env=env, capture_output=True, text=True)
                    self.assertEqual((result.returncode, result.stdout.strip()), (0, "cdnd"), result.stderr)

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


if __name__ == "__main__":
    unittest.main()
