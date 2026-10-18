// Static wiring checks: every app.X the UI modules call is defined in web/app.js. A refactor that drops one (3.16
// dropped app.badge and app.bump) turns a successful hire or message into a "Could not …" toast at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../web/", import.meta.url);
const app = readFileSync(new URL("app.js", root), "utf8");
const literal = app.slice(app.indexOf("const app = {"), app.indexOf("\n};", app.indexOf("const app = {")));
const defined = new Set([...app.matchAll(/\bapp\.([A-Za-z_]\w*)\s*=/g)].map(m => m[1]));
for (const m of literal.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_]\w*)\s*[:(,]/gm)) defined.add(m[1]);   // key: …, method(…), async method(…), shorthand,

test("every app.X called from web/ui and web/app.js is defined", () => {
  const files = ["app.js", ...readdirSync(new URL("ui/", root)).filter(f => f.endsWith(".js")).map(f => "ui/" + f)];
  const missing = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, root), "utf8");
    for (const m of src.matchAll(/\bapp\.([A-Za-z_]\w*)\s*\(/g)) if (!defined.has(m[1])) missing.push(`${f}: app.${m[1]}()`);
  }
  assert.deepEqual([...new Set(missing)], []);
});
