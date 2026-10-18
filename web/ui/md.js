// A small, safe markdown for chat messages. The text is HTML-escaped first, then a subset is formatted: paragraphs and
// line breaks, **bold**, *italics*, `code`, fenced code blocks, - and 1. lists, # headings, pipe tables and http(s)
// links. Nothing from the message can become a tag or an attribute other than these.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function inline(t) {
  const codes = [];
  t = t.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });   // code is never formatted
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"'<>]+)\)/g, (m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(])\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  return t.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[+i]}</code>`);
}

export function md(text) {
  const lines = esc(text || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(x => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; } };
  const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => inline(c.trim()));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {                                            // a fenced block runs to its close (or the end)
      flushPara(); flushList();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {   // a pipe table
      flushPara(); flushList();
      const head = cells(line), rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); out.push(`<p class="md-h">${inline(h[1])}</p>`); continue; }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join("");
}
