// Clips of the floor: a short recording of the office as it is, or a timelapse of the last day (Replay played at speed
// and recorded end to end). The pixel floor only: names and bubbles live in the page around it, so nothing private is
// in the video. Saved as a .webm the browser downloads; nothing leaves the machine.
import { toast } from "./util.js";
import { icon } from "./icons.js";

export function makeRecorder({ office, replay, frame, onSaved }) {
  let rec = null;

  const supported = () => typeof MediaRecorder !== "undefined" && HTMLCanvasElement.prototype.captureStream;
  function start({ seconds = 15, name = "clip", until = null, label = "Recording" } = {}) {
    if (rec) return false;
    if (!supported()) { toast("This browser cannot record the floor (try Chrome or Edge).", "warn"); return false; }
    const canvas = office.picture().canvas;
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
    let mr;
    try { mr = new MediaRecorder(canvas.captureStream(30), type ? { mimeType: type, videoBitsPerSecond: 3e6 } : undefined); }
    catch { toast("Could not start recording.", "bad"); return false; }
    const chunks = [], began = performance.now();
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      dot.remove(); clearInterval(rec.tick); clearTimeout(rec.timer);
      rec = null;
      if (!blob.size) { toast("Nothing was recorded.", "warn"); return; }
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = `claude-office-${name}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast(`Saved the ${name === "timelapse" ? "timelapse" : "clip"} (${(blob.size / 1e6).toFixed(1)} MB).`, "good", { ic: "play" });
      if (onSaved) onSaved(name);
    };
    const dot = document.createElement("div");
    dot.className = "rec-dot";
    dot.innerHTML = `<i></i><span>${label}</span><b>0:00</b><button class="btn sm ghost" aria-label="Stop recording">${icon("stop", 14)}Stop</button>`;
    frame.appendChild(dot);
    dot.querySelector("button").addEventListener("click", stop);
    mr.start(500);
    rec = { mr,
      tick: setInterval(() => {
        const s = Math.floor((performance.now() - began) / 1000);
        dot.querySelector("b").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        if (until && until()) stop();
      }, 250),
      timer: until ? setTimeout(stop, 5 * 60000) : setTimeout(stop, seconds * 1000) };      // a timelapse stops at the end, or after 5 min
    return true;
  }
  function stop() { if (rec && rec.mr.state !== "inactive") rec.mr.stop(); }

  // The last day as a timelapse: Replay (about a minute end to end), recorded until it reaches now.
  async function timelapse(hours = 24) {
    if (rec) return;
    if (!supported()) { toast("This browser cannot record the floor (try Chrome or Edge).", "warn"); return; }
    if (replay.active()) replay.close();
    await replay.open(hours);
    if (!replay.active()) return;
    start({ name: "timelapse", label: "Timelapse", until: () => !replay.active() || replay.done() });
  }
  return { clip: (seconds) => start({ seconds, name: "clip" }), timelapse, stop, recording: () => !!rec };
}
