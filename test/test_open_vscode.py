"""The task view's Open in VS Code, iTerm2 and Finder (SHEP-27, SHEP-38): mods/chat/panel.js openIn() opens the
task's folder (its worktree, a --here task's list folder) with core/open-editor.js's command, and says why in a toast
when it can't: another machine's task (nothing runs), a removed worktree, the app missing, sh not starting. The method
runs as written in panel.js, in node, with core/open-editor.js as is and exec and toast stubbed; the bar's icons are
checked in the source."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PANEL = os.path.join(ROOT, "mods", "chat", "panel.js")
SRC = open(PANEL, encoding="utf-8").read()
MATCH = re.search(r"\n  openIn\(app, cx\) \{\n.*?\n  \}\n", SRC, re.S)
CORE = re.sub(r"^export ", "", open(os.path.join(ROOT, "core", "open-editor.js"), encoding="utf-8").read(), flags=re.M)

HARNESS = r"""
const input = %(input)s;
%(core)s
const calls = [], toasts = [];
const exec = async (cmd, args, opts) => { calls.push([cmd, ...args, opts ?? null]); if (input.result === null) throw new Error("ENOENT"); return input.result; };
const toast = (n) => toasts.push(n);
const obj = { %(method)s };
const pending = [];
const cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
const self = { rec: input.rec, opening: false };
obj.openIn.call(self, input.app, cx);
while (pending.length) await pending.shift();
console.log(JSON.stringify({ calls: calls.map((c) => [c[0], c[1], c[3], c[4]]), toasts, opening: self.opening }));
"""

WT = "/h/.local/share/shepherdr/worktrees/shop/task-3-x"
TASK = {"mode": "worktree", "worktree": WT, "folder": "/h/dev/shop", "machine": None, "state": "running"}
OK = {"code": 0, "stdout": "", "stderr": ""}


def run(rec, result=OK, app="vscode"):
    script = HARNESS % {"method": MATCH.group(0).strip(), "core": CORE, "input": json.dumps({"rec": rec, "result": result, "app": app})}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "open.mjs")
        with open(path, "w") as f:
            f.write(script)
        out = subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


class OpenInVSCode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if MATCH is None or shutil.which("node") is None:
            raise unittest.SkipTest("panel.js openIn() not found or no node")

    def test_a_worktree_task_opens_its_worktree_without_a_word(self):
        out = run(TASK)
        self.assertEqual(out["calls"], [["sh", "-c", "open-vscode", WT]])
        self.assertEqual(out["toasts"], [])
        self.assertFalse(out["opening"])

    def test_a_here_task_opens_its_folder(self):
        out = run({"mode": "here", "folder": "/h/dev/shop", "machine": None, "state": "running"})
        self.assertEqual(out["calls"], [["sh", "-c", "open-vscode", "/h/dev/shop"]])

    def test_another_machines_task_runs_nothing_and_says_where(self):
        out = run({**TASK, "machine": "vm-demo"})
        self.assertEqual(out["calls"], [])
        self.assertEqual(out["toasts"], [{"title": "Couldn't open VS Code",
                                          "body": "This task runs on vm-demo: VS Code opens only this machine's folders.", "level": "error"}])

    def test_a_done_tasks_removed_worktree_says_so(self):
        out = run({**TASK, "state": "done"}, {"code": 3, "stdout": "", "stderr": ""})
        self.assertEqual(out["toasts"][0]["body"], "Its folder is gone (a finished task's worktree is removed).")
        self.assertEqual(out["toasts"][0]["level"], "error")

    def test_no_vs_code_says_so(self):
        out = run(TASK, {"code": 4, "stdout": "", "stderr": ""})
        self.assertIn("VS Code isn't installed", out["toasts"][0]["body"])

    def test_sh_not_starting_says_so(self):
        out = run(TASK, None)
        self.assertEqual(out["toasts"][0]["body"], "sh couldn't start.")
        self.assertFalse(out["opening"])

    def test_no_worktree_yet_runs_nothing(self):
        out = run({**TASK, "worktree": None, "state": "todo"})
        self.assertEqual(out["calls"], [])
        self.assertIn("no worktree yet", out["toasts"][0]["body"])

    def test_iterm_opens_the_worktree(self):
        out = run(TASK, app="iterm")
        self.assertEqual(out["calls"], [["sh", "-c", "open-iterm", WT]])
        self.assertEqual(out["toasts"], [])

    def test_finder_opens_a_here_tasks_folder(self):
        out = run({"mode": "here", "folder": "/h/dev/shop", "machine": None, "state": "running"}, app="finder")
        self.assertEqual(out["calls"], [["sh", "-c", "open-finder", "/h/dev/shop"]])

    def test_no_iterm_says_so(self):
        out = run(TASK, {"code": 4, "stdout": "", "stderr": ""}, app="iterm")
        self.assertEqual(out["toasts"], [{"title": "Couldn't open iTerm2", "body": "iTerm2 isn't installed.", "level": "error"}])

    def test_a_done_tasks_removed_worktree_in_finder_says_so(self):
        out = run({**TASK, "state": "done"}, {"code": 3, "stdout": "", "stderr": ""}, app="finder")
        self.assertEqual(out["toasts"], [{"title": "Couldn't open Finder", "body": "Its folder is gone (a finished task's worktree is removed).", "level": "error"}])

    def test_another_machines_task_runs_nothing_in_iterm_or_finder(self):
        for app, name in (("iterm", "iTerm2"), ("finder", "Finder")):
            out = run({**TASK, "machine": "vm-demo"}, app=app)
            self.assertEqual(out["calls"], [])
            self.assertEqual(out["toasts"][0]["body"], f"This task runs on vm-demo: {name} opens only this machine's folders.")

    def test_the_bar_has_the_three_icons_dim_for_another_machine(self):
        bar = re.search(r"\n  barRow\(t, st, addr\) \{\n.*?\n  \}\n", SRC, re.S).group(0)
        self.assertIn("Object.keys(APPS).map((app) => this.openIcon(t, app))", bar)
        icon = re.search(r"\n  openIcon\(t, app\) \{\n.*?\n  \}\n", SRC, re.S).group(0)
        self.assertIn("accessibility_label(`Open in ${a.name}`)", icon)
        self.assertIn("this.openIn(app, cx)", icon)
        self.assertIn("busy || Boolean(this.rec.machine), (el) => el.opacity(0.5)", icon)
        self.assertNotIn(".tooltip(", icon)


if __name__ == "__main__":
    unittest.main()
