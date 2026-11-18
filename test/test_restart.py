"""mods/coordinator/restart.sh for another machine's agent: it runs there, over hc (SHEP-107)."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import sys
from unittest import mock
from pathlib import Path

def read(p):
    with open(p) as f:
        return f.read()


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "mods", "coordinator", "restart.sh")

# A fake hc: logs each call (and what came on stdin); `exec` answers as the other machine would, `machine ls` says
# whether that machine is reachable.
FAKE_HC = r"""#!/usr/bin/env bash
log=$FAKE_DIR/calls
printf '%s\n' "$*" >>"$log"
case $1 in
  exec)
    cat >"$FAKE_DIR/stdin"
    printf '%s\n' "$@" >"$FAKE_DIR/exec-args"
    [ "$FAKE_STATE" = connected ] || exit 1
    echo t9 ;;
  machine) printf '{"machines":[{"name":"vmb","state":"%s"}]}\n' "$FAKE_STATE" ;;
  *) echo "the local core was used: $*" >&2; exit 9 ;;
esac
"""


class RemoteRestart(unittest.TestCase):
    def run_script(self, state, env=None):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        with open(hc, "w") as f:
            f.write(FAKE_HC)
        os.chmod(hc, 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "FAKE_DIR": d, "FAKE_STATE": state, **(env or {})}
        r = subprocess.run(["bash", SCRIPT, "vmb/t2", json.dumps(["claude", "--model", "sonnet"])], env=e,
                           capture_output=True, text=True, timeout=30)
        return r, d

    def test_runs_on_its_machine(self):
        r, d = self.run_script("connected", {"HERDR_RESTART_CHAT": "pane1", "HERDR_RESTART_RESUME": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "vmb/t9")
        args = read(os.path.join(d, "exec-args")).split("\n")
        self.assertEqual(args[:3], ["exec", "--on", "vmb"])
        self.assertIn("HERDR_RESTART_CHAT=pane1", args)
        self.assertIn("HERDR_RESTART_RESUME=1", args)
        # the script itself goes over, with that machine's own address for the agent
        tail = args[args.index("--") + 1:]
        self.assertEqual(tail[:3], ["bash", "-s", "t2"])
        self.assertEqual(json.loads(tail[3]), ["claude", "--model", "sonnet"])
        self.assertEqual(read(os.path.join(d, "stdin")), read(SCRIPT))
        # nothing ran on this machine's core
        self.assertTrue(all(c.startswith("exec ") for c in read(os.path.join(d, "calls")).splitlines()))

    def test_no_env_without_a_chat(self):
        r, d = self.run_script("connected")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("--env", read(os.path.join(d, "exec-args")).split("\n"))

    def test_offline_says_so(self):
        r, _ = self.run_script("disconnected")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stderr.strip(), "vmb is offline. Try again once it's back.")
        self.assertEqual(r.stdout, "")


# A fake hc for an agent on this machine: `get` answers its record, `run` logs its arguments.
LOCAL_HC = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DIR/calls"
case $1 in
  get)
    if [ "$2" = t9 ]; then cat "$FAKE_DIR/new.json"
    else echo '{"address":"t2","cwd":"/tmp","labels":{"herdr.chat":"vmb/p7","herdr.role":"coordinator","herdr.space":"sp1","herdr.tab":"tb1"}}'; fi ;;
  run)
    printf '%s\n' "$@" >"$FAKE_DIR/run-args"
    jq -n --args '$ARGS.positional | to_entries | map(select(.value == "--label") | .key + 1) as $indices | $ARGS.positional as $a | {state:"live",labels:([$indices[] | $a[.] | capture("^(?<key>[^=]+)=(?<value>.*)$")] | from_entries)}' -- "$@" >"$FAKE_DIR/new.json"
    echo '{"address":"t9"}' ;;
  ls) echo '{"terminals":[]}' ;;
esac
"""


class ChatLabel(unittest.TestCase):
    """The new agent's herdr.chat holds its pane as its own machine names it, never a window's "<machine>/<pane>"
    (GitHub #761: another machine's window then misses the pane and ends the agent)."""

    def restart(self, env):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        with open(hc, "w") as f:
            f.write(LOCAL_HC)
        os.chmod(hc, 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "HERDR_APP_HOME": d, "FAKE_DIR": d, "HERDR_RESTART_RESUME": "1", **env}
        r = subprocess.run(["bash", SCRIPT, "t2", json.dumps(["claude", "--resume", "s1"])], env=e,
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        return read(os.path.join(d, "run-args")).split("\n")

    def test_window_name_from_the_chat(self):
        self.assertIn("herdr.chat=p7", self.restart({"HERDR_RESTART_CHAT": "vmb/p7"}))

    def test_window_name_from_its_label(self):
        args = self.restart({})
        self.assertIn("herdr.chat=p7", args)
        self.assertNotIn("herdr.chat=vmb/p7", args)


IDENTITY_HC = r"""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ["FAKE_DIR"])
a = sys.argv[1:]
with (root / "calls").open("a") as f: f.write(json.dumps(a) + "\n")
state = json.loads((root / "state.json").read_text())
if a[0] == "get": print(json.dumps(state.get(a[1], {})))
elif a[0] == "ls": print(json.dumps({"terminals": list(state.values())}))
elif a[0] == "run":
    labels = dict(a[i+1].split("=", 1) for i, v in enumerate(a) if v == "--label")
    labels.pop(os.environ.get("DROP_LABEL", ""), None)
    new = "t" + str(max([8] + [int(k[1:]) for k in state if k[1:].isdigit()]) + 1)
    state[new] = {"address": new, "state": "live", "labels": labels, "cwd": "/tmp"}
    (root / "state.json").write_text(json.dumps(state))
    for arg in a:
        if arg.startswith("herdr-handoff-"):
            (root / "handoff.txt").write_text((root / ".config/herdr-core/templates" / (arg + ".md")).read_text())
    print(json.dumps({"address": new, "first_message": {"sent": not bool(os.environ.get("FAIL_SEND"))}}))
    if os.environ.get("FAIL_RUN"): sys.exit(1)
elif a[0] == "send" and os.environ.get("FAIL_SEND"): sys.exit(1)
elif a[0] == "label":
    state[a[1]]["labels"].update(dict(x.split("=", 1) for x in a[2:]))
    (root / "state.json").write_text(json.dumps(state))
elif a[0] in ("kill", "rm"):
    state.pop(a[1], None)
    (root / "state.json").write_text(json.dumps(state))
"""


class AssistantIdentity(unittest.TestCase):
    def restart(self, labels, extra=None, slots=None, doc=None, argv=None, workers=None):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = root = Path(self.tmp.name)
        (root / "bin").mkdir()
        (root / "bin/hc").write_text(IDENTITY_HC.replace("#!/usr/bin/env python3", "#!" + sys.executable))
        (root / "bin/hc").chmod(0o755)
        for launcher in ("claude-magpie", "claude-cdnd"):
            (root / "bin" / launcher).write_text("#!/bin/sh\nexit 99\n")
            (root / "bin" / launcher).chmod(0o755)
        (root / ".config/herdr-core/templates").mkdir(parents=True)
        (root / ".config/herdr-core/templates/assistant.md").write_text("---\ncommand: claude\n---\nAssistant\n")
        (root / "state.json").write_text(json.dumps({"t2": {
            "address": "t2", "state": "live", "cwd": "/tmp", "labels": labels}, **(workers or {})}))
        if slots is not None:
            (root / "shared.json").write_text(json.dumps({"coordinator.slots": slots}))
        if doc is not None:
            state_dir = root / ".local/state/herdr-core/default"
            state_dir.mkdir(parents=True)
            (state_dir / "docs.json").write_text(json.dumps({"herdr-app": {"value": doc}}))
        env = {"PATH": f"{root}/bin:/usr/bin:/bin", "HOME": str(root), "HERDR_APP_HOME": str(root),
               "FAKE_DIR": str(root), "HERDR_RESTART_CHAT": "p7", "HERDR_RESTART_RESUME": "1", **(extra or {})}
        self.env = env
        command = ["bash", SCRIPT, "t2"]
        if argv != "":
            command.append(json.dumps(argv or ["claude", "--resume", "s1"]))
        result = subprocess.run(command,
                                env=env, capture_output=True, text=True, timeout=30)
        self.state = json.loads((root / "state.json").read_text())
        return result

    def test_legacy_pane_to_chat_remains_news_recipient(self):
        result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        sys.path.insert(0, os.path.join(ROOT, "mods/tasks/bin"))
        from herdr_task import launch
        def hc(*args):
            return {"terminals": list(self.state.values())} if args[0] == "ls" else self.state.get(args[1])
        with mock.patch.object(launch, "hc_json", hc):
            self.assertEqual(launch.coordinator_in("sp1"), "t9", "task news lost its Assistant after pane -> Chat restart")
        self.assertEqual(self.state["t9"]["labels"]["herdr.coordinator.tab"], "tb1")

    def test_canonical_chat_identity_and_context_survive_repeated_restart(self):
        labels = {"herdr.role": "coordinator", "herdr.coordinator.space": "sp1", "herdr.coordinator.tab": "tb1",
                  "herdr.chat": "p7", "herdr.chat.slot": "slot1", "herdr.chat.origin": "slot:slot1",
                  "herdr.coordinator": "parent-tab"}
        result = self.restart(labels)
        for addr in ("t9", "t10"):
            self.assertEqual(result.returncode, 0, result.stderr)
            labels = self.state[addr]["labels"]
            self.assertEqual(labels["herdr.coordinator.space"], "sp1")
            self.assertEqual(labels["herdr.coordinator.tab"], "tb1")
            self.assertEqual(labels["herdr.chat.origin"], "slot:slot1")
            self.assertEqual(labels["herdr.chat.slot"], "slot1")
            self.assertEqual(labels["herdr.coordinator"], "parent-tab")
            self.assertEqual(json.loads(labels["herdr.launcher.argv"]), ["claude", "--resume", "s1"])
            if addr == "t9":
                result = subprocess.run(["bash", SCRIPT, addr, json.dumps(["claude", "--resume", "s1"])],
                                        env=self.env, capture_output=True, text=True, timeout=30)
                self.state = json.loads((self.root / "state.json").read_text())
        self.assertEqual(list(self.state), ["t10"])

    def test_damaged_chat_recovers_from_unique_slot(self):
        result = self.restart({"herdr.role": "coordinator", "herdr.chat": "p7"},
                              slots={"slot1": {"space": "sp1", "tab": "tb1", "pane": "p7"}})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state["t9"]["labels"]["herdr.coordinator.space"], "sp1")

    def test_damaged_chat_recovers_from_saved_layout(self):
        doc = {"spaces": [{"id": "sp1", "tabs": [{"id": "tb1", "root": {
            "id": "p7", "content": {"mod": "chat", "props": {"role": "coordinator", "slot": "slot1"}}}}]}]}
        result = self.restart({"herdr.role": "coordinator", "herdr.chat": "p7"}, doc=doc)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state["t9"]["labels"]["herdr.coordinator.tab"], "tb1")

    def test_ambiguous_or_missing_mapping_keeps_original_untouched(self):
        for slots in ({}, {"one": {"space": "sp1", "tab": "tb1", "pane": "p7"},
                           "two": {"space": "sp2", "tab": "tb2", "pane": "p7"}},
                      {"remote": {"space": "vm/sp1", "tab": "vm/tb1", "pane": "vm/p7", "folder": "/tmp"}}):
            with self.subTest(slots=slots):
                result = self.restart({"herdr.role": "coordinator", "herdr.chat": "p7"}, slots=slots)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("previous Assistant was kept", result.stderr)
                self.assertEqual(list(self.state), ["t2"])
                calls = [json.loads(x) for x in (self.root / "calls").read_text().splitlines()]
                self.assertEqual([x[0] for x in calls], ["get"])

    def test_failed_replacement_route_does_not_end_original(self):
        result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"},
                              {"DROP_LABEL": "herdr.coordinator.space"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no verified route", result.stderr)
        self.assertIn("t2", self.state)
        calls = [json.loads(x) for x in (self.root / "calls").read_text().splitlines()]
        self.assertFalse(any(x[0] in ("label", "kill", "rm") for x in calls))

    def test_cross_agent_handoff_keeps_route_and_selected_permissions(self):
        argv = ["codex", "--model", "test-model", "--sandbox", "read-only"]
        result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"},
                              {"HERDR_RESTART_RESUME": ""}, argv=argv)
        self.assertEqual(result.returncode, 0, result.stderr)
        labels = self.state["t9"]["labels"]
        self.assertEqual(labels["herdr.agent"], "codex")
        self.assertEqual(json.loads(labels["herdr.launcher.argv"]), argv)
        self.assertEqual(labels["herdr.coordinator.space"], "sp1")

    def test_launcher_handoff_preserves_flags_and_handoff_context(self):
        argv = ["claude-magpie", "--model", "provider/model", "--permission-mode", "plan", "--add-dir", "/extra"]
        result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"},
                              {"HERDR_RESTART_RESUME": ""}, argv=argv)
        self.assertEqual(result.returncode, 0, result.stderr)
        labels = self.state["t9"]["labels"]
        self.assertEqual(labels["herdr.agent"], "claude")
        self.assertEqual(json.loads(labels["herdr.launcher.argv"]), argv)
        handoff = (self.root / "handoff.txt").read_text()
        self.assertIn("claude-magpie --model provider/model --permission-mode plan --add-dir /extra", handoff)
        self.assertIn("Its last screen is saved in", handoff)
        self.assertIn("Assistant\n", handoff)

    def test_unconfirmed_handoff_keeps_previous_assistant_and_worker_labels(self):
        worker = {"address": "t3", "state": "live", "parent": "t2", "labels": {}}
        result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"},
                              {"HERDR_RESTART_RESUME": "", "FAIL_SEND": "1"}, workers={"t3": worker})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("handoff didn't reach", result.stderr)
        self.assertIn("t2", self.state)
        self.assertEqual(self.state["t3"], worker)

    def test_pane_restart_without_argv_keeps_canonical_identity_and_workers(self):
        worker = {"address": "t3", "state": "live", "parent": "t2", "labels": {}}
        result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"},
                              {"HERDR_RESTART_CHAT": "", "HERDR_RESTART_RESUME": ""}, argv="", workers={"t3": worker})
        self.assertEqual(result.returncode, 0, result.stderr)
        labels = self.state["t9"]["labels"]
        self.assertEqual(labels["herdr.coordinator.space"], "sp1")
        self.assertEqual(labels["herdr.coordinator.tab"], "tb1")
        self.assertEqual(labels["herdr.space"], "sp1")
        self.assertEqual(labels["herdr.tab"], "tb1")
        self.assertEqual(self.state["t3"]["labels"]["herdr.coordinator"], "tb1")

    def test_resume_keeps_session_flags_and_does_not_send_handoff(self):
        argv = ["claude", "--resume", "session-id", "--model", "model", "--permission-mode", "plan"]
        result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"}, argv=argv)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(x) for x in (self.root / "calls").read_text().splitlines()]
        run = next(x for x in calls if x[0] == "run")
        self.assertEqual(run[run.index("herdr-clean") + 1:], argv)
        self.assertFalse(any(x[0] == "send" for x in calls))

    def test_default_restart_keeps_declared_launcher_model_and_permissions(self):
        argv = ["claude-magpie", "--model", "provider/model", "--permission-mode", "plan"]
        result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1",
                               "herdr.launcher.argv": json.dumps(argv)}, {"HERDR_RESTART_RESUME": ""}, argv="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.state["t9"]["labels"]["herdr.launcher.argv"]), argv)
        self.assertIn("claude-magpie --model provider/model --permission-mode plan", (self.root / "handoff.txt").read_text())

    def test_failed_spawn_with_address_does_not_end_previous_assistant(self):
        for resume in ("1", ""):
            result = self.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"},
                                  {"FAIL_RUN": "1", "HERDR_RESTART_RESUME": resume})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("t2", self.state)
class NoTab(unittest.TestCase):
    """GitHub #980: an Assistant the service started without the window (a web-only install, service/spaces.ts) has
    a space but no tab or chat. restart.sh quit at its first guard without a word, and the remote side dropped its
    stderr: all anyone saw was "It didn't restart". It restarts in the background under its space now, and a
    restart that can't says why, across machines too."""

    def restart(self, labels, env=None, argv=("claude", "--resume", "s1")):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        rec = json.dumps({"address": "t2", "cwd": "/tmp", "template": "assistant", "labels": labels})
        with open(hc, "w") as f:
            f.write(LOCAL_HC.replace(LOCAL_HC.split("\n")[5], f"    else echo '{rec}'; fi ;;"))
        os.chmod(hc, 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "HERDR_APP_HOME": d, "FAKE_DIR": d, "HERDR_RESTART_RESUME": "1", **(env or {})}
        r = subprocess.run(["bash", SCRIPT, "t2", json.dumps(list(argv))], env=e, capture_output=True, text=True, timeout=30)
        p = os.path.join(d, "run-args")
        return r, (read(p).split("\n") if os.path.exists(p) else None)

    def test_a_space_alone_restarts_in_the_background(self):
        r, args = self.restart({"herdr.space": "sp1", "herdr.coordinator.space": "sp1", "herdr.role": "coordinator"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        self.assertIn("--keep", args)
        for label in ("herdr.space=sp1", "herdr.coordinator.space=sp1", "herdr.role=coordinator"):
            self.assertIn(label, args)
        self.assertFalse(any(a.startswith("herdr.tab=") for a in args), "no empty tab label")

    def test_a_space_alone_with_conflicting_or_remote_space_labels_is_refused(self):
        """SHEP-81: #980's space-only restart takes no space the identity check (SHEP-70) would refuse."""
        for labels in ({"herdr.space": "sp1", "herdr.coordinator.space": "sp2", "herdr.role": "coordinator"},
                       {"herdr.space": "vm/sp1", "herdr.role": "coordinator"}):
            with self.subTest(labels=labels):
                r, args = self.restart(labels)
                self.assertEqual(r.returncode, 1)
                self.assertIn("previous Assistant was kept", r.stderr)
                self.assertIsNone(args)

    def test_nowhere_to_go_says_why(self):
        r, args = self.restart({"herdr.role": "coordinator"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("t2 has no space, tab or chat to restart into.", r.stderr)
        self.assertIsNone(args)

    def test_the_other_machine_says_why(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        hc = os.path.join(d, "bin", "hc")
        with open(hc, "w") as f:
            f.write(FAKE_HC.replace("    echo t9 ;;", '    [ -n "$FAKE_WHY" ] && { echo "$FAKE_WHY" >&2; exit 1; }\n    echo t9 ;;'))
        os.chmod(hc, 0o755)
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "FAKE_DIR": d, "FAKE_STATE": "connected",
             "FAKE_WHY": "t2 has no space, tab or chat to restart into."}
        r = subprocess.run(["bash", SCRIPT, "vmb/t2", "[]"], env=e, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stderr.strip(), "It didn't restart on vmb: t2 has no space, tab or chat to restart into.")


class Bash32(unittest.TestCase):
    """macOS's /bin/bash is 3.2, without bash 4's mapfile and readarray (GitHub #736): restart.sh still restarts."""

    def restart(self, env):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        templates = Path(d) / ".config/herdr-core/templates"
        templates.mkdir(parents=True)
        (templates / "assistant.md").write_text("---\ncommand: claude\n---\nAssistant\n")
        hc = os.path.join(d, "bin", "hc")
        with open(hc, "w") as f:
            f.write(LOCAL_HC)
        os.chmod(hc, 0o755)
        # BASH_ENV runs before the script: it takes bash 4's builtins away, as on bash 3.2.
        old = os.path.join(d, "bash32")
        with open(old, "w") as f:
            f.write("enable -n mapfile readarray\n")
        e = {"PATH": f"{d}/bin:/usr/bin:/bin", "HOME": d, "HERDR_APP_HOME": d, "FAKE_DIR": d, "BASH_ENV": old, **env}
        r = subprocess.run(["bash", SCRIPT, "t2", json.dumps(["claude", "--model", "a b"])], env=e,
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "t9")
        return r, read(os.path.join(d, "run-args")).split("\n")

    def test_resume(self):
        r, args = self.restart({"HERDR_RESTART_RESUME": "1"})
        self.assertNotIn("command not found", r.stderr)
        self.assertEqual(args[args.index("herdr-clean") + 1:][:3], ["claude", "--model", "a b"])

    def test_handoff(self):
        r, args = self.restart({})
        self.assertNotIn("command not found", r.stderr)
        self.assertIn("herdr.agent=claude", args)


class Detach(unittest.TestCase):
    """lib/coordinator.js's script() runs the helper scripts detached, also where there is no setsid (macOS, #736)."""

    def detach(self, with_setsid):
        src = read(os.path.join(ROOT, "lib", "coordinator.js"))
        m = re.search(r"^export const DETACH = '(.*)';$", src, re.M)
        self.assertIsNotNone(m, "lib/coordinator.js exports DETACH, the shell line script() runs")
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, "bin"))
        for tool in ["bash", "nohup", "sleep"] + (["setsid"] if with_setsid else []):
            os.symlink(shutil.which(tool), os.path.join(d, "bin", tool))
        sh = os.path.join(d, "helper.sh")
        with open(sh, "w") as f:
            f.write('sleep 0.5; printf "%s\\n" "$@" >"$OUT"\n')
        out = os.path.join(d, "out")
        t = time.time()
        r = subprocess.run(["bash", "-c", m.group(1), sh, "t2", "a b"], env={"PATH": f"{d}/bin", "HOME": d, "OUT": out},
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLess(time.time() - t, 0.5, "it returns at once, the script running on")
        for _ in range(50):
            if os.path.exists(out) and read(out).endswith("\n"):
                break
            time.sleep(0.1)
        self.assertEqual(read(out), "t2\na b\n")

    def test_with_setsid(self):
        self.detach(True)

    def test_without_setsid(self):
        self.detach(False)


if __name__ == "__main__":
    unittest.main()
