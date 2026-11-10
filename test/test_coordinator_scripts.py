"""The coordinator mod's shell helpers: a missing helper fails (test_restart.py covers the detach itself, #736)."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def detach_command():
    src = (ROOT / "lib/coordinator.js").read_text()
    m = re.search(r"^export const DETACH = '(.*)';$", src, re.M)
    assert m, "DETACH not found in lib/coordinator.js"
    return m.group(1)


class Detach(unittest.TestCase):
    """script() in lib/coordinator.js: the menu's launcher for mods/coordinator/*.sh."""

    def test_a_missing_helper_fails(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run(["/bin/bash", "-c", detach_command(), str(Path(d) / "nope.sh"), "a"],
                               env={"PATH": "/usr/bin:/bin", "HOME": d}, capture_output=True, text=True, timeout=10)
        self.assertEqual(r.returncode, 127)


if __name__ == "__main__":
    unittest.main()
