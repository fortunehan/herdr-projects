"""Files opens a file as a code tab (SHEP-31): a click on a file in Files (mods/files-tasks) opens it as a read-only
tab in the middle (mods/code-view) through lib/code-tabs.js, one tab per file: a click on a file whose tab is still
open goes back to it. Folders still open in the tree. The mods run as written in node, Herdr's API stubbed."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def source(*rel):
    """A module without its imports and exports: the harness gives what it imports."""
    with open(os.path.join(ROOT, *rel), encoding="utf-8") as f:
        src = re.sub(r"^import .*$", "", f.read(), flags=re.M)
    return re.sub(r"^export (default )?", "", src, flags=re.M)


# Any element: every builder method returns it; it keeps its id, click handler and children.
EL = r"""
function el(tag) {
  const e = { tag, kids: [] };
  const p = new Proxy(e, { get(t, k) {
    if (k in t) return t[k];
    if (k === "id") return (v) => { t.idv = v; return p; };
    if (k === "on_click") return (f) => { t.click = f; return p; };
    if (k === "child") return (c) => { t.kids.push(c); return p; };
    if (k === "children") return (cs) => { t.kids.push(...cs); return p; };
    if (k === "when") return (c, f) => (c ? f(p) : p);
    return () => p;
  } });
  return p;
}
const div = () => el("div"), v_flex = () => el("v_flex"), h_flex = () => el("h_flex"), svg = (s) => el("svg:" + s);
const View = class {};
function text(n) { return typeof n === "string" ? n : n && n.kids ? n.kids.map(text).join(" ") : ""; }
"""

TABS = EL + r"""
const input = %(input)s;
const store = { "files.tabs": input.tabs ?? null };
let ps = input.panes ?? [], sp = input.spaces ?? [{ id: "s1", active: true, tabs: [] }];
const calls = [], toasts = [];
let n = 0;
const shared = (k) => store[k] ?? null, setShared = (k, v) => { store[k] = v; };
const panes = () => ps, spaces = () => sp, run = (cmd, a) => calls.push(["run", cmd, a]);
const notify = (t) => toasts.push(t);
const exec = async (cmd, args) => {
  calls.push(["exec", cmd, ...args]);
  if (input.fail) return { code: 1, stdout: "", stderr: "no such space" };
  n++;
  const tab = `tab${n}`, pane = `p${n}`;
  ps = [...ps, { pane, tab, mod: "code-view", terminal: null, title: "code-view" }];
  return { code: 0, stdout: JSON.stringify({ tab, pane }), stderr: "" };
};
%(src)s
const out = [];
for (const s of input.steps) {
  if (s.close) ps = ps.filter((p) => p.pane !== s.close);
  if (s.open) { calls.length = 0; await openCode(s.open); out.push({ calls: [...calls], tabs: store["files.tabs"] }); }
  if (s.pane) out.push({ code: codeOfPane(s.pane) });
}
console.log(JSON.stringify({ out, toasts }));
"""

FILES = EL + r"""
const input = %(input)s;
const opened = [];
const openCode = async (a) => { opened.push(a); };
const theme = () => ({}), spaces = () => [], panes = () => [], focused = () => null, window = () => null;
const exec = async () => ({ code: 1, stdout: "", stderr: "" }), watchFolder = async () => [];
%(src)s
const v = Object.create(Files.prototype);
v.context = { key: "k", cwd: "/w/repo", on: input.on, space: "s1" }; v.root = "/w/repo"; v.on = input.on;
v.entries = new Map([["", [{ name: "src", dir: true }, { name: "README.md", dir: false }]]]);
v.folders = new Set(); v.pending = new Set(); v.marks = {};
let notified = 0;
const cx = { notify() { notified++; }, spawn() {} };
const rows = () => v.rows("", 0, [], {});
const byId = (id) => rows().find((r) => r.idv === id);
byId("file-README.md").click({}, cx);
byId("file-src").click({}, cx);
const tree = rows().map(text).join(" ");
console.log(JSON.stringify({ opened, folders: [...v.folders], file: v.file ?? null, tree }));
"""

VIEW = EL + r"""
const input = %(input)s;
const made = [];
const props = () => input.props, theme = () => ({ dim: "#888", ansi1: "#1", ansi2: "#2", ansi3: "#3", ansi4: "#4", ansi5: "#5", ansi6: "#6" }), settings = () => ({ font_family: "Mono" });
const readTextFile = async (path, opts) => { made.push(["read", path, opts]); if (input.throws) throw new Error("too big"); return input.text; };
const EditorState = { new: (o) => { made.push(["state", o]); return { release() {} }; } };
const Editor = { new: () => el("editor") };
%(src)s
const pending = [];
const cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
const v = Object.create(CodeView.prototype);
v.init({}, cx);
while (pending.length) await pending.shift();
const r = v.render(cx);
console.log(JSON.stringify({ made, shown: r.kids[0]?.tag ?? null, text: text(r) }));
"""


def node(harness, src, inp):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.mjs")
        with open(path, "w") as f:
            f.write(harness % {"src": src, "input": json.dumps(inp)})
        p = subprocess.run(["node", path], capture_output=True, text=True)
    if p.returncode != 0:
        raise AssertionError(p.stderr)
    return json.loads(p.stdout)


def flags(call):
    return {call[i][2:]: call[i + 1] for i in range(4, len(call) - 1, 2) if call[i].startswith("--")}


FILE = {"space": "s1", "root": "/w/repo", "file": "src/app.ts", "on": None}


@unittest.skipIf(shutil.which("node") is None, "no node")
class CodeTabs(unittest.TestCase):
    def tabs(self, steps, **kw):
        return node(TABS, source("lib", "code-tabs.js"), {"steps": steps, **kw})

    def test_a_click_opens_a_tab_named_after_the_file(self):
        r = self.tabs([{"open": FILE}])
        (call,) = r["out"][0]["calls"]
        self.assertEqual(call[:4], ["exec", "herdr-app", "do", "tab.new"])
        f = flags(call)
        self.assertEqual((f["space"], f["name"], f["mod"]), ("s1", "app.ts", "code-view"))
        self.assertEqual(json.loads(f["props"]), {"root": "/w/repo", "file": "src/app.ts", "on": None})
        (entry,) = r["out"][0]["tabs"].values()
        self.assertEqual((entry["tab"], entry["pane"], entry["file"]), ("tab1", "p1", "src/app.ts"))

    def test_another_file_gets_another_tab(self):
        r = self.tabs([{"open": FILE}, {"open": {**FILE, "file": "README.md"}}])
        self.assertEqual(flags(r["out"][1]["calls"][0])["name"], "README.md")
        self.assertEqual(sorted(e["tab"] for e in r["out"][1]["tabs"].values()), ["tab1", "tab2"])

    def test_the_same_file_again_goes_to_its_tab(self):
        r = self.tabs([{"open": FILE}, {"open": FILE}])
        calls = r["out"][1]["calls"]
        self.assertFalse([c for c in calls if c[0] == "exec"], "no second tab")
        self.assertIn(["run", "tab.select", {"id": "tab1"}], calls)
        self.assertIn(["run", "pane.focus", {"pane": "p1"}], calls)

    def test_a_closed_tab_opens_again_and_is_forgotten(self):
        r = self.tabs([{"open": FILE}, {"open": {**FILE, "file": "b.py"}}, {"close": "p1"}, {"open": FILE}])
        self.assertEqual(r["out"][2]["calls"][0][3], "tab.new")
        self.assertEqual(sorted(e["pane"] for e in r["out"][2]["tabs"].values()), ["p2", "p3"])

    def test_its_tab_in_another_space_shows_that_space(self):
        tabs = {'["s2",null,"/w/repo/src/app.ts"]': {"space": "s2", "tab": "t9", "pane": "p9", "root": "/w/repo", "file": "src/app.ts", "on": None}}
        r = self.tabs([{"open": {**FILE, "space": "s2"}}], tabs=tabs, panes=[{"pane": "p9", "tab": "t9", "mod": "code-view"}],
                      spaces=[{"id": "s1", "active": True}, {"id": "s2", "active": False}])
        self.assertEqual(r["out"][0]["calls"][0], ["run", "space.select", {"id": "s2"}])

    def test_same_path_on_another_machine_is_another_tab(self):
        r = self.tabs([{"open": FILE}, {"open": {**FILE, "on": "vm"}}])
        f = flags(r["out"][1]["calls"][0])
        self.assertEqual(json.loads(f["props"])["on"], "vm")

    def test_the_header_finds_a_panes_file(self):
        r = self.tabs([{"open": {**FILE, "on": "vm"}}, {"pane": "p1"}, {"pane": "nope"}])
        self.assertEqual((r["out"][1]["code"]["file"], r["out"][1]["code"]["on"]), ("src/app.ts", "vm"))
        self.assertIsNone(r["out"][2]["code"])

    def test_a_refused_tab_says_so(self):
        r = self.tabs([{"open": FILE}], fail=True)
        self.assertEqual(r["toasts"][0]["level"], "error")
        self.assertIn("app.ts", r["toasts"][0]["title"])
        self.assertIsNone(r["out"][0]["tabs"])


@unittest.skipIf(shutil.which("node") is None, "no node")
class FilesClick(unittest.TestCase):
    def test_a_file_opens_as_a_tab_and_a_folder_opens_in_the_tree(self):
        r = node(FILES, source("mods", "files-tasks", "main.js"), {"on": "vm"})
        self.assertEqual(r["opened"], [{"space": "s1", "root": "/w/repo", "file": "README.md", "on": "vm"}])
        self.assertEqual(r["folders"], ["src"])
        self.assertIsNone(r["file"], "the tree stays")
        self.assertIn("README.md", r["tree"])

    def test_no_preview_in_the_side_panel(self):
        with open(os.path.join(ROOT, "mods", "files-tasks", "main.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("Editor", src)
        self.assertNotIn("mods/files/", src, "its own icons")


@unittest.skipIf(shutil.which("node") is None, "no node")
class CodeView(unittest.TestCase):
    def view(self, **inp):
        inp.setdefault("props", {"root": "/w/repo", "file": "src/app.ts", "on": "vm"})
        return node(VIEW, source("mods", "code-view", "main.js"), inp)

    def test_shows_the_file_read_only_with_colours(self):
        r = self.view(text="const a = 1;\n")
        self.assertEqual(r["made"][0], ["read", "/w/repo/src/app.ts", {"on": "vm"}])
        o = r["made"][1][1]
        self.assertEqual((o["language"], o["readonly"], o["value"], o["font_family"]), ("js", True, "const a = 1;\n", "Mono"))
        self.assertIn("keyword", o["syntax"])
        self.assertEqual(r["shown"], "editor")

    def test_a_gone_file_says_so(self):
        r = self.view(text=None)
        self.assertNotEqual(r["shown"], "editor")
        self.assertIn("src/app.ts is no longer there", r["text"])

    def test_binary_and_unreadable(self):
        self.assertIn("Binary file", self.view(text="a\0b")["text"])
        self.assertIn("Cannot show this file", self.view(throws=True)["text"])

    def test_a_long_file_is_cut(self):
        o = self.view(text="x" * 400010)["made"][1][1]
        self.assertTrue(o["value"].endswith("… (file truncated)"))
        self.assertEqual(len(o["value"]), 400000 + len("\n… (file truncated)"))


class Layout(unittest.TestCase):
    def test_the_files_block_keeps_its_id(self):
        with open(os.path.join(ROOT, "layouts", "shepherdr.json")) as f:
            text = f.read()
        self.assertRegex(text, r'"id": "files",\s*"type": "block",\s*"content": \{\s*"mod": "files-tasks"')


if __name__ == "__main__":
    unittest.main()
