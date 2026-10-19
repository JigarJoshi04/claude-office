"""The stuck rescuer (rescue.py): its nudge, and the ladder fields on Needs-you items."""
import unittest

from office import rescue
from office.snapshot import Office


def snap(x, nudged=None):
    return {"now": 1_800_000_000, "seats": [{"id": "claude2", "label": "claude2", "kind": "claude", "status": "working", "usage": {}, "sessions": [x]}],
            "lanes": [], "units": [], "asks": [], "office": {}, "nudged": nudged or {}}


class RescueTests(unittest.TestCase):
    def test_the_nudge_says_what_the_office_sees(self):
        self.assertIn("quiet for 23 minutes", rescue.nudge_text({"state": "stuck", "quiet_s": 1400}))
        self.assertIn("same call 9 times in a row (ran: pytest)", rescue.nudge_text({"state": "working", "loop": {"count": 9, "text": "ran: pytest"}}))

    def test_stuck_and_looping_items_carry_the_ladder(self):
        x = {"id": "s1", "name": "api", "state": "stuck", "quiet_s": 1400, "talk": "direct", "lane_id": "1019-x", "live": True, "kind": "lane"}
        it = next(a for a in Office._attention(snap(x, {"s1": 1_799_999_000})) if a.get("stuck"))
        self.assertEqual((it["talk"], it["lane_id"], it["nudged_at"]), ("direct", "1019-x", 1_799_999_000))
        y = {"id": "s2", "name": "web", "state": "working", "talk": "review", "live": True, "kind": "desk", "loop": {"count": 9, "text": "ran: pytest"}}
        it = next(a for a in Office._attention(snap(y)) if a.get("loop"))
        self.assertEqual((it["talk"], it["nudged_at"]), ("review", None))


if __name__ == "__main__":
    unittest.main()
