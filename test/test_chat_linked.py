"""The window chat's linked() (mods/chat/main.js) can never blank the chat again (SHEP-108): a render past the window's
~50 ms limit draws nothing, so each reply is linked once and kept, a frame spends at most LINK_MS linking (the rest
show plain and get their links on a redraw it schedules), and a reply linkify throws on shows as written.
The method is run as written in main.js, in node, with core/chat-links.js's linkify stubbed."""
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
MATCH = re.search(r"\n  linked\(text\) \{\n.*?\n  \}\n", SRC, re.S)
LIMIT = re.search(r"\nconst LINK_MS = (\d+);", SRC)

HARNESS = r"""
const LINK_MS = %(limit)s;
const home = () => "/Users/me";
let calls = 0, clock = 0;
const realNow = Date.now;
Date.now = () => clock;
const links = { linkify: (t) => { calls++; if (t.includes("BAD")) throw new Error("boom"); clock += t.includes("SLOW") ? 20 : 1; return "L:" + t; } };
const obj = { %(method)s };
const timers = [];
const self = { machine: null, linkSpent: 0, linkCx: { timer: { after: (ms, fn) => timers.push(fn) } }, linked: obj.linked };
const out = {};
out.bad = self.linked("a BAD reply");
out.first = self.linked("SLOW one");
out.second = self.linked("two");
out.timers = timers.length;
out.secondAgain = self.linked("two");
// the next frame: the kept one is not linked again, the waiting one is
self.linkSpent = 0;
const before = calls;
out.firstKept = self.linked("SLOW one");
out.keptCalls = calls - before;
out.secondNext = self.linked("two");
Date.now = realNow;
console.log(JSON.stringify(out));
"""


def run():
    script = HARNESS % {"method": MATCH.group(0).strip(), "limit": LIMIT.group(1)}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "linked.mjs")
        with open(path, "w") as f:
            f.write(script)
        return json.loads(subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout)


class LinkedNeverBlanksTheChat(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if MATCH is None or LIMIT is None or shutil.which("node") is None:
            raise unittest.SkipTest("main.js linked() or LINK_MS not found, or no node")
        cls.out = run()

    def test_a_reply_linkify_throws_on_shows_as_written(self):
        self.assertEqual(self.out["bad"], "a BAD reply")

    def test_past_the_frame_budget_replies_show_plain_and_a_redraw_is_asked(self):
        self.assertEqual(self.out["first"], "L:SLOW one")
        self.assertEqual(self.out["second"], "two")
        self.assertEqual(self.out["secondAgain"], "two")
        self.assertEqual(self.out["timers"], 1)

    def test_a_linked_reply_is_kept_and_the_waiting_one_links_next_frame(self):
        self.assertEqual(self.out["firstKept"], "L:SLOW one")
        self.assertEqual(self.out["keptCalls"], 0)
        self.assertEqual(self.out["secondNext"], "L:two")


if __name__ == "__main__":
    unittest.main()
