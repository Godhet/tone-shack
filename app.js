// Tone Shack — a tiny browser guitar amp.
// Signal flow:
//   mic(Arturia) -> inputGain -> waveshaper(drive) -> cab EQ -> tone stack
//                -> chorus -> reverb -> master -> limiter -> your headphones
//
// A "preset" is just a bundle of settings for that chain. Knobs tweak them live.

// ------------------------------------------------------------------ presets
const PRESETS = {
  "oasis-acoustic": {
    title: "Oasis — Acoustic",
    note: "clean, bright body & sparkle (electric faking an acoustic)",
    driveScale: 4,          // how hard the GAIN knob pushes into distortion
    cab: { hp: 90, lp: 9000, bodyFreq: 120, bodyGain: 4, presFreq: 3500, presGain: 3 },
    chorus: { wet: 0.28, rate: 0.6, depth: 0.004 },
    knobs: { gain: 0.05, bass: 3, mid: -2, treble: 5, reverb: 0.35, level: 0.8 },
  },
  "oasis-electric": {
    title: "Oasis — Electric",
    note: "thick Marshall crunch, layered & sustained",
    driveScale: 26,
    cab: { hp: 85, lp: 5000, bodyFreq: 200, bodyGain: 3, presFreq: 2600, presGain: 4 },
    chorus: { wet: 0, rate: 0.5, depth: 0.003 },
    knobs: { gain: 0.5, bass: 4, mid: 4, treble: 2, reverb: 0.15, level: 0.65 },
  },
  "acdc": {
    title: "AC/DC — Crunch",
    note: "cranked Marshall, mid-forward, tight, no fizz",
    driveScale: 18,
    cab: { hp: 90, lp: 5500, bodyFreq: 180, bodyGain: 2, presFreq: 3000, presGain: 3 },
    chorus: { wet: 0, rate: 0.5, depth: 0.003 },
    knobs: { gain: 0.4, bass: 2, mid: 5, treble: 3, reverb: 0.08, level: 0.65 },
  },
};

// knob definitions: [key, label, min, max, step, unit]
const KNOBS = [
  ["gain",   "Gain",   0,   1,  0.01, ""],
  ["bass",   "Bass",  -12,  12, 0.5,  "dB"],
  ["mid",    "Mid",   -12,  12, 0.5,  "dB"],
  ["treble", "Treble",-12,  12, 0.5,  "dB"],
  ["reverb", "Reverb", 0,   1,  0.01, ""],
  ["level",  "Level",  0,   1,  0.01, ""],
];

// ------------------------------------------------------------------ state
const state = {
  ctx: null,
  stream: null,
  source: null,
  nodes: {},        // named audio nodes
  presetId: null,
  values: {},       // current knob values
  meterRAF: null,
};

// ------------------------------------------------------------------ helpers
// tanh soft-clip curve. k = drive amount. Bigger k = more distortion.
function makeDriveCurve(k) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

// build a synthetic reverb impulse: decaying stereo noise.
function makeReverbIR(ctx, seconds = 2.2, decay = 3.0) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}

function biquad(ctx, type, freq, gain = 0, q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

// ------------------------------------------------------------------ audio graph
function buildGraph() {
  const ctx = state.ctx;
  const n = {};

  n.inputGain = ctx.createGain();
  n.inputGain.gain.value = 1.2;          // modest — too hot here = everything clips/distorts

  // noise gate: silences hiss/static when you're not actually playing
  n.gate = ctx.createGain();
  n.gate.gain.value = 0;

  // separate boost feeding ONLY the detector, so lowering the amp input
  // doesn't weaken chord/tuner detection
  n.detectGain = ctx.createGain();
  n.detectGain.gain.value = 2.5;

  n.shaper = ctx.createWaveShaper();
  n.shaper.oversample = "4x";
  n.shaper.curve = makeDriveCurve(2);

  // cabinet sim = filters
  n.cabHP   = biquad(ctx, "highpass", 85, 0, 0.7);
  n.cabBody = biquad(ctx, "peaking", 180, 3, 1.0);
  n.cabPres = biquad(ctx, "peaking", 3000, 3, 1.4);
  n.cabLP   = biquad(ctx, "lowpass", 5500, 0, 0.7);

  // tone stack (the Bass/Mid/Treble knobs)
  n.tBass   = biquad(ctx, "lowshelf", 120, 0);
  n.tMid    = biquad(ctx, "peaking", 800, 0, 0.9);
  n.tTreble = biquad(ctx, "highshelf", 3200, 0);

  // chorus (parallel wet path)
  n.chDelay = ctx.createDelay(0.05);
  n.chDelay.delayTime.value = 0.02;
  n.chLFO = ctx.createOscillator();
  n.chLFO.type = "sine";
  n.chLFO.frequency.value = 0.6;
  n.chDepth = ctx.createGain();
  n.chDepth.gain.value = 0.003;
  n.chWet = ctx.createGain();
  n.chWet.gain.value = 0;
  n.chLFO.connect(n.chDepth).connect(n.chDelay.delayTime);
  n.chLFO.start();

  // reverb (parallel wet path)
  n.convolver = ctx.createConvolver();
  n.convolver.buffer = makeReverbIR(ctx);
  n.revWet = ctx.createGain();
  n.revWet.gain.value = 0.2;

  // mix + output
  n.preMaster = ctx.createGain();
  n.master = ctx.createGain();
  n.master.gain.value = 0.6;

  // safety limiter so a high-gain preset can't blast your ears
  n.limiter = ctx.createDynamicsCompressor();
  n.limiter.threshold.value = -6;
  n.limiter.knee.value = 0;
  n.limiter.ratio.value = 20;
  n.limiter.attack.value = 0.003;
  n.limiter.release.value = 0.12;

  // metering tap
  n.analyser = ctx.createAnalyser();
  n.analyser.fftSize = 512;

  // clean detection tap (pre-drive) for tuner + chord trainer
  n.detect = ctx.createAnalyser();
  n.detect.fftSize = 4096;
  n.detect.smoothingTimeConstant = 0.8;

  // ---- wire it up ----
  // main chain into tone stack
  n.inputGain.connect(n.gate);          // gate sits between input and the amp
  n.gate.connect(n.shaper);
  n.inputGain.connect(n.analyser);      // meter taps the raw input
  n.inputGain.connect(n.detectGain);    // detection gets its own boost
  n.detectGain.connect(n.detect);
  n.shaper.connect(n.cabHP);
  n.cabHP.connect(n.cabBody);
  n.cabBody.connect(n.cabPres);
  n.cabPres.connect(n.cabLP);
  n.cabLP.connect(n.tBass);
  n.tBass.connect(n.tMid);
  n.tMid.connect(n.tTreble);

  // chorus: dry + wet -> preMaster
  n.tTreble.connect(n.preMaster);       // dry
  n.tTreble.connect(n.chDelay);
  n.chDelay.connect(n.chWet).connect(n.preMaster);

  // reverb: dry + wet -> master
  n.preMaster.connect(n.master);        // dry
  n.preMaster.connect(n.convolver);
  n.convolver.connect(n.revWet).connect(n.master);

  n.master.connect(n.limiter);
  n.limiter.connect(ctx.destination);

  state.nodes = n;
}

function connectSource() {
  if (state.source) try { state.source.disconnect(); } catch (e) {}
  state.source = state.ctx.createMediaStreamSource(state.stream);
  state.source.connect(state.nodes.inputGain);
}

// ------------------------------------------------------------------ preset / knobs
function applyPreset(id) {
  const p = PRESETS[id];
  if (!p) return;
  state.presetId = id;
  const n = state.nodes;

  // audio nodes only exist once powered on; the UI can render before that
  if (state.ctx) {
    n.cabHP.frequency.value = p.cab.hp;
    n.cabLP.frequency.value = p.cab.lp;
    n.cabBody.frequency.value = p.cab.bodyFreq;
    n.cabBody.gain.value = p.cab.bodyGain;
    n.cabPres.frequency.value = p.cab.presFreq;
    n.cabPres.gain.value = p.cab.presGain;

    n.chLFO.frequency.value = p.chorus.rate;
    n.chDepth.gain.value = p.chorus.depth;
    n.chWet.gain.value = p.chorus.wet;
  }

  // knobs -> live values
  state.values = { ...p.knobs };
  for (const [key] of KNOBS) applyKnob(key, state.values[key]);

  renderKnobs();
  document.getElementById("ampTitle").textContent = p.title;
  document.getElementById("ampNote").textContent = p.note;
  document.querySelectorAll(".preset").forEach((b) =>
    b.classList.toggle("active", b.dataset.preset === id)
  );
}

function applyKnob(key, value) {
  state.values[key] = value;
  if (!state.ctx) return;            // UI-only until powered on
  const n = state.nodes;
  const p = PRESETS[state.presetId];
  switch (key) {
    case "gain":
      n.shaper.curve = makeDriveCurve(1 + value * (p ? p.driveScale : 20));
      break;
    case "bass":   n.tBass.gain.value = value; break;
    case "mid":    n.tMid.gain.value = value; break;
    case "treble": n.tTreble.gain.value = value; break;
    case "reverb": n.revWet.gain.value = value; break;
    case "level":  n.master.gain.value = value; break;
  }
}

// ------------------------------------------------------------------ UI: controls
// Horizontal sliders: click or drag anywhere on the track to set a value.
const drag = { key: null, spec: null, el: null };

function renderKnobs() {
  const wrap = document.getElementById("knobs");
  wrap.innerHTML = "";
  for (const spec of KNOBS) {
    const [key, label] = spec;
    const el = document.createElement("div");
    el.className = "ctrl";
    el.innerHTML = `
      <div class="ctrl-head">
        <span class="name">${label}</span>
        <span class="val" id="val-${key}"></span>
      </div>
      <div class="ctrl-hit">
        <div class="ctrl-track">
          <div class="ctrl-fill"></div>
          <div class="ctrl-thumb"></div>
        </div>
      </div>
    `;
    wrap.appendChild(el);
    setControl(el, spec, state.values[key]);

    const hit = el.querySelector(".ctrl-hit");
    hit.addEventListener("mousedown", (e) => {
      drag.key = key; drag.spec = spec; drag.el = el;
      setFromPointer(e.clientX);
      e.preventDefault();
    });
    hit.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [, , min, max, step] = spec;
      const v = clamp(state.values[key] - Math.sign(e.deltaY) * step * 4, min, max);
      applyKnob(key, v);
      setControl(el, spec, v);
    }, { passive: false });
  }
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function setFromPointer(clientX) {
  if (!drag.key) return;
  const [key, , min, max] = drag.spec;
  const track = drag.el.querySelector(".ctrl-track").getBoundingClientRect();
  const frac = clamp((clientX - track.left) / track.width, 0, 1);
  const v = min + frac * (max - min);
  applyKnob(key, v);
  setControl(drag.el, drag.spec, v);
}

window.addEventListener("mousemove", (e) => { if (drag.key) setFromPointer(e.clientX); });
window.addEventListener("mouseup", () => { drag.key = null; drag.spec = null; drag.el = null; });

function setControl(el, spec, val) {
  const [key, , min, max, , unit] = spec;
  const pct = ((val - min) / (max - min)) * 100;
  el.querySelector(".ctrl-fill").style.width = pct + "%";
  el.querySelector(".ctrl-thumb").style.left = pct + "%";
  el.querySelector("#val-" + key).textContent = unit === "dB"
    ? (val > 0 ? "+" : "") + val.toFixed(1)
    : String(Math.round(val * 100));
}

// ------------------------------------------------------------------ devices
async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const sel = document.getElementById("deviceSelect");
  sel.innerHTML = "";
  inputs.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Input ${i + 1}`;
    sel.appendChild(opt);
  });
  sel.disabled = false;
}

async function openStream(deviceId) {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,   // <-- critical: these three MANGLE guitar tone
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
}

// ------------------------------------------------------------------ meter
function startMeter() {
  const analyser = state.nodes.analyser;
  const buf = new Uint8Array(analyser.fftSize);
  const fill = document.getElementById("meterFill");
  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    fill.style.width = Math.min(100, peak * 140) + "%";
    // noise gate: open when you're playing, close (smoothly) when you're not
    if (state.nodes.gate) {
      const open = peak > 0.02;
      const target = open ? 1 : 0;
      state.nodes.gate.gain.setTargetAtTime(
        target, state.ctx.currentTime, open ? 0.005 : 0.08);
    }
    state.meterRAF = requestAnimationFrame(tick);
  };
  tick();
}

// ------------------------------------------------------------------ power on
async function powerOn() {
  const statusEl = document.getElementById("status");
  const btn = document.getElementById("powerBtn");
  try {
    statusEl.textContent = "starting…";
    state.ctx = new AudioContext({ latencyHint: "interactive" });
    await state.ctx.resume();
    await openStream();                 // first grab (also unlocks device labels)
    await refreshDevices();
    buildGraph();
    connectSource();
    applyPreset("oasis-electric");       // sensible default so you hear something
    startMeter();

    btn.textContent = "POWER OFF";
    btn.classList.add("on");
    statusEl.textContent = "live · " + Math.round(state.ctx.baseLatency * 1000) + "ms";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "mic blocked?";
    alert("Couldn't start audio:\n" + err.message +
      "\n\nMake sure you allowed microphone access and picked the Arturia.");
  }
}

function powerOff() {
  if (state.meterRAF) cancelAnimationFrame(state.meterRAF);
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  if (state.ctx) state.ctx.close();
  state.ctx = null;
  const btn = document.getElementById("powerBtn");
  btn.textContent = "POWER ON";
  btn.classList.remove("on");
  document.getElementById("status").textContent = "standby";
  document.getElementById("meterFill").style.width = "0%";
}

// ------------------------------------------------------------------ wire UI
document.getElementById("powerBtn").addEventListener("click", () => {
  if (state.ctx) powerOff(); else powerOn();
});

document.getElementById("deviceSelect").addEventListener("change", async (e) => {
  if (!state.ctx) return;
  await openStream(e.target.value);
  connectSource();
});

document.querySelectorAll(".preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!state.ctx) { applyPreset(btn.dataset.preset); return; }   // preview settings
    applyPreset(btn.dataset.preset);
  });
});

// ==================================================================
//  LEARN MODE  —  tuner + chord trainer
// ==================================================================
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

// chord tones as pitch classes (C=0)
const CHORD_TONES = { D:[2,6,9], G:[7,11,2], C:[0,4,7], Em:[4,7,11] };
// fingering low->high [E A D G B e]; -1 = muted, 0 = open
const CHORD_FRETS = {
  D:  [-1,-1, 0, 2, 3, 2],
  G:  [ 3, 2, 0, 0, 0, 3],
  C:  [-1, 3, 2, 0, 1, 0],
  Em: [ 0, 2, 2, 0, 0, 0],
};
const CHORD_FINGERS = {
  D:  [0,0,0,1,3,2],
  G:  [2,1,0,0,0,3],
  C:  [0,3,2,0,1,0],
  Em: [0,2,3,0,0,0],
};
const CHORD_SEQUENCE = ["D", "G", "C", "Em"];

// detection tuning knobs (we'll adjust these against your real guitar)
const CHORD_THRESHOLD = 0.72;   // cosine similarity needed to count as a match
const CHORD_HOLD = 9;           // frames it must hold before it counts

const learn = { mode: "tuner", chordIdx: 0, hold: 0, cooling: false };

// ---- pitch detection (autocorrelation) → frequency in Hz, or -1 ----
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return -1;                 // too quiet to be a note

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const b = buf.slice(r1, r2);
  const n = b.length;
  const c = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) c[i] += b[j] * b[j + i];

  let d = 0; while (c[d] > c[d + 1]) d++;
  let max = -1, pos = -1;
  for (let i = d; i < n; i++) if (c[i] > max) { max = c[i]; pos = i; }
  let T0 = pos;
  const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2, bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);
  return sampleRate / T0;
}

// ---- chromagram (12 pitch-class energies), normalized ----
function computeChroma() {
  const analyser = state.nodes.detect;
  const bins = analyser.frequencyBinCount;
  const db = new Float32Array(bins);
  analyser.getFloatFrequencyData(db);
  const rate = state.ctx.sampleRate;
  const chroma = new Float32Array(12);
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const freq = (i * rate) / (bins * 2);
    if (freq < 75 || freq > 1200) continue;   // focus on fundamentals
    const mag = Math.pow(10, db[i] / 20);
    const pc = ((Math.round(12 * Math.log2(freq / 16.35))) % 12 + 12) % 12;
    chroma[pc] += mag;
    total += mag;
  }
  if (total > 0) {
    let norm = 0;
    for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 12; i++) chroma[i] /= norm;
  }
  return { chroma, total };
}

function chordSimilarity(chroma, tones) {
  const tpl = new Float32Array(12);
  for (const t of tones) tpl[t] = 1;
  let tn = Math.sqrt(tones.length);
  let dot = 0;
  for (let i = 0; i < 12; i++) dot += chroma[i] * tpl[i];
  return dot / (tn || 1);
}

// ---- chord diagram SVG ----
function renderChord(name) {
  const frets = CHORD_FRETS[name], fingers = CHORD_FINGERS[name];
  const nFrets = 4, W = 120, H = 150, padX = 16, padY = 28;
  const gw = (W - 2 * padX) / 5, gh = (H - padY - 16) / nFrets;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  // strings
  for (let s = 0; s < 6; s++) {
    const x = padX + s * gw;
    svg += `<line class="grid" x1="${x}" y1="${padY}" x2="${x}" y2="${padY + nFrets * gh}"/>`;
  }
  // frets (first one is the nut)
  for (let f = 0; f <= nFrets; f++) {
    const y = padY + f * gh;
    const cls = f === 0 ? "nut" : "grid";
    svg += `<line class="${cls}" x1="${padX}" y1="${y}" x2="${padX + 5 * gw}" y2="${y}"/>`;
  }
  // markers + dots
  for (let s = 0; s < 6; s++) {
    const x = padX + s * gw;
    const fr = frets[s];
    if (fr === -1) svg += `<text class="mark" x="${x}" y="${padY - 8}" text-anchor="middle">×</text>`;
    else if (fr === 0) svg += `<text class="mark" x="${x}" y="${padY - 8}" text-anchor="middle">○</text>`;
    else {
      const y = padY + (fr - 0.5) * gh;
      svg += `<circle class="dot" cx="${x}" cy="${y}" r="8"/>`;
      if (fingers[s]) svg += `<text class="fng" x="${x}" y="${y + 4}" text-anchor="middle">${fingers[s]}</text>`;
    }
  }
  svg += `</svg>`;
  return svg;
}

// ---- the two display updaters ----
function updateTuner() {
  const buf = new Float32Array(2048);
  state.nodes.detect.getFloatTimeDomainData(buf);
  let freq = autoCorrelate(buf, state.ctx.sampleRate);
  const noteEl = document.getElementById("tunerNote");
  const needle = document.getElementById("tunerNeedle");
  const cents = document.getElementById("tunerCents");
  document.querySelectorAll(".tuner-strings span").forEach((s) => s.classList.remove("hot"));

  // keep only plausible guitar fundamentals (low E ~82Hz .. high frets ~520Hz)
  if (freq > 0 && (freq < 65 || freq > 520)) freq = -1;

  // median-smooth the last several readings so it settles instead of jittering
  if (!learn.freqHist) learn.freqHist = [];
  if (freq > 0) {
    learn.freqHist.push(freq);
    if (learn.freqHist.length > 8) learn.freqHist.shift();
  } else {
    learn.freqHist.length = 0;   // silence resets it
  }

  if (learn.freqHist.length < 4) {
    noteEl.textContent = "—";
    noteEl.classList.remove("in-tune");
    needle.style.left = "50%";
    cents.textContent = "pluck a single string";
    return;
  }
  const sorted = [...learn.freqHist].sort((a, b) => a - b);
  freq = sorted[Math.floor(sorted.length / 2)];   // median
  const midi = 69 + 12 * Math.log2(freq / 440);
  const rounded = Math.round(midi);
  const centsOff = Math.round((midi - rounded) * 100);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  noteEl.textContent = name;
  const inTune = Math.abs(centsOff) <= 5;
  noteEl.classList.toggle("in-tune", inTune);
  needle.style.left = (50 + Math.max(-50, Math.min(50, centsOff)) ) + "%";
  needle.style.background = inTune ? "var(--green)" : "var(--gold)";
  cents.textContent = inTune ? "IN TUNE ✓" : (centsOff > 0 ? `+${centsOff}¢ (a touch sharp)` : `${centsOff}¢ (a touch flat)`);
  // highlight matching open-string letters
  const letter = name[0];
  document.querySelectorAll(".tuner-strings span").forEach((s) => {
    if (s.dataset.s.toUpperCase() === letter) s.classList.add("hot");
  });
}

function setChordTarget() {
  const name = CHORD_SEQUENCE[learn.chordIdx];
  document.getElementById("chordName").textContent = name;
  document.getElementById("chordDiagram").innerHTML = renderChord(name);
  const prog = document.getElementById("chordProgress");
  prog.innerHTML = CHORD_SEQUENCE.map((_, i) =>
    `<span class="dot ${i < learn.chordIdx ? "done" : ""} ${i === learn.chordIdx ? "cur" : ""}"></span>`
  ).join("");
}

function updateChord() {
  const name = CHORD_SEQUENCE[learn.chordIdx];
  const { chroma, total } = computeChroma();
  const status = document.getElementById("chordStatus");
  const hearing = document.getElementById("chordHearing");
  const progressBar = document.getElementById("chordProgress");

  // energy gate — are you actually playing?
  let rms = 0;
  const tb = new Float32Array(1024);
  state.nodes.detect.getFloatTimeDomainData(tb);
  for (let i = 0; i < tb.length; i++) rms += tb[i] * tb[i];
  rms = Math.sqrt(rms / tb.length);

  if (learn.cooling) return;

  if (rms < 0.01) {
    status.textContent = "strum it…";
    status.classList.remove("hit");
    learn.hold = Math.max(0, learn.hold - 1);
    hearing.textContent = "";
  } else {
    const sim = chordSimilarity(chroma, CHORD_TONES[name]);
    // show what it's hearing (top 3 notes)
    const top = [...chroma.keys()].sort((a, b) => chroma[b] - chroma[a]).slice(0, 3)
      .filter((i) => chroma[i] > 0.2).map((i) => NOTE_NAMES[i]);
    hearing.textContent = top.length ? "hearing: " + top.join("  ") : "";
    if (sim >= CHORD_THRESHOLD) learn.hold++;
    else learn.hold = Math.max(0, learn.hold - 1);
    status.textContent = learn.hold > 0 ? "almost…" : "keep strumming…";
    status.classList.remove("hit");
  }

  // progress ring on current dot via opacity trick: reuse status text
  const cur = progressBar.querySelector(".dot.cur");
  if (cur) cur.style.opacity = 0.4 + 0.6 * Math.min(1, learn.hold / CHORD_HOLD);

  if (learn.hold >= CHORD_HOLD) {
    status.textContent = "✓ nice — " + name + "!";
    status.classList.add("hit");
    learn.hold = 0;
    learn.cooling = true;
    setTimeout(() => {
      learn.chordIdx = (learn.chordIdx + 1) % CHORD_SEQUENCE.length;
      learn.cooling = false;
      setChordTarget();
    }, 900);
  }
}

// ---- the learn loop ----
function learnTick() {
  if (!state.ctx || state.view !== "learn") return;
  if (learn.mode === "tuner") updateTuner();
  else if (learn.mode === "chord") updateChord();
  else return;                       // scales is a static reference, no listening
  state.learnRAF = requestAnimationFrame(learnTick);
}
function startLearn() {
  if (state.learnRAF) cancelAnimationFrame(state.learnRAF);
  if (state.ctx && state.view === "learn") learnTick();
}
function stopLearn() {
  if (state.learnRAF) cancelAnimationFrame(state.learnRAF);
  state.learnRAF = null;
}

// ---- view + sub-tab wiring ----
state.view = "amp";
document.querySelectorAll("#tabs > .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    document.querySelectorAll("#tabs > .tab").forEach((t) =>
      t.classList.toggle("active", t === tab));
    document.getElementById("view-amp").hidden = state.view !== "amp";
    document.getElementById("view-learn").hidden = state.view !== "learn";
    if (state.view === "learn") {
      if (!state.ctx) {
        document.getElementById("chordStatus").textContent = "power on to start listening";
      }
      setChordTarget();
      startLearn();
    } else stopLearn();
  });
});
document.querySelectorAll("[data-learn]").forEach((tab) => {
  tab.addEventListener("click", () => {
    learn.mode = tab.dataset.learn;
    document.querySelectorAll("[data-learn]").forEach((t) =>
      t.classList.toggle("active", t === tab));
    document.getElementById("tunerPanel").hidden = learn.mode !== "tuner";
    document.getElementById("chordPanel").hidden = learn.mode !== "chord";
    document.getElementById("scalesPanel").hidden = learn.mode !== "scales";
    learn.hold = 0; learn.cooling = false;
    if (learn.mode === "scales") { stopLearn(); renderScale(); }
    else startLearn();
  });
});

// ==================================================================
//  SCALES  —  fretboard reference
// ==================================================================
const SCALES = {
  "min-pent": {
    name: "Minor pentatonic",
    intervals: [0, 3, 5, 7, 10],
    degrees: ["1", "b3", "4", "5", "b7"],
    tip: "The backbone of rock and blues lead playing. Almost every solo you know lives here. Five notes, no wrong-sounding ones.",
  },
  "blues": {
    name: "Blues",
    intervals: [0, 3, 5, 6, 7, 10],
    degrees: ["1", "b3", "4", "b5", "5", "b7"],
    tip: "Minor pentatonic plus the b5 'blue note'. Pass through that note rather than landing on it and you get instant Zeppelin and Sabbath flavour.",
  },
  "maj-pent": {
    name: "Major pentatonic",
    intervals: [0, 2, 4, 7, 9],
    degrees: ["1", "2", "3", "5", "6"],
    tip: "Brighter and happier than minor pentatonic. Same shapes, different root. Think classic rock and country licks.",
  },
};

const ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// MIDI note of each open string, displayed high e first (top of the diagram)
const STRING_MIDI = [64, 59, 55, 50, 45, 40];
const STRING_LBL = ["e", "B", "G", "D", "A", "E"];
const FRET_COUNT = 15;

const scaleState = { type: "min-pent", rootPc: 9 };   // A minor pentatonic

function buildFretboard(rootPc, intervals, degrees, boxRootPc) {
  const padL = 46, padR = 14, padT = 22, fw = 40, sh = 26;
  const boardW = FRET_COUNT * fw;
  const W = padL + boardW + padR;
  const H = padT + 5 * sh + 44;
  const x = (fret) => padL + fret * fw;          // right edge of a fret
  const dotX = (fret) => padL + (fret - 0.5) * fw;
  const y = (s) => padT + s * sh;

  // the classic first box: four frets starting where the box root sits
  // lowest on the 6th string
  let startFret = 0;
  for (let f = 0; f <= 12; f++) {
    if ((STRING_MIDI[5] + f) % 12 === boxRootPc) { startFret = f; break; }
  }
  const bandFrom = startFret;
  const bandTo = Math.min(FRET_COUNT, startFret + 3);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // suggested starting position band
  svg += `<rect class="fb-band" x="${x(bandFrom - 1)}" y="${y(0) - 10}" width="${
    (bandTo - bandFrom + 1) * fw}" height="${5 * sh + 20}" rx="2"/>`;

  // inlays
  for (const f of [3, 5, 7, 9, 12, 15]) {
    if (f > FRET_COUNT) continue;
    if (f === 12) {
      svg += `<circle class="fb-inlay" cx="${dotX(f)}" cy="${y(1)}" r="3.5"/>`;
      svg += `<circle class="fb-inlay" cx="${dotX(f)}" cy="${y(3)}" r="3.5"/>`;
    } else {
      svg += `<circle class="fb-inlay" cx="${dotX(f)}" cy="${y(2.5)}" r="3.5"/>`;
    }
  }

  // frets + strings
  for (let f = 0; f <= FRET_COUNT; f++) {
    svg += `<line class="${f === 0 ? "fb-nut" : "fb-fret"}" x1="${x(f)}" y1="${
      y(0)}" x2="${x(f)}" y2="${y(5)}"/>`;
  }
  for (let s = 0; s < 6; s++) {
    svg += `<line class="fb-string" x1="${x(0)}" y1="${y(s)}" x2="${x(FRET_COUNT)}" y2="${y(s)}"/>`;
    svg += `<text class="fb-open" x="${padL - 30}" y="${y(s) + 3.5}">${STRING_LBL[s]}</text>`;
  }

  // fret numbers
  for (let f = 1; f <= FRET_COUNT; f++) {
    svg += `<text class="fb-num" x="${dotX(f)}" y="${y(5) + 22}" text-anchor="middle">${f}</text>`;
  }

  // scale tones
  for (let s = 0; s < 6; s++) {
    for (let f = 0; f <= FRET_COUNT; f++) {
      const pc = (STRING_MIDI[s] + f) % 12;
      const idx = intervals.indexOf((pc - rootPc + 12) % 12);
      if (idx === -1) continue;
      const isRoot = idx === 0;
      const cx = f === 0 ? padL - 12 : dotX(f);
      const cy = y(s);
      if (f === 0 && isRoot) {
        svg += `<circle class="fb-root" cx="${cx}" cy="${cy}" r="9"/>`;
        svg += `<text class="fb-root-lbl" x="${cx}" y="${cy + 3}" text-anchor="middle">${ROOTS[pc]}</text>`;
      } else if (f === 0) {
        svg += `<circle class="fb-tone" cx="${cx}" cy="${cy}" r="8"/>`;
      } else if (isRoot) {
        svg += `<circle class="fb-root" cx="${cx}" cy="${cy}" r="10"/>`;
        svg += `<text class="fb-root-lbl" x="${cx}" y="${cy + 3}" text-anchor="middle">${ROOTS[pc]}</text>`;
      } else {
        svg += `<circle class="fb-tone" cx="${cx}" cy="${cy}" r="9"/>`;
        svg += `<text class="fb-tone-lbl" x="${cx}" y="${cy + 3}" text-anchor="middle">${degrees[idx]}</text>`;
      }
    }
  }

  svg += `</svg>`;
  return { svg, startFret, bandFrom, bandTo };
}

function renderScale() {
  const sc = SCALES[scaleState.type];
  const rootName = ROOTS[scaleState.rootPc];
  // major pentatonic shares its shapes with the minor pentatonic a minor
  // third below, so its classic first box sits at that relative-minor root
  const boxRootPc = scaleState.type === "maj-pent"
    ? (scaleState.rootPc + 9) % 12
    : scaleState.rootPc;
  const { svg, bandFrom, bandTo } = buildFretboard(
    scaleState.rootPc, sc.intervals, sc.degrees, boxRootPc);
  document.getElementById("fretboard").innerHTML = svg;

  const where = bandFrom === 0
    ? "open position, using the open strings plus the first three frets"
    : `frets ${bandFrom} to ${bandTo}, index finger at fret ${bandFrom}`;
  document.getElementById("scaleTip").innerHTML =
    `<strong>${rootName} ${sc.name.toLowerCase()}.</strong> ${sc.tip} ` +
    `Start in the shaded box: ${where}. Play it up and down until the shape is in your hands, ` +
    `then try landing on an orange root note at the end of a phrase — that is what makes a lick sound finished.`;

  document.querySelectorAll("#scaleTypeRow .chip").forEach((c) =>
    c.classList.toggle("active", c.dataset.scale === scaleState.type));
  document.querySelectorAll("#scaleRootRow .chip").forEach((c) =>
    c.classList.toggle("active", Number(c.dataset.root) === scaleState.rootPc));
}

function buildScalePickers() {
  const typeRow = document.getElementById("scaleTypeRow");
  for (const [id, sc] of Object.entries(SCALES)) {
    const b = document.createElement("button");
    b.className = "chip wide";
    b.dataset.scale = id;
    b.textContent = sc.name;
    b.addEventListener("click", () => { scaleState.type = id; renderScale(); });
    typeRow.appendChild(b);
  }
  const rootRow = document.getElementById("scaleRootRow");
  ROOTS.forEach((name, pc) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.root = pc;
    b.textContent = name;
    b.addEventListener("click", () => { scaleState.rootPc = pc; renderScale(); });
    rootRow.appendChild(b);
  });
}
buildScalePickers();
renderScale();
applyPreset("oasis-electric");     // show the amp face before power on

// start/stop learn loop alongside power
const _powerOn = powerOn;
powerOn = async function () {
  await _powerOn();
  if (state.view === "learn") startLearn();
};
const _powerOff = powerOff;
powerOff = function () {
  stopLearn();
  _powerOff();
};
