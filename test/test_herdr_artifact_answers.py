"""herdr-artifact (SHEP-87): the person's answers to a recipe's choices, forms and buttons are kept per version in
answers.json before their words go to the agent (`note --answer`), read back with `answers` (the window's view and,
through the store, the web app), forwarded to another machine with --from; and the `check` block's rules. Runs in a
throwaway store; hc is faked, nothing is installed."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


A = load("herdr_artifact_answers_under_test", os.path.join(ROOT, "mods", "artifacts", "bin", "herdr-artifact"))

RECIPE = {"recipe": 1, "blocks": [
    {"type": "choice", "id": "ship", "question": "Ship it?", "options": [{"label": "Ship"}, {"label": "Wait"}]},
    {"type": "check", "command": "bun test", "exit": 0, "summary": "12 pass", "output": "ok", "caption": "Unit tests"},
]}


class Answers(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="shepherdr-answers-")
        store = os.path.join(self.dir, "store")
        self.folder = os.path.join(self.dir, "proj")
        os.makedirs(self.folder)
        self.sent = []
        self.patches = [mock.patch.object(A, "STORE", store), mock.patch.object(A, "FILES", os.path.join(store, "files")),
                        mock.patch.object(A, "NOTES", os.path.join(store, "notes")),
                        mock.patch.object(A, "APP", os.path.join(self.dir, "app")),
                        mock.patch.object(A.shutil, "which", return_value=None),
                        mock.patch.object(A, "me", return_value={"terminal": "t9", "task": None}),
                        mock.patch.object(A, "keeper", return_value=("t9", "made it"))]
        for p in self.patches:
            p.start()
        src = os.path.join(self.dir, "r")
        os.makedirs(src)
        with open(os.path.join(src, "recipe.json"), "w") as f:
            json.dump(RECIPE, f)
        with mock.patch("sys.stdout"):
            A.cmd_publish(types.SimpleNamespace(dir=src, id=None, title="Plan", folder=self.folder, task=None, note=None, json=True, custom=False))
        with A.Store(A.locate(self.folder), write=False) as s:
            self.aid = s.data["artifacts"][0]["id"]

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def note(self, **k):
        base = dict(id=self.aid, text="Ship it?: Ship", version=None, spot=None, image=None, shot=None, panel=None, area=None,
                    machine=None, json=True, answer=None, value=None, by=None, notes=None, blocks=None)
        o = types.SimpleNamespace(**{**base, **k})

        def run(argv, **_):
            if argv[:2] == ["hc", "send"]:
                # the answer is already kept when its words go
                self.sent.append((argv[2], argv[3], A.read_answers(self.aid, 1)))
            return subprocess.CompletedProcess(argv, 0, "", "")
        out = io.StringIO()
        with mock.patch.object(A, "run", side_effect=run), mock.patch("sys.stdout", out):
            A.cmd_note(o)
        return out.getvalue()

    def answers(self, **k):
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            A.cmd_answers(types.SimpleNamespace(**{**dict(id=self.aid, version=None, machine=None, json=True), **k}))
        return json.loads(out.getvalue())

    def test_an_answer_is_kept_with_its_version_before_it_is_sent(self):
        self.assertEqual(self.answers(), {})
        self.note(answer="ship", value=json.dumps("Ship"), by="web")
        kept = self.answers()
        self.assertEqual(kept["ship"]["value"], "Ship")
        self.assertEqual(kept["ship"]["by"], "web")
        self.assertIsInstance(kept["ship"]["at"], int)
        self.assertTrue(os.path.isfile(os.path.join(A.FILES, self.aid, "v1", "answers.json")))
        to, body, then = self.sent[0]
        self.assertEqual(to, "t9")
        self.assertIn('<hc from="artifact"', body)
        self.assertIn("Ship it?: Ship", body)
        self.assertEqual(then["ship"]["value"], "Ship")
        # the agent's recipe.json is untouched
        with open(os.path.join(A.FILES, self.aid, "v1", "recipe.json")) as f:
            self.assertEqual(json.load(f), RECIPE)

    def test_a_new_answer_replaces_the_old_and_a_form_keeps_its_values(self):
        self.note(answer="ship", value=json.dumps("Ship"))
        self.note(text="Ship it?: Wait", answer="ship", value=json.dumps("Wait"), by="window")
        self.note(text="Form", answer="b9", value=json.dumps({"name": "Ann", "ok": True}))
        kept = self.answers(version=1)
        self.assertEqual(kept["ship"]["value"], "Wait")
        self.assertEqual(kept["ship"]["by"], "window")
        self.assertEqual(kept["b9"]["value"], {"name": "Ann", "ok": True})
        self.assertEqual(len(self.sent), 3)

    def test_a_plain_note_keeps_nothing_and_a_bad_key_is_refused(self):
        self.note(text="Make the chart bigger", spot="the chart")
        self.assertEqual(self.answers(), {})
        with self.assertRaisesRegex(A.Fail, "block key"):
            self.note(answer="../x", value="1")
        with self.assertRaisesRegex(A.Fail, "no v7"):
            self.note(answer="ship", value='"Ship"', version=7)
        self.assertEqual(len(self.sent), 1)

    def test_another_machines_answer_goes_there_with_its_key(self):
        calls = []

        def run(argv, **_):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, json.dumps({"to": "t3", "why": "made it", "version": 1, "image": None}) + "\n", "")
        o = types.SimpleNamespace(id=self.aid, text="Ship it?: Ship", version=1, spot=None, image=None, shot=None, panel=None, area=None,
                                  machine="vm", json=True, answer="ship", value='"Ship"', by="window", notes=None, blocks=None)
        with mock.patch.object(A, "run", side_effect=run), mock.patch("sys.stdout", io.StringIO()):
            A.cmd_note(o)
        argv = calls[0]
        self.assertEqual(argv[2:4], ["--on", "vm"])
        self.assertEqual(argv[argv.index("--answer") + 1], "ship")
        self.assertEqual(argv[argv.index("--value") + 1], '"Ship"')
        self.assertEqual(argv[argv.index("--by") + 1], "window")
        # nothing kept here: it lives there
        self.assertEqual(A.read_answers(self.aid, 1), {})
        calls.clear()

        def read(argv, **_):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, '{"ship": {"value": "Ship", "at": 1, "by": "web"}}\n', "")
        with mock.patch.object(A, "run", side_effect=read):
            self.assertEqual(self.answers(machine="vm", version=1)["ship"]["value"], "Ship")
        self.assertEqual(calls[0][2:6], ["--on", "vm", "answers", self.aid])

    def test_a_republished_version_never_carries_answers(self):
        """A kept version pulled into a folder and published again: its answers stay with the old version."""
        src = os.path.join(self.dir, "again")
        shutil.copytree(os.path.join(A.FILES, self.aid, "v1"), src)
        with open(os.path.join(src, "answers.json"), "w") as f:
            json.dump({"ship": {"value": "Ship", "at": 1}}, f)
        with mock.patch("sys.stdout"):
            A.cmd_publish(types.SimpleNamespace(dir=src, id=self.aid, title=None, folder=self.folder, task=None, note="v2", json=True, custom=False))
        self.assertFalse(os.path.exists(os.path.join(A.FILES, self.aid, "v2", "answers.json")))
        self.assertEqual(self.answers(version=2), {})

    def test_check_blocks(self):
        d = os.path.join(self.dir, "r")
        ok = lambda b: A.recipe_problems(d, ["recipe.json"]) if write(b) else None  # noqa: E731

        def write(b):
            with open(os.path.join(d, "recipe.json"), "w") as f:
                json.dump({"recipe": 1, "blocks": [b]}, f)
            return True
        self.assertEqual(ok({"type": "check", "command": "make test", "exit": 2, "summary": "1 failed"}), [])
        self.assertEqual(ok({"type": "code", "lang": "diff", "text": "+a\n-b"}), [])
        self.assertEqual(len(ok({"type": "check", "exit": 0})), 1)
        self.assertEqual(len(ok({"type": "check", "command": "x", "exit": "0"})), 1)
        self.assertEqual(len(ok({"type": "check", "command": "x", "exit": True})), 1)
        self.assertEqual(len(ok({"type": "check", "command": "x", "exit": 0, "output": "y" * (A.CHECK_OUTPUT_MAX + 1)})), 1)
        self.assertEqual(len(ok({"type": "check", "command": "x", "exit": 0, "summary": 3})), 1)


if __name__ == "__main__":
    unittest.main()
