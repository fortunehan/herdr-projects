"""herdr-task's local additions (herdr_task/local.py): an Assistant's local notes and a repo's own git
config. Throwaway folders and git repos (no global git config); hc and the settings file are never touched."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "mods", "tasks", "bin"))
sys.dont_write_bytecode = True

import herdr_task.assistant_settings as assistant_settings  # noqa: E402
import herdr_task.commands as commands  # noqa: E402
import herdr_task.launch as launch  # noqa: E402
import herdr_task.local as local  # noqa: E402
import herdr_task.store as store  # noqa: E402

GIT_ENV = {"GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        p = mock.patch.dict(os.environ, GIT_ENV)
        p.start()
        self.addCleanup(p.stop)

    def git(self, cwd, *args):
        return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True, text=True).stdout.strip()

    def repo(self, name="repo"):
        main = os.path.join(self.tmp, name)
        subprocess.run(["git", "init", "-q", "-b", "main", main], check=True)
        for k, v in (("user.name", "T"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")):
            self.git(main, "config", k, v)
        self.git(main, "commit", "-q", "--allow-empty", "-m", "base")
        return main


class AssistantNotes(Base):
    """P1: ~/.herdr/assistant/_everywhere.md and <slug>.md reach an Assistant's new session, Claude's or Codex's."""

    def setUp(self):
        super().setUp()
        self.notes = os.path.join(self.tmp, "assistant")
        os.makedirs(self.notes)
        for mod, name, value in ((local, "NOTES", self.notes), (store, "STORE", os.path.join(self.tmp, "tasks"))):
            p = mock.patch.object(mod, name, value)
            p.start()
            self.addCleanup(p.stop)

    def write(self, name, text):
        with open(os.path.join(self.notes, name), "w") as f:
            f.write(text)

    def test_everywhere_then_the_spaces_own_by_its_slug(self):
        main = self.repo()
        sub = os.path.join(main, "src")
        os.makedirs(sub)
        slug = store.store_path(main)[0]
        self.write("_everywhere.md", "Grill a big ask first.")
        self.write(f"{slug}.md", "conversation-sdk is at ~/Codes/sdk.")
        text = local.assistant_notes({"cwd": sub})
        self.assertLess(text.index("Grill a big ask first."), text.index("conversation-sdk is at ~/Codes/sdk."))
        self.assertIn("not in any repo", text)

    def test_nothing_without_notes_and_a_long_file_is_cut(self):
        self.assertEqual(local.assistant_notes({"cwd": self.repo()}), "")
        self.write("_everywhere.md", "x" * (local.NOTES_MAX + 50))
        text = local.assistant_notes({"cwd": "/nowhere"})
        self.assertIn("(cut here: the file is longer)", text)
        self.assertEqual(text.count("x"), local.NOTES_MAX)

    def test_an_assistants_session_note_ends_with_them_and_a_workers_never_has_them(self):
        self.write("_everywhere.md", "Grill a big ask first.")
        k = {"cwd": self.repo(), "labels": {"herdr.role": "coordinator", "herdr.space": "sp1"}}
        with mock.patch.object(assistant_settings, "hc_json", lambda *a: k), mock.patch.object(assistant_settings, "run", lambda *a: None), \
                mock.patch.object(assistant_settings, "rows", lambda space: [{"key": "reactions", "value": "off"}]), \
                mock.patch.object(assistant_settings, "block", lambda rs: "Your settings: ..."), \
                mock.patch.object(assistant_settings, "digest", lambda rs: "d"):
            text = assistant_settings.session_note("t1")
            self.assertTrue(text.startswith("Your settings: ..."))
            self.assertTrue(text.endswith("Grill a big ask first."))
            k["labels"] = {"herdr.task": "repo#1"}
            with mock.patch.object(assistant_settings.reactions, "agent_note", lambda terminal, k: "reactions"):
                self.assertEqual(assistant_settings.session_note("t2"), "reactions")


class Store:
    def __init__(self, folder, tasks=()):
        self.data, self.loc = {"tasks": list(tasks)}, {"folder": folder, "kind": "repo", "name": os.path.basename(folder)}

    def ref(self, t):
        return f"SHEP-{t['id']}"


class RepoGitConfig(Base):
    """P2: git config herdr.base / herdr.branch / herdr.wid, the repo's over the global one, over the space's settings."""

    def setUp(self):
        super().setUp()
        self.main = self.repo()
        self.git(self.main, "branch", "develop")
        self.store = Store(self.main)
        for mod, name, value in ((launch, "settings_for", lambda s, space: {"tasks": {"branch": "", "base": ""}}),
                                 (commands, "space_base", lambda s, space=None: "")):
            p = mock.patch.object(mod, name, value)
            p.start()
            self.addCleanup(p.stop)

    def task(self, **extra):
        return {"id": 4, "title": "Fix login", "mode": "worktree", **extra}

    def test_a_new_task_takes_the_repos_base(self):
        t = self.task()
        commands.set_base(self.store, t, None, new=True)
        self.assertNotIn("base", t)
        self.git(self.main, "config", "herdr.base", "develop")
        commands.set_base(self.store, t, None, new=True)
        self.assertEqual((t["base"], t["base_set"]), ("develop", True))
        t = self.task()
        commands.set_base(self.store, t, "main", new=True)  # its own --base wins
        self.assertNotIn("base", t)

    def test_the_repos_setting_wins_over_the_global_one(self):
        glob = os.path.join(self.tmp, "gitconfig")
        with open(glob, "w") as f:
            f.write("[herdr]\n\tbase = nope\n\twid = 99\n")
        with mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": glob}):
            self.assertEqual(local.base(self.main), "nope")
            self.git(self.main, "config", "herdr.base", "develop")
            self.assertEqual(local.base(self.main), "develop")
            t = self.task()
            local.set_wid(self.store, t, None)
            self.assertEqual(t["wid"], "99")

    def test_the_branch_pattern_with_its_work_item(self):
        self.git(self.main, "config", "herdr.branch", "feature/ADO-{wid}-{n}-{slug}")
        self.assertEqual(launch.branch_for(self.store, self.task(wid="16951176")), "feature/ADO-16951176-4-fix-login")
        self.assertEqual(launch.branch_for(self.store, self.task()), "task/4-fix-login")  # no work item: the space's, else the default
        self.git(self.main, "config", "herdr.branch", "feature/{slug}")  # no {n}: refused as Branch names refuses it
        self.assertEqual(launch.branch_for(self.store, self.task()), "task/4-fix-login")

    def test_wid_forms(self):
        t = self.task()
        for given, kept in (("16951176", "16951176"), ("#16951176", "16951176"), ("ADO-16951176", "16951176"), ("", None)):
            local.set_wid(self.store, t, given)
            self.assertEqual(t.get("wid"), kept, given)
        self.git(self.main, "config", "herdr.wid", "123")
        local.set_wid(self.store, t, None)
        self.assertEqual(t["wid"], "123")
        local.set_wid(self.store, t, "")
        self.assertNotIn("wid", t)
        with self.assertRaises(local.Fail):
            local.set_wid(self.store, t, "login")


if __name__ == "__main__":
    unittest.main()
