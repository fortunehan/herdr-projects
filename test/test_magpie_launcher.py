"""Claude worker launchers, inheritance and recovery, without a live Herdr core."""
import home_guard  # noqa: F401
import argparse
import json
import os
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mods/tasks/bin"))
from herdr_task import commands, launch, revive, settings
from herdr_task.base import Fail


class MagpieLauncher(unittest.TestCase):
    def setUp(self):
        self.store = SimpleNamespace(loc={"folder": "/repo", "kind": "folder"}, dirty=False,
                                     key=lambda t: "repo#1", ref=lambda t: "APP-1")
        self.layers = [{}, {}, {}]
        self.layer_patch = patch.object(settings, "settings_layers", lambda *a: self.layers)
        self.layer_patch.start()
        self.addCleanup(self.layer_patch.stop)

    def argv(self, task=None):
        return settings.worker_argv(self.store, task or {}, "sp1")

    def test_cli_flags_and_set_are_available_for_add_edit_and_start(self):
        from herdr_task import cli
        for verb in ("add", "edit", "start"):
            target = "Example" if verb == "add" else "APP-1"
            with self.subTest(verb=verb), patch.object(sys, "argv", ["herdr-task", verb, target, "--launcher", "magpie", "--set", "task.model=provider/model"]), \
                    patch.object(cli, "cmd_" + verb) as command:
                self.assertEqual(cli.main(), 0)
                args = command.call_args.args[0]
                self.assertEqual((args.launcher, args.set), ("magpie", ["task.model=provider/model"]))

    def test_defaults_and_explicit_flags(self):
        self.layers[2] = {"worker": {"agent": "claude", "launcher": "magpie"}}
        argv = self.argv()
        self.assertEqual(argv[:5], ["claude-magpie", "--model", settings.MAGPIE_MODEL, "--effort", "high"])
        self.assertIn("statusLine", argv[argv.index("--settings") + 1])
        argv = self.argv({"model": "other/model", "effort": "max"})
        self.assertEqual(argv[:5], ["claude-magpie", "--model", "other/model", "--effort", "max"])

    def test_task_launcher_both_ways_and_same_launcher(self):
        for old, new, expected in [("direct", "magpie", settings.MAGPIE_MODEL), ("magpie", "direct", None)]:
            with self.subTest(old=old):
                self.layers[2] = {"worker": {"agent": "claude", "launcher": old, "model": "space/model", "effort": "max"}}
                argv = self.argv({"launcher": new})
                self.assertEqual(settings.argv_model(argv), (expected, "max"))
                self.assertEqual(settings.argv_model(self.argv({"launcher": old})), ("space/model", "max"))
                self.assertEqual(settings.argv_model(self.argv({"launcher": new, "model": "task/model"})), ("task/model", "max"))

    def test_everywhere_machine_space_layers_drop_model_and_keep_effort(self):
        self.layers = [{"worker": {"agent": "claude", "model": "opus", "effort": "max"}},
                       {"worker": {"launcher": "magpie", "model": "machine/model"}},
                       {"worker": {"launcher": "direct"}}]
        self.assertEqual(settings.argv_model(self.argv()), (None, "max"))
        self.layers[2] = {"worker": {"launcher": "magpie"}}
        self.assertEqual(settings.argv_model(self.argv()), ("machine/model", "max"))

    def test_codex_ignores_inherited_launcher_but_explicit_pair_is_refused(self):
        self.layers[2] = {"worker": {"agent": "claude", "launcher": "magpie"}}
        self.assertEqual(self.argv({"agent": "codex"})[0], "codex")
        with self.assertRaises(Fail):
            settings.set_opts({}, argparse.Namespace(agent="codex", launcher="magpie"))
        with self.assertRaises(Fail):
            settings.set_opts({}, argparse.Namespace(set=["task.agent=codex", "task.launcher=magpie"]))
        self.layers[2] = {"worker": {"agent": "codex", "launcher": "magpie"}}
        with self.assertRaises(Fail):
            self.argv()

    def test_edit_launcher_drops_own_model_unless_given_together(self):
        task = {"agent": "claude", "launcher": "direct", "model": "opus", "effort": "max"}
        settings.set_opts(task, argparse.Namespace(launcher="magpie"))
        self.assertNotIn("model", task)
        self.assertEqual(task["effort"], "max")
        settings.set_opts(task, argparse.Namespace(launcher="direct", model="sonnet"))
        self.assertEqual(task["model"], "sonnet")
        settings.set_opts(task, argparse.Namespace(set=["launcher=magpie", "model=custom/model"]))
        self.assertEqual(task["model"], "custom/model")
        task = {"model": "space/model", "effort": "max"}
        settings.set_opts(task, argparse.Namespace(launcher="magpie"), launcher="magpie")
        self.assertEqual(task["model"], "space/model")

    def test_settings_argv_wins_even_over_task_flags(self):
        raw = ["claude-magpie", "--model", "typed/model", "--effort", "low"]
        self.layers[2] = {"worker": {"argv": raw, "launcher": "magpie"}}
        self.assertEqual(self.argv({"model": "ignored/model", "effort": "max", "launcher": "direct"}), raw)
        self.assertEqual(settings.agent_key(["/some/bin/claude-magpie"]), "claude")
        self.assertEqual(launch.resume_argv(raw, "S1"), raw + ["--permission-mode", launch.claude_mode(raw), "--resume", "S1"])
        owned = launch.own_argv(raw)
        self.assertIn("PermissionRequest", owned[owned.index("--settings") + 1])

    def test_launch_stores_and_labels_claude_and_keeps_wrappers(self):
        argv = settings.argv_for({"agent": "claude", "launcher": "magpie"})
        task = {"id": 1, "agents": [], "title": "Try", "mode": "here"}
        with patch.object(launch, "folder_for", return_value="/repo"), \
                patch.object(launch, "ensure_launcher"), \
                patch.object(launch, "agent_name", return_value="app-1-try"), \
                patch.object(launch, "coordinator_tab", return_value=None), \
                patch.object(launch, "track"), patch.object(launch.local, "with_setup", side_effect=lambda t, f, a: a), \
                patch.object(launch, "low_priority", side_effect=lambda a, n: ["low", *a]), \
                patch.object(launch, "run", return_value=SimpleNamespace(stdout='{"address":"t1"}', stderr="", returncode=0)) as run:
            record = launch.launch(self.store, task, argv, "sp1")
            cmd = run.call_args.args[0]
            self.assertIn("herdr.agent=claude", cmd)
            shell = cmd[cmd.index("-c") + 1]
            self.assertIn(launch.CLEAN_ENV, shell)
            self.assertIn(launch.AGENT_PATH, shell)
            self.assertIn("low", cmd)
            self.assertIn("herdr-magpie", cmd)
            self.assertEqual((record["agent"], record["launcher"], record["argv"]), ("claude", "magpie", argv))
            launch.launch(self.store, task, argv, "sp1", custom=True)
            self.assertNotIn("herdr-magpie", run.call_args.args[0])
            self.assertTrue(task["agents"][-1]["custom_argv"])

    def test_resume_uses_original_launcher_switch_uses_current_settings(self):
        old = settings.argv_for({"agent": "claude", "launcher": "magpie", "model": "original/model", "effort": "max"})
        task = {"id": 1, "agents": [{"argv": old, "agent": "claude", "session": "S1", "at": 1}], "pick_at": 999,
                "launcher": "direct", "state": "running"}
        self.layers[2] = {"worker": {"agent": "claude", "model": "sonnet", "effort": "low"}}
        with patch.object(commands, "unarchive"), patch.object(commands, "parent_for", return_value=None), \
                patch.object(commands, "launch", return_value={}) as run, \
                patch.object(commands, "handoff", return_value="handoff"):
            commands.start_again(self.store, task, "sp1")
            self.assertEqual(run.call_args.args[2], old)
            self.assertEqual(run.call_args.kwargs["resume"], old + ["--permission-mode", "default", "--resume", "S1"])
            self.layers[2]["worker"]["argv"] = old
            commands.start_again(self.store, task, "sp1")
            self.assertFalse(run.call_args.kwargs["custom"])
            self.layers[2]["worker"].pop("argv")
            commands.start_again(self.store, task, "sp1", current=True)
            self.assertEqual(run.call_args.args[2][0], "claude")
            self.assertNotIn("resume", run.call_args.kwargs)
            self.assertEqual(run.call_args.args[4], "handoff")
            task["launcher"] = "magpie"
            commands.start_again(self.store, task, "sp1", current=True)
            self.assertEqual(run.call_args.args[2][:3], ["claude-magpie", "--model", settings.MAGPIE_MODEL])

    def test_switch_resumes_only_within_the_same_launcher(self):
        for old in settings.LAUNCHERS:
            for new in settings.LAUNCHERS:
                with self.subTest(old=old, new=new):
                    previous = settings.argv_for({"agent": "claude", "launcher": old, "model": "old/model"})
                    chosen = settings.argv_for({"agent": "claude", "launcher": new, "perm": "auto"})
                    task = {"id": 1, "title": "Continue work", "prompt": "Keep the task context", "state": "running",
                            "agents": [{"argv": previous, "agent": "claude", "session": "S1", "log": "/old/session.jsonl"}]}
                    with patch.object(commands, "unarchive"), patch.object(commands, "parent_for", return_value=None), \
                            patch.object(commands, "launch", return_value={}) as run, \
                            patch.object(launch, "instructions", return_value="worker instructions"), \
                            patch.object(launch, "where_line", return_value="same branch and folder"), \
                            patch.object(launch, "notes", return_value=""), patch.object(launch, "closing_line", return_value="task commands"), \
                            patch.object(launch, "settings_block", return_value="task settings"):
                        _, resumed = commands.start_again(self.store, task, "sp1", argv_json=json.dumps(chosen), current=True)
                    self.assertEqual(resumed, old == new)
                    self.assertEqual(run.call_args.args[2], chosen)
                    if resumed:
                        self.assertEqual(run.call_args.kwargs["resume"], chosen + ["--resume", "S1"])
                    else:
                        self.assertNotIn("resume", run.call_args.kwargs)
                        text = run.call_args.args[4]
                        for context in ("APP-1", "Keep the task context", "/old/session.jsonl", "worker instructions", "same branch and folder"):
                            self.assertIn(context, text)

    def test_recovery_and_lost_session_keep_launcher_and_hooks(self):
        argv = launch.magpie_argv(launch.own_argv(["claude-magpie", "--model", "original/model", "--effort", "max"]))
        kind, base = revive.base_argv(["env", *argv, "--resume", "S1", "old prompt"])
        self.assertEqual((kind, base), ("claude", argv))
        k = {"address": "t1", "name": "app-1-try", "pid": 2, "argv": ["/bin/sh"], "labels": {"herdr.task": "repo#1"}}
        rec = {"kind": kind, "argv": base, "session": "gone", "log": None, "pid": 1}
        with patch.object(revive, "task_of", return_value={"state": "running"}):
            how, fresh, _ = revive.plan(k, rec, set())
            self.assertEqual(how, "fresh")
            self.assertEqual(fresh[:-1], argv)
            self.assertIn("earlier session is gone", fresh[-1])
            with tempfile.NamedTemporaryFile() as log:
                rec["log"] = log.name
                how, resumed, _ = revive.plan(k, rec, set())
                self.assertEqual((how, resumed), ("resume", argv + ["--resume", "gone"]))
        k.update(foreground={"pid": 8, "argv": ["claude", "--effort", "max"]}, labels={revive.LABEL: json.dumps(rec)})
        with patch.object(revive, "session_of", return_value=("gone", "log")):
            self.assertEqual(revive.record_of(k)["argv"], argv)
            rec["argv"] = ["/bin/claude-magpie", "--model", "custom/model"]
            k["labels"][revive.LABEL] = json.dumps(rec)
            self.assertEqual(revive.record_of(k)["argv"], rec["argv"])

    def test_missing_launcher_errors_without_running_plain_claude(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ["claude", "hc"]:
                (root / name).write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
                (root / name).chmod(0o755)
            env = {**os.environ, "PATH": folder, "HC_TERMINAL_ID": ""}
            argv = ["claude-magpie", "--model", "copilot/sonnet", "--model=other/model", "--effort", "high", "--resume", "S1", "words with spaces"]
            cmd = ["/bin/sh", *launch.magpie_argv(argv)[1:]]
            fallback = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(fallback.returncode, 127)
            self.assertEqual(fallback.stdout, "")
            self.assertIn("claude-magpie is not installed", fallback.stderr)
            (root / "claude-magpie").write_text("#!/bin/sh\nprintf 'magpie\\n'; printf '%s\\n' \"$@\"\n")
            (root / "claude-magpie").chmod(0o755)
            retried = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(retried.stdout.splitlines(), ["magpie", *argv[1:]])
            self.assertEqual(retried.stderr, "")

    def test_reviewer_does_not_use_worker_launcher(self):
        self.layers[2] = {"worker": {"agent": "claude", "launcher": "magpie"}}
        self.assertEqual(shlex.split(settings.reviewer_command("claude", "sonnet", "high")),
                         launch.clean_env(["claude", "--permission-mode", "plan", "--model", "sonnet", "--effort", "high"]))

    def test_cdnd_settings_and_reviewer_commands(self):
        for role in ("coordinator", "worker", "reviewer"):
            self.layers[2] = {role: {"agent": "claude", "launcher": "cdnd", "model": "custom/model", "effort": "max"}}
            pick = settings.settings_for(self.store, "sp1")[role]
            argv = settings.argv_for(pick)
            self.assertEqual(argv[:5], ["claude-cdnd", "--model", "custom/model", "--effort", "max"])
            self.assertEqual(settings.agent_key(argv), "claude")
        self.assertEqual(shlex.split(settings.reviewer_command("claude", "custom/model", "high", launcher="cdnd")),
                         launch.clean_env(["claude-cdnd", "--permission-mode", "plan", "--model", "custom/model", "--effort", "high"]))
        self.assertIn("--model copilot/claude-sonnet-5.5", settings.reviewer_command("claude", launcher="magpie"))
        self.assertTrue(launch.helper_hc(["hc", "run", "--bg", "--name", "shep-1-review", "--label", "herdr.agent=claude", "--",
                                         "claude-magpie", "--permission-mode", "plan", "--model", "copilot/claude-sonnet-5.5", "--effort", "high", "Review it"]))
        with patch.object(settings, "run", return_value=SimpleNamespace(returncode=1)):
            for command in ("claude-magpie", "claude-cdnd"):
                with self.assertRaisesRegex(Fail, "is not installed"):
                    settings.ensure_launcher([command])

    def test_missing_launcher_is_checked_before_ending_current_worker(self):
        from contextlib import nullcontext
        task = {"id": 1, "state": "running", "agents": []}
        self.store.find = lambda _: task
        args = argparse.Namespace(id="1", space=None, agent=None, argv=None, parent=None, keep=False)
        with patch.object(commands, "open_store", return_value=nullcontext(self.store)), \
                patch.object(commands, "live_agents", return_value=[{"address": "t1", "labels": {}}]), \
                patch.object(commands, "detail", side_effect=lambda x: x), patch.object(commands, "agent_running", return_value=True), \
                patch.object(commands, "refresh_sessions"), patch.object(commands, "default_space", return_value="sp1"), \
                patch.object(commands, "worker_argv", return_value=["claude-cdnd"]), patch.object(settings, "run", return_value=SimpleNamespace(returncode=1)), \
                patch.object(commands, "end_agent") as end:
            with self.assertRaisesRegex(Fail, "claude-cdnd is not installed"):
                commands.cmd_switch(args)
            end.assert_not_called()

    def test_assistant_recovery_keeps_declared_cdnd_launcher(self):
        argv = ["claude-cdnd", "--model", "custom/model", "--effort", "high"]
        terminal = {"argv": ["sh", "-c", "template"], "pid": 1, "foreground": {"pid": 2, "argv": ["claude"]},
                    "labels": {"herdr.launcher.argv": json.dumps(argv), "herdr.role": "coordinator"}}
        with patch.object(revive, "session_of", return_value=("S1", "log")):
            record = revive.record_of(terminal)
        self.assertEqual((record["kind"], record["argv"]), ("claude", argv))

    def test_launcher_probe_uses_login_path_without_starting_a_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            marker = root / "started"
            (root / "claude-cdnd").write_text("#!/bin/sh\ntouch " + shlex.quote(str(marker)) + "\n")
            (root / "claude-cdnd").chmod(0o755)
            shell = root / "login-shell"
            shell.write_text("#!/bin/sh\nPATH=" + shlex.quote(folder) + ':"$PATH"; export PATH\nshift\nexec /bin/sh -c "$@"\n')
            shell.chmod(0o755)
            with patch.dict(os.environ, {"SHELL": str(shell), "PATH": "/usr/bin:/bin"}):
                settings.ensure_launcher(["claude-cdnd"])
                with self.assertRaisesRegex(Fail, "is not installed"):
                    settings.ensure_launcher([str(root / "missing" / "claude-cdnd")])
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
