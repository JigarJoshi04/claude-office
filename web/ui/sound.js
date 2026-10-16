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
  hire: () => { note(392, 0, 0.08); note(523, 0.08, 0.08); note(784, 0.16, 0.16, "triangle"); },
  // Level up: a rising run that lands on a held chord, the classic "you got stronger" fanfare.
  levelup: () => {
    [392, 523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.07, 0.1, "square", 0.05));
    [1047, 1319, 1568].forEach(f => note(f, 0.38, 0.55, "triangle", 0.045));
  },
  // Achievement: two bright chimes and a sparkle.
  achievement: () => { note(1319, 0, 0.12, "triangle", 0.06); note(1760, 0.11, 0.22, "triangle", 0.06); [2637, 3136].forEach((f, i) => note(f, 0.3 + i * 0.05, 0.08, "square", 0.02)); },
};

export const sound = {
  get on() { return on; },
  set(v) { on = !!v; if (on) ctx(); },
  preview(name) {                       // the Settings "Play" button: one sound, without switching effects on
    try { if (SFX[name]) SFX[name](); } catch { /* audio is a nicety */ }
  },
  play(name) {
    if (!on || !SFX[name]) return;
    const t = performance.now();
    if (name !== "click" && t - last < 350) return;      // never a cacophony
    last = t;
    try { SFX[name](); } catch { /* audio is a nicety */ }
  },
};
