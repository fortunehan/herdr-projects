"""The task view's Open in VS Code, iTerm2, Finder and Xcode (SHEP-27, SHEP-38, SHEP-97): mods/chat/panel.js openIn()
opens the task's folder (its worktree, a --here task's list folder) with core/open-editor.js openFolder(), and says
which step failed and why in a toast: another machine's task (nothing runs), a removed worktree, the app missing. The method
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
const exec = async (cmd, args, opts) => {
  calls.push([cmd, ...args]);
  if (input.result === null) throw new Error("ENOENT");
  return input.result[cmd] ?? input.result.default ?? { code: 0, stdout: "", stderr: "" };
};
const toast = (n) => toasts.push(n);
const window = () => ({ platform: input.platform });
const obj = { %(method)s };
const pending = [];
const cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
const self = { rec: input.rec, opening: false };
obj.openIn.call(self, input.app, cx);
while (pending.length) await pending.shift();
console.log(JSON.stringify({ calls, toasts, opening: self.opening }));
"""

WT = "/h/.local/share/shepherdr/worktrees/shop/task-3-x"
TASK = {"mode": "worktree", "worktree": WT, "folder": "/h/dev/shop", "machine": None, "state": "running"}
OK = {}
FAIL = lambda cmd, code=1, stderr="": {cmd: {"code": code, "stdout": "", "stderr": stderr}}


def run(rec, result=OK, app="vscode", platform="macos"):
    script = HARNESS % {"method": MATCH.group(0).strip(), "core": CORE,
                        "input": json.dumps({"rec": rec, "result": result, "app": app, "platform": platform})}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "open.mjs")
        with open(path, "w") as f:
            f.write(script)
        out = subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def opened(bundle, folder=WT):
    return [["/bin/test", "-d", folder], ["/usr/bin/open", "-b", bundle, "--", folder]]


class OpenInVSCode(unittest.TestCase):
    """SHEP-97: the task view runs core/open-editor.js openFolder(), as a pane header's Open menu does."""

    @classmethod
    def setUpClass(cls):
        if MATCH is None or shutil.which("node") is None:
            raise unittest.SkipTest("panel.js openIn() not found or no node")

    def test_a_worktree_task_opens_its_worktree_without_a_word(self):
        out = run(TASK)
        self.assertEqual(out["calls"], opened("com.microsoft.VSCode"))
        self.assertEqual(out["toasts"], [])
        self.assertFalse(out["opening"])

    def test_a_here_task_opens_its_folder(self):
        out = run({"mode": "here", "folder": "/h/dev/shop", "machine": None, "state": "running"})
        self.assertEqual(out["calls"], opened("com.microsoft.VSCode", "/h/dev/shop"))

    def test_another_machines_task_runs_nothing_and_says_where(self):
        out = run({**TASK, "machine": "vm-demo"})
        self.assertEqual(out["calls"], [])
        self.assertEqual(out["toasts"], [{"title": "Couldn't open VS Code",
                                          "body": "This task runs on vm-demo: VS Code opens only this machine's folders.", "level": "error"}])

    def test_a_done_tasks_removed_worktree_says_so(self):
        out = run({**TASK, "state": "done"}, FAIL("/bin/test"))
        self.assertEqual(out["calls"], [["/bin/test", "-d", WT]])
        self.assertEqual(out["toasts"][0]["body"], f"Its folder is gone (a finished task's worktree is removed): {WT}")
        self.assertEqual(out["toasts"][0]["level"], "error")

    def test_no_vs_code_says_so_with_its_bundle_id(self):
        out = run(TASK, FAIL("/usr/bin/open", stderr="LSCopyApplicationURLsForBundleIdentifier() failed while trying to determine the application with bundle identifier com.microsoft.VSCode."))
        self.assertTrue(out["toasts"][0]["body"].startswith("VS Code isn't installed: macOS has no app with the bundle id com.microsoft.VSCode."))

    def test_exec_rejecting_says_which_step(self):
        out = run(TASK, None)
        self.assertEqual(out["toasts"][0]["body"], f"Checking the folder failed: /bin/test couldn't run: ENOENT (test -d {WT})")
        self.assertFalse(out["opening"])

    def test_a_failed_launch_shows_its_stderr_and_command(self):
        out = run(TASK, FAIL("/usr/bin/open", stderr="LSOpenURLsWithRole() failed with error -600"), app="iterm")
        self.assertEqual(out["toasts"], [{"title": "Couldn't open iTerm2", "level": "error",
                                          "body": f"Opening iTerm2 failed: LSOpenURLsWithRole() failed with error -600 (open -b com.googlecode.iterm2 -- {WT})"}])

    def test_off_macos_vs_code_uses_its_code_command(self):
        out = run(TASK, platform="linux")
        self.assertEqual(out["calls"], [["code", WT]])
        out = run(TASK, app="finder", platform="linux")
        self.assertEqual(out["calls"], [])
        self.assertEqual(out["toasts"][0]["body"], "Finder opens only on macOS.")

    def test_no_worktree_yet_runs_nothing(self):
        out = run({**TASK, "worktree": None, "state": "todo"})
        self.assertEqual(out["calls"], [])
        self.assertIn("no worktree yet", out["toasts"][0]["body"])

    def test_iterm_opens_the_worktree(self):
        out = run(TASK, app="iterm")
        self.assertEqual(out["calls"], opened("com.googlecode.iterm2"))
        self.assertEqual(out["toasts"], [])

    def test_finder_opens_a_here_tasks_folder(self):
        out = run({"mode": "here", "folder": "/h/dev/shop", "machine": None, "state": "running"}, app="finder")
        self.assertEqual(out["calls"], opened("com.apple.finder", "/h/dev/shop"))

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

    def test_xcode_opens_the_worktree(self):
        out = run(TASK, app="xcode")
        self.assertEqual(out["calls"], opened("com.apple.dt.Xcode"))
        self.assertEqual(out["toasts"], [])


COPY = re.search(r"\n  copy\(what, addr, cx\) \{\n.*?\n  \}\n", SRC, re.S)

COPY_HARNESS = r"""
const input = %(input)s;
%(core)s
const toasts = [], clip = [];
const toast = (n) => toasts.push(n);
const plainError = (e) => e.message;
const obj = { %(method)s };
const cx = { write_to_clipboard(s) { if (input.broken) throw new Error("no clipboard"); clip.push(s); } };
obj.copy.call({ rec: input.rec }, input.what, input.addr, cx);
console.log(JSON.stringify({ clip, toasts }));
"""


def copy(what, rec=TASK, addr="vm-demo/w3", broken=False):
    script = COPY_HARNESS % {"method": COPY.group(0).strip(), "core": CORE,
                             "input": json.dumps({"rec": rec, "what": what, "addr": addr, "broken": broken})}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "copy.mjs")
        with open(path, "w") as f:
            f.write(script)
        out = subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


class CopyFromTheTaskBar(unittest.TestCase):
    """SHEP-91: the task bar's Copy path and Copy panel ID, as an Assistant's pane header has them (mods/pane-chat)."""

    @classmethod
    def setUpClass(cls):
        if COPY is None or shutil.which("node") is None:
            raise unittest.SkipTest("panel.js copy() not found or no node")

    def test_copy_path_puts_the_worktree_on_the_clipboard(self):
        out = copy("path")
        self.assertEqual(out["clip"], [WT])
        self.assertEqual(out["toasts"], [{"title": "Full path copied", "level": "success", "timeout": 1600}])

    def test_copy_panel_id_puts_the_workers_address_on_the_clipboard(self):
        out = copy("id")
        self.assertEqual(out["clip"], ["vm-demo/w3"])
        self.assertEqual(out["toasts"][0]["title"], "Panel ID copied")

    def test_no_worker_copies_nothing_and_says_why(self):
        out = copy("id", addr=None)
        self.assertEqual(out["clip"], [])
        self.assertEqual(out["toasts"], [{"title": "Couldn't copy", "body": "No live terminal is available for this task.", "level": "warning"}])

    def test_a_clipboard_failure_says_so(self):
        out = copy("path", broken=True)
        self.assertEqual(out["toasts"], [{"title": "Couldn't copy", "body": "no clipboard", "level": "error"}])

    def test_the_bar_puts_the_copy_icons_before_the_open_icons(self):
        bar = re.search(r"\n  barRow\(t, st, addr\) \{\n.*?\n  \}\n", SRC, re.S).group(0)
        copies = bar.index("Object.keys(COPIES).map((what) => this.copyIcon(t, what, addr))")
        self.assertLess(copies, bar.index("Object.keys(APPS).map((app) => this.openIcon(t, app))"))
        icon = re.search(r"\n  copyIcon\(t, what, addr\) \{\n.*?\n  \}\n", SRC, re.S).group(0)
        self.assertIn("accessibility_label(c.name)", icon)
        self.assertIn('what === "id" && !addr, (el) => el.opacity(0.5)', icon)
        self.assertNotIn(".tooltip(", icon)


if __name__ == "__main__":
    unittest.main()
