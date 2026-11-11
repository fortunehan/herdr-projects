"""The task view's Open in VS Code (SHEP-27): mods/chat/panel.js openInEditor() opens the task's folder (its worktree,
a --here task's list folder) with core/open-editor.js's command, and says why in a toast when it can't: another
machine's task (nothing runs), a removed worktree, no VS Code, sh not starting. The method runs as written in
panel.js, in node, with core/open-editor.js as is and exec and toast stubbed; the bar's button is checked in the source."""
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
MATCH = re.search(r"\n  openInEditor\(cx\) \{\n.*?\n  \}\n", SRC, re.S)
CORE = re.sub(r"^export ", "", open(os.path.join(ROOT, "core", "open-editor.js"), encoding="utf-8").read(), flags=re.M)

HARNESS = r"""
const input = %(input)s;
const editor = (() => { %(core)s; return { OPEN, TITLE, folderOf, cantOpen, command, problem }; })();
const calls = [], toasts = [];
const exec = async (cmd, args, opts) => { calls.push([cmd, ...args, opts ?? null]); if (input.result === null) throw new Error("ENOENT"); return input.result; };
const toast = (n) => toasts.push(n);
const obj = { %(method)s };
const pending = [];
const cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
const self = { rec: input.rec, opening: false };
obj.openInEditor.call(self, cx);
while (pending.length) await pending.shift();
console.log(JSON.stringify({ calls: calls.map((c) => [c[0], c[1], c[3], c[4]]), toasts, opening: self.opening }));
"""

WT = "/h/.local/share/shepherdr/worktrees/shop/task-3-x"
TASK = {"mode": "worktree", "worktree": WT, "folder": "/h/dev/shop", "machine": None, "state": "running"}
OK = {"code": 0, "stdout": "", "stderr": ""}


def run(rec, result=OK):
    script = HARNESS % {"method": MATCH.group(0).strip(), "core": CORE, "input": json.dumps({"rec": rec, "result": result})}
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
            raise unittest.SkipTest("panel.js openInEditor() not found or no node")

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

    def test_the_bar_has_the_button_dim_for_another_machine(self):
        bar = re.search(r"\n  barRow\(t, st, addr\) \{\n.*?\n  \}\n", SRC, re.S).group(0)
        self.assertIn('button("thread-vscode", "Open in VS Code"', bar)
        self.assertIn("this.openInEditor(cx)", bar)
        self.assertIn("Boolean(this.rec.machine), (b) => b.opacity(0.5)", bar)


if __name__ == "__main__":
    unittest.main()
