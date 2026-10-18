// The office radio: endless lo-fi made up on the spot with WebAudio (no files, nothing fetched). Seventh chords on a
// soft electric piano, a round bass, swung drums, a sparse melody and a little vinyl crackle, at 76 BPM. A new
// progression every eight bars. Off until the CEO turns it on; browsers start audio only after a click or a key.
const BPM = 76, BEAT = 60 / BPM, LOOKAHEAD = 0.12;
const PROGRESSIONS = [            // semitones from the key's root: each chord is four notes
  [[5, 9, 12, 16], [4, 7, 11, 14], [2, 5, 9, 12], [0, 4, 7, 11]],      // IV maj7 · iii7 · ii7 · I maj7
  [[9, 12, 16, 19], [2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11]],    // vi7 · ii7 · V7 · I maj7
  [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]],   // I maj7 · vi7 · IV maj7 · V7
  [[2, 5, 9, 12], [7, 11, 14, 17], [0, 4, 7, 11], [5, 9, 12, 16]],     // ii7 · V7 · I maj7 · IV maj7
];
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];
const KEYS = [57, 58, 60, 62, 53];      // A, B♭, C, D, F (MIDI roots for the chords)
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// The chord for a bar (pure, for tests): the progression changes every eight bars, the key every 32.
export function chordAt(bar, seed = 0) {
  const prog = PROGRESSIONS[(Math.floor(bar / 8) + seed) % PROGRESSIONS.length], key = KEYS[(Math.floor(bar / 32) + seed) % KEYS.length];
  return prog[bar % 4].map(n => key + n);
}

export function makeRadio() {
  let ac = null, master = null, timer = 0, on = false, nextT = 0, step = 0, noise = null, crackle = null, seed = Math.floor(Math.random() * 4);
  const listeners = new Set();

  function setup() {
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return false;
    ac = new A();
    master = ac.createGain(); master.gain.value = 0;
    const warm = ac.createBiquadFilter(); warm.type = "lowpass"; warm.frequency.value = 3200;   // a warm, slightly muffled mix
    master.connect(warm).connect(ac.destination);
    noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }
  function env(g, t, a, peak, rel) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + rel); }
  function keys(midi, t, len, vol) {          // an electric piano voice: two detuned triangles through a lowpass
    const g = ac.createGain(), f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 1400;
    for (const det of [-6, 5]) { const o = ac.createOscillator(); o.type = "triangle"; o.frequency.value = hz(midi); o.detune.value = det; o.connect(f); o.start(t); o.stop(t + len + 0.1); }
    f.connect(g).connect(master); env(g, t, 0.02, vol, len);
  }
  function bass(midi, t, len) {
    const o = ac.createOscillator(), g = ac.createGain(); o.type = "sine"; o.frequency.value = hz(midi - 24);
    o.connect(g).connect(master); env(g, t, 0.01, 0.32, len); o.start(t); o.stop(t + len + 0.05);
  }
  function kick(t) {
    const o = ac.createOscillator(), g = ac.createGain(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    o.connect(g).connect(master); env(g, t, 0.003, 0.55, 0.22); o.start(t); o.stop(t + 0.3);
  }
  function hiss(t, type, freq, vol, len) {
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noise; f.type = type; f.frequency.value = freq;
    s.connect(f).connect(g).connect(master); env(g, t, 0.002, vol, len); s.start(t, Math.random() * 0.5); s.stop(t + len + 0.05);
  }
  function lead(midi, t, len) {
    const o = ac.createOscillator(), g = ac.createGain(), v = ac.createOscillator(), vg = ac.createGain();
    o.type = "sine"; o.frequency.value = hz(midi); v.frequency.value = 5; vg.gain.value = 3; v.connect(vg).connect(o.frequency);
    o.connect(g).connect(master); env(g, t, 0.04, 0.09, len); o.start(t); v.start(t); o.stop(t + len + 0.1); v.stop(t + len + 0.1);
  }
  // One sixteenth at a time, scheduled a little ahead of the clock.
  function schedule() {
    while (nextT < ac.currentTime + LOOKAHEAD) {
      const s16 = step % 16, bar = Math.floor(step / 16), chord = chordAt(bar, seed), swing = s16 % 2 ? BEAT / 4 * 0.16 : 0, t = nextT + swing;
      if (s16 === 0) { chord.forEach(n => keys(n, t, BEAT * 3.2, 0.05)); bass(chord[0], t, BEAT * 1.6); }
      if (s16 === 6 && Math.random() < 0.6) chord.slice(1).forEach(n => keys(n + 12, t, BEAT * 1.2, 0.03));
      if (s16 === 8) bass(Math.random() < 0.5 ? chord[0] : chord[2], t, BEAT * 1.4);
      if (s16 === 0 || s16 === 10 || (s16 === 7 && Math.random() < 0.3)) kick(t);
      if (s16 === 4 || s16 === 12) hiss(t, "bandpass", 1900, 0.16, 0.16);
      if (s16 % 2 === 0) hiss(t, "highpass", 7500, s16 % 4 ? 0.035 : 0.05, 0.04);
      if (s16 % 4 === 2 && Math.random() < 0.28) lead(chord[0] + 12 + PENTA[Math.floor(Math.random() * PENTA.length)], t, BEAT * (Math.random() < 0.5 ? 0.9 : 1.8));
      nextT += BEAT / 4; step++;
    }
  }
  function startCrackle() {
    const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noise; s.loop = true; f.type = "highpass"; f.frequency.value = 3000; g.gain.value = 0.006;
    s.connect(f).connect(g).connect(master); s.start(); crackle = s;
  }

  function start() {
    if (!ac && !setup()) return false;
    if (ac.state === "suspended") ac.resume();
    on = true;
    master.gain.cancelScheduledValues(ac.currentTime);
    master.gain.setValueAtTime(master.gain.value, ac.currentTime); master.gain.linearRampToValueAtTime(0.3, ac.currentTime + 1.5);   // background level, under the sound effects
    nextT = ac.currentTime + 0.1; step = 0; seed = Math.floor(Math.random() * 4);
    if (!crackle) startCrackle();
    clearInterval(timer); timer = setInterval(schedule, 25); schedule();
    listeners.forEach(f => f(true));
    return true;
  }
  function stop() {
    on = false;
    clearInterval(timer);
    if (ac) { master.gain.cancelScheduledValues(ac.currentTime); master.gain.setValueAtTime(master.gain.value, ac.currentTime); master.gain.linearRampToValueAtTime(0, ac.currentTime + 0.6); }
    if (crackle) { const c = crackle; crackle = null; setTimeout(() => { try { c.stop(); } catch { /* stopped */ } }, 700); }
    if (ac) setTimeout(() => { if (!on && ac.state === "running") ac.suspend(); }, 800);   // no idle audio thread while off
    listeners.forEach(f => f(false));
  }
  return { start, stop, toggle: () => (on ? (stop(), false) : start()), get on() { return on; }, onChange: (f) => listeners.add(f) };
}
