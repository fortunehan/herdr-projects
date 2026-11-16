"""Claude worker launchers, inheritance and recovery, without a live Herdr core."""
import home_guard  # noqa: F401
import argparse
import json
import os
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
        self.assertEqual(launch.resume_argv(raw, "S1"), raw + ["--resume", "S1"])
        owned = launch.own_argv(raw)
        self.assertIn("PermissionRequest", owned[owned.index("--settings") + 1])

    def test_launch_stores_and_labels_claude_and_keeps_wrappers(self):
        argv = settings.argv_for({"agent": "claude", "launcher": "magpie"})
        task = {"id": 1, "agents": [], "title": "Try", "mode": "here"}
        with patch.object(launch, "folder_for", return_value="/repo"), \
                patch.object(launch, "agent_name", return_value="app-1-try"), \
                patch.object(launch, "coordinator_tab", return_value=None), \
                patch.object(launch, "track"), patch.object(launch.local, "with_setup", side_effect=lambda t, f, a: a), \
                patch.object(launch, "low_priority", side_effect=lambda a, n: ["low", *a]), \
                patch.object(launch, "run", return_value=SimpleNamespace(stdout='{"address":"t1"}', stderr="", returncode=0)) as run:
            record = launch.launch(self.store, task, argv, "sp1")
            cmd = run.call_args.args[0]
            self.assertIn("herdr.agent=claude", cmd)
            self.assertIn(launch.CLEAN_ENV + ' exec "$@"', cmd)
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
                patch.object(commands, "launch", return_value={}) as run:
            commands.start_again(self.store, task, "sp1")
            self.assertEqual(run.call_args.args[2], old)
            self.assertEqual(run.call_args.kwargs["resume"], old + ["--resume", "S1"])
            commands.start_again(self.store, task, "sp1", current=True)
            self.assertEqual(run.call_args.args[2][0], "claude")
            self.assertEqual(run.call_args.kwargs["resume"][-2:], ["--resume", "S1"])
            task["launcher"] = "magpie"
            commands.start_again(self.store, task, "sp1", current=True)
            self.assertEqual(run.call_args.args[2][:3], ["claude-magpie", "--model", settings.MAGPIE_MODEL])

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

    def test_fallback_executes_plain_claude_without_model_and_retries_magpie(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ["claude", "hc"]:
                (root / name).write_text("#!/bin/sh\nprintf '%s\\n' \"$@\"\n")
                (root / name).chmod(0o755)
            env = {**os.environ, "PATH": folder, "HC_TERMINAL_ID": ""}
            argv = ["claude-magpie", "--model", "copilot/sonnet", "--model=other/model", "--effort", "high", "--resume", "S1", "words with spaces"]
            cmd = ["/bin/sh", *launch.magpie_argv(argv)[1:]]
            fallback = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(fallback.returncode, 0, fallback.stderr)
            self.assertEqual(fallback.stdout.splitlines(), ["--effort", "high", "--resume", "S1", "words with spaces"])
            self.assertEqual(fallback.stderr.count("This machine has no claude-magpie"), 1)
            (root / "claude-magpie").write_text("#!/bin/sh\nprintf 'magpie\\n'; printf '%s\\n' \"$@\"\n")
            (root / "claude-magpie").chmod(0o755)
            retried = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(retried.stdout.splitlines(), ["magpie", *argv[1:]])
            self.assertEqual(retried.stderr, "")

    def test_reviewer_does_not_use_worker_launcher(self):
        self.layers[2] = {"worker": {"agent": "claude", "launcher": "magpie"}}
        self.assertEqual(settings.reviewer_command("claude", "sonnet", "high"), "claude --permission-mode plan --model sonnet --effort high")


if __name__ == "__main__":
    unittest.main()
