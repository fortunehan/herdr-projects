"""A task's Shell (SHEP-25): mods/task-shell starts one shell per task the first time its Shell view shows, finds it
again after switching away, starts a new one only once the person exited it and the view shows again, never for a
Done task; herdr-task (herdr_task/shells.py) ends it when its task is Done or its worktree goes.
The mod runs as written in node, its window helpers stubbed (the layout file in memory, hc recorded); herdr-task's
part in-process with hc stubbed."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "mods", "tasks", "bin")
MAIN = os.path.join(ROOT, "mods", "task-shell", "main.js")
LAYOUT = os.path.join(ROOT, "layouts", "shepherdr.json")

# main.js without its imports and exports: the harness gives what it imports.
SRC = re.sub(r"^import .*$", "", open(MAIN, encoding="utf-8").read(), flags=re.M)
SRC = re.sub(r"^export (default )?", "", SRC, flags=re.M)

HARNESS = r"""
const input = %(input)s;
const SHELL = "tasks-thread-shell";
let file = JSON.stringify(input.layout);
const calls = [], focus = [];
const st = { shown: true, where: input.where, thread: { terminal: "t1" }, terms: input.terms ?? [], folderThere: input.folderThere ?? true };
let n = 0;
const View = class {}, div = () => el(), v_flex = () => el(), button = (id) => ({ button: id });
function el() { const e = {}; for (const m of ["id", "size_full", "min_h", "items_center", "justify_center", "px", "gap", "bg", "text_size", "text_color", "text_center", "max_w"]) e[m] = () => e;
  e.child = () => e; e.when = (c, f) => (c ? f(e) : e); return e; }
const theme = () => ({}), appHome = () => "/app", shared = (k) => (k === "layout" ? "shepherdr" : k === "tasks.thread" ? st.thread : null);
const layout = () => JSON.parse(file), readTextFile = async () => file;
const writeTextFile = async (_p, text) => { file = text; };
const shown = () => st.shown, where = () => st.where, terminals = () => st.terms;
const run = (cmd, a) => { if (cmd === "pane.focus") focus.push(a.terminal); };
const exec = async (cmd, args, opts) => { calls.push(["exec", cmd, ...args, opts?.on ?? null]); return { code: st.folderThere ? 0 : 1, stdout: "", stderr: "" }; };
const hc = async (args) => {
  calls.push(["hc", ...args]);
  if (args[0] === "run") {
    const addr = `t${90 + n++}`, labels = {};
    for (let i = 0; i < args.length; i++) if (args[i] === "--label") { const [k, v] = args[i + 1].split("="); labels[k] = v; }
    const on = args.includes("--on") ? args[args.indexOf("--on") + 1] : null;
    st.terms.push({ address: on ? `${on}/${addr}` : addr, state: "live", labels });
    return { code: 0, stdout: JSON.stringify({ address: addr }), stderr: "" };
  }
  return { code: 0, stdout: "{}", stderr: "" };
};
%(src)s
const pending = [];
const cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); }, timer: { every() {}, after(_ms, fn) { fn(cx); } } };
const v = Object.create(TaskShell.prototype);
v.init({}, cx);
const settle = async () => { while (pending.length) await pending.shift(); };
const out = [];
for (const step of input.steps) {
  if (step.shown !== undefined) st.shown = step.shown;
  if (step.where !== undefined) st.where = step.where;
  if (step.exit) st.terms = st.terms.filter((k) => k.address !== step.exit);
  if (step.button) { v.start(target(st.where, st.thread), cx); await settle(); }
  else { v.tick(cx); await settle(); }
  out.push({ state: v.state, why: v.why, addr: v.addr, view: find(layout(), "tasks-thread-shell-view")?.content?.terminal ?? null,
    hostHidden: Boolean(find(layout(), "tasks-thread-shell-host")?.hidden) });
}
console.log(JSON.stringify({ out, calls, focus, terms: st.terms }));
"""

TASK = {"terminal": "t1", "ref": "SHEP-25", "folder": "/work/wt-25", "machine": None, "key": "shepherdr#25", "state": "running"}


def run_mod(steps, where=TASK, terms=None, folder_there=True, view=None):
    with open(LAYOUT) as f:
        tree = json.load(f)
    if view:  # left pointed at from before (a reload of the mod)
        col = find(tree, "tasks-thread-shell")
        col["children"][0]["hidden"] = True
        col["children"].append({"id": "tasks-thread-shell-view", "type": "block", "content": {"terminal": view}})
    inp = {"layout": tree, "where": where, "terms": terms or [], "steps": steps, "folderThere": folder_there}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "shell.mjs")
        with open(path, "w") as f:
            f.write(HARNESS % {"src": SRC, "input": json.dumps(inp)})
        p = subprocess.run(["node", path], capture_output=True, text=True)
    if p.returncode != 0:
        raise AssertionError(p.stderr)
    return json.loads(p.stdout)


def find(n, i):
    if isinstance(n, dict):
        if n.get("id") == i:
            return n
        for c in n.get("children") or []:
            hit = find(c, i)
            if hit:
                return hit
    return None


def runs(calls):
    return [c for c in calls if c[:2] == ["hc", "run"]]


@unittest.skipIf(shutil.which("node") is None, "no node")
class ShellView(unittest.TestCase):
    def test_no_shell_until_the_view_shows(self):
        r = run_mod([{"shown": False}, {"shown": False}])
        self.assertEqual(runs(r["calls"]), [])
        self.assertIsNone(r["out"][-1]["view"])

    def test_first_show_starts_one_in_the_worktree_and_shows_it(self):
        r = run_mod([{}])
        (call,) = runs(r["calls"])
        self.assertEqual(call[call.index("--cwd") + 1], "/work/wt-25")
        self.assertIn("--no-parent", call)
        labels = [call[i + 1] for i, a in enumerate(call) if a == "--label"]
        self.assertEqual(labels, ["herdr.task-shell=shepherdr#25", "herdr.shell=task"])
        self.assertFalse(any(x.startswith("herdr.task=") for x in labels), "a shell is none of the task's agents")
        last = r["out"][-1]
        self.assertEqual((last["state"], last["addr"], last["view"], last["hostHidden"]), ("live", "t90", "t90", True))
        self.assertEqual(r["focus"], ["t90"])

    def test_switching_away_and_back_keeps_the_same_shell(self):
        r = run_mod([{}, {"shown": False}, {"shown": True, "where": dict(TASK, terminal="t2", key="shepherdr#26", folder="/work/wt-26")},
                     {"shown": False, "where": TASK}, {"shown": True}, {}])
        self.assertEqual(len(runs(r["calls"])), 2, "one for each task, never a second for the same task")
        self.assertEqual([o["view"] for o in r["out"]][-2:], ["t90", "t90"])
        self.assertFalse(any(c[:2] == ["hc", "kill"] for c in r["calls"]), "the view never ends a shell")

    def test_a_shell_from_before_is_found_by_its_label(self):
        old = {"address": "t40", "state": "live", "labels": {"herdr.task-shell": "shepherdr#25", "herdr.shell": "task"}}
        r = run_mod([{}], terms=[old])
        self.assertEqual(runs(r["calls"]), [])
        self.assertEqual(r["out"][-1]["view"], "t40")

    def test_an_exited_shell_is_replaced_the_next_time_the_view_shows(self):
        r = run_mod([{}, {"exit": "t90"}, {}, {"shown": False}, {"shown": True}])
        states = [o["state"] for o in r["out"]]
        self.assertEqual(states, ["live", "ended", "ended", "ended", "live"])
        self.assertIsNone(r["out"][1]["view"])
        self.assertIn(["hc", "rm", "t90"], r["calls"])
        self.assertEqual(len(runs(r["calls"])), 2)
        self.assertEqual(r["out"][-1]["view"], "t91")

    def test_new_shell_button_after_it_ended(self):
        r = run_mod([{}, {"exit": "t90"}, {"button": True}])
        self.assertEqual((r["out"][-1]["state"], r["out"][-1]["view"]), ("live", "t91"))

    def test_none_for_a_done_task(self):
        r = run_mod([{}], where=dict(TASK, state="done"))
        self.assertEqual(runs(r["calls"]), [])
        self.assertIn("done", r["out"][-1]["why"])

    def test_a_done_tasks_ended_shell_left_in_the_layout_is_not_shown(self):
        r = run_mod([{}], where=dict(TASK, state="done"), view="t40")
        self.assertEqual((r["out"][-1]["view"], r["out"][-1]["hostHidden"]), (None, False))

    def test_another_tasks_shell_left_in_the_layout_is_not_shown_while_starting(self):
        r = run_mod([{}], view="t40")
        self.assertEqual(r["out"][-1]["view"], "t90")

    def test_none_when_its_folder_is_gone(self):
        r = run_mod([{}], folder_there=False)
        self.assertEqual(runs(r["calls"]), [])
        self.assertEqual(r["out"][-1]["state"], "error")

    def test_another_machines_task_gets_its_shell_there(self):
        r = run_mod([{}, {}], where=dict(TASK, terminal="vm/t3", machine="vm"))
        (call,) = runs(r["calls"])
        self.assertEqual(call[call.index("--on") + 1], "vm")
        self.assertIn(["exec", "test", "-d", "/work/wt-25", "vm"], r["calls"])
        self.assertEqual(r["out"][-1]["view"], "vm/t90")


class EndsWithItsTask(unittest.TestCase):
    """herdr-task's side: hc and the task lists stubbed."""

    def setUp(self):
        sys.path.insert(0, BIN)
        import herdr_task.shells as shells
        self.shells = shells
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.wt = os.path.join(self.tmp, "wt")
        os.makedirs(self.wt)
        self.terms = {}   # address -> labels
        self.tasks = {}   # key -> task (missing: gone from its list)
        self.ran = []

        def hc_json(*args):
            if args[0] == "ls":
                want = args[2]
                return {"terminals": [{"address": a, "state": "live"} for a, labels in self.terms.items()
                                      if want in (f"{k}={v}" for k, v in labels.items())]}
            if args[0] == "get":
                return {"address": args[1], "labels": self.terms.get(args[1], {})}
            return None

        def run(argv):
            self.ran.append(argv[1:])
            if argv[1] == "kill":
                self.terms.pop(argv[2], None)
        for name, value in (("hc_json", hc_json), ("run", run), ("_task", lambda key: (True, self.tasks.get(key)))):
            p = mock.patch.object(shells, name, value)
            p.start()
            self.addCleanup(p.stop)

    def shell(self, addr, key):
        self.terms[addr] = {"herdr.task-shell": key, "herdr.shell": "task"}

    def test_end_shells_ends_only_that_tasks(self):
        self.shell("t5", "repo#1")
        self.shell("t6", "repo#2")
        self.assertEqual(self.shells.end_shells("repo#1"), ["t5"])
        self.assertEqual(list(self.terms), ["t6"])
        self.assertEqual(self.ran, [["kill", "t5"], ["rm", "t5"]])

    def test_pass_ends_done_gone_and_worktree_removed(self):
        self.tasks = {"repo#1": {"state": "running", "worktree": self.wt}, "repo#2": {"state": "done", "worktree": self.wt},
                      "repo#4": {"state": "running", "worktree": os.path.join(self.tmp, "removed")},
                      "repo#5": {"state": "running"}}
        for i in (1, 2, 3, 4, 5):
            self.shell(f"t{i}", f"repo#{i}")
        report = {}
        self.shells.shell_pass(report)
        self.assertEqual(sorted(self.terms), ["t1", "t5"], "a running task's shell stays, also a --here task's")
        self.assertEqual(sorted(report["shells_ended"]), ["repo#2", "repo#3", "repo#4"])

    def test_refused_hc_is_no_shells(self):
        def refuse(*a):
            raise self.shells.Fail("refusing to run hc")
        with mock.patch.object(self.shells, "hc_json", refuse):
            self.assertEqual(self.shells.end_shells("repo#1"), [])

    def test_finish_ends_its_shell_before_its_worktree_goes(self):
        import herdr_task.github as github
        order = []
        s = mock.Mock()
        s.key.return_value = "repo#1"
        with mock.patch.object(github, "end_shells", lambda key: order.append(("shells", key))), \
                mock.patch.object(github, "mid_turn", lambda *a: False), \
                mock.patch.object(github, "live_agents", lambda key: []), \
                mock.patch.object(github, "remove_worktree", lambda *a: order.append(("worktree",))):
            github.finish(s, {"state": "ready", "worktree": self.wt})
        self.assertEqual(order, [("shells", "repo#1"), ("worktree",)])

    def test_end_done_ends_its_shell_at_once(self):
        import herdr_task.tick as tick
        s = mock.Mock()
        s.key.return_value, s.ref.return_value = "repo#1", "R-1"
        t = {"state": "done", "done_at": tick.now()}
        report = {}
        with mock.patch.object(tick, "end_shells", lambda key: ["t5"] if key == "repo#1" else []):
            tick.end_done(s, t, report)
        self.assertEqual(report["shells_ended"], ["R-1"])


class InstallerComparesWithoutTheShell(unittest.TestCase):
    def test_a_shown_shell_leaves_the_layout_unchanged(self):
        from importlib.machinery import SourceFileLoader
        sh = SourceFileLoader("shepherdr_cli", os.path.join(ROOT, "bin", "shepherdr")).load_module()
        with open(LAYOUT, "rb") as f:
            shipped = f.read()
        d = json.loads(shipped)
        col = find(d, "tasks-thread-shell")
        col["children"][0]["hidden"] = True
        col["children"].append({"id": "tasks-thread-shell-view", "type": "block", "content": {"terminal": "t42"}})
        self.assertEqual(sh.layout_bytes(json.dumps(d).encode()), sh.layout_bytes(shipped))


if __name__ == "__main__":
    unittest.main()
