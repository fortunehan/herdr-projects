"""Run the window chat's endedWhy method with a stub hc, without starting an Assistant."""
import home_guard  # noqa: F401
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def ended_results(source=None):
    if source is None:
        with open(os.path.join(ROOT, "mods/chat/main.js")) as f:
            source = f.read()
    method = re.search(r"\n  async endedWhy\(addr\) \{\n.*?\n  \}\n", source, re.S).group(0)
    script = '''
const chat = { %s };
let output = "", fail = false;
const calls = [];
const hc = async (args) => { calls.push(args); if (fail) throw Error("offline"); return { stdout: output }; };
const cases = [
  ["error then note", "Error: account/read failed: test timeout\\n[hc] incomplete: older output may be missing"],
  ["multiple notes", "First line\\nError: real failure\\n[hc] incomplete: older output may be missing\\n[hc] only its screen: it is working; test"],
  ["notes only", "[hc] incomplete: older output may be missing\\n[hc] only its screen: it is working; test"],
  ["empty", "\\n  "],
  ["long", "Error: " + "x".repeat(300) + "\\n[hc] note"],
  ["ordinary last line", "first\\n  last line  \\n"],
];
const results = {};
for (const [name, value] of cases) { output = value; results[name] = await chat.endedWhy("t-test"); }
fail = true;
results.rejected = await chat.endedWhy("t-test");
results.noAddress = await chat.endedWhy(null);
console.log(JSON.stringify({ results, calls }));
''' % method
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "ended.mjs")
        with open(path, "w") as f:
            f.write(script)
        return json.loads(subprocess.run(["node", path], capture_output=True, text=True, check=True).stdout)


@unittest.skipUnless(shutil.which("node"), "node is required")
class EndedWhy(unittest.TestCase):
    def test_shows_the_agent_error_and_keeps_empty_fallback_and_truncation(self):
        out = ended_results()
        self.assertEqual(out["results"], {
            "error then note": "It said: Error: account/read failed: test timeout",
            "multiple notes": "It said: Error: real failure",
            "notes only": "", "empty": "", "long": "It said: " + ("Error: " + "x" * 300)[:200],
            "ordinary last line": "It said: last line", "rejected": "", "noAddress": "",
        })
        self.assertEqual(out["calls"], [["read", "t-test", "--lines", "8"]] * 7)
        with open(os.path.join(ROOT, "mods/chat/main.js")) as f:
            self.assertIn('why || "It exited before it was ready."', f.read())


if __name__ == "__main__":
    unittest.main()
