"""The Tasks panel follows the space picked (SHEP-28): a task opened in space A no longer shows in space B; B shows its
list, and A its task again (in the view it had) once the person is back. The lines the Tasks list's render
(mods/tasks/main.js draw) and the task view header's render (mods/chat/panel.js renderHead) run are taken as written
and run in node with each mod's own copy of core/thread-space.js, the window stubbed: the layout's stacks, shared
state and the shown space; timers run at once."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODS = {"tasks": os.path.join(ROOT, "mods", "tasks", "main.js"), "chat": os.path.join(ROOT, "mods", "chat", "panel.js")}
# What each render runs for it: the hosts line and the switched() check after it.
GLUE = re.compile(r"\n(    const hosts = \{[^\n]*\};\n    if \(switched\(hosts\)\)[^\n]*\n)")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def core(mod):
    return re.sub(r"^export ", "", read(os.path.join(ROOT, "mods", mod, "core", "thread-space.js")), flags=re.M)


def glue(mod):
    hit = GLUE.search(read(MODS[mod]))
    return hit.group(1) if hit else None


HARNESS = r"""
const input = %(input)s;
%(core)s
const store = {};
let active = "A";
const tree = { id: "root", children: [{ id: "tasks", active: "tasks-list", children: [{ id: "tasks-list" }, { id: "tasks-thread",
  children: [{ id: "tasks-thread-head" }, { id: "tasks-thread-body", active: "tasks-thread-chat",
    children: [{ id: "tasks-thread-chat" }, { id: "tasks-thread-term" }, { id: "tasks-thread-shell" }, { id: "tasks-thread-pr" }] }] }] }] };
const node = (n, id) => (n.id === id ? n : (n.children ?? []).map((c) => node(c, id)).find(Boolean) ?? null);
const spaces = () => ["A", "B", "C"].map((id) => ({ id, active: id === active }));
const layout = () => tree, shared = (k) => store[k] ?? null, setShared = (k, v) => { store[k] = v; };
const run = (cmd, a) => { if (cmd === "layout.select") node(tree, a.stack).active = a.child; };
const cx = { timer: { after(_ms, fn) { fn(cx); } } };
const render = { tasks: (cx) => { %(tasks)s }, chat: (cx) => { %(chat)s } };
// Whichever copy shows draws: the list while the stack shows it, the header while it shows a task.
const draw = () => render[node(tree, "tasks").active === "tasks-thread" ? "chat" : "tasks"](cx);
const shows = () => node(tree, "tasks").active === "tasks-thread" ? `${store["tasks.thread"]?.task} ${node(tree, "tasks-thread-body").active}` : "list";
const out = [];
draw();
for (const s of input.steps) {
  if (s.open) { store["tasks.thread"] = { terminal: s.open.toLowerCase(), task: s.open, key: { machine: null, folder: "/f", slug: "f", id: s.open } };
    node(tree, "tasks").active = "tasks-thread"; node(tree, "tasks-thread-body").active = s.view ?? "tasks-thread-chat"; }
  if (s.list) node(tree, "tasks").active = "tasks-list";
  if (s.pick) active = s.pick;
  // Herdr draws a shown copy again when its live data changes (a space picked): twice, as a second redraw does.
  draw(); draw();
  out.push(shows());
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(shutil.which("node"), "needs node")
class TasksPanelFollowsTheSpace(unittest.TestCase):
    def run_steps(self, steps):
        src = HARNESS % {"input": json.dumps({"steps": steps}), "core": core("tasks"), "tasks": glue("tasks"), "chat": glue("chat")}
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(src)
        try:
            r = subprocess.run(["node", f.name], capture_output=True, text=True, timeout=60)
        finally:
            os.unlink(f.name)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1])

    def test_both_renders_ask(self):
        for mod in MODS:
            self.assertIsNotNone(glue(mod), f"{MODS[mod]} doesn't check for a space switch in its render")
        self.assertEqual(core("tasks"), core("chat"))

    def test_another_space_shows_its_list_and_the_first_its_task_again(self):
        self.assertEqual(self.run_steps([{"open": "SHEP-1", "view": "tasks-thread-shell"}, {"pick": "B"}, {"pick": "A"}]),
                         ["SHEP-1 tasks-thread-shell", "list", "SHEP-1 tasks-thread-shell"])

    def test_each_space_keeps_its_own_task(self):
        self.assertEqual(self.run_steps([{"open": "SHEP-1"}, {"pick": "B"}, {"open": "SHEP-2", "view": "tasks-thread-pr"},
                                         {"pick": "A"}, {"pick": "C"}, {"pick": "B"}]),
                         ["SHEP-1 tasks-thread-chat", "list", "SHEP-2 tasks-thread-pr", "SHEP-1 tasks-thread-chat", "list",
                          "SHEP-2 tasks-thread-pr"])

    def test_a_space_left_on_its_list_comes_back_to_it(self):
        self.assertEqual(self.run_steps([{"open": "SHEP-1"}, {"list": True}, {"pick": "B"}, {"pick": "A"}]),
                         ["SHEP-1 tasks-thread-chat", "list", "list", "list"])

    def test_the_terminal_comes_back_as_the_chat(self):
        self.assertEqual(self.run_steps([{"open": "SHEP-1", "view": "tasks-thread-term"}, {"pick": "B"}, {"pick": "A"}]),
                         ["SHEP-1 tasks-thread-term", "list", "SHEP-1 tasks-thread-chat"])


if __name__ == "__main__":
    unittest.main()
