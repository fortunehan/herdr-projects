"""Review launches reload configured networking at the hc process boundary."""
import home_guard  # noqa: F401
import http.server
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mods/tasks/bin"))
from herdr_task import launch, settings


class ReviewerEnvironment(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="review-launch-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.requests = []
        requests = self.requests

        class Proxy(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"local proxy only")

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        proxy = f"http://127.0.0.1:{server.server_port}"
        self.configured = dict.fromkeys(("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"), proxy)
        self.configured.update(NO_PROXY="localhost,internal.test", no_proxy="localhost,internal.test",
                               SSL_CERT_FILE=str(self.root / "ca with spaces.crt"),
                               SSL_CERT_DIR=str(self.root / "certs"),
                               REQUESTS_CA_BUNDLE=str(self.root / "requests.crt"),
                               NODE_EXTRA_CA_CERTS=str(self.root / "node.crt"))
        profile = "\n".join(f"export {k}={shlex.quote(v)}" for k, v in self.configured.items())
        profile += '\nexport PATH="$HOME/bin:/usr/bin:/bin" CLAUDE_CODE_SESSION_ID=profile-marker\n'
        (self.root / ".zshenv").write_text(profile)
        (self.root / ".profile").write_text(profile)
        self.shell = self.root / "login shell"
        self.shell.write_text('#!/bin/sh\n[ "$1" = -lc ] || exit 99\n. "$HOME/.profile"\nshift\nexec /bin/sh -c "$@"\n')
        self.shell.chmod(0o755)
        tools = self.root / "bin"
        tools.mkdir()
        hc = tools / "hc"
        hc.write_text(f"#!{sys.executable}\nimport os, subprocess, sys\n"
                      "a = sys.argv[sys.argv.index('--') + 1:]\n"
                      "r = subprocess.run(a, check=True)\nprint('{\"address\":\"t-test\"}')\n")
        hc.chmod(0o755)
        fake = (f"#!{sys.executable}\nimport json, os, sys, urllib.request\n"
                f"keys = {list(self.configured)!r}\n"
                "seen = {k: os.environ.get(k) for k in keys}\n"
                f"assert seen == {self.configured!r}, 'configured networking missing or stale'\n"
                "assert 'CLAUDE_CODE_SESSION_ID' not in os.environ\n"
                "assert urllib.request.proxy_bypass('internal.test')\n"
                "with urllib.request.urlopen('http://review.invalid/probe', timeout=5) as r:\n"
                "    assert r.read() == b'local proxy only'\n"
                "with open(os.environ['CAPTURE'], 'w') as f:\n"
                "    json.dump({'env': seen, 'argv': sys.argv[1:]}, f)\n")
        for name in ("codex", "claude", "claude-magpie", "claude-cdnd"):
            cli = tools / name
            cli.write_text(fake)
            cli.chmod(0o755)
        self.prompt = "Review 'quoted' $literal `text` ; & \n two lines"
        self.capture = self.root / "capture.json"

    def parent(self, shell, stale):
        env = {"HOME": str(self.root), "SHELL": str(shell), "PATH": f"{self.root}/bin:/usr/bin:/bin",
               "CAPTURE": str(self.capture), "CLAUDE_CODE_SESSION_ID": "holder-marker"}
        if stale:
            env.update(dict.fromkeys(self.configured, "stale-holder-value"))
        return env

    def check_capture(self, argv):
        seen = json.loads(self.capture.read_text())
        self.assertEqual(seen["env"], self.configured)
        self.assertEqual(seen["argv"], argv)
        self.assertEqual(self.requests[-1], "http://review.invalid/probe")

    def test_generated_worker_review_command_at_hc_boundary(self):
        shells = [self.shell]
        if shutil.which("zsh"):
            shells.append(shutil.which("zsh"))
        for shell in shells:
            for stale in (False, True):
                for who, launcher in (("codex", None), ("claude", None), ("claude", "magpie"), ("claude", "cdnd")):
                    with self.subTest(shell=str(shell), stale=stale, who=who, launcher=launcher):
                        command = settings.reviewer_command(who, "vendor/model", "high", launcher=launcher)
                        hc = "hc run --bg --name demo-1-review --label herdr.role=reviewer -- "
                        result = subprocess.run(["/bin/sh", "-c", hc + command + " " + shlex.quote(self.prompt)],
                                                env=self.parent(shell, stale), capture_output=True, text=True, timeout=15)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        seen = json.loads(self.capture.read_text())
                        self.assertEqual(seen["env"], self.configured)
                        self.assertEqual(seen["argv"][-1], self.prompt)
                        self.assertIn("vendor/model", seen["argv"])
                        self.assertEqual(self.requests[-1], "http://review.invalid/probe")

    def test_generated_cli_arguments_stay_literal(self):
        model = "gpt 'quoted' $literal `text`; echo injected"
        command = settings.reviewer_command("codex", model, "high")
        result = subprocess.run(["/bin/sh", "-c", "hc run --bg --name demo-1-review -- " + command + " " + shlex.quote(self.prompt)],
                                env=self.parent(self.shell, True), capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.check_capture(["--no-daemon", "--sandbox", "read-only", "--ask-for-approval", "never", "--disable", "hooks",
                            "-m", model, "-c", 'model_reasoning_effort="high"', self.prompt])

    def test_task_launch_reviewer_at_hc_boundary(self):
        from types import SimpleNamespace
        s = SimpleNamespace(key=lambda t: "demo#1", dirty=False)
        argv = ["codex", "--no-daemon", "--sandbox", "read-only", "--ask-for-approval", "never"]
        for stale in (False, True):
            with self.subTest(stale=stale):
                env = self.parent(self.shell, stale)
                run = lambda a: subprocess.run(a, env=env, capture_output=True, text=True, timeout=15)
                with mock.patch.object(launch, "run", run), mock.patch.object(launch, "ensure_launcher"), \
                        mock.patch.object(launch, "folder_for", return_value=str(self.root)), \
                        mock.patch.object(launch, "coordinator_tab", return_value=None), \
                        mock.patch.object(launch, "agent_name", return_value="demo-1-review"), \
                        mock.patch.object(launch, "in_shell", side_effect=lambda a: a), \
                        mock.patch.object(launch, "low_priority", side_effect=lambda a, n: a):
                    launch.launch(s, {"id": 1}, argv, "sp1", message=self.prompt, role="reviewer")
                self.check_capture(argv[1:] + [self.prompt])

    def test_permission_matcher_accepts_only_the_exact_generated_wrapper(self):
        command = settings.reviewer_command("codex", "gpt-test", "high")
        prefix = "hc run --bg --name demo-1-review --label herdr.role=reviewer -- "
        wrapped = shlex.split(command)
        prompt = shlex.quote(self.prompt)
        self.assertTrue(launch.own_command("/x/herdr-task", prefix + command + " " + prompt, True))
        for altered in ([*wrapped[:2], wrapped[2] + "; touch /tmp/no", *wrapped[3:]],
                        [*wrapped[:3], "other-wrapper", *wrapped[4:]],
                        [*wrapped, "--dangerously-bypass-approvals-and-sandbox"],
                        [*wrapped, "-c", 'shell_environment_policy.set={HTTP_PROXY="other"}']):
            self.assertFalse(launch.own_command("/x/herdr-task", prefix + shlex.join(altered) + " " + prompt, True))
