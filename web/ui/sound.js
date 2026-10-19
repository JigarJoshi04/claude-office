// 8-bit sound effects, synthesised with WebAudio (no files). Off until the CEO turns them on.
let ac = null, on = false, last = 0;

function ctx() {
  if (!ac) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ac = new A(); }
  if (ac.state === "suspended") ac.resume();
  return ac;
}
function note(freq, start, len, type = "square", vol = 0.05) {
  const a = ctx(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, a.currentTime + start);
  g.gain.setValueAtTime(0, a.currentTime + start);
  g.gain.linearRampToValueAtTime(vol, a.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + len);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start); o.stop(a.currentTime + start + len + 0.02);
}
const SFX = {
  arrive: () => { note(660, 0, 0.08); note(990, 0.07, 0.1); },
  leave: () => { note(660, 0, 0.08); note(440, 0.07, 0.12); },
  report: () => { [523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.08, 0.14, "square", 0.06)); note(1568, 0.34, 0.25, "triangle", 0.05); },
  limit: () => { note(196, 0, 0.18, "sawtooth", 0.05); note(147, 0.16, 0.3, "sawtooth", 0.05); },
  bad: () => { for (let i = 0; i < 3; i++) note(880, i * 0.16, 0.08, "square", 0.05); },
  click: () => note(1200, 0, 0.03, "square", 0.025),
  // A combo climbs: each step of the combo plays the run a little higher.
  combo: (n = 2) => { const k = Math.pow(2, Math.min(8, n - 1) / 12); [659, 784, 988, 1319].forEach((f, i) => note(f * k, i * 0.05, 0.09, "square", 0.05)); },
  hire: () => { note(392, 0, 0.08); note(523, 0.08, 0.08); note(784, 0.16, 0.16, "triangle"); },
  // Level up: a rising run that lands on a held chord, the classic "you got stronger" fanfare.
  levelup: () => {
    [392, 523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.07, 0.1, "square", 0.05));
    [1047, 1319, 1568].forEach(f => note(f, 0.38, 0.55, "triangle", 0.045));
  },
  // A gift opens: a quick rattle, a pop, then a run that climbs higher (and longer) the rarer the sticker.
  gift: (rarity = "common") => {
    const k = { common: 0, rare: 1, seasonal: 1, team: 1, epic: 2, legendary: 3 }[rarity] || 0;   // seasonal and team stickers rank with rare
    [220, 247, 220].forEach((f, i) => note(f, i * 0.05, 0.04, "square", 0.03));
    note(880, 0.18, 0.06, "square", 0.05);
    [784, 988, 1175, 1568, 1976, 2349].slice(0, 3 + k).forEach((f, i) => note(f, 0.26 + i * 0.07, 0.12, "triangle", 0.05));
    if (k >= 2) [1568, 1976, 2349].forEach(f => note(f, 0.3 + (3 + k) * 0.07, 0.5, "triangle", 0.035));
  },
  // A merge rings the ship's bell: a struck brass note with its bright, out-of-tune partials, ringing on.
  bell: (n = 1) => { for (let i = 0; i < Math.min(4, 2 * n); i++) { const at = i * 0.56; note(784, at, 1.6, "sine", 0.08); note(1880, at, 0.9, "sine", 0.035); note(2650, at, 0.45, "sine", 0.02); note(392, at, 1.2, "triangle", 0.025); } },
  // A gift lands on the floor: a soft wooden "tok-tok".
  ring: () => { for (const at of [0, 0.5]) for (let i = 0; i < 8; i++) note(i % 2 ? 1480 : 1320, at + i * 0.045, 0.045, "square", 0.035); },   // a desk phone
  drop: () => { note(392, 0, 0.05, "triangle", 0.05); note(523, 0.07, 0.07, "triangle", 0.045); },
  // The cat purrs: a low, soft rumble.
  purr: () => { for (let i = 0; i < 6; i++) note(i % 2 ? 62 : 58, i * 0.07, 0.08, "triangle", 0.06); note(880, 0.45, 0.06, "triangle", 0.02); },
  // Happy hour: a little party horn.
  happy: () => { [523, 659, 784, 659, 784, 1047].forEach((f, i) => note(f, i * 0.09, 0.1, "square", 0.045)); },
  // Achievement: two bright chimes and a sparkle.
  achievement: () => { note(1319, 0, 0.12, "triangle", 0.06); note(1760, 0.11, 0.22, "triangle", 0.06); [2637, 3136].forEach((f, i) => note(f, 0.3 + i * 0.05, 0.08, "square", 0.02)); },
};

export const sound = {
  get on() { return on; },
  set(v) { on = !!v; if (on) ctx(); },
  preview(name) {                       // the Settings "Play" button: one sound, without switching effects on
    try { if (SFX[name]) SFX[name](); } catch { /* audio is a nicety */ }
  },
  play(name, arg) {
    if (!on || !SFX[name]) return;
    const t = performance.now();
    if (!["click", "gift", "happy"].includes(name) && t - last < 350) return;   // never a cacophony (but never drop a gift or the party)
    last = t;
    try { SFX[name](arg); } catch { /* audio is a nicety */ }
  },
};
