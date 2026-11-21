"""SHEP-105: a pick from the window chat's "/", "#" or "@" list (mods/chat/main.js pick() and enter()) leaves the caret
right after what it put in, never at the start of the box. The methods run as written in main.js, in node, over a
stub box that, like the real TextareaState, puts the caret at 0 on set_value; the timers run at once."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = open(os.path.join(ROOT, "mods", "chat", "main.js"), encoding="utf-8").read()


def method(head):
    m = re.search(r"\n  " + re.escape(head) + r" \{\n.*?\n  \}\n", SRC, re.S)
    return m.group(0).strip() if m else None


METHODS = {k: method(h) for k, h in {"pick": "pick(c, cx)", "put": "put(text)", "enter": "enter(cx, hold)"}.items()}
MENTIONS = re.sub(r"^import .*$", "", re.sub(r"^export ", "", open(os.path.join(ROOT, "core", "mentions.js"), encoding="utf-8").read(), flags=re.M), flags=re.M)

HARNESS = r"""
const SH = "";
%(mentions)s
const mentions = { pickInto, pickTaskInto };
const taskRef = (t) => t.id;
const input = %(input)s;
const obj = { %(methods)s };
const box = { v: input.text, sel: { start: input.text.length, end: input.text.length },
  value() { return this.v; },
  set_value(v) { this.v = v; this.sel = { start: 0, end: 0 }; },
  set_selected_range(r) { this.sel = { ...r }; },
  focus() {} };
const timers = [];
const cx = { notify() {}, timer: { after: (ms, fn) => timers.push(fn) } };
const self = Object.assign(Object.create(obj), { box, picked: [], pickedTasks: [], slashSel: 0, t: { cwd: "/here" },
  suggestions: () => [input.pick], send() { throw new Error("sent"); } });
if (input.via === "enter") {
  self.enter(cx, false);
  // the textarea's own Enter puts its new line in after the pick (why enter() sets the text again)
  box.v += "\n"; box.sel = { start: box.v.length, end: box.v.length };
} else self.pick(input.pick, cx);
for (const fn of timers) fn();
console.log(JSON.stringify({ text: box.v, sel: box.sel }));
"""


def run(text, pick, via="pick"):
    body = ",\n".join(v for v in METHODS.values() if v)
    script = HARNESS % {"mentions": MENTIONS, "methods": body, "input": json.dumps({"text": text, "pick": pick, "via": via})}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "pick.mjs")
        with open(path, "w") as f:
            f.write(script)
        out = subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


SKILL = {"name": "review-pr", "about": "Review a PR"}
SPACE = {"space": {"name": "shop", "target": "vm/sp1"}, "name": "#shop"}
TASK = {"task": {"id": "SHEP-7", "folder": "/here"}, "name": "@SHEP-7"}


class PickLeavesTheCaretAfterIt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (METHODS["pick"] and METHODS["enter"]) or shutil.which("node") is None:
            raise unittest.SkipTest("main.js pick()/put()/enter() not found or no node")

    def check(self, out, text):
        self.assertEqual(out["text"], text)
        self.assertEqual(out["sel"], {"start": len(text), "end": len(text)})

    def test_a_skill_picked_by_tab_or_click(self):
        self.check(run("/rev", SKILL), "/review-pr ")

    def test_a_skill_picked_by_enter(self):
        self.check(run("/rev", SKILL, via="enter"), "/review-pr ")

    def test_a_space_after_other_words(self):
        # mid-text: the words before the "#…" stay as they are, the caret goes right after "#shop "
        self.check(run("ask about it #sh", SPACE), "ask about it #shop ")

    def test_a_space_picked_by_enter(self):
        self.check(run("ask about it #sh", SPACE, via="enter"), "ask about it #shop ")

    def test_a_task_after_other_words(self):
        self.check(run("see @SHE", TASK), "see @SHEP-7 ")

    def test_a_task_picked_by_enter_in_a_longer_message(self):
        self.check(run("line one\nsee @SHE", TASK, via="enter"), "line one\nsee @SHEP-7 ")

    def test_a_caret_counts_utf16_like_the_box(self):
        self.check(run("看看 #sh", SPACE), "看看 #shop ")


if __name__ == "__main__":
    unittest.main()
