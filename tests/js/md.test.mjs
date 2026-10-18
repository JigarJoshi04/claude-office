// The chat's markdown: everything is escaped first, then a small, safe subset is formatted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { md } from "../../web/ui/md.js";

test("escapes HTML before formatting anything", () => {
  assert.equal(md("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(md("**<b>x</b>**"), "<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>");
  assert.ok(!md('[x](javascript:alert(1))').includes("href"));
  assert.ok(!md('[x]("onmouseover=alert(1))').includes("href"));
});

test("inline: bold, italics, code and links", () => {
  assert.equal(md("a **b** c"), "<p>a <strong>b</strong> c</p>");
  assert.equal(md("use `npm test` now"), "<p>use <code>npm test</code> now</p>");
  assert.equal(md("`**not bold**`"), "<p><code>**not bold**</code></p>");
  assert.equal(md("an *aside* here"), "<p>an <em>aside</em> here</p>");
  assert.equal(md("2 * 3 * 4"), "<p>2 * 3 * 4</p>");
  assert.equal(md("see [the PR](https://github.com/a/b/pull/1)"), '<p>see <a href="https://github.com/a/b/pull/1" target="_blank" rel="noopener noreferrer">the PR</a></p>');
});

test("blocks: paragraphs, lists, headings and fenced code", () => {
  assert.equal(md("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>");
  assert.equal(md("- a\n- b **c**"), "<ul><li>a</li><li>b <strong>c</strong></li></ul>");
  assert.equal(md("1. first\n2. second"), "<ol><li>first</li><li>second</li></ol>");
  assert.equal(md("## Plan\nNext"), '<p class="md-h">Plan</p><p>Next</p>');
  assert.equal(md("```js\nconst a = 1 < 2;\n```"), '<pre><code>const a = 1 &lt; 2;</code></pre>');
  assert.equal(md("```\nunclosed <x>"), "<pre><code>unclosed &lt;x&gt;</code></pre>");
  assert.equal(md("| a | b |\n|---|---|\n| 1 | 2 |"), '<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>');
});
