"""The lane runner end to end, with a fake `claude`: a seat that hits its usage limit hands the lane to the next seat."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

FAKE_CLAUDE = textwrap.dedent("""\
    #!/usr/bin/env python3
    import os, re, sys
    prompt = sys.argv[sys.argv.index("-p") + 1]
    seat = os.path.basename(os.environ.get("CLAUDE_CONFIG_DIR", ""))
    with open(os.environ["FAKE_CALLS"], "a") as f:
        f.write(seat + "\\n")
    if seat == os.environ["FAKE_LIMITED_SEAT"]:
        print("You've hit your session limit · resets 3am (Asia/Kolkata)")
        sys.exit(1)
    report = re.search(r"REPORT file: (\\S+)", prompt).group(1)
    state = re.search(r"STATE file: (\\S+)", prompt).group(1)
    open(state, "a").write("did the work on " + seat + "\\n")
    open(report, "w").write("STATUS: DONE - fake work finished\\n")
""")

DRIVER = textwrap.dedent("""\
    import json, sys
    from office import config, lanes
    cfg = config.load_config()
    lane = lanes.create_lane("Failover test", "Do the thing.", sys.argv[1], "auto", "haiku", "acceptEdits",
                             ["claude2", "claude3"], cfg, launch=False)
    rc = lanes.run_lane(lane["id"])
    print(json.dumps({"rc": rc, "lane": lanes.load_lane(lane["id"]), "limits": lanes.read_limits()}))
""")


class RunnerFailoverTest(unittest.TestCase):
    def test_limit_moves_the_lane_to_the_next_seat(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            now = time.time()
            for seat in ("claude2", "claude3"):
                d = home / f".{seat}"
                (d / "sessions").mkdir(parents=True)
                (d / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {
                    "accessToken": "fake-access", "refreshToken": "fake-refresh",
                    "expiresAt": int((now + 3600) * 1000), "rateLimitTier": "default_claude_max_5x"}}))
            cfg_dir, state_dir, data_dir = home / "cfg", home / "state", home / "data"
            for d in (cfg_dir, state_dir, data_dir):
                d.mkdir(parents=True)
            # Fresh usage so nothing reaches the network; claude2 has more room, so it is picked first.
            (state_dir / "usage-cache.json").write_text(json.dumps({
                "claude2": {"five_hour": {"pct": 10.0, "resets_at": now + 3600}, "weekly": {"pct": 10.0, "resets_at": now + 86400}, "fetched_at": now},
                "claude3": {"five_hour": {"pct": 40.0, "resets_at": now + 3600}, "weekly": {"pct": 40.0, "resets_at": now + 86400}, "fetched_at": now},
            }))
            (cfg_dir / "divider.json").write_text(json.dumps({"mode": "fixed", "global_max_lanes": 4, "seats": {
                "claude2": {"enabled": True, "weight": 70, "max_lanes": 2},
                "claude3": {"enabled": True, "weight": 30, "max_lanes": 2}}}))
            bindir = Path(tmp) / "bin"
            bindir.mkdir()
            (bindir / "claude").write_text(FAKE_CLAUDE)
            (bindir / "claude").chmod(0o755)
            work = Path(tmp) / "work"
            work.mkdir()
            calls = Path(tmp) / "calls.txt"
            env = dict(os.environ, CLAUDE_OFFICE_HOME=str(home), CLAUDE_OFFICE_CONFIG=str(cfg_dir),
                       CLAUDE_OFFICE_STATE=str(state_dir), CLAUDE_OFFICE_DATA=str(data_dir),
                       PATH=f"{bindir}:{os.environ.get('PATH', '')}", PYTHONPATH=str(REPO),
                       FAKE_CALLS=str(calls), FAKE_LIMITED_SEAT=".claude2")
            out = subprocess.run([sys.executable, "-c", DRIVER, str(work)], env=env, capture_output=True,
                                 text=True, timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr)
            res = json.loads(out.stdout.strip().splitlines()[-1])
            lane = res["lane"]
            self.assertEqual(calls.read_text().split(), [".claude2", ".claude3"])
            self.assertEqual(lane["status"], "done")
            self.assertEqual([r["seat"] for r in lane["runs"]], ["claude2", "claude3"])
            self.assertEqual(lane["runs"][0].get("ended_by"), "limit")
            self.assertIn("claude2", res["limits"], "the limited seat must rest until its reset")
            self.assertGreater(res["limits"]["claude2"], now)


if __name__ == "__main__":
    unittest.main()
