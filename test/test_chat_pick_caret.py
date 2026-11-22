"""SHEP-105: a pick from the window chat's "/", "#" or "@" list (mods/chat/main.js) leaves the caret right after what it
put in and its space, never at the start of the box, and keeps any text after the caret as it is. suggestions(),
pick(), enter() and their helpers run as written in main.js, in node, over a stub box that, like the real
TextareaState, puts the caret at 0 on set_value; the timers run at once. A "|" in a test's text is the caret."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "mods", "chat", "main.js"), encoding="utf-8") as _f:
    SRC = _f.read()


def method(head):
    m = re.search(r"\n  " + re.escape(head) + r" \{\n.*?\n  \}\n", SRC, re.S)
    return m.group(0).strip() if m else None


HEADS = {"suggestions": "suggestions()", "caretText": "caretText()", "pick": "pick(c, cx)", "put": "put(text, caret = text.length)",
         "dropEnterLine": "dropEnterLine({ text, caret })", "enter": "enter(cx, hold)"}
METHODS = {k: method(h) for k, h in HEADS.items()}


def core(name):
    with open(os.path.join(ROOT, "core", name), encoding="utf-8") as f:
        s = re.sub(r"^export ", "", f.read(), flags=re.M)
    return re.sub(r'^import \{ SH \} from "\./paths\.js";$', 'const SH = "";', s, flags=re.M)


HARNESS = r"""
%(mentions)s
const mentions = { typing, match, typingTask, matchTasks, pickInto, pickTaskInto };
%(slash)s
const slash = { typing: slashTyping, match: slashMatch, atCaret, joinAtCaret };
const SECTION_DOT = {};
const taskRef = (t) => t.id;
const input = %(input)s;
const obj = { %(methods)s };
const at0 = input.text.indexOf("|");
const box = { v: input.text.replace("|", ""), sel: { start: at0, end: at0 },
  value() { return this.v; },
  set_value(v) { this.v = v; this.sel = { start: 0, end: 0 }; },
  selected_range() { return { ...this.sel }; },
  set_selected_range(r) { this.sel = { ...r }; },
  focus() {} };
// typing at the caret, as the textarea does
const type = (s) => { const at = box.sel.end; box.v = box.v.slice(0, at) + s + box.v.slice(at); box.sel = { start: at + s.length, end: at + s.length }; };
const timers = [];
const cx = { notify() {}, timer: { after: (ms, fn) => timers.push(fn) } };
let sent = null;
const self = Object.assign(Object.create(obj), { box, picked: [], pickedTasks: [], slashSel: 0, slashOff: null, t: { cwd: "/here" },
  cmds: [{ name: "review-pr", about: "Review a PR" }],
  reach: { spaces: [{ id: "sp1", name: "shop", machine: "vm", route: "vm", target: "vm/sp1" }] },
  mentionableTasks: () => [{ id: "SHEP-7", title: "Fix it", folder: "/here", state: "working" }],
  send() { sent = box.v; } });
const list = self.suggestions().map((c) => c.name);
if (input.via === "enter") {
  if (input.lineFirst) type("\n");
  self.enter(cx, false);
  if (!input.lineFirst) type("\n");
  if (input.typed) type(input.typed);
} else if (list.length) self.pick(self.suggestions()[0], cx);
for (const fn of timers) fn();
console.log(JSON.stringify({ list, sent, text: box.v.slice(0, box.sel.start) + "|" + box.v.slice(box.sel.start), collapsed: box.sel.start === box.sel.end }));
"""


def run(text, via="pick", typed="", lineFirst=False):
    body = ",\n".join(v for v in METHODS.values() if v)
    slash = core("slash.js").replace("function typing(", "function slashTyping(").replace("function match(", "function slashMatch(")
    inp = {"text": text, "via": via, "typed": typed, "lineFirst": lineFirst}
    script = HARNESS % {"mentions": core("mentions.js"), "slash": slash, "methods": body, "input": json.dumps(inp)}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "pick.mjs")
        with open(path, "w") as f:
            f.write(script)
        out = subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


class PickLeavesTheCaretAfterIt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (METHODS["pick"] and METHODS["enter"] and METHODS["suggestions"]) or shutil.which("node") is None:
            raise unittest.SkipTest("main.js pick()/enter()/suggestions() not found or no node")

    def check(self, out, text):
        self.assertEqual(out["text"], text)
        self.assertTrue(out["collapsed"])

    def test_a_skill_picked_by_tab_or_click(self):
        self.check(run("/rev|"), "/review-pr |")

    def test_a_skill_picked_by_enter(self):
        self.check(run("/rev|", via="enter"), "/review-pr |")

    def test_a_skill_picked_by_enter_whose_line_came_first(self):
        self.check(run("/rev|", via="enter", lineFirst=True), "/review-pr |")

    def test_a_letter_typed_right_after_enter_is_kept(self):
        # Enter's 30 ms fix-up used to set the whole text again, dropping it
        self.check(run("/rev|", via="enter", typed="a"), "/review-pr a|")

    def test_a_space_after_other_words(self):
        self.check(run("ask about it #sh|"), "ask about it #shop |")

    def test_a_space_picked_by_enter(self):
        self.check(run("ask about it #sh|", via="enter"), "ask about it #shop |")

    def test_a_task_picked_by_enter_in_a_longer_message(self):
        self.check(run("line one\nsee @SHE|", via="enter"), "line one\nsee @SHEP-7 |")

    def test_a_skill_typed_before_the_rest_of_the_message(self):
        # mid-text: the words after the caret stay as they are; no second space
        self.check(run("/rev| fix the login bug"), "/review-pr |fix the login bug")

    def test_a_skill_by_enter_before_the_rest(self):
        self.check(run("/rev| fix the login bug", via="enter"), "/review-pr |fix the login bug")

    def test_a_space_mid_text(self):
        self.check(run("ask #sh| about the release\nthanks"), "ask #shop |about the release\nthanks")

    def test_a_task_mid_text_by_enter_whose_line_came_first(self):
        self.check(run("see @SHE| and its PR", via="enter", lineFirst=True), "see @SHEP-7 |and its PR")

    def test_a_task_before_a_new_line(self):
        self.check(run("see @SHE|\nsecond line"), "see @SHEP-7 |\nsecond line")

    def test_no_list_with_the_caret_inside_a_word(self):
        self.assertEqual(run("/rev|iew")["list"], [])

    def test_enter_on_a_whole_command_sends_it(self):
        self.assertEqual(run("/review-pr|", via="enter")["sent"], "/review-pr")

    def test_a_caret_counts_utf16_like_the_box(self):
        self.check(run("看看 #sh| 好吗"), "看看 #shop |好吗")


if __name__ == "__main__":
    unittest.main()
