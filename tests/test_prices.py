import json
import tempfile
import unittest
from pathlib import Path

from office import prices
from office.tokens import TokenLedger


class PriceTests(unittest.TestCase):
    def test_models_match_their_price_rows(self):
        self.assertEqual(prices.base_model("claude-opus-5-5"), "claude-opus-5-5")
        self.assertEqual(prices.base_model("claude-opus-5"), "claude-opus-5")            # not mistaken for 5.5
        self.assertEqual(prices.base_model("claude-opus-5-20260301"), "claude-opus-5")
        self.assertEqual(prices.base_model("claude-haiku-4-5-20251001"), "claude-haiku-4-5")
        self.assertIsNone(prices.base_model("<synthetic>"))
        self.assertIsNone(prices.base_model("claude-opus-9"))

    def test_one_response_at_list_price(self):
        u = {"input_tokens": 2, "cache_creation_input_tokens": 1375, "cache_read_input_tokens": 261320, "output_tokens": 870,
             "cache_creation": {"ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 1375}}
        self.assertEqual(prices.response_cost("claude-opus-5-5", u), round((2 * 4 + 1375 * 5 + 261320 * 0.2 + 870 * 20)))
        hour = dict(u, cache_creation={"ephemeral_1h_input_tokens": 1375, "ephemeral_5m_input_tokens": 0})
        self.assertEqual(prices.response_cost("claude-opus-5-5", hour) - prices.response_cost("claude-opus-5-5", u), 1375 * 3)
        self.assertEqual(prices.response_cost("claude-opus-5-5", dict(u, speed="fast")), 2 * prices.response_cost("claude-opus-5-5", u))
        self.assertEqual(prices.response_cost("claude-sonnet-5-5", dict(u, speed="fast")), prices.response_cost("claude-sonnet-5-5", u))
        self.assertEqual(prices.response_cost("claude-opus-5-5", dict(u, inference_geo="us")), round(prices.response_cost("claude-opus-5-5", u) * 1.1))
        no_split = {"input_tokens": 0, "cache_creation_input_tokens": 1000, "output_tokens": 0}          # older lines: 5-minute writes
        self.assertEqual(prices.response_cost("claude-haiku-4-5", no_split), 1250)
        short = {"input_tokens": 50_000, "output_tokens": 1000}
        long = {"input_tokens": 50_000, "cache_read_input_tokens": 60_000, "output_tokens": 1000}     # over 100k: the higher tier
        self.assertEqual(prices.response_cost("claude-haiku-5-5", short), round(50_000 * 0.1 + 1000 * 0.5))
        self.assertEqual(prices.response_cost("claude-haiku-5-5", long), round(50_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5))
        self.assertIsNone(prices.response_cost("mystery-model", u))

    def test_plans(self):
        self.assertEqual(prices.plan_usd({"health": {"tier": "Max 5x"}}), 100)
        self.assertEqual(prices.plan_usd({"health": {"tier": "Max 5x"}, "plan_usd": 150}), 150)
        self.assertIsNone(prices.plan_usd({"health": {"tier": "gpt-6-astra"}}))
        self.assertEqual(prices.plan_usd({"health": {"tier": "gpt-6-astra"}, "plan_usd": 0}), 0)


class LedgerValueTests(unittest.TestCase):
    def test_each_response_is_priced_once_and_set_against_the_plans(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            proj = root / ".claude" / "projects" / "-w"
            proj.mkdir(parents=True)
            (root / ".claude" / "session-env" / "s1").mkdir(parents=True)
            usage = {"input_tokens": 0, "cache_creation_input_tokens": 1_000_000, "cache_read_input_tokens": 10_000_000, "output_tokens": 100_000,
                     "cache_creation": {"ephemeral_5m_input_tokens": 1_000_000, "ephemeral_1h_input_tokens": 0}}
            line = lambda mid, extra=None: json.dumps({"type": "assistant", "timestamp": "2026-10-18T10:00:00Z", "message": {
                "id": mid, "model": "claude-opus-5-5", "usage": usage, "content": extra or []}}, separators=(",", ":")) + "\n"
            bash = [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "git commit -m x"}}]
            result = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "[main 1234567] x"}]}}) + "\n"
            (proj / "s1.jsonl").write_text(line("m1") + line("m1") + line("m2", bash) + result)   # m1 written twice; m2 also runs git
            led = TokenLedger(root / "tokens.json", [("claude", root / ".claude")])
            led.scan()
            seats = [{"id": "claude", "kind": "claude", "health": {"tier": "Max 20x"}}]
            v = led.view(seats, today="2026-10-18", rng="today")
            one = 1_000_000 * 5 / 1e6 + 10_000_000 * 0.2 / 1e6 + 100_000 * 20 / 1e6        # $9 a response
            self.assertAlmostEqual(v["total"]["usd"], 2 * one)
            self.assertEqual(v["shipped"]["commits"], 1)                                      # the priced line still ships
            self.assertEqual(v["value"]["plans"], {"claude": 200})
            self.assertAlmostEqual(v["value"]["plan_usd"], round(200 / 30.44, 2))
            self.assertAlmostEqual(v["value"]["multiple"], round(2 * one / (200 / 30.44), 1))
            self.assertEqual(v["value"]["estimated"], 0)
            self.assertAlmostEqual(v["days"][-1]["usd"], 2 * one)
            self.assertAlmostEqual(v["models"][0]["usd"], 2 * one)
            self.assertAlmostEqual(v["sessions"][0]["usd"], 2 * one)
            led.scan()                                                                        # nothing priced twice
            self.assertAlmostEqual(led.view(seats, today="2026-10-18")["total"]["usd"], 2 * one)

    def test_sessions_without_prices_are_estimated(self):
        from office.demo import _demo_token_ledger
        led = _demo_token_ledger()
        seats = [{"id": "astra", "kind": "codex", "health": {"tier": "gpt-6-astra"}}]
        v = led.view(seats, rng="30", seat="astra")                       # Codex is priced from its totals
        self.assertGreater(v["total"]["usd"], 0)
        self.assertEqual(v["value"]["estimated"], 0)                      # its formula is exact, not an estimate
        self.assertIsNone(v["value"]["multiple"])                         # no plan price for Codex unless set


class PlanSettingTests(unittest.TestCase):
    def test_plan_price_is_validated(self):
        from office import settings
        self.assertEqual(settings.validate({"seats": {"claude": {"plan_usd": 150}}})["seats"]["claude"]["plan_usd"], 150)
        self.assertIsNone(settings.validate({"seats": {"claude": {"plan_usd": None}}})["seats"]["claude"]["plan_usd"])
        for bad in (-1, 10001, "100", True):
            with self.assertRaises(ValueError):
                settings.validate({"seats": {"claude": {"plan_usd": bad}}})


if __name__ == "__main__":
    unittest.main()


class LookSettingTests(unittest.TestCase):
    def test_a_characters_look_is_validated(self):
        from office import settings
        out = settings.validate({"seats": {"claude": {"look": {"skin": 2, "hair": 8, "style": 5, "glasses": True}}}, "ceo_name": "Me", "ceo_look": {"style": 4}})
        self.assertEqual(out["seats"]["claude"]["look"], {"skin": 2, "hair": 8, "style": 5, "glasses": True})
        self.assertEqual(out["ceo"], {"name": "Me", "look": {"style": 4}})
        self.assertIsNone(settings.validate({"seats": {"claude": {"look": None}}})["seats"]["claude"]["look"])
        for bad in ({"skin": 6}, {"style": -1}, {"hair": "1"}, {"glasses": 1}, {"hat": 1}, "x"):
            with self.assertRaises(ValueError):
                settings.validate({"seats": {"claude": {"look": bad}}})
