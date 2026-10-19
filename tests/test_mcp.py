"""The office as an MCP server (mcp.py): the JSON-RPC exchange, each tool against a stand-in API, and that nothing
hires or stops a lane."""
import io
import json
import unittest
from unittest.mock import patch

from office import mcp

PUBLIC = {"version": "9", "office": {"name": "Test office", "level": 4}, "totals": {"needs_you": 2}, "lanes": {"running": 1},
          "seats": [{"id": "c2", "name": "Atlas", "kind": "claude", "status": "working", "five_hour": {"used_pct": 40, "resets_at": 1_800_000_000},
                     "weekly": None, "sessions": 2, "working": 1, "lanes": 1}]}
STATE = {"next_pick": {"seat": "c2", "why": "most plan left"},
         "lanes": [{"id": "l1", "title": "Fix it", "status": "running", "seat": "c2"}, {"id": "l2", "title": "Docs", "status": "done", "report_status": "STATUS: DONE"}]}


def api(method, path, body=None):
    if path == "/api/public":
        return PUBLIC
    if path == "/api/state":
        return STATE
    if path.startswith("/api/lane?id="):
        return {"lane": {"title": "Fix it", "status": "done"}, "report": "STATUS: DONE - fixed", "state": "tests green"}
    if path in ("/api/event", "/api/ask"):
        api.posted.append((path, body))
        return {"ok": True, "found_session": True}
    raise AssertionError(path)


class McpTests(unittest.TestCase):
    def setUp(self):
        api.posted = []
        p = patch.object(mcp, "_call", side_effect=api)
        p.start(); self.addCleanup(p.stop)

    def rpc(self, method, params=None, mid=1):
        return mcp.handle({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})

    def text(self, name, **args):
        r = self.rpc("tools/call", {"name": name, "arguments": args})["result"]
        return r["content"][0]["text"], r.get("isError", False)

    def test_the_handshake_and_the_tools(self):
        init = self.rpc("initialize", {"protocolVersion": "2025-06-18"})["result"]
        self.assertEqual((init["protocolVersion"], init["capabilities"]), ("2025-06-18", {"tools": {}}))
        names = [t["name"] for t in self.rpc("tools/list")["result"]["tools"]]
        self.assertEqual(names, ["office_status", "next_seat", "list_lanes", "lane_report", "post_news", "ask_ceo"])
        self.assertFalse(any(w in n for n in names for w in ("hire", "stop", "resume")))   # nothing that spends a plan
        self.assertIsNone(mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertEqual(self.rpc("nope")["error"]["code"], -32601)
        self.assertEqual(self.rpc("tools/call", {"name": "hire_lane"})["error"]["code"], -32602)

    def test_each_tool(self):
        self.assertIn("Atlas (c2, claude): working; 5-hour window 40% used", self.text("office_status")[0])
        self.assertIn("Needs the CEO: 2", self.text("office_status")[0])
        self.assertEqual(self.text("next_seat")[0], "The next lane goes to c2: most plan left")
        self.assertIn("l2 [done]", self.text("list_lanes")[0])
        self.assertNotIn("l2", self.text("list_lanes", status="running")[0])
        self.assertIn("STATUS: DONE - fixed", self.text("lane_report", id="l1")[0])
        self.assertEqual(self.text("post_news", text="Deploy done", level="good")[0], "On the floor.")
        self.assertIn("comes back to this session", self.text("ask_ceo", question="Merge now?")[0])
        self.assertEqual([p for p, _ in api.posted], ["/api/event", "/api/ask"])
        self.assertEqual(api.posted[0][1]["source"], "agent")

    def test_an_office_that_is_down_is_an_error_result_not_a_crash(self):
        with patch.object(mcp, "_call", side_effect=RuntimeError("The office is not running on port 7420")):
            text, err = self.text("office_status")
        self.assertTrue(err)
        self.assertIn("not running", text)

    def test_nothing_a_client_sends_ends_it(self):
        out = io.BytesIO()
        lines = [b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":[1]}', b'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"office_status","arguments":"x"}}',
                 b'{"jsonrpc":"2.0","id":3,"result":{}}', b"\xff\xfe", b'{"jsonrpc":"2.0","id":4,"method":"initialize","params":{"protocolVersion":{"x":1}}}',
                 b'{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"lane_report","arguments":{"id":"x"}}}', b'{"jsonrpc":"2.0","id":6,"method":"ping"}']
        text = io.StringIO()
        with patch.object(mcp, "_call", side_effect=KeyError("lane")):
            mcp.serve(io.BytesIO(b"\n".join(lines) + b"\n"), text)
        got = {r.get("id"): r for r in map(json.loads, text.getvalue().splitlines())}
        self.assertEqual(got[1]["error"]["code"], -32602)
        self.assertEqual(got[2]["error"]["code"], -32602)
        self.assertNotIn(3, got)                                   # a response sent to it gets no reply
        self.assertEqual(got[4]["result"]["protocolVersion"], mcp.PROTOCOL)
        self.assertTrue(got[5]["result"]["isError"])              # a tool's own failure is its result, not "no such tool"
        self.assertEqual(got[6]["result"], {})                    # and it is still answering

    def test_over_stdio_one_message_a_line(self):
        out = io.StringIO()
        mcp.serve(io.StringIO('{"jsonrpc":"2.0","id":7,"method":"ping"}\nnot json\n\n[1]\n'), out)
        lines = [json.loads(l) for l in out.getvalue().splitlines()]
        self.assertEqual(lines[0], {"jsonrpc": "2.0", "id": 7, "result": {}})
        self.assertEqual([l["error"]["code"] for l in lines[1:]], [-32700, -32600])


if __name__ == "__main__":
    unittest.main()
