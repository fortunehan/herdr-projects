"""The window chat's refocus() (mods/chat/main.js) never takes the keyboard from a text selection (SHEP-192, GitHub #916):
a drag over the messages selects them, and the message box taking focus a moment later made Ctrl+C copy nothing.
The method is run as it is written in main.js, in node, with the window's helpers stubbed: the box's focus is
recorded, the timers run at once."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN = os.path.join(ROOT, "mods", "chat", "main.js")

# The method as written: from `  refocus(` to the line before `  render(cx) {`.
SRC = open(MAIN, encoding="utf-8").read()
MATCH = re.search(r"\n  refocus\(paneFocused, showsBox, cx\) \{\n.*?\n  \}\n", SRC, re.S)
FIELD = re.search(r"\n  fieldHolds\(\) \{\n.*?\n  \}\n", SRC, re.S)
# The decision itself (core/chat-focus.js boxRefocus(), SHEP-23), as plain JS.
FOCUS = re.sub(r"^export ", "", open(os.path.join(ROOT, "core", "chat-focus.js"), encoding="utf-8").read(), flags=re.M)

HARNESS = r"""
const input = %(input)s;
const sharedData = input.shared ?? {};
const shared = (k) => sharedData[k] ?? null, dialogHolds = () => false, keysElsewhere = (h, mine) => Boolean(h?.who && h.who !== mine), liveHolder = (h) => h;
const keysOver = (h, mine) => Boolean(h?.who && h.who !== mine && h.over), holdKeys = () => {};
const KEY_HOLDER = "keyboard.holder";
%(focus)s
const obj = { %(method)s, %(field)s };
const focusCalls = [];
const timers = [];
const self = Object.assign({ box: { focus: () => focusCalls.push(1) }, wasFocused: false, hadBox: false,
  focused: false, call: null, press: null, refocusAt: 0, areaKey: () => "pane", fieldHolds: obj.fieldHolds }, input.self);
if (input.field) self.field = { state: {}, shown: () => input.field === "shown" };
const cx = { timer: { after: (ms, fn) => timers.push([ms, fn]) } };
obj.refocus.call(self, input.paneFocused, input.showsBox, cx);
for (const [, fn] of timers) fn();
console.log(JSON.stringify({ focus: focusCalls.length }));
"""


def run(self_state, paneFocused=True, showsBox=True, shared=None, field=None):
    method = MATCH.group(0).strip()
    inp = {"self": self_state, "paneFocused": paneFocused, "showsBox": showsBox, "shared": shared or {}, "field": field}
    script = HARNESS % {"method": method, "field": FIELD.group(0).strip(), "focus": FOCUS, "input": json.dumps(inp)}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "refocus.mjs")
        with open(path, "w") as f:
            f.write(script)
        out = subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)["focus"]


class RefocusKeepsSelection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if MATCH is None or FIELD is None or shutil.which("node") is None:
            raise unittest.SkipTest("main.js refocus() not found or no node")

    def test_pane_focused_by_a_click_takes_the_box_when_nothing_is_dragged(self):
        # Opening or clicking the pane puts the keyboard in the box (the behaviour kept).
        self.assertEqual(run({"pressMoved": False, "press": {"at": 0}}), 2)

    def test_a_drag_that_selects_text_keeps_the_keyboard_off_the_box(self):
        # The repro: the pane gets focus from the press of a drag; the box's timers (0 and 600 ms) must not steal it.
        self.assertEqual(run({"pressMoved": True, "press": {"at": 0}}), 0)

    def test_a_selection_is_not_taken_by_a_later_render_either(self):
        # Pane focused, box blurred, press more than 1.5 s old: the other branch refocuses; not over a selection.
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressMoved": True, "press": {"at": 0}}
        self.assertEqual(run(state), 0)

    def test_without_a_selection_that_later_render_refocuses_the_box(self):
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressMoved": False, "press": {"at": 0}}
        self.assertEqual(run(state), 1)

    def test_a_field_in_an_overlay_keeps_the_keyboard(self):
        # SHEP-9: Mark up's note in the artifact viewer holds it "over" the panes; the pane getting focus under it takes nothing.
        over = {"keyboard.holder": {"who": "artifact.markup", "at": 1, "over": True}}
        self.assertEqual(run({"pressMoved": False, "press": {"at": 0}}, shared=over), 0)

    def test_a_card_field_with_the_keyboard_keeps_it_on_a_later_render(self):
        # SHEP-23: typing in a question card's Other... (or find, a secret's box) 1.5 s after the click: the box is
        # blurred, the press old, the chat its own holder; the box took the keyboard mid-typing.
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressMoved": False, "press": {"at": 0}}
        self.assertEqual(run(state, field="shown"), 0)

    def test_a_card_field_keeps_it_when_the_pane_gets_focus_too(self):
        # A click on Other... in a chat pane that wasn't focused: the pane's 0 and 600 ms timers leave the field alone.
        self.assertEqual(run({"pressMoved": False, "press": {"at": 0}}, field="shown"), 0)

    def test_a_field_taken_off_screen_no_longer_holds_the_keyboard(self):
        # The card answered or gone (no blur comes): the box gets the keyboard back as before.
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressMoved": False, "press": {"at": 0}}
        self.assertEqual(run(state, field="gone"), 1)

    def test_cmd_shift_l_takes_the_box_over_a_selection(self):
        # SHEP-15: the chat Cmd+Shift+L names gets its box focused, a selection or not.
        import time
        req = {"chat.composereq": {"to": "pane", "at": int(time.time() * 1000)}}
        state = {"wasFocused": True, "hadBox": True, "focused": True, "pressMoved": True, "press": {"at": 0}}
        self.assertEqual(run(state, shared=req), 2)

    def test_cmd_shift_l_takes_the_box_from_a_card_field(self):
        import time
        req = {"chat.composereq": {"to": "pane", "at": int(time.time() * 1000)}}
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressMoved": False, "press": {"at": 0}}
        self.assertEqual(run(state, shared=req, field="shown"), 2)


class ChatTracksDrags(unittest.TestCase):
    def test_the_chat_root_notes_a_drag_and_its_release(self):
        self.assertIn("on_mouse_up(\"left\", () => { this.pressing = false; })", SRC)
        self.assertRegex(SRC, r"on_mouse_move\(\(e\) => \{ if \(e\.bounds\) this\.noteArea\(e\.bounds\); this\.noteDrag\(e\.position\); \}\)")
        self.assertIn("this.pressing = true; this.pressMoved = false;", SRC)


if __name__ == "__main__":
    unittest.main()
