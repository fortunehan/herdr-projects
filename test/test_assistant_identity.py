"""Assistant recipient recovery and pending news, with isolated persistent state and a fake core."""
import home_guard  # noqa: F401
import contextlib
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mods/tasks/bin"))
from herdr_task import assistant_identity as identity, launch, news, assistant_settings, reactions, home
from test_herdr_task import Store


class RecipientRecovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ, {
            "HOME": str(self.root), "HERDR_APP_HOME": str(self.root),
            "XDG_STATE_HOME": str(self.root / "state"), "HC_SESSION": "default"}))
        self.terms = {"t2": {"address": "t2", "state": "live", "cwd": "/same-folder", "labels": {
            "herdr.role": "coordinator", "herdr.chat": "p7"}}}
        self.calls = []
        self.label_ok = True
        self.label_saved = True
        self.stack.enter_context(mock.patch.object(launch, "hc_json", self.hc))
        self.stack.enter_context(mock.patch.object(launch, "run", self.run_hc))

    def slots(self, rows=None):
        rows = rows if rows is not None else {"slot1": {"space": "sp1", "tab": "tb1", "pane": "p7"}}
        (self.root / "shared.json").write_text(json.dumps({"coordinator.slots": rows}))

    def hc(self, *args):
        self.calls.append(args)
        if args[0] == "ls":
            return {"terminals": copy.deepcopy(list(self.terms.values()))}
        if args[0] == "get":
            return copy.deepcopy(self.terms.get(args[1]))
        raise AssertionError(args)

    def run_hc(self, args):
        self.calls.append(tuple(args))
        self.assertEqual(args[:2], ["hc", "label"])
        if self.label_ok and self.label_saved:
            self.terms[args[2]]["labels"].update(dict(x.split("=", 1) for x in args[3:]))
        return subprocess.CompletedProcess(args, 0 if self.label_ok else 1, "", "")

    def test_recovery_writes_and_verifies_route_then_stays_on_fast_path(self):
        self.slots()
        self.assertEqual(launch.coordinator_in("sp1"), "t2")
        self.assertEqual(launch.coordinator_tab("t2"), "tb1")
        self.assertEqual(self.terms["t2"]["labels"]["herdr.coordinator.space"], "sp1")
        with mock.patch.object(identity, "saved_chats", side_effect=AssertionError("normal route read mappings")):
            self.assertEqual(launch.coordinator_in("sp1"), "t2")
        self.assertEqual(sum(c[:2] == ("hc", "label") for c in self.calls), 1)

    def test_ambiguous_mapping_has_no_side_effects(self):
        self.slots({"a": {"space": "sp1", "tab": "tb1", "pane": "p7"},
                    "b": {"space": "sp2", "tab": "tb2", "pane": "p7"}})
        before = copy.deepcopy(self.terms)
        with self.assertWarnsRegex(UserWarning, "ambiguous"):
            self.assertIsNone(launch.coordinator_in("sp1"))
        self.assertEqual(self.terms, before)
        self.assertFalse(any(c[0] == "hc" for c in self.calls))

    def test_same_folder_or_remote_slot_never_establishes_ownership(self):
        self.slots({"remote": {"space": "vm/sp1", "tab": "vm/tb1", "pane": "vm/p7", "folder": "/same-folder"}})
        with self.assertWarnsRegex(UserWarning, "missing"):
            self.assertIsNone(launch.coordinator_in("sp1"))
        self.assertIsNone(launch.coordinator_in("vm/sp1"))
        self.assertFalse(any(c[0] == "hc" for c in self.calls))

    def test_failed_or_unconfirmed_label_write_is_not_a_recipient(self):
        self.slots()
        for ok, saved in ((False, False), (True, False)):
            self.label_ok, self.label_saved = ok, saved
            with self.assertWarns(UserWarning):
                self.assertIsNone(launch.coordinator_in("sp1"))

    def test_duplicate_live_assistants_are_not_arbitrarily_selected(self):
        self.slots()
        self.terms["t3"] = {"address": "t3", "state": "live", "labels": {
            "herdr.role": "coordinator", "herdr.coordinator.space": "sp1"}}
        with self.assertWarnsRegex(UserWarning, "multiple live Assistants"):
            self.assertIsNone(launch.coordinator_in("sp1"))
        self.assertFalse(any(c[0] == "hc" for c in self.calls))

    def test_conflicting_slot_and_chat_are_refused(self):
        self.slots({"slot1": {"space": "sp1", "tab": "tb1", "pane": "p7"},
                    "slot2": {"space": "sp2", "tab": "tb2", "pane": "p8"}})
        self.terms["t2"]["labels"]["herdr.chat.slot"] = "slot2"
        with self.assertWarnsRegex(UserWarning, "ambiguous"):
            self.assertIsNone(launch.coordinator_in("sp1"))

    def test_slot_origin_can_recover_without_chat_label(self):
        self.slots()
        self.terms["t2"]["labels"] = {"herdr.role": "coordinator", "herdr.chat.origin": "slot:slot1"}
        self.assertEqual(launch.coordinator_in("sp1"), "t2")

    def test_only_assistants_get_detail_reads(self):
        self.terms["t2"]["labels"].update({"herdr.space": "sp1", "herdr.tab": "tb1"})
        original = self.hc
        def many(*args):
            result = original(*args)
            if args == ("ls",):
                result["terminals"] += [{"address": f"worker-{i}", "state": "live"} for i in range(2000)]
            return result
        with mock.patch.object(launch, "hc_json", many):
            self.assertEqual(launch.coordinator_in("sp1"), "t2")
        self.assertEqual([c for c in self.calls if c[0] == "get"], [("get", "t2")])

    def news_fixture(self):
        task = {"id": 68, "title": "Fix fixture", "state": "done", "space": "sp1", "merged": True}
        store = Store([task])
        store.loc["folder"] = str(self.root)
        path = self.root / "news.json"
        line = news.news_line(store, task, {"status": "done"}, "done")
        path.write_text(json.dumps({"seen": {"f": {"_init": True, "68": {"status": "done"}}}, "outbox": [{
            "key": "f#68", "space": "sp1", "event": "done", "status": "done", "text": line, "at": 10000}]}))
        self.send_ok, self.sent = True, []
        def send(args, **kwargs):
            self.assertEqual(args[:2], ["hc", "send"])
            if self.send_ok:
                self.sent.append((args[2], args[3]))
            return subprocess.CompletedProcess(args, 0 if self.send_ok else 1, "", "")
        for mod, name, value in (
            (news, "NEWS", str(path)), (news, "now", lambda: 20000),
            (news, "store_files", lambda folder: ["fixture"]),
            (news, "read_list", lambda p: {"folder": str(self.root), "tasks": [task]}),
            (news, "locate", lambda folder: store.loc), (news, "Store", lambda *a, **kw: store),
            (news, "hc_json", self.hc), (news, "typing", lambda addr: False), (news, "guard", lambda args: None),
            (news.subprocess, "run", send), (news, "news_read", lambda quiet: None),
            (news, "held_pass", lambda report: None), (assistant_settings, "settings_pass", lambda *a: None),
            (reactions, "reactions_pass", lambda *a: None), (home, "log_news", lambda rows: None)):
            self.stack.enter_context(mock.patch.object(mod, name, value))
        return task, path

    def test_pending_merged_news_recovers_route_and_delivers_once(self):
        self.slots()
        _, path = self.news_fixture()
        report = {}
        news.news_pass(report)
        news.news_pass(report)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][0], "t2")
        self.assertIn("SHEP-68 is done: merged", self.sent[0][1])
        self.assertEqual(json.loads(path.read_text())["outbox"], [])
        self.assertEqual(len(report["news"]), 1)

    def test_pending_merged_news_reaches_replacement_after_legacy_chat_restart(self):
        from test_restart import AssistantIdentity
        restart = AssistantIdentity()
        try:
            result = restart.restart({"herdr.role": "coordinator", "herdr.space": "sp1", "herdr.tab": "tb1"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.terms = restart.state
            _, path = self.news_fixture()
            news.news_pass({})
            news.news_pass({})
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.sent[0][0], "t9")
            self.assertIn("SHEP-68 is done: merged", self.sent[0][1])
            self.assertEqual(json.loads(path.read_text())["outbox"], [])
        finally:
            restart.doCleanups()

    def test_failed_send_stays_pending_until_success(self):
        self.slots()
        _, path = self.news_fixture()
        self.send_ok = False
        news.news_pass({})
        self.assertEqual(len(json.loads(path.read_text())["outbox"]), 1)
        self.send_ok = True
        news.news_pass({})
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(json.loads(path.read_text())["outbox"], [])

    def test_ambiguous_route_keeps_news_pending(self):
        self.slots({"a": {"space": "sp1", "tab": "tb1", "pane": "p7"},
                    "b": {"space": "sp2", "tab": "tb2", "pane": "p7"}})
        _, path = self.news_fixture()
        with self.assertWarnsRegex(UserWarning, "ambiguous"):
            news.news_pass({})
        self.assertEqual(self.sent, [])
        self.assertEqual(len(json.loads(path.read_text())["outbox"]), 1)

    def test_stale_merged_news_is_not_delivered_after_recovery(self):
        self.slots()
        task, path = self.news_fixture()
        task["state"] = "todo"
        news.news_pass({})
        self.assertEqual(self.sent, [])
        self.assertEqual(json.loads(path.read_text())["outbox"], [])


if __name__ == "__main__":
    unittest.main()
