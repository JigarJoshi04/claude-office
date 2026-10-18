"""The CEO at the computer or away (office/presence.py), from a fake desktop."""
import unittest

from office.presence import Presence, AWAY_IDLE_S


class PresenceTests(unittest.TestCase):
    def test_away_and_back(self):
        reading = {"locked": False, "idle_s": 3.0, "source": "gnome"}
        p = Presence(reader=lambda: dict(reading))
        self.assertTrue(p.tick(1000.0)["present"])
        reading.update(idle_s=AWAY_IDLE_S + 60)                         # no input for six minutes
        st = p.tick(1400.0)
        self.assertEqual((st["present"], st["away_since"]), (False, 1400.0 - AWAY_IDLE_S - 60))
        reading.update(locked=True, idle_s=900)
        self.assertEqual(p.tick(2000.0)["away_since"], 1400.0 - AWAY_IDLE_S - 60)   # still the same absence
        reading.update(locked=False, idle_s=1)
        st = p.tick(3000.0)
        self.assertEqual((st["present"], st["away_since"], st["last_away"]), (True, None, {"from": 1040.0, "to": 3000.0}))

    def test_a_locked_screen_is_away_and_unknown_desktops_say_nothing(self):
        self.assertFalse(Presence(reader=lambda: {"locked": True, "idle_s": None, "source": "gnome"}).tick(10.0)["present"])
        self.assertIsNone(Presence(reader=lambda: {"locked": None, "idle_s": None, "source": None}).tick(10.0)["present"])


class GdbusTests(unittest.TestCase):
    def test_idle_time_from_the_real_answer(self):
        from office.presence import idle_from
        self.assertEqual(idle_from("(uint64 596171,)"), 596.171)     # not the 64 of "uint64"
        self.assertIsNone(idle_from(""))
        self.assertIsNone(idle_from(None))
