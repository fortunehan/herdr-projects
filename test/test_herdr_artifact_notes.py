"""herdr-artifact note (SHEP-88): Mark up's Send all gives several numbered notes, each its spot in words and its
words, plus words about all of it, to the agent as ONE message (--notes, a JSON list, inline, @file or stdin); a single
note keeps the message it always had, so agents and older callers keep working. Runs in a throwaway store; hc is faked."""
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
BIN = os.path.join(ROOT, "mods", "artifacts", "bin", "herdr-artifact")
sys.dont_write_bytecode = True


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


A = load("herdr_artifact_notes_under_test", BIN)

NOTES = [
    {"text": "Make this bigger", "spot": "the 180×80 px area at x 120–300, y 80–160 of the 720×540 panel (near the top left)"},
    {"text": "Red, not green", "spot": "the point at x 360, y 270 of the 720×540 panel (near the middle)"},
    {"text": "", "spot": "the point at x 600, y 500 of the 720×540 panel (near the bottom right)"},
]


class Notes(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="shepherdr-notes-")
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
            json.dump({"recipe": 1, "blocks": [{"type": "text", "text": "Hello"}]}, f)
        with mock.patch("sys.stdout"):
            A.cmd_publish(types.SimpleNamespace(dir=src, id=None, title="Plan", folder=self.folder, task=None, note=None, json=True, custom=False))
        with A.Store(A.locate(self.folder), write=False) as s:
            self.aid = s.data["artifacts"][0]["id"]

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def note(self, **k):
        base = dict(id=self.aid, text=None, version=None, spot=None, image=None, shot=None, panel=None, area=None,
                    machine=None, json=True, answer=None, value=None, by=None, notes=None)
        o = types.SimpleNamespace(**{**base, **k})

        def run(argv, **_):
            if argv[:2] == ["hc", "send"]:
                self.sent.append((argv[2], argv[3]))
            return subprocess.CompletedProcess(argv, 0, "", "")
        out = io.StringIO()
        with mock.patch.object(A, "run", side_effect=run), mock.patch("sys.stdout", out):
            A.cmd_note(o)
        return json.loads(out.getvalue())

    def test_several_notes_go_as_one_numbered_message(self):
        out = self.note(notes=json.dumps(NOTES), text="  Otherwise it looks good ")
        self.assertEqual(out["notes"], 3)
        self.assertEqual(len(self.sent), 1)
        to, body = self.sent[0]
        self.assertEqual(to, "t9")
        self.assertEqual(body, (
            f'<hc from="artifact" id="{self.aid}" version="1" title="Plan" notes="3">\n'
            "3 notes, numbered as marked on it:\n\n"
            f"1. On {NOTES[0]['spot']}:\nMake this bigger\n\n"
            f"2. On {NOTES[1]['spot']}:\nRed, not green\n\n"
            f"3. On {NOTES[2]['spot']}:\n(no words: just this spot)\n\n"
            "About all of it:\nOtherwise it looks good\n"
            "</hc>"))

    def test_one_note_keeps_todays_message(self):
        self.note(notes=json.dumps(NOTES[:1]))
        self.note(text="Make this bigger", spot=NOTES[0]["spot"])
        self.assertEqual(self.sent[0], self.sent[1])
        self.assertIn(f'on="{NOTES[0]["spot"]}">\nMake this bigger\n</hc>', self.sent[0][1])
        self.assertNotIn("notes=", self.sent[0][1])

    def test_notes_from_a_file_or_stdin_and_a_bare_list_of_words(self):
        p = os.path.join(self.dir, "notes.json")
        with open(p, "w") as f:
            json.dump({"notes": NOTES[:2]}, f)
        self.note(notes="@" + p)
        with mock.patch("sys.stdin", io.StringIO(json.dumps(["Bigger", "Smaller"]))):
            self.note(notes="-")
        self.assertIn('notes="2"', self.sent[0][1])
        self.assertIn("2. On the point at x 360", self.sent[0][1])
        self.assertIn("1. On it:\nBigger\n\n2. On it:\nSmaller", self.sent[1][1])

    def test_bad_notes_are_refused_before_anything_goes(self):
        for bad in ["{", '{"a": 1}', "[1, 2]", json.dumps([{"text": "x"}] * (A.NOTES_MAX + 1))]:
            with self.assertRaises(A.Fail):
                self.note(notes=bad)
        with self.assertRaisesRegex(A.Fail, "Nothing to send"):
            self.note(notes="[]")
        with self.assertRaisesRegex(A.Fail, "Nothing to send"):
            self.note()
        self.assertEqual(self.sent, [])

    def test_an_older_version_and_the_picture_are_said(self):
        img = os.path.join(self.dir, "shot.png")
        open(img, "wb").close()
        self.note(notes=json.dumps(NOTES[:2]), image=img)
        body = self.sent[0][1]
        self.assertTrue(body.endswith(f"each note's spot marked with its number in blue: {img}\n</hc>"))

    def test_another_machine_gets_the_notes_through_on(self):
        calls = []

        def run(argv, **_):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, json.dumps({"to": "t3", "why": "made it", "version": 1, "image": None, "notes": 2}) + "\n", "")
        o = types.SimpleNamespace(id=self.aid, text="All good", version=1, spot=None, image=None, shot=None, panel=None, area=None,
                                  machine="vm", json=True, answer=None, value=None, by=None, notes=json.dumps(NOTES[:2]))
        out = io.StringIO()
        with mock.patch.object(A, "run", side_effect=run), mock.patch("sys.stdout", out):
            A.cmd_note(o)
        argv = calls[0]
        self.assertEqual(argv[2:5], ["--on", "vm", "note"])
        self.assertEqual(json.loads(argv[argv.index("--notes") + 1]), NOTES[:2])
        self.assertEqual(argv[argv.index("--text") + 1], "All good")
        self.assertNotIn("--spot", argv)
        self.assertEqual(json.loads(out.getvalue())["to"], "vm/t3")

    def test_the_cli_takes_notes_without_text(self):
        r = subprocess.run([sys.executable, BIN, "note", "--help"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                           env={**os.environ, "SHEPHERDR_HANDED_OVER": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("--notes", r.stdout)

    def test_markup_carries_core_markup(self):
        self.assertIn(os.path.join("core", "markup.js"), A.MARKUP_HELPERS)
        with open(os.path.join(ROOT, "mods", "artifacts", "markup.js")) as f:
            self.assertIn('from "./core/markup.js"', f.read())


if __name__ == "__main__":
    unittest.main()
