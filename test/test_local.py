"""herdr-task's local additions (herdr_task/local.py): an Assistant's local notes, a repo's own git
config and its worktree setup command. Throwaway folders and git repos (no global git config); hc and the settings file are never touched."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
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
import herdr_task.layout as layout  # noqa: E402
import herdr_task.local as local  # noqa: E402
import herdr_task.store as store  # noqa: E402

ADO_URL = "https://acme@dev.azure.com/acme/Shop/_git/shop"
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


class OwnDataMoves(Base):
    """SHEP-141's move takes this fork's own data too: the Assistant's notes, ado.json and Claude's usage go to
    Shepherdr's own folders, a link left at each old path; a rollback brings them back."""

    def test_moved_linked_and_read_there(self):
        home = os.path.join(self.tmp, "home")
        old = os.path.join(home, ".herdr")
        os.makedirs(os.path.join(old, "assistant"))
        os.makedirs(os.path.join(old, "usage"))
        for rel, text in (("assistant/_everywhere.md", "Reply in English."), ("ado.json", '{"merge": "rebase"}'),
                          ("usage/claude.json", '{"at": 1}')):
            with open(os.path.join(old, rel), "w") as f:
                f.write(text)
        self.assertEqual(layout.migrate(home=home, env={}, mac=False)["state"], "migrated")
        w = layout.Where(home, {}, False)
        self.assertEqual(w.path("assistant-notes"), os.path.join(home, ".config", "shepherdr", "assistant"))
        self.assertEqual(w.path("ado"), os.path.join(home, ".config", "shepherdr", "ado.json"))
        self.assertEqual(w.path("usage"), os.path.join(home, ".local", "state", "shepherdr", "usage"))
        for kind, rel in (("assistant-notes", "assistant"), ("ado", "ado.json"), ("usage", "usage")):
            self.assertTrue(os.path.islink(os.path.join(old, rel)), rel)
            self.assertTrue(os.path.exists(w.path(kind)) and not os.path.islink(w.path(kind)), kind)
        with open(os.path.join(w.path("assistant-notes"), "_everywhere.md")) as f:
            self.assertEqual(f.read(), "Reply in English.")
        layout.rollback(home=home, env={}, mac=False)
        self.assertEqual(w.path("assistant-notes"), os.path.join(old, "assistant"))
        self.assertFalse(os.path.islink(os.path.join(old, "assistant")))
        with open(os.path.join(old, "ado.json")) as f:
            self.assertEqual(f.read(), '{"merge": "rebase"}')

    def test_the_status_line_helper_knows_the_usage_folder(self):
        with open(os.path.join(ROOT, "bin", "shepherdr-statusline")) as f:
            src = f.read()
        self.assertIn('return SHEP(".herdr/usage/claude.json")', src)
        self.assertIn("'.herdr/usage': ('state', 'usage')", src)


class AssistantNotes(Base):
    """P1: ~/.config/shepherdr/assistant/_everywhere.md and <slug>.md reach an Assistant's new session, Claude's or Codex's."""

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
        self.assertTrue(text.endswith(":\n" + "x" * local.NOTES_MAX + "\n(cut here: the file is longer)"))

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
            self.git(self.main, "remote", "add", "origin", ADO_URL)
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
        self.git(self.main, "remote", "add", "origin", ADO_URL)
        self.git(self.main, "config", "herdr.wid", "123")
        local.set_wid(self.store, t, None)
        self.assertEqual(t["wid"], "123")
        local.set_wid(self.store, t, "")
        self.assertNotIn("wid", t)
        with self.assertRaises(local.Fail):
            local.set_wid(self.store, t, "login")

    def global_wid(self, origin):
        glob = os.path.join(self.tmp, "gitconfig")
        with open(glob, "w") as f:
            f.write("[herdr]\n\twid = 16951176\n")
        self.git(self.main, "remote", "add", "origin", origin)
        return mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": glob})

    def test_a_github_repo_never_takes_the_global_wid(self):
        with self.global_wid("https://github.com/acme/shop.git"):
            t = self.task()
            local.set_wid(self.store, t, None)
            self.assertNotIn("wid", t)

    def test_an_azure_devops_repo_takes_the_global_wid(self):
        with self.global_wid(ADO_URL):
            t = self.task()
            local.set_wid(self.store, t, None)
            self.assertEqual(t["wid"], "16951176")

    def test_an_explicit_wid_applies_in_a_github_repo(self):
        with self.global_wid("git@github.com:acme/shop.git"):
            t = self.task()
            local.set_wid(self.store, t, "ADO-42")
            self.assertEqual(t["wid"], "42")
            local.set_wid(self.store, t, "")
            self.assertNotIn("wid", t)


class WorktreeSetup(Base):
    """P3: git config herdr.setup runs once in a new worktree, in the agent's own terminal, before the agent."""

    def setUp(self):
        super().setUp()
        self.main = self.repo()
        self.wt = os.path.join(self.tmp, "wt")
        self.git(self.main, "worktree", "add", "-q", "-b", "task/1", self.wt)
        self.task = {"id": 1, "title": "Login", "mode": "worktree", "worktree": self.wt}
        self.agent = ["sh", "-c", 'echo "agent in $PWD"']

    def run_argv(self, argv):
        return subprocess.run(argv, cwd=self.wt, capture_output=True, text=True)

    def test_it_runs_once_before_the_agent(self):
        self.assertEqual(local.with_setup(self.task, self.wt, self.agent), self.agent)  # unset: as it was
        self.git(self.main, "config", "herdr.setup", "echo ready > prepared.txt")
        argv = local.with_setup(self.task, self.wt, self.agent)
        r = self.run_argv(argv)
        self.assertIn(f"agent in {self.wt}", r.stdout)
        self.assertTrue(os.path.exists(os.path.join(self.wt, "prepared.txt")))
        self.assertEqual(local.with_setup(self.task, self.wt, self.agent), self.agent)  # done once
        self.assertFalse(os.path.exists(os.path.join(self.main, ".git", local.SETUP_DONE)))  # the worktree's own mark

    def test_a_failed_setup_still_starts_the_agent_and_runs_again_next_time(self):
        self.git(self.main, "config", "herdr.setup", "exit 3")
        r = self.run_argv(local.with_setup(self.task, self.wt, self.agent))
        self.assertIn("agent in", r.stdout)
        self.assertIn("herdr.setup failed", r.stderr)
        self.assertNotEqual(local.with_setup(self.task, self.wt, self.agent), self.agent)

    def test_never_for_a_task_in_the_folder_itself_and_the_brief_says_so(self):
        self.git(self.main, "config", "herdr.setup", "wt hook pre-start")
        self.assertEqual(local.with_setup({"mode": "here"}, self.main, self.agent), self.agent)
        self.assertEqual(local.setup_line(Store(self.main), {"mode": "here"}), "")
        self.assertIn("`wt hook pre-start`", local.setup_line(Store(self.main), self.task))


if __name__ == "__main__":
    unittest.main()
