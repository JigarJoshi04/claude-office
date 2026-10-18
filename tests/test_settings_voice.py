import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from office import config, settings, voice
from office.snapshot import Office


class SettingsTests(unittest.TestCase):
    def test_partial_atomic_merge_permissions_and_public_view(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_DIR", Path(tmp)):
            path = Path(tmp) / "config.json"
            original = {"programmes": [{"name": "Keep"}], "lane_defaults": {"model": "opus"},
                        "ceo": {"name": "Old", "title": "CEO"}, "seats": {"a": {"hidden": False}},
                        "private": {"accessToken": "do-not-expose"}}
            path.write_text(json.dumps(original))
            cfg = settings.save({"office_name": "Workshop", "ceo_name": "Alex", "seats": {
                "a": {"label": "A", "nickname": "", "color": "#AbC123"}},
                "voice": {"enabled": True}, "private": "ignore", "voice_available": True})
            self.assertEqual(cfg["programmes"], original["programmes"])
            self.assertEqual(cfg["lane_defaults"], original["lane_defaults"])
            self.assertEqual(cfg["ceo"], {"name": "Alex", "title": "CEO"})
            self.assertFalse(cfg["seats"]["a"]["hidden"])
            self.assertIsNone(cfg["seats"]["a"]["nickname"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), cfg)
            self.assertEqual(list(Path(tmp).iterdir()), [path])
            with patch.object(settings.shutil, "which", return_value="/bin/jarvis-say"):
                out = settings.view(cfg, [dict(cfg["seats"]["a"], id="a")])
            self.assertTrue(out["voice_available"])
            self.assertEqual(out["voice"]["quiet_hours"], [23, 8])
            self.assertNotIn("private", out)
            self.assertNotIn("hidden", out["seats"]["a"])

    def test_validation_rejects_invalid_values_and_types(self):
        bad = [{"office_name": ""}, {"ceo_name": "x" * 41}, {"ceo_name": 3}, {"seats": []},
               {"seats": {"a": []}}, {"seats": {"../a": {}}}, {"seats": {"a": {"nickname": "x" * 25}}},
               {"seats": {"a": {"label": None}}}, {"seats": {"a": {"color": "#fff"}}},
               {"seats": {"a": {"color": 123456}}}, {"voice": []}, {"voice": {"enabled": 1}},
               {"voice": {"events": ["unknown"]}}, {"voice": {"events": [{}]}},
               {"voice": {"events": "report"}}, {"voice": {"quiet_hours": [23, 24]}},
               {"voice": {"quiet_hours": [False, 8]}}, {"voice": {"quiet_hours": [8]}},
               {"voice": {"quiet_hours": [1.0, 8]}}, {"voice": {"quiet_hours": None}}]
        for body in bad:
            with self.subTest(body=body), self.assertRaises(ValueError):
                settings.validate(body)
        self.assertEqual(settings.validate({"seats": {"a": {"nickname": None}}})["seats"]["a"]["nickname"], None)

    def test_personality_style_is_one_of_the_archetypes(self):
        ok = settings.validate({"seats": {"a": {"style": "The Night Owl"}, "b": {"style": None}}})
        self.assertEqual(ok["seats"]["a"]["style"], "The Night Owl")
        self.assertIsNone(ok["seats"]["b"]["style"])
        for bad in ("The Hacker", "", 3, ["The Builder"]):
            with self.subTest(style=bad), self.assertRaises(ValueError):
                settings.validate({"seats": {"a": {"style": bad}}})
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_DIR", Path(tmp)):
            cfg = settings.save({"seats": {"a": {"style": "The Builder"}}})
            self.assertEqual(settings.view(cfg, [dict(cfg["seats"]["a"], id="a")])["seats"]["a"]["style"], "The Builder")

    def test_invalid_update_or_failed_replace_keeps_existing_config(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_DIR", Path(tmp)):
            path = Path(tmp) / "config.json"
            path.write_text('{"keep":true}')
            with self.assertRaises(ValueError):
                settings.save({"office_name": ""})
            with patch.object(settings.os, "replace", side_effect=OSError("full")), self.assertRaises(OSError):
                settings.save({"office_name": "new"})
            self.assertEqual(path.read_text(), '{"keep":true}')
            self.assertEqual(list(Path(tmp).iterdir()), [path])

    def test_next_build_refreshes_claude_and_codex_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".claude2/sessions").mkdir(parents=True)
            (root / ".codex").mkdir()
            with patch.object(config, "HOME", root), patch.object(config, "CONFIG_DIR", root / "cfg"), \
                 patch.object(config, "STATE_DIR", root / "state"), patch.object(config, "DATA_DIR", root / "data"), \
                 patch("office.snapshot.list_units", return_value=[]), \
                 patch("office.snapshot.read_codex_seat", return_value={"sessions": []}):
                office = Office()
                before = office.build()
                settings.save({"seats": {"claude2": {"label": "Atlas", "color": "#112233"},
                                          "astra": {"label": "Star"}}})
                after = office.build()
                self.assertEqual(after["seats"][0]["label"], "Atlas")
                self.assertEqual(after["seats"][0]["color"], "#112233")
                self.assertEqual(after["seats"][1]["label"], "Star")
                self.assertEqual(after["office"]["version"], "3.69.0")
                self.assertEqual(before["office"]["started_at"], after["office"]["started_at"])

    def test_settings_redacts_configurable_names_and_omits_credentials(self):
        secret = "sk-ant-" + "x" * 25
        cfg = {"office_name": secret, "ceo": {"name": secret}, "accessToken": secret,
               "voice": {"enabled": False, "accessToken": secret}}
        out = settings.view(cfg, [{"id": "a", "label": secret, "nickname": secret, "color": "#123456", "refreshToken": secret}])
        blob = json.dumps(out)
        for forbidden in (secret, "accessToken", "refreshToken"):
            self.assertNotIn(forbidden, blob)


class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000
        self.hour = 12
        self.spawn = Mock()
        self.announcer = voice.Announcer(clock=lambda: self.now,
            localtime=lambda now: time.struct_time((2026, 10, 16, self.hour, 0, 0, 4, 289, -1)),
            popen=self.spawn, which=lambda exe: "/bin/jarvis-say")
        self.cfg = {"voice": {"enabled": True, "events": list(settings.VOICE_EVENTS), "quiet_hours": [23, 8]}}

    def test_phrases_short_without_event_paths_ids_or_secrets(self):
        for kind in settings.VOICE_EVENTS:
            for seat in ("claude3", "/home/private/session", "deadbeef-1234567890"):
                text = voice.phrase({"kind": kind, "seat": seat, "text": "/private/key token=verysecret"})
                self.assertLess(len(text), 90)
                for forbidden in ("/", "1234567890", "verysecret"):
                    self.assertNotIn(forbidden, text)
        self.assertEqual(voice.phrase({"kind": "limit", "seat": "claude3"}), "claude3 hit its usage limit.")
        self.assertIsNone(voice.phrase({"kind": "arrive"}))

    def test_rate_limit_and_detached_spawn(self):
        ev = {"kind": "report", "seat": "claude2"}
        self.announcer.announce(ev, self.cfg)
        self.now += 19
        self.announcer.announce(ev, self.cfg)
        self.assertEqual(self.spawn.call_count, 1)
        self.now += 1
        self.announcer.announce(ev, self.cfg)
        self.assertEqual(self.spawn.call_count, 2)
        self.spawn.assert_called_with(["/bin/jarvis-say", "claude2 filed a report."], start_new_session=True,
                                     stdin=voice.subprocess.DEVNULL, stdout=voice.subprocess.DEVNULL, stderr=voice.subprocess.DEVNULL)

    def test_quiet_hours_wrap_and_daytime_boundaries(self):
        for hours, silent, spoken in (([23, 8], [23, 0, 7], [8, 22]), ([9, 17], [9, 12, 16], [8, 17]),
                                      ([8, 8], [], [0, 8, 23])):
            self.cfg["voice"]["quiet_hours"] = hours
            for hour in silent + spoken:
                self.hour = hour
                self.now += 21
                before = self.spawn.call_count
                self.announcer.announce({"kind": "report"}, self.cfg)
                self.assertEqual(self.spawn.call_count - before, int(hour in spoken))

    def test_disabled_demo_filters_levels_and_unavailable(self):
        ev = {"kind": "report"}
        self.announcer.announce(ev, {}, demo=False)
        self.announcer.announce(ev, self.cfg, demo=True)
        for kind, level in (("lane", "warn"), ("lane", "info"), ("usage", "warn"), ("usage", "info"), ("arrive", "good")):
            self.announcer.announce({"kind": kind, "level": level}, self.cfg)
        self.spawn.assert_not_called()
        for kind, level in (("lane", "good"), ("lane", "bad"), ("usage", "bad"), ("stuck", "warn")):
            self.now += 21
            self.announcer.announce({"kind": kind, "level": level}, self.cfg)
        self.assertEqual(self.spawn.call_count, 4)
        self.now += 21
        self.announcer.which = lambda exe: None
        self.announcer.announce(ev, self.cfg)
        self.assertEqual(self.spawn.call_count, 4)
        self.announcer.which = lambda exe: "/missing"
        self.spawn.side_effect = OSError("gone")
        self.announcer.announce(ev, self.cfg)  # optional voice failures never break snapshots
