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
                    machine=None, json=True, answer=None, value=None, by=None, notes=None, blocks=None)
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
                                  machine="vm", json=True, answer=None, value=None, by=None, notes=json.dumps(NOTES[:2]), blocks=None)
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


# SHEP-113: on a recipe each note names the blocks it is on (Mark up reads them from the recipe as drawn)
HEADING = {"path": "blocks[0]", "kind": "heading", "text": "Release plan"}
ROW = {"path": "blocks[3].rows[1]", "kind": "table row 2", "text": "Beta | 9 | late"}
IMAGE = {"path": "blocks[4]", "kind": "image", "text": "Sign-in screen", "file": "login.png"}


class NotesOnBlocks(unittest.TestCase):
    """Notes whose blocks are named: each block's kind, its path in recipe.json and a short excerpt, the spot kept."""
    setUp, tearDown, note = Notes.setUp, Notes.tearDown, Notes.note

    def test_several_notes_name_their_blocks(self):
        notes = [{**NOTES[0], "blocks": [HEADING]}, {**NOTES[1], "blocks": [ROW, IMAGE], "more": 2}, NOTES[2]]
        self.note(notes=json.dumps(notes))
        self.assertEqual(self.sent[0][1], (
            f'<hc from="artifact" id="{self.aid}" version="1" title="Plan" notes="3">\n'
            "3 notes, numbered as marked on it:\n\n"
            "1. On the heading at blocks[0]: \u201cRelease plan\u201d\n"
            f"Spot: {NOTES[0]['spot']}\nMake this bigger\n\n"
            "2. On 4 blocks:\n"
            "- the table row 2 at blocks[3].rows[1]: \u201cBeta | 9 | late\u201d\n"
            "- the image at blocks[4]: \u201cSign-in screen\u201d (login.png)\n"
            "- and 2 more\n"
            f"Spot: {NOTES[1]['spot']}\nRed, not green\n\n"
            f"3. On {NOTES[2]['spot']}:\n(no words: just this spot)\n"
            "</hc>"))

    def test_a_single_note_names_its_block_before_the_words(self):
        self.note(text="Shorter", spot=NOTES[1]["spot"], blocks=json.dumps({"blocks": [HEADING], "more": 0}))
        self.note(notes=json.dumps([{"text": "Shorter", "spot": NOTES[1]["spot"], "blocks": [HEADING]}]))
        self.assertEqual(self.sent[0], self.sent[1])
        self.assertIn(f'on="{NOTES[1]["spot"]}">\nOn the heading at blocks[0]: \u201cRelease plan\u201d\nShorter\n</hc>', self.sent[0][1])

    def test_bad_blocks_are_dropped_and_too_many_counted(self):
        blocks = [{"path": "blocks[0]"}, "x", None] + [dict(HEADING, path=f"blocks[{i}]") for i in range(7)]
        self.note(notes=json.dumps([{"text": "a", "blocks": blocks}, {"text": "b", "blocks": "junk"}]))
        body = self.sent[0][1]
        self.assertIn("1. On 7 blocks:", body)
        self.assertIn("- the heading at blocks[4]", body)
        self.assertNotIn("blocks[5]", body)
        self.assertIn("- and 2 more", body)
        self.assertIn("2. On it:\nb", body)
        with self.assertRaises(A.Fail):
            self.note(text="x", blocks="{")

    def test_another_machine_gets_a_single_notes_blocks(self):
        calls = []

        def run(argv, **_):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, json.dumps({"to": "t3", "why": "made it", "version": 1, "image": None}) + "\n", "")
        o = types.SimpleNamespace(id=self.aid, text=None, version=1, spot=None, image=None, shot=None, panel=None, area=None, machine="vm",
                                  json=True, answer=None, value=None, by=None, notes=json.dumps([{"text": "Bigger", "spot": "x", "blocks": [ROW]}]), blocks=None)
        with mock.patch.object(A, "run", side_effect=run), mock.patch("sys.stdout", io.StringIO()):
            A.cmd_note(o)
        argv = calls[0]
        self.assertNotIn("--notes", argv)
        self.assertEqual(json.loads(argv[argv.index("--blocks") + 1]), {"blocks": [ROW], "more": 0})
        self.assertEqual(argv[argv.index("--spot") + 1], "x")

    def test_the_guide_explains_the_blocks(self):
        with open(A.GUIDE) as f:
            guide = f.read()
        self.assertIn("blocks[3].rows[1]", guide)
        r = subprocess.run([sys.executable, BIN, "note", "--help"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                           env={**os.environ, "SHEPHERDR_HANDED_OVER": "1"})
        self.assertIn("--blocks", r.stdout)


# SHEP-114: a note on selected words carries the quote and its context; one on a picture names it and the spot in it
TEXT = {"path": "blocks[1]", "kind": "text", "text": "The plan is that we ship on Friday after the review."}
QUOTE = {"text": "ship on Friday", "before": "The plan is that we ", "after": " after the review."}
PICTURE = {"file": "login.png", "path": "blocks[4]", "caption": "Sign-in screen", "width": 1280, "height": 800,
           "spot": "the 640×400 px area at x 640–1280, y 0–400 (the top right quarter)"}
PICTURE_SPOT = "the 640×400 px area at x 640–1280, y 0–400 (the top right quarter) of picture “login.png” (1280×800)"


class NotesOnWordsAndPictures(unittest.TestCase):
    setUp, tearDown, note = Notes.setUp, Notes.tearDown, Notes.note

    def test_quote_and_picture_notes_in_one_message(self):
        notes = [{"text": "Say Monday", "spot": "", "blocks": [TEXT], "quote": QUOTE},
                 {"text": "Too dark", "spot": PICTURE_SPOT, "picture": PICTURE},
                 {"text": "Crop it", "spot": "picture “a.png”", "picture": {"file": "a.png", "path": "blocks[9].before"}}]
        self.note(notes=json.dumps(notes, ensure_ascii=False), text="Thanks")
        self.assertEqual(self.sent[0][1], (
            f'<hc from="artifact" id="{self.aid}" version="1" title="Plan" notes="3">\n'
            "3 notes, numbered as marked on it:\n\n"
            "1. On the text at blocks[1]: “The plan is that we ship on Friday after the review.”\n"
            "Selected: “ship on Friday”\n"
            "In context: “The plan is that we «ship on Friday» after the review.”\n"
            "Say Monday\n\n"
            "2. On the picture “login.png” (1280×800) at blocks[4]: “Sign-in screen”\n"
            f"Spot in it: {PICTURE['spot']}\nToo dark\n\n"
            "3. On the picture “a.png” at blocks[9].before\nCrop it\n\n"
            "About all of it:\nThanks\n"
            "</hc>"))

    def test_a_single_quote_note_reads_the_same_from_blocks_or_notes(self):
        self.note(text="Say Monday", blocks=json.dumps({"blocks": [TEXT], "more": 0, "quote": QUOTE}))
        self.note(notes=json.dumps([{"text": "Say Monday", "spot": "", "blocks": [TEXT], "quote": QUOTE}]))
        self.assertEqual(self.sent[0], self.sent[1])
        self.assertIn("Selected: “ship on Friday”\nIn context:", self.sent[0][1])
        self.assertNotIn(" on=", self.sent[0][1])

    def test_a_single_picture_note_keeps_its_spot_in_on(self):
        self.note(text="Too dark", spot=PICTURE_SPOT, blocks=json.dumps({"blocks": [], "picture": PICTURE}, ensure_ascii=False))
        body = self.sent[0][1]
        self.assertIn(f'on="{PICTURE_SPOT}"', body)
        self.assertIn(f"On the picture “login.png” (1280×800) at blocks[4]: “Sign-in screen”\nSpot in it: {PICTURE['spot']}\nToo dark", body)

    def test_junk_quotes_and_pictures_are_dropped(self):
        self.note(notes=json.dumps([{"text": "a", "quote": {"text": " "}, "picture": {"file": 3}}, {"text": "b"}]))
        self.assertIn("1. On it:\na", self.sent[0][1])

    def test_another_machine_gets_a_single_notes_quote(self):
        calls = []

        def run(argv, **_):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, json.dumps({"to": "t3", "why": "made it", "version": 1, "image": None}) + "\n", "")
        o = types.SimpleNamespace(id=self.aid, text=None, version=1, spot=None, image=None, shot=None, panel=None, area=None, machine="vm",
                                  json=True, answer=None, value=None, by=None, notes=json.dumps([{"text": "x", "spot": "", "blocks": [TEXT], "quote": QUOTE}]), blocks=None)
        with mock.patch.object(A, "run", side_effect=run), mock.patch("sys.stdout", io.StringIO()):
            A.cmd_note(o)
        argv = calls[0]
        self.assertEqual(json.loads(argv[argv.index("--blocks") + 1]), {"blocks": [TEXT], "more": 0, "quote": QUOTE})

    def test_the_guide_explains_words_and_pictures(self):
        with open(A.GUIDE) as f:
            guide = f.read()
        self.assertIn("Selected: “", guide)
        self.assertIn("Spot in it:", guide)
