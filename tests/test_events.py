import unittest

from office import server


class InboundEventTests(unittest.TestCase):
    def test_a_scripts_news_is_checked(self):
        ok = server.inbound_event({"text": "  Prod   deploy done ", "level": "good", "seat": "claude", "source": "deploy", "banner": True}, ["claude"])
        self.assertEqual(ok, {"text": "Prod deploy done", "level": "good", "seat": "claude", "source": "deploy", "banner": True})
        self.assertEqual(server.inbound_event({"text": "x"}, [])["level"], "info")
        for bad in ({"text": ""}, {"text": "x" * 141}, {"text": "x", "level": "loud"}, {"text": "x", "seat": "nobody"},
                    {"text": "x", "source": "<script>"}, {"text": "x", "banner": "yes"}, {"text": 3}, []):
            with self.assertRaises(ValueError, msg=bad):
                server.inbound_event(bad, ["claude"])

    def test_at_most_thirty_a_minute(self):
        server._EVENTS.clear()
        self.assertTrue(all(server._event_budget(now=1000 + i) for i in range(30)))
        self.assertFalse(server._event_budget(now=1031))
        self.assertTrue(server._event_budget(now=1061))                       # the first ones have aged out
        server._EVENTS.clear()


if __name__ == "__main__":
    unittest.main()
