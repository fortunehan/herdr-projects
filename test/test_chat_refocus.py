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

HARNESS = r"""
const input = %(input)s;
const sharedData = input.shared ?? {};
const shared = (k) => sharedData[k] ?? null, dialogHolds = () => false, keysElsewhere = (h, mine) => Boolean(h?.who && h.who !== mine), liveHolder = (h) => h;
const keysOver = (h, mine) => Boolean(h?.who && h.who !== mine && h.over), holdKeys = () => {};
const KEY_HOLDER = "keyboard.holder";
const obj = { %(method)s };
const focusCalls = [];
const timers = [];
const self = Object.assign({ box: { focus: () => focusCalls.push(1) }, wasFocused: false, hadBox: false,
  focused: false, call: null, press: null, refocusAt: 0, areaKey: () => "pane" }, input.self);
// "now": a press that just started
if (self.press?.at === "now") self.press.at = Date.now();
const cx = { timer: { after: (ms, fn) => timers.push([ms, fn]) } };
obj.refocus.call(self, input.paneFocused, input.showsBox, cx);
// a press that starts after the timers were set, before they fire
if (input.pressAfter) { self.pressing = true; self.press = { at: Date.now() }; }
// the person goes to another pane, or the keyboard to the Tasks search, before the timers fire
if (input.leaveAfter) self.paneFocusedNow = false;
if (input.holderAfter) sharedData["keyboard.holder"] = input.holderAfter;
for (const [, fn] of timers) fn();
console.log(JSON.stringify({ focus: focusCalls.length, entryPending: Boolean(self.entryPending) }));
"""


def run(self_state, paneFocused=True, showsBox=True, shared=None, pressAfter=False, full=False, leaveAfter=False, holderAfter=None):
    method = MATCH.group(0).strip()
    inp = {"self": self_state, "paneFocused": paneFocused, "showsBox": showsBox, "shared": shared or {}, "pressAfter": pressAfter,
           "leaveAfter": leaveAfter, "holderAfter": holderAfter}
    script = HARNESS % {"method": method, "input": json.dumps(inp)}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "refocus.mjs")
        with open(path, "w") as f:
            f.write(script)
        out = subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout
    got = json.loads(out)
    return got if full else got["focus"]


class RefocusKeepsSelection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if MATCH is None or shutil.which("node") is None:
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

    def test_a_press_still_held_keeps_the_keyboard_off_the_box(self):
        # SHEP-14: the press that focuses the pane may become a drag: neither path takes the keyboard while it is held.
        got = run({"pressing": True, "pressMoved": False, "press": {"at": "now"}}, full=True)
        self.assertEqual(got, {"focus": 0, "entryPending": True})
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressing": True, "pressMoved": False, "press": {"at": "now"}}
        self.assertEqual(run(state), 0)

    def test_a_plain_click_held_past_the_timers_gets_the_box_on_release(self):
        # the entry request stays pending through the press; the release redraws and it is taken then
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressing": False, "pressMoved": False,
                 "entryPending": True, "press": {"at": "now"}}
        self.assertEqual(run(state, full=True), {"focus": 2, "entryPending": False})
        # a drag instead: nothing taken, and nothing left pending
        self.assertEqual(run({**state, "pressMoved": True}, full=True), {"focus": 0, "entryPending": False})

    def test_a_press_starting_after_the_timers_were_set_keeps_the_keyboard(self):
        # and the entry request waits for its release
        self.assertEqual(run({"pressMoved": False, "press": {"at": 0}}, pressAfter=True, full=True), {"focus": 0, "entryPending": True})
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressMoved": False, "press": {"at": 0}}
        self.assertEqual(run(state, pressAfter=True), 0)

    def test_leaving_the_pane_ends_a_held_press_and_the_entry_request(self):
        # a release outside the chat never reaches it; leaving the pane (or the next press) ends the hold
        got = run({"pressing": True, "pressMoved": False, "entryPending": True, "press": {"at": "now"}}, paneFocused=False, full=True)
        self.assertEqual(got, {"focus": 0, "entryPending": False})

    def test_a_request_is_dropped_when_the_person_moves_on_before_it_fires(self):
        self.assertEqual(run({"pressMoved": False, "press": {"at": 0}}, leaveAfter=True), 0)
        search = {"who": "tasks", "at": 1}
        self.assertEqual(run({"pressMoved": False, "press": {"at": 0}}, holderAfter=search), 0)
        state = {"wasFocused": True, "hadBox": True, "focused": False, "pressMoved": False, "press": {"at": 0}}
        self.assertEqual(run(state, leaveAfter=True), 0)
        self.assertEqual(run(state, holderAfter=search), 0)
        # the keyboard already elsewhere when the pane gets focus: no request kept
        self.assertEqual(run({"pressMoved": False, "press": {"at": 0}}, shared={"keyboard.holder": search}, full=True),
                         {"focus": 0, "entryPending": False})

    def test_a_field_in_an_overlay_keeps_the_keyboard(self):
        # SHEP-9: Mark up's note in the artifact viewer holds it "over" the panes; the pane getting focus under it takes nothing.
        over = {"keyboard.holder": {"who": "artifact.markup", "at": 1, "over": True}}
        self.assertEqual(run({"pressMoved": False, "press": {"at": 0}}, shared=over), 0)

    def test_leaving_the_pane_lets_an_old_selection_go(self):
        # SHEP-14: a selection made a while ago no longer keeps the keyboard once the person went to another pane.
        state = {"pressMoved": True, "pressing": False, "press": {"at": 0}}
        run(state, paneFocused=False)
        self.assertEqual(run({**state, "pressMoved": False}), 2)

    def test_cmd_shift_l_takes_the_box_over_a_selection(self):
        # SHEP-15: the chat Cmd+Shift+L names gets its box focused, a selection or not.
        import time
        req = {"chat.composereq": {"to": "pane", "at": int(time.time() * 1000)}}
        state = {"wasFocused": True, "hadBox": True, "focused": True, "pressMoved": True, "press": {"at": 0}}
        self.assertEqual(run(state, shared=req), 2)


class ChatTracksDrags(unittest.TestCase):
    def test_the_chat_root_notes_a_drag_and_its_release(self):
        self.assertIn("on_mouse_up(\"left\", (_e, cx) => { this.pressing = false; cx.notify(); })", SRC)
        self.assertIn("on_mouse_down_out(() => { this.pressing = false; })", SRC)
        self.assertRegex(SRC, r"on_mouse_move\(\(e\) => \{ if \(e\.bounds\) this\.noteArea\(e\.bounds\); this\.noteDrag\(e\.position\); \}\)")
        # a double or triple click selects too (SHEP-14)
        self.assertIn("this.pressing = true; this.pressMoved = (e.click_count ?? 1) >= 2;", SRC)


if __name__ == "__main__":
    unittest.main()
