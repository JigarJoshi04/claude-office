// Brief share codes: a template as one line to paste in a chat ("co-brief:v1:" + base64url of {name, title, brief}),
// and the checks an imported one gets. A shared brief is instructions an agent will follow, so nothing imported runs
// by itself: it is shown in full first and only ever kept as a template.
const PREFIX = "co-brief:v1:";
export const LIMITS = { name: 40, title: 80, brief: 20000 };      // the same as a team template's (office/teamtpl.py)

export function encodeBrief(t) {
  const bytes = new TextEncoder().encode(JSON.stringify({ name: t.name, title: t.title, brief: t.brief }));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// {name, title, brief} from a code, or an Error that says what is wrong with it. Only those three keys are kept.
export function decodeBrief(code) {
  const s = String(code || "").replace(/\s+/g, "");
  if (!s.startsWith(PREFIX)) throw new Error("That is not a brief code: one starts with co-brief:v1:");
  const broken = () => new Error("The code is damaged: copy it again in full.");
  let obj;
  try {
    const b64 = s.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { throw broken(); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw broken();
  const out = {};
  for (const k of ["name", "title", "brief"]) {
    if (typeof obj[k] !== "string" || !obj[k].trim()) throw new Error(`The code has no ${k}.`);
    if (obj[k].length > LIMITS[k]) throw new Error(`Its ${k} is too long (at most ${LIMITS[k].toLocaleString()} characters).`);
    out[k] = k === "name" ? obj[k].trim() : obj[k];
  }
  return out;
}

// Text that looks like a key or a password (the office's own masks, sessions.SECRET_RE, in short): warned about
// before a brief is shared, before an imported one is kept, and before a lane is hired with it.
const SECRET = /(sk-ant-[\w-]{8,}|sk-[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|glpat-[\w-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[\w-]{35}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|hooks\.slack\.com\/services\/[\w/-]{20,}|\b(?:password|passwd|secret|api[_-]?key|access[_-]?key)\w{0,30}["']?\s*[=:]\s*["']?(?=[^\s'",}]*[A-Za-z])[^\s'",}]{6,})/i;
export const looksSecret = (text) => SECRET.test(text || "");
