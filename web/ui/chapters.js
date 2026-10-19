// Chapters: every six weeks a free 30-tier track, filled by the XP the whole team earns from real work (career XP,
// office/career.py). Each tier brings a gift (rare every fifth, epic at 15 and 25, and the chapter's trophy at 30);
// past tier 30 every further step is a vault key, another gift. Nothing is lost at the end of a chapter: the next one
// starts fresh. The chapter's start is kept in the game save so every screen counts from the same XP.
import { store } from "./util.js";

const EPOCH = Date.UTC(2026, 0, 5) / 86400000;          // a Monday: chapter 1 began here, every 42 days a new one
export const LENGTH = 42, TIERS = 30;
const VAULT = 25000;                                     // XP for each vault key past the last tier

// The chapter a local day (YYYY-MM-DD) falls in: {n, start, end, daysLeft}.
export function chapterOf(day) {
  const d = Math.floor(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 86400000);
  const n = Math.floor((d - EPOCH) / LENGTH) + 1, s = EPOCH + (n - 1) * LENGTH;
  const iso = (x) => new Date(x * 86400000).toISOString().slice(0, 10);
  return { n, start: iso(s), end: iso(s + LENGTH - 1), daysLeft: s + LENGTH - d };
}
// XP to reach tier t (1-based): a little more for each tier.
export const tierXp = (t) => 8000 * t + 150 * t * t;
// Where XP leaves the track: {tier, into, need, keys} (keys: vault keys past the last tier).
export function tierOf(xp) {
  let t = 0;
  while (t < TIERS && xp >= tierXp(t + 1)) t++;
  const keys = t === TIERS ? Math.floor((xp - tierXp(TIERS)) / VAULT) : 0;
  const from = t === TIERS ? tierXp(TIERS) + keys * VAULT : t ? tierXp(t) : 0, to = t === TIERS ? from + VAULT : tierXp(t + 1);
  return { tier: t, into: xp - from, need: to - from, keys };
}
// What a tier gives: {min, label} (min is the gift's least rarity).
export function rewardFor(t) {
  if (t === TIERS) return { min: "epic", label: "The chapter trophy and an epic gift" };
  if (t === 15 || t === 25) return { min: "epic", label: "An epic gift" };
  if (t % 5 === 0) return { min: "rare", label: "A rare gift" };
  return { min: null, label: "A gift" };
}

// The track now, from the team's XP: base is the XP when the chapter began (kept in the save).
export function trackNow(day, totalXp, demo = false) {
  const ch = chapterOf(day);
  let base = store.get("chapterBase", null);
  if (demo) base = { id: ch.n, xp: Math.max(0, totalXp - 137000) };
  else if (!base || base.id !== ch.n) { base = { id: ch.n, xp: totalXp }; store.set("chapterBase", base); }   // first sight of a chapter
  const xp = Math.max(0, totalXp - base.xp);
  return { ...ch, xp, ...tierOf(xp) };
}

// New tiers reached since the last look: grants their gifts (fixed ids, so two screens never both give one) and
// returns them for the celebration. claimed is kept in the save too.
export function claim(track, grant) {
  const was = store.get("chapterClaimed", null);
  const had = was && was.id === track.n ? was : { id: track.n, tier: 0, keys: 0 };
  const got = [];
  for (let t = had.tier + 1; t <= track.tier; t++) {
    const r = rewardFor(t);
    if (grant(null, "chapter", r.min, null, `chapter-${track.n}-${t}`)) got.push({ tier: t, ...r });
  }
  for (let k = had.keys + 1; k <= track.keys; k++) if (grant(null, "chapter", "rare", null, `vault-${track.n}-${k}`)) got.push({ key: k, label: "A vault key: a rare gift" });
  if (track.tier > had.tier || track.keys > had.keys) store.set("chapterClaimed", { id: track.n, tier: track.tier, keys: track.keys });
  return got;
}
