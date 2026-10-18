"""trust.py: a report's claim of done against its own last test run."""
import json
import tempfile
import unittest
from pathlib import Path

from office import trust
from office.sessions import TranscriptState


class TrustTests(unittest.TestCase):
    def test_verdicts(self):
        t = trust.trust_of
        self.assertIsNone(t(None, True, 10, 5))
        self.assertIsNone(t("STATUS: BLOCKED - no access", False, 10, 5))
        self.assertIsNone(t("Notes so far", False, 10, 5))                              # no claim, nothing to check
        self.assertEqual(t("STATUS: DONE - shipped", False, 10, 5)["level"], "contradicted")
        self.assertEqual(t("STATUS: READY #12", True, 10, 5)["level"], "verified")
        self.assertEqual(t("STATUS: DONE", True, 10, None)["level"], "verified")
        self.assertEqual(t("STATUS: DONE", True, 5, 10)["why"], "it changed code after its last passing test run")
        self.assertEqual(t("STATUS: COMPLETE", None, None, 10)["why"], "no test run in its transcript")

    def test_a_transcript_knows_its_last_change(self):
        st = TranscriptState(Path("/nonexistent"))
        line = lambda ts, name, inp: json.dumps({"type": "assistant", "timestamp": ts, "message": {"id": ts, "content": [
            {"type": "tool_use", "id": "t" + ts, "name": name, "input": inp}]}}).encode()
        st.feed_line(line("2026-10-19T10:00:00Z", "Edit", {"file_path": "/w/a.py"}))
        st.feed_line(line("2026-10-19T10:05:00Z", "Edit", {"file_path": "/lane/STATE.md"}))       # notes are not code
        first = st.edit_at
        self.assertIsNotNone(first)
        st.feed_line(line("2026-10-19T10:09:00Z", "Write", {"file_path": "/w/b.py"}))
        self.assertGreater(st.edit_at, first)

    def test_the_store_keeps_verdicts_across_restarts(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = trust.Store(Path(tmp) / "trust.json")
            s.put("s1", {"level": "contradicted", "why": "x", "at": 100.0})
            self.assertEqual(trust.Store(Path(tmp) / "trust.json").get("s1")["level"], "contradicted")
            self.assertEqual([k for k, _ in s.recent(50)], ["s1"])
            self.assertEqual(s.recent(200), [])


class AttentionTests(unittest.TestCase):
    def test_a_contradicted_claim_needs_you(self):
        from office.snapshot import Office, attention_key
        snap = {"now": 1000.0, "asks": [], "lanes": [], "units": [], "office": {},
                "seats": [{"id": "c", "label": "claude", "kind": "claude", "status": "ok", "usage": {}, "sessions": []}],
                "contradicted": [{"session": "s1", "seat": "c", "lane": "l1", "name": "api", "level": "contradicted", "why": "its last test run failed"}]}
        items = [a for a in Office._attention(snap) if a.get("trust")]
        self.assertEqual(items[0]["text"], "api on claude says it is done, but its last test run failed")
        self.assertEqual(items[0]["lane"], "l1")                                          # gone from the floor: its lane
        self.assertEqual(attention_key(items[0]), "trust:s1")


if __name__ == "__main__":
    unittest.main()
