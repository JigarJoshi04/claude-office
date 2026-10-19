// Brief share codes (web/ui/sharecode.js): what a teammate pastes must come back exactly, and nothing else gets in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBrief, decodeBrief, looksSecret, LIMITS } from "../../web/ui/sharecode.js";

test("a template survives a share code exactly, any language", () => {
  const t = { name: "Fix ✓ test", title: "Réparer l'export", brief: "Goal: 修复\nDone when: green 🟢" };
  const code = encodeBrief(t);
  assert.match(code, /^co-brief:v1:[A-Za-z0-9_-]+$/);                 // one line, safe in any chat
  assert.deepEqual(decodeBrief(code), t);
  assert.deepEqual(decodeBrief("  " + code.slice(0, 30) + "\n" + code.slice(30) + " "), t);   // wrapped by a chat app
});

test("only the name, title and brief are kept", () => {
  const raw = JSON.stringify({ name: "x", title: "y", brief: "z", permission_mode: "bypassPermissions", workdir: "/" });
  const code = "co-brief:v1:" + Buffer.from(raw).toString("base64url");
  assert.deepEqual(decodeBrief(code), { name: "x", title: "y", brief: "z" });
});

test("a broken, empty or oversized code says what is wrong", () => {
  assert.throws(() => decodeBrief("hello"), /not a brief code/);
  assert.throws(() => decodeBrief("co-brief:v1:%%%"), /damaged/);
  assert.throws(() => decodeBrief("co-brief:v1:" + Buffer.from("[1]").toString("base64url")), /damaged/);
  assert.throws(() => decodeBrief(encodeBrief({ name: " ", title: "t", brief: "b" })), /no name/);
  assert.throws(() => decodeBrief(encodeBrief({ name: "n", title: "t", brief: "b".repeat(LIMITS.brief + 1) })), /too long/);
  assert.throws(() => decodeBrief("co-brief:v1:" + Buffer.from([0xff, 0xfe]).toString("base64url")), /damaged/);   // not UTF-8
});

test("keys and passwords are noticed, ordinary briefs are not", () => {
  for (const s of ["use ghp_abcdefghijklmnopqrstuvwxyz1234", "sk-ant-api03-abcdefghij", "password = hunter2x", "-----BEGIN RSA PRIVATE KEY-----", "AKIAABCDEFGHIJKLMNOP"])
    assert.ok(looksSecret(s), s);
  for (const s of ["Done when: the tests pass", "Fix the token counter in tokens.py", "commit 4cb86f6", "api_key handling in auth.py"])
    assert.ok(!looksSecret(s), s);
});
