"use strict";
(() => {
// Onglet DJ : deux platines, transition calée sur le tempo (rampe de BPM),
// point de transition conseillé, notes, paires favorites.

// ---------- Options (chacune activable à la main) ----------

// Styles de transition. `blend` : les deux morceaux se mélangent pendant N mesures.
// Sinon B tombe sur la mesure et l'effet sur A se joue juste avant (`lead` temps).
const STYLES = {
  fondu: { label: "Fondu", blend: true, lead: 0, hint: "Fondu enchaîné doux" },
  eq: { label: "Mix EQ", blend: true, lead: 0, hint: "Mélange long, échange des basses au milieu" },
  filtre: { label: "Filtre", blend: true, lead: 0, hint: "A s'efface dans un filtre, B s'ouvre" },
  coupure: { label: "Coupure", lead: 0, hint: "Coupe net sur la mesure" },
  echo: { label: "Écho", lead: 2, hint: "A part en écho, B tombe" },
  reverb: { label: "Réverb", lead: 2, hint: "A se noie dans la réverb" },
  frein: { label: "Freinage", lead: 1, hint: "A ralentit comme un vinyle qu'on arrête" },
  backspin: { label: "Backspin", lead: 1, hint: "A tourne à l'envers" },
  roll: { label: "Loop roll", lead: 4, hint: "A répète un temps de plus en plus court" },
  montee: { label: "Montée", lead: 8, hint: "Souffle qui monte sur 2 mesures, puis drop" },
  stutter: { label: "Stutter", lead: 4, hint: "A hachée en croches, puis drop" },
};
const DJ_DEFAULTS = {
  noRepeat: true, autoPoint: true, sync: true, ramp: true, bassSwap: true, keylock: false, autoNext: false,
  bars: "auto", styles: Object.keys(STYLES), vary: true,
};
let djOpts = { ...DJ_DEFAULTS };
try {
  djOpts = { ...DJ_DEFAULTS, ...JSON.parse(localStorage.getItem("tf-dj") || "{}") };
} catch {}
djOpts.styles = (djOpts.styles || []).filter((k) => STYLES[k]);
if (!djOpts.styles.length) djOpts.styles = ["fondu"];
function saveOpts() {
  try {
    localStorage.setItem("tf-dj", JSON.stringify(djOpts));
  } catch {}
}

// ---------- Moteur audio ----------

let dctx = null;
let master = null;
let workletReady = null;
const LATENCY = 0.02; // = fenêtre du keylock / 2, pour que les deux voies restent calées

function ensureDj() {
  if (dctx) return workletReady;
  dctx = new AudioContext({ latencyHint: "playback" });
  const comp = dctx.createDynamicsCompressor();
  comp.threshold.value = -3;
  comp.ratio.value = 12;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  master = dctx.createGain();
  master.gain.value = 0.9;
  master.connect(comp).connect(dctx.destination);
  fx.meter = dctx.createAnalyser();
  fx.meter.fftSize = 2048;
  master.connect(fx.meter);
  buildFx();
  workletReady = dctx.audioWorklet
    .addModule("dj-worklet.js")
    .then(() => true)
    .catch(() => false);
  for (const d of Object.values(decks)) buildChain(d);
  return workletReady;
}

function newDeck(id) {
  return {
    id,
    track: null,
    buf: null,
    grid: null,
    peaks: null,
    src: null,
    playing: false,
    pos: 0, // position quand arrêtée (secondes du morceau)
    pts: [], // automation du débit : [{ t, r }], linéaire entre deux points
    t0: 0,
    p0: 0,
    pitch: 0, // curseur de tempo, en %
    inPt: 0,
    outPt: 0,
    n: null,
    overview: null,
    loading: false,
    spent: false, // morceau déjà joué puis remplacé par une transition
  };
}
const decks = { A: newDeck("A"), B: newDeck("B") };
let masterDeck = "A";
const other = (id) => (id === "A" ? "B" : "A");

// Effets partagés : écho calé sur le tempo et réverb.
const fx = {};
function buildFx() {
  fx.echoIn = dctx.createGain();
  fx.delay = dctx.createDelay(4);
  fx.fbFilter = dctx.createBiquadFilter();
  fx.fbFilter.type = "lowpass";
  fx.fbFilter.frequency.value = 3200;
  fx.fb = dctx.createGain();
  fx.fb.gain.value = 0.55;
  fx.echoIn.connect(fx.delay).connect(fx.fbFilter).connect(fx.fb).connect(fx.delay);
  fx.fbFilter.connect(master);
  fx.verbIn = dctx.createGain();
  fx.verb = dctx.createConvolver();
  const len = Math.round(dctx.sampleRate * 3.2);
  const ir = dctx.createBuffer(2, len, dctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = ir.getChannelData(c);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp((-i / dctx.sampleRate) * 2.2);
  }
  fx.verb.buffer = ir;
  fx.verbOut = dctx.createGain();
  fx.verbOut.gain.value = 3;
  fx.verbIn.connect(fx.verb).connect(fx.verbOut).connect(master);
  const nl = dctx.sampleRate * 2;
  fx.noise = dctx.createBuffer(1, nl, dctx.sampleRate);
  const nd = fx.noise.getChannelData(0);
  for (let i = 0; i < nl; i++) nd[i] = Math.random() * 2 - 1;
}

function buildChain(d) {
  const n = {};
  n.lock = null;
  n.plain = dctx.createDelay(0.1);
  n.plain.delayTime.value = LATENCY;
  n.plainGain = dctx.createGain();
  n.lockGain = dctx.createGain();
  n.low = dctx.createBiquadFilter();
  n.low.type = "lowshelf";
  n.low.frequency.value = 160;
  n.mid = dctx.createBiquadFilter();
  n.mid.type = "peaking";
  n.mid.frequency.value = 1000;
  n.mid.Q.value = 0.7;
  n.high = dctx.createBiquadFilter();
  n.high.type = "highshelf";
  n.high.frequency.value = 5000;
  n.swap = dctx.createBiquadFilter(); // basses coupées pendant la transition
  n.swap.type = "lowshelf";
  n.swap.frequency.value = 180;
  n.lp = dctx.createBiquadFilter(); // filtres des transitions
  n.lp.type = "lowpass";
  n.lp.frequency.value = 22000;
  n.hp = dctx.createBiquadFilter();
  n.hp.type = "highpass";
  n.hp.frequency.value = 10;
  n.fader = dctx.createGain();
  n.x = dctx.createGain();
  n.echoSend = dctx.createGain();
  n.echoSend.gain.value = 0;
  n.verbSend = dctx.createGain();
  n.verbSend.gain.value = 0;
  n.plain.connect(n.plainGain).connect(n.low);
  n.lockGain.connect(n.low);
  n.low.connect(n.mid).connect(n.high).connect(n.swap).connect(n.lp).connect(n.hp).connect(n.fader).connect(n.x).connect(master);
  n.fader.connect(n.echoSend).connect(fx.echoIn);
  n.fader.connect(n.verbSend).connect(fx.verbIn);
  d.n = n;
  workletReady.then((ok) => {
    if (!ok) return;
    n.lock = new AudioWorkletNode(dctx, "keylock", { outputChannelCount: [2] });
    n.lock.connect(n.lockGain);
    setKeylock(d, djOpts.keylock, true);
  });
  setKeylock(d, djOpts.keylock, true);
  applyX();
}

function setKeylock(d, on, now) {
  if (!d.n) return;
  const t = dctx.currentTime;
  const ok = on && d.n.lock;
  for (const [g, v] of [[d.n.lockGain.gain, ok ? 1 : 0], [d.n.plainGain.gain, ok ? 0 : 1]]) {
    g.cancelScheduledValues(t);
    if (now) g.value = v;
    else {
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(v, t + 0.05);
    }
  }
}

// Débit (vitesse de lecture) à l'instant t, d'après l'automation.
function rateAt(d, t) {
  const p = d.pts;
  if (!p.length) return 1 + d.pitch / 100;
  if (t <= p[0].t) return p[0].r;
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i].t) {
      const a = p[i - 1], b = p[i];
      return b.t === a.t ? b.r : a.r + ((b.r - a.r) * (t - a.t)) / (b.t - a.t);
    }
  }
  return p[p.length - 1].r;
}

// Position dans le morceau à l'instant t (intégrale du débit).
function posAt(d, t = dctx?.currentTime ?? 0) {
  if (!d.playing) return d.pos;
  if (t <= d.t0) return d.p0;
  let pos = d.p0;
  let ta = d.t0;
  let ra = rateAt(d, ta + 1e-9);
  for (const pt of d.pts) {
    if (pt.t <= ta || pt.t >= t) continue;
    pos += ((pt.t - ta) * (ra + rateAt(d, pt.t))) / 2;
    ta = pt.t;
    ra = rateAt(d, ta + 1e-9);
  }
  return pos + ((t - ta) * (ra + rateAt(d, t))) / 2;
}

// Instant où la position `target` sera atteinte (débit actuel constant).
function timeOfPos(d, target) {
  const t = dctx.currentTime;
  return t + (target - posAt(d, t)) / rateAt(d, t);
}

function baseRate(d) {
  return 1 + d.pitch / 100;
}

function automate(d) {
  // Rejoue l'automation du débit sur la source (et le keylock en miroir).
  if (!d.src) return;
  const pr = d.src.playbackRate;
  const lock = d.n.lock?.parameters.get("pitch");
  const t = dctx.currentTime;
  for (const prm of [pr, lock]) {
    if (!prm) continue;
    prm.cancelScheduledValues(0);
    prm.setValueAtTime(prm === pr ? rateAt(d, t) : 1 / rateAt(d, t), t);
  }
  let prev = null;
  for (const pt of d.pts) {
    if (pt.t <= t) {
      prev = pt;
      continue;
    }
    const step = prev && prev.t === pt.t;
    const ramp = !step && prev && prev.r !== pt.r;
    for (const prm of [pr, lock]) {
      if (!prm) continue;
      const v = prm === pr ? pt.r : 1 / pt.r;
      if (ramp) prm.linearRampToValueAtTime(v, pt.t);
      else prm.setValueAtTime(v, pt.t);
    }
    prev = pt;
  }
}

// Coupe l'automation après t (en gardant le débit à cet instant).
function truncatePts(d, t) {
  const r = rateAt(d, t);
  d.pts = d.pts.filter((p) => p.t < t);
  d.pts.push({ t, r });
}

function setRate(d, r, at) {
  const t = at ?? dctx.currentTime;
  if (!d.playing) return;
  truncatePts(d, t);
  d.pts.push({ t, r });
  automate(d);
}

function startSource(d, when, pos) {
  stopSource(d);
  markPlayed(d.track);
  const src = dctx.createBufferSource();
  src.buffer = d.buf;
  src.connect(d.n.plain);
  if (d.n.lock) src.connect(d.n.lock);
  d.src = src;
  d.playing = true;
  d.t0 = when;
  d.p0 = pos;
  d.pts = [{ t: when, r: baseRate(d) }];
  src.playbackRate.value = baseRate(d);
  automate(d);
  src.start(when, Math.max(0, pos));
  src.onended = () => {
    if (d.src !== src) return;
    d.pos = Math.min(posAt(d), d.buf.duration);
    d.playing = false;
    d.src = null;
    renderDeck(d);
  };
}

function stopSource(d) {
  if (!d.src) return;
  const s = d.src;
  d.src = null;
  try {
    s.onended = null;
    s.stop();
  } catch {}
}

async function play(d, when, pos) {
  if (!d.buf) return;
  await ensureDj();
  if (dctx.state === "suspended") await dctx.resume();
  if (typeof audio !== "undefined" && !audio.paused) audio.pause();
  startSource(d, when ?? dctx.currentTime + 0.03, pos ?? d.pos);
  renderDeck(d);
}

function pause(d) {
  if (!d.playing) return;
  d.pos = posAt(d);
  stopSource(d);
  d.playing = false;
  d.pts = [];
  if (mix && (mix.from === d.id || mix.to === d.id)) cancelMix();
  renderDeck(d);
}

function seek(d, pos) {
  pos = Math.max(0, Math.min(pos, (d.buf?.duration || 0) - 0.05));
  if (d.playing) startSource(d, dctx.currentTime + 0.02, pos);
  else d.pos = pos;
  renderDeck(d);
}

// ---------- Grille ----------

const beatLen = (d) => 60 / d.grid.bpm;
// Indice de temps (fractionnaire) d'une position, compté depuis le premier temps.
const beatIndex = (d, pos) => (pos - d.grid.first_beat) / beatLen(d);
const beatPos = (d, i) => d.grid.first_beat + i * beatLen(d);
const effBpm = (d, t) => (d.grid ? d.grid.bpm * (d.playing ? rateAt(d, t ?? dctx.currentTime) : baseRate(d)) : null);

function snapBar(d, pos) {
  if (!d.grid) return pos;
  return beatPos(d, Math.round(beatIndex(d, pos) / 4) * 4);
}

// Prochain début de mesure (4 temps) après pos.
function nextBar(d, pos, minBeats = 0.5) {
  const i = Math.ceil((beatIndex(d, pos) + minBeats) / 4) * 4;
  return beatPos(d, i);
}

/// Facteur double / moitié de tempo : k tel que bpmB·k soit le plus proche de bpmA.
function tempoFactor(bpmA, bpmB) {
  let best = 1;
  for (const k of [0.5, 1, 2]) if (Math.abs(bpmB * k - bpmA) < Math.abs(bpmB * best - bpmA)) best = k;
  return best;
}

// ---------- Transition ----------

let mix = null; // { from, to, T0, T1, armed, preview }

function planBars(a, b) {
  if (djOpts.bars !== "auto") return Number(djOpts.bars);
  // Auto : la plus courte entre l'outro de A et l'intro de B, entre 4 et 32 mesures.
  const beatsA = a.grid.outro_beats || 0;
  const beatsB = b.grid.intro_beats || 0;
  const avail = Math.min(beatsA || 64, beatsB || 64) / 4;
  let bars = 4;
  for (const n of [8, 16, 32]) if (n <= avail) bars = n;
  return bars;
}

function canMix() {
  const a = decks[masterDeck], b = decks[other(masterDeck)];
  return a.buf && b.buf && a.grid && b.grid;
}

// Style de la prochaine transition (tiré au sort parmi ceux cochés si « Varier »).
let plannedStyle = null;
let lastStyle = null;
function pickStyle() {
  const on = djOpts.styles.filter((k) => STYLES[k]);
  if (!on.length) return "fondu";
  if (!djOpts.vary) return on[0];
  const pool = on.length > 1 ? on.filter((k) => k !== lastStyle) : on;
  return pool[Math.floor(Math.random() * pool.length)];
}
function nextStyle() {
  if (!plannedStyle || !djOpts.styles.includes(plannedStyle)) plannedStyle = pickStyle();
  return plannedStyle;
}
// Temps d'avance (secondes) dont l'effet a besoin avant la mesure de B.
function leadSeconds(style, a) {
  return ((STYLES[style].lead || 0) * 60) / (effBpm(a) || 120);
}

function resetFx(d, t) {
  const n = d.n;
  for (const [prm, v] of [[n.swap.gain, 0], [n.lp.frequency, 22000], [n.hp.frequency, 10], [n.echoSend.gain, 0], [n.verbSend.gain, 0]]) {
    prm.cancelScheduledValues(t);
    prm.setValueAtTime(v, t);
  }
}

let fxSources = []; // sources ajoutées par un effet (loop roll, backspin, souffle)
function stopFxSources() {
  for (const s of fxSources) {
    try {
      s.stop();
    } catch {}
  }
  fxSources = [];
}

// Coupe la lecture normale de A à t, sans la marquer arrêtée (la position continue).
function stopAt(d, t) {
  if (!d.src) return;
  d.src.onended = null;
  d.src.stop(t);
}

// Lit un extrait de A dans sa chaîne (pour les effets qui remplacent sa lecture).
function fxSource(d, buf) {
  const src = dctx.createBufferSource();
  src.buffer = buf;
  src.connect(d.n.plain);
  if (d.n.lock) src.connect(d.n.lock);
  fxSources.push(src);
  return src;
}

const powerCurves = (n = 64) => {
  const ca = new Float32Array(n), cb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    ca[i] = Math.cos((x * Math.PI) / 2);
    cb[i] = Math.sin((x * Math.PI) / 2);
  }
  return [ca, cb];
};

// Programme la transition : B entre à T0, sur un début de mesure de A.
function schedule(T0, opts = {}) {
  const a = decks[masterDeck], b = decks[other(masterDeck)];
  const style = opts.style || nextStyle();
  const st = STYLES[style];
  const bars = planBars(a, b);
  const beats = bars * 4;
  const bpmA = effBpm(a, T0);
  const beatA = 60 / bpmA; // durée réelle d'un temps de A
  const rA = rateAt(a, T0);
  const k = tempoFactor(bpmA, b.grid.bpm);
  const bpmBt = b.grid.bpm * k; // tempo de B exprimé dans la grille de A
  const sync = djOpts.sync;
  const ramp = sync && djOpts.ramp;
  const endBpm = ramp ? bpmBt : bpmA;
  // Durée réelle : tempo linéaire de bpmA à endBpm sur `beats` temps.
  const D = (120 * beats) / (bpmA + endBpm);
  const now = dctx.currentTime;
  const L0 = T0 - st.lead * beatA; // début de l'effet sur A
  const T1 = st.blend || ramp ? T0 + D : T0 + 0.05;

  stopFxSources();
  resetFx(a, now);
  resetFx(b, now);

  // Départ de B : son point d'entrée, sur la mesure.
  const rB0 = sync ? bpmA / bpmBt : baseRate(b);
  startSource(b, T0, b.inPt);
  b.pts = [{ t: T0, r: rB0 }];
  if (ramp) b.pts.push({ t: T0 + D, r: 1 });
  automate(b);
  if (ramp && st.blend) {
    truncatePts(a, T0);
    a.pts.push({ t: T1, r: endBpm / a.grid.bpm });
    automate(a);
  }
  if (!ramp && sync) b.pitch = Math.round((rB0 - 1) * 1000) / 10;

  const xa = a.n.x.gain, xb = b.n.x.gain;
  for (const g of [xa, xb]) g.cancelScheduledValues(now);
  xa.setValueAtTime(xGain(a.id), now);
  xb.setValueAtTime(0, now);
  // Instant du n-ième temps après T0 (le tempo varie linéairement pendant D).
  const beatTime = (n) => {
    const qa = (endBpm - bpmA) / (2 * D * 60), qb = bpmA / 60;
    return T0 + (Math.abs(qa) < 1e-9 ? n / qb : (-qb + Math.sqrt(qb * qb + 4 * qa * n)) / (2 * qa));
  };
  const mid = beatTime(Math.round(bars / 2) * 4);
  const bassSwapAt = (t) => {
    const sa = a.n.swap.gain, sb = b.n.swap.gain;
    sb.setValueAtTime(-40, now);
    sa.setValueAtTime(0, t - 0.03);
    sa.linearRampToValueAtTime(-40, t + 0.03);
    sb.setValueAtTime(-40, t - 0.03);
    sb.linearRampToValueAtTime(0, t + 0.03);
  };
  // A s'arrête net à T0, B tombe à T0.
  const drop = () => {
    xa.setValueAtTime(1, Math.max(now, T0 - 0.004));
    xa.linearRampToValueAtTime(0, T0 + 0.004);
    xb.setValueAtTime(1, T0);
  };

  switch (style) {
    case "fondu": {
      const [ca, cb] = powerCurves();
      xa.setValueCurveAtTime(ca, T0, D);
      xb.setValueCurveAtTime(cb, T0, D);
      if (djOpts.bassSwap) bassSwapAt(mid);
      break;
    }
    case "eq": {
      // B entre vite sans basses, les basses s'échangent au milieu, A sort à la fin.
      xb.setValueAtTime(0, T0);
      xb.linearRampToValueAtTime(1, beatTime(beats / 4));
      xa.setValueAtTime(1, beatTime((beats * 3) / 4));
      xa.linearRampToValueAtTime(0, T1);
      bassSwapAt(mid);
      break;
    }
    case "filtre": {
      const [ca, cb] = powerCurves();
      a.n.hp.frequency.setValueAtTime(10, T0);
      a.n.hp.frequency.exponentialRampToValueAtTime(1800, T1);
      b.n.lp.frequency.setValueAtTime(250, T0);
      b.n.lp.frequency.exponentialRampToValueAtTime(22000, T1);
      xa.setValueCurveAtTime(ca, T0, D);
      xb.setValueCurveAtTime(cb, T0, D);
      if (djOpts.bassSwap) bassSwapAt(mid);
      break;
    }
    case "coupure":
      drop();
      break;
    case "echo": {
      // Le dernier temps de A part dans un écho en croche pointée qui s'éteint.
      fx.delay.delayTime.setValueAtTime(0.75 * beatA, now);
      const sg = a.n.echoSend.gain;
      sg.setValueAtTime(0, now);
      sg.setValueAtTime(0, T0 - beatA);
      sg.linearRampToValueAtTime(1, T0 - beatA + 0.02);
      sg.setValueAtTime(1, T0);
      sg.linearRampToValueAtTime(0, T0 + 0.02);
      a.n.hp.frequency.setValueAtTime(10, L0);
      a.n.hp.frequency.exponentialRampToValueAtTime(300, T0);
      drop();
      break;
    }
    case "reverb": {
      const sg = a.n.verbSend.gain;
      sg.setValueAtTime(0, L0);
      sg.linearRampToValueAtTime(1, T0);
      sg.linearRampToValueAtTime(0, T0 + 0.03);
      a.n.hp.frequency.setValueAtTime(10, L0);
      a.n.hp.frequency.exponentialRampToValueAtTime(500, T0);
      drop();
      break;
    }
    case "frein": {
      // Le débit de A tombe à presque rien sur un temps (comme une platine qu'on arrête).
      truncatePts(a, L0);
      a.pts.push({ t: T0, r: 0.03 });
      automate(a);
      xa.setValueAtTime(1, L0);
      xa.linearRampToValueAtTime(0.6, T0 - 0.01);
      drop();
      break;
    }
    case "backspin": {
      // 2,5 s de A jouées à l'envers, vite puis de moins en moins.
      const P = posAt(a, L0);
      const sr = a.buf.sampleRate;
      const len = Math.min(Math.round(2.5 * sr), Math.round(P * sr));
      if (len > sr * 0.2) {
        const rev = dctx.createBuffer(a.buf.numberOfChannels, len, sr);
        const end = Math.round(P * sr);
        for (let c = 0; c < a.buf.numberOfChannels; c++) {
          const from = a.buf.getChannelData(c), to = rev.getChannelData(c);
          for (let i = 0; i < len; i++) to[i] = from[end - 1 - i];
        }
        stopAt(a, L0);
        const sp = fxSource(a, rev);
        sp.playbackRate.setValueAtTime(3, L0);
        sp.playbackRate.exponentialRampToValueAtTime(0.4, T0);
        sp.start(L0);
        sp.stop(T0 + 0.01);
      }
      drop();
      break;
    }
    case "roll": {
      // Le temps juste avant la mesure est répété : 1, 1/2, 1/4 puis 1/8 de temps.
      const P = posAt(a, L0);
      const bl = beatLen(a);
      stopAt(a, L0);
      [1, 0.5, 0.25, 0.125].forEach((f, i) => {
        const s = fxSource(a, a.buf);
        s.loop = true;
        s.loopStart = P;
        s.loopEnd = P + bl * f;
        s.playbackRate.value = rA;
        const t = L0 + i * beatA;
        s.start(t, P);
        s.stop(t + beatA);
      });
      a.n.hp.frequency.setValueAtTime(10, L0);
      a.n.hp.frequency.exponentialRampToValueAtTime(900, T0);
      drop();
      break;
    }
    case "montee": {
      // Souffle qui monte sur 2 mesures pendant que A perd ses basses.
      const ns = dctx.createBufferSource();
      ns.buffer = fx.noise;
      ns.loop = true;
      const bp = dctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.5;
      const g = dctx.createGain();
      ns.connect(bp).connect(g).connect(master);
      bp.frequency.setValueAtTime(300, L0);
      bp.frequency.exponentialRampToValueAtTime(9000, T0);
      g.gain.setValueAtTime(0, now);
      g.gain.setValueAtTime(0.0001, L0);
      g.gain.exponentialRampToValueAtTime(0.35, T0);
      g.gain.setTargetAtTime(0, T0, 0.08);
      ns.start(L0);
      ns.stop(T0 + 1);
      fxSources.push(ns);
      a.n.hp.frequency.setValueAtTime(10, L0);
      a.n.hp.frequency.exponentialRampToValueAtTime(700, T0);
      drop();
      break;
    }
    case "stutter": {
      // Dernière mesure de A hachée : croches, puis doubles croches.
      xa.setValueAtTime(1, L0);
      for (let i = 0; i < 12; i++) {
        const sub = i < 4 ? 0.5 : 0.25;
        const t = i < 4 ? L0 + i * 0.5 * beatA : L0 + 2 * beatA + (i - 4) * 0.25 * beatA;
        xa.setValueAtTime(1, t);
        xa.setValueAtTime(0, t + sub * beatA * 0.55);
      }
      drop();
      break;
    }
  }

  lastStyle = style;
  plannedStyle = null;
  mix = { from: a.id, to: b.id, T0, T1, D, bars, bpmA, endBpm, k, style, blend: !!st.blend, ramp, armed: false, preview: opts.preview || null };
  renderAll();
}

function xGain(id) {
  const v = Number($("#xfader").value) / 1000;
  return id === "A" ? Math.cos((v * Math.PI) / 2) : Math.sin((v * Math.PI) / 2);
}

function applyX() {
  for (const d of Object.values(decks)) {
    if (!d.n) continue;
    const g = d.n.x.gain;
    g.cancelScheduledValues(dctx.currentTime);
    g.setTargetAtTime(xGain(d.id), dctx.currentTime, 0.01);
  }
}

function finishMix() {
  const m = mix;
  mix = null;
  const a = decks[m.from], b = decks[m.to];
  pause(a);
  for (const d of [a, b]) resetFx(d, dctx.currentTime);
  b.n.x.gain.cancelScheduledValues(0);
  b.n.x.gain.value = 1;
  a.n.x.gain.cancelScheduledValues(0);
  a.n.x.gain.value = 0;
  $("#xfader").value = b.id === "A" ? 0 : 1000;
  masterDeck = b.id;
  a.spent = true;
  lastMix = { a: a.track.path, b: b.track.path };
  if (djOpts.ramp && djOpts.sync) b.pitch = 0;
  if (m.preview) return endPreview(m.preview);
  renderAll();
  if (djOpts.autoNext) loadBestNext();
}

let autoSkip = null; // transition auto annulée à la main : on ne la réarme pas
function cancelMix(byUser = false) {
  if (!mix) return;
  const m = mix;
  mix = null;
  if (byUser && m.from) autoSkip = `${decks[m.from].track?.path}|${decks[m.from].outPt}`;
  if (m.armed) return renderAll();
  const a = decks[m.from], b = decks[m.to];
  if (b.playing && dctx.currentTime < m.T0) {
    stopSource(b);
    b.playing = false;
    b.pos = b.inPt;
  }
  stopFxSources();
  for (const d of [a, b]) {
    resetFx(d, dctx.currentTime);
    for (const s of [d.n.echoSend.gain, d.n.verbSend.gain]) s.value = 0;
    if (d.playing) {
      // Un effet a pu couper la lecture normale de A : on la relance où elle en est.
      if (d === a && dctx.currentTime >= m.T0 - STYLES[m.style].lead * (60 / m.bpmA)) startSource(d, dctx.currentTime + 0.02, posAt(d));
      else setRate(d, rateAt(d, dctx.currentTime));
    }
  }
  applyX();
  renderAll();
}

// Mixer : maintenant (prochaine mesure) ou au point conseillé.
function startMix(now) {
  if (!canMix()) return;
  const a = decks[masterDeck];
  if (mix && !mix.auto) return cancelMix(true);
  if (!a.playing) {
    // A à l'arrêt : on le lance depuis sa position.
    play(a).then(() => startMix(now));
    return;
  }
  const t = dctx.currentTime;
  const pos = posAt(a, t);
  const lead = leadSeconds(nextStyle(), a) * rateAt(a, t);
  let target = now || pos > a.outPt - lead - 0.05 ? nextBar(a, pos + lead + 0.25 * rateAt(a, t)) : a.outPt;
  if (!djOpts.sync) target = pos + lead + 0.3;
  mix = { from: a.id, to: other(a.id), target, armed: true };
  renderMixer();
}

// Préécoute : on se place 4 mesures avant la sortie, on écoute la transition,
// puis on revient où on était.
async function preview() {
  if (!canMix()) return;
  if (mix?.preview || mix) cancelMix();
  const a = decks[masterDeck], b = decks[other(masterDeck)];
  const saved = { master: a.id, posA: posAt(a), playingA: a.playing, posB: b.pos, x: $("#xfader").value, pitchA: a.pitch, pitchB: b.pitch };
  const lead = 16 * beatLen(a);
  await play(a, undefined, Math.max(0, a.outPt - lead));
  mix = { from: a.id, to: b.id, target: a.outPt, armed: true, previewSaved: saved };
  renderMixer();
}

function endPreview(saved) {
  // Laisse sonner 2 mesures après la transition, puis remet tout en place.
  const b = decks[other(saved.master)];
  const back = () => {
    const a = decks[saved.master];
    pause(b);
    b.pos = saved.posB;
    b.pitch = saved.pitchB;
    a.pitch = saved.pitchA;
    masterDeck = saved.master;
    $("#xfader").value = saved.x;
    applyX();
    a.pos = saved.posA;
    if (saved.playingA) play(a);
    renderAll();
  };
  previewTimer = setTimeout(back, 8 * beatLen(b) * 1000);
  renderAll();
}
let previewTimer = null;
let lastMix = null;

// Boucle : arme la transition à l'approche du point, met à jour l'affichage.
function tick() {
  if (!dctx) return;
  const t = dctx.currentTime;
  if (mix?.armed) {
    const a = decks[mix.from];
    if (!a.playing) cancelMix();
    else {
      const T0 = timeOfPos(a, mix.target);
      const style = nextStyle();
      const lead = leadSeconds(style, a);
      if (T0 - t < lead + 0.35) {
        const preview = mix.previewSaved;
        mix = null;
        // Trop tard pour l'effet en entier : on prend la mesure suivante.
        if (T0 - t < lead + 0.05) {
          mix = { from: a.id, to: other(a.id), target: nextBar(a, posAt(a, t) + (lead + 0.3) * rateAt(a, t)), armed: true, previewSaved: preview };
          return;
        }
        schedule(T0, { preview, style });
      }
    }
  } else if (mix && t >= mix.T1) finishMix();
  else if (!mix && djOpts.autoPoint && canMix() && !decks[other(masterDeck)].spent) {
    // Point de transition auto : on arme dès que A joue et que B attend.
    const a = decks[masterDeck], b = decks[other(masterDeck)];
    const key = `${a.track.path}|${a.outPt}`;
    const pos = posAt(a, t);
    const lead = (leadSeconds(nextStyle(), a) + 0.3) * rateAt(a, t);
    // Déjà trop près (ou un peu après) du point de sortie : prochaine mesure possible.
    if (a.playing && !b.playing && autoSkip !== key && pos < a.outPt + 32 * beatLen(a))
      mix = { from: a.id, to: b.id, target: pos < a.outPt - lead ? a.outPt : nextBar(a, pos + lead), armed: true, auto: true };
  }
  if (mix?.auto && !djOpts.autoPoint) mix = null;
}
setInterval(tick, 50);

// ---------- Chargement ----------

async function loadDeck(id, t) {
  const d = decks[id];
  if (!t) return;
  if (d.playing && mix) return toast("Attends la fin de la transition", true);
  if (d.playing) pause(d);
  d.loading = true;
  d.track = t;
  d.buf = null;
  d.grid = null;
  d.peaks = null;
  d.overview = null;
  d.pitch = 0;
  d.spent = false;
  renderDeck(d);
  try {
    await ensureDj();
    const [bytes, grid] = await Promise.all([
      invoke("audio_bytes", { path: t.path }),
      invoke("beat_grid", { path: t.path, bpm: t.bpm || null }),
    ]);
    if (d.track !== t) return;
    const ab = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
    d.buf = await dctx.decodeAudioData(ab);
    d.grid = grid;
    grids.set(t.path, grid);
    d.peaks = computePeaks(d.buf);
    d.pos = grid.mix_in;
    d.inPt = grid.mix_in;
    d.outPt = grid.mix_out;
  } catch (e) {
    toast("Chargement impossible : " + e, true);
    d.track = null;
  } finally {
    d.loading = false;
  }
  if (!decks[other(id)].track) masterDeck = id;
  renderAll();
}

function loadBestNext() {
  const a = decks[masterDeck];
  const free = other(masterDeck);
  if (!a.track) return;
  const list = nextFor(a.track, true);
  if (list.length) loadDeck(free, list[0].t);
  else toast("Plus rien à enchaîner : tous les morceaux ont déjà été joués", true);
}

// Pics pour la forme d'onde : 100 colonnes par seconde.
const PEAK_RATE = 100;
function computePeaks(buf) {
  const ch = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : null];
  const per = Math.max(1, Math.floor(buf.sampleRate / PEAK_RATE));
  const n = Math.ceil(buf.length / per);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(buf.length, (i + 1) * per);
    for (let j = i * per; j < end; j += 4) {
      const v = Math.abs(ch[0][j]) + (ch[1] ? Math.abs(ch[1][j]) : Math.abs(ch[0][j]));
      if (v > m) m = v;
    }
    out[i] = m / 2;
  }
  return out;
}

// ---------- Interface des platines ----------

const deckEl = (id) => document.querySelector(`.deck[data-deck="${id}"]`);
const fmtBpm = (b) => (b ? b.toFixed(1).replace(".", ",") : "–");
const fmtT = (s) => {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

function deckTemplate(id) {
  const el = deckEl(id);
  el.innerHTML = `
    <div class="d-head">
      <div class="d-cover"><svg><use href="#i-note"/></svg><img alt=""/></div>
      <div class="d-meta"><b class="d-title"></b><small class="d-artist"></small><div class="d-tags"></div></div>
      <div class="d-tempo"><b class="d-bpm">–</b><small class="d-pitch"></small></div>
    </div>
    <canvas class="overview" title="Clic : aller à · Maj + clic : point d'entrée · Alt + clic : point de sortie"></canvas>
    <div class="d-times muted small"><span class="d-pos">0:00</span><span class="d-points"></span><span class="d-left">-0:00</span></div>
    <div class="d-controls">
      <button class="icon d-play" title="Lecture / pause (${id === "A" ? "Q" : "P"})"><svg><use href="#i-play"/></svg></button>
      <button class="icon d-cue" title="Revenir au point d'entrée"><svg><use href="#i-cue"/></svg></button>
      <button class="ghost small d-sync" title="Cale le tempo et les temps sur l'autre platine"><svg><use href="#i-sync"/></svg><span>Sync</span></button>
      <button class="link d-setin" title="Point d'entrée à la mesure en cours">Entrée ici</button>
      <button class="link d-setout" title="Point de sortie à la mesure en cours">Sortie ici</button>
      <button class="link d-auto" title="Points conseillés par l'analyse">Auto</button>
    </div>
    <label class="d-slider"><span>Tempo</span><input type="range" class="d-rate" min="-80" max="80" value="0" title="Double-clic : remettre à 0" /><output class="d-rate-v">0 %</output></label>
    <div class="d-eq">
      <label><span>Vol</span><input type="range" class="d-vol" min="0" max="100" value="100" /></label>
      <label><span>Aigus</span><input type="range" class="d-eq-h" min="-26" max="6" value="0" title="Double-clic : 0" /></label>
      <label><span>Médiums</span><input type="range" class="d-eq-m" min="-26" max="6" value="0" title="Double-clic : 0" /></label>
      <label><span>Basses</span><input type="range" class="d-eq-l" min="-26" max="6" value="0" title="Double-clic : 0" /></label>
    </div>
    <details class="d-note"><summary><svg><use href="#i-pen"/></svg> Note</summary><textarea rows="2" placeholder="Ex. : drop à 1:32, ne pas mixer avec du vocal"></textarea></details>
    <div class="d-empty"><div>Glisse un morceau ici<br><span class="muted small">ou choisis-en un plus bas</span></div></div>`;
  const d = decks[id];
  el.querySelector(".d-play").onclick = () => (d.playing ? pause(d) : play(d));
  el.querySelector(".d-cue").onclick = () => seek(d, d.inPt);
  el.querySelector(".d-sync").onclick = () => syncDeck(d);
  el.querySelector(".d-setin").onclick = () => setPoint(d, "in", posAt(d));
  el.querySelector(".d-setout").onclick = () => setPoint(d, "out", posAt(d));
  el.querySelector(".d-auto").onclick = () => {
    if (!d.grid) return;
    d.inPt = d.grid.mix_in;
    d.outPt = d.grid.mix_out;
    renderDeck(d);
  };
  const rate = el.querySelector(".d-rate");
  rate.oninput = () => {
    d.pitch = Number(rate.value) / 10;
    if (d.playing && !(mix && !mix.armed)) setRate(d, baseRate(d));
    renderDeck(d);
  };
  rate.ondblclick = () => {
    rate.value = 0;
    rate.oninput();
  };
  const eq = (cls, node) => {
    const i = el.querySelector(cls);
    i.oninput = () => d.n && (d.n[node].gain.value = Number(i.value));
    i.ondblclick = () => ((i.value = 0), i.oninput());
  };
  eq(".d-eq-h", "high");
  eq(".d-eq-m", "mid");
  eq(".d-eq-l", "low");
  const vol = el.querySelector(".d-vol");
  vol.oninput = () => d.n && (d.n.fader.gain.value = (Number(vol.value) / 100) ** 2);
  const ov = el.querySelector(".overview");
  ov.onclick = (e) => {
    if (!d.buf) return;
    const r = ov.getBoundingClientRect();
    const pos = ((e.clientX - r.left) / r.width) * d.buf.duration;
    if (e.shiftKey) setPoint(d, "in", pos);
    else if (e.altKey) setPoint(d, "out", pos);
    else seek(d, pos);
  };
  const note = el.querySelector("textarea");
  note.onchange = () => d.track && saveNote(d.track.path, note.value);
}

function setPoint(d, which, pos) {
  if (!d.grid) return;
  pos = snapBar(d, pos);
  if (which === "in") d.inPt = Math.max(0, pos);
  else d.outPt = Math.min(pos, d.buf.duration - 1);
  if (mix?.armed && mix.from === d.id) mix.target = d.outPt;
  renderDeck(d);
}

// Sync : même tempo que l'autre platine, temps alignés.
function syncDeck(d) {
  const o = decks[other(d.id)];
  if (!d.grid || !o.grid) return;
  const t = dctx ? dctx.currentTime : 0;
  const bpmO = o.playing ? effBpm(o, t) : o.grid.bpm * baseRate(o);
  const k = tempoFactor(bpmO, d.grid.bpm);
  const r = bpmO / (d.grid.bpm * k);
  d.pitch = Math.max(-8, Math.min(8, Math.round((r - 1) * 1000) / 10));
  if (d.playing && o.playing) {
    // Décale la position de moins d'un demi-temps pour tomber sur les temps de l'autre.
    const when = t + 0.05;
    const phO = beatIndex(o, posAt(o, when)) / k;
    const pos = posAt(d, when);
    const phD = beatIndex(d, pos);
    let delta = (phO - phD) % 1;
    if (delta > 0.5) delta -= 1;
    if (delta < -0.5) delta += 1;
    startSource(d, when, pos + delta * beatLen(d));
    setRate(d, 1 + d.pitch / 100, when);
  } else if (d.playing) setRate(d, baseRate(d));
  renderDeck(d);
}

function renderDeck(d) {
  const el = deckEl(d.id);
  if (!el.firstElementChild) deckTemplate(d.id);
  const t = d.track;
  el.classList.toggle("empty", !t);
  el.classList.toggle("loading", d.loading);
  el.classList.toggle("master", masterDeck === d.id && !!t);
  el.classList.toggle("playing", d.playing);
  el.querySelector(".d-title").textContent = t ? t.title : "";
  el.querySelector(".d-artist").textContent = t ? t.artist || "" : "";
  const tags = el.querySelector(".d-tags");
  tags.replaceChildren();
  if (t?.key) tags.append(keyPill(t.key));
  if (d.grid?.dj_intro) tags.append(badge(`Intro DJ ${d.grid.intro_beats / 4} mes.`, "ok"));
  if (d.loading) tags.append(badge("Analyse…"));
  const img = el.querySelector(".d-cover img");
  img.removeAttribute("src");
  img.classList.remove("on");
  if (t?.has_cover || t?.hasCover) coverFor(t.path).then((u) => d.track === t && setImg(img, u));
  el.querySelector(".d-play use").setAttribute("href", d.playing ? "#i-pause" : "#i-play");
  el.querySelector(".d-rate").value = Math.round(d.pitch * 10);
  el.querySelector(".d-rate-v").textContent = `${d.pitch > 0 ? "+" : ""}${d.pitch.toFixed(1).replace(".", ",")} %`;
  const note = el.querySelector("textarea");
  if (document.activeElement !== note) note.value = t ? notes.get(t.path) || "" : "";
  el.querySelector(".d-note").open = !!(t && notes.get(t.path));
  el.querySelector(".d-points").textContent = d.grid ? `entrée ${fmtT(d.inPt)} · sortie ${fmtT(d.outPt)}` : "";
  for (const b of el.querySelectorAll("button")) b.disabled = !d.buf;
  d.overview = null;
  renderMixer();
}

function badge(text, cls = "") {
  const s = document.createElement("span");
  s.className = "badge-s " + cls;
  s.textContent = text;
  return s;
}

function renderAll() {
  for (const d of Object.values(decks)) renderDeck(d);
  renderBrowser();
}

function renderMixer() {
  const a = decks[masterDeck], b = decks[other(masterDeck)];
  const ok = canMix();
  const go = $("#mix-go");
  go.disabled = !ok && !mix;
  $("#mix-preview").disabled = !ok || !!(mix && !mix.armed);
  $("#mix-pair").disabled = !(a.track && b.track);
  const arrow = `${a.id} → ${b.id}`;
  go.querySelector("span").textContent = mix && !mix.auto ? "Annuler" : `Mixer ${arrow}`;
  go.title = mix && !mix.auto ? "Annuler la transition (Espace)" : "Lance la transition à la prochaine mesure (Espace)";
  const plan = $("#mix-plan");
  if (!ok) {
    plan.textContent = !a.track || !b.track ? "Charge un morceau sur chaque platine." : "Analyse en cours…";
    return;
  }
  const bars = planBars(a, b);
  const bpmA = a.grid.bpm * baseRate(a);
  const k = tempoFactor(bpmA, b.grid.bpm);
  const parts = [];
  parts.push(`Sortie de ${a.id} à ${fmtT(a.outPt)}${a.grid.outro_beats >= 16 && Math.abs(a.outPt - a.grid.mix_out) < 0.05 ? " (début de l'outro)" : ""}`);
  parts.push(`entrée de ${b.id} à ${fmtT(b.inPt)}${b.grid.dj_intro && Math.abs(b.inPt - b.grid.mix_in) < 0.05 ? " (intro DJ)" : ""}`);
  let tempo = "";
  if (djOpts.sync && djOpts.ramp) tempo = `tempo ${fmtBpm(bpmA)} → ${fmtBpm(b.grid.bpm * k)} BPM`;
  else if (djOpts.sync) tempo = `${b.id} calé à ${fmtBpm(bpmA)} BPM`;
  else tempo = "sans synchro";
  if (k !== 1) tempo += k === 2 ? " (B en double tempo)" : " (B en demi-tempo)";
  const style = nextStyle();
  const st = STYLES[style];
  plan.replaceChildren(`${parts.join(", ")}. ${st.blend ? bars + " mesures, " : ""}${tempo}. `);
  const sb = document.createElement("b");
  sb.textContent = `Style : ${st.label}`;
  sb.title = st.hint;
  plan.append(sb);
  if (djOpts.vary && djOpts.styles.length > 1 && !(mix && !mix.armed)) {
    const re = document.createElement("button");
    re.className = "link reroll";
    re.textContent = "↻ autre";
    re.title = "Tirer un autre style";
    re.onclick = () => {
      plannedStyle = pickStyle();
      renderMixer();
    };
    plan.append(" ", re);
  }
}

function setStatus() {
  const s = $("#mix-status");
  const t = dctx?.currentTime ?? 0;
  const a = decks[masterDeck];
  if (mix && !mix.armed) {
    const done = Math.max(0, (t - mix.T0) / mix.D);
    const name = STYLES[mix.style].label;
    if (t < mix.T0) s.textContent = `${name} · B tombe sur la mesure…`;
    else if (mix.blend) {
      const bpm = mix.bpmA + (mix.endBpm - mix.bpmA) * Math.min(1, done);
      s.textContent = `${name} ${Math.min(mix.bars, Math.floor(done * mix.bars) + 1)}/${mix.bars} mesures · ${fmtBpm(bpm)} BPM`;
    } else s.textContent = `${name} · ${fmtBpm(effBpm(decks[mix.to], t))} BPM`;
    const x = mix.blend ? Math.min(1, done) : t >= mix.T0 ? 1 : 0;
    $("#xfader").value = Math.round(x * 1000 * (mix.to === "B" ? 1 : -1) + (mix.to === "B" ? 0 : 1000));
  } else if (mix?.armed) {
    const left = (mix.target - posAt(decks[mix.from], t)) / rateAt(decks[mix.from], t);
    s.textContent = `${mix.previewSaved ? "Pré-écoute : " : ""}${STYLES[nextStyle()].label} dans ${fmtT(left)}`;
  } else if (a.playing && a.grid) s.textContent = `${fmtBpm(effBpm(a, t))} BPM`;
  else s.textContent = canMix() ? "Prêt" : "Charge deux morceaux";
}

// ---------- Formes d'onde ----------

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fitCanvas(c) {
  const r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * devicePixelRatio));
  const h = Math.max(1, Math.round(r.height * devicePixelRatio));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
    return true;
  }
  return false;
}

const DECK_COLOR = { A: "--accent", B: "--accent-2" };

function drawOverview(d) {
  const c = deckEl(d.id).querySelector(".overview");
  const resized = fitCanvas(c);
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!d.peaks) return;
  if (!d.overview || resized) {
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const o = off.getContext("2d");
    const per = d.peaks.length / W;
    o.fillStyle = css(DECK_COLOR[d.id]);
    for (let x = 0; x < W; x++) {
      let m = 0;
      for (let j = Math.floor(x * per); j < Math.floor((x + 1) * per); j++) m = Math.max(m, d.peaks[j] || 0);
      const h = Math.max(1, m * H * 0.95);
      o.fillRect(x, (H - h) / 2, 1, h);
    }
    d.overview = off;
  }
  const dur = d.buf.duration;
  const X = (s) => (s / dur) * W;
  const gr = d.grid;
  if (gr) {
    g.fillStyle = "rgba(60,200,120,.18)";
    if (gr.intro_end) g.fillRect(X(gr.first_beat), 0, X(gr.intro_end) - X(gr.first_beat), H);
    g.fillStyle = "rgba(255,170,40,.18)";
    if (gr.outro_start) g.fillRect(X(gr.outro_start), 0, W - X(gr.outro_start), H);
  }
  const pos = posAt(d);
  g.globalAlpha = 0.35;
  g.drawImage(d.overview, 0, 0);
  g.globalAlpha = 1;
  g.save();
  g.beginPath();
  g.rect(0, 0, X(pos), H);
  g.clip();
  g.drawImage(d.overview, 0, 0);
  g.restore();
  const mark = (s, color) => {
    g.fillStyle = color;
    g.fillRect(Math.round(X(s)) - devicePixelRatio, 0, 2 * devicePixelRatio, H);
  };
  if (gr) {
    mark(d.inPt, "#3cc878");
    mark(d.outPt, "#ffaa28");
  }
  mark(pos, css("--text"));
}

const ZOOM_SECONDS = 6;
function drawZoom(d) {
  const c = document.querySelector(`.wave-row[data-deck="${d.id}"] canvas`);
  fitCanvas(c);
  const g = c.getContext("2d");
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!d.peaks) return;
  const t = dctx?.currentTime ?? 0;
  const pos = posAt(d, t);
  const rate = d.playing ? rateAt(d, t) : baseRate(d);
  const span = ZOOM_SECONDS * rate; // secondes du morceau visibles
  const start = pos - span / 2;
  const px = span / W;
  const gr = d.grid;
  // Zones intro / outro.
  if (gr) {
    const X = (s) => (s - start) / px;
    g.fillStyle = "rgba(60,200,120,.12)";
    if (gr.intro_end) g.fillRect(X(gr.first_beat), 0, X(gr.intro_end) - X(gr.first_beat), H);
    g.fillStyle = "rgba(255,170,40,.12)";
    if (gr.outro_start) g.fillRect(X(gr.outro_start), 0, W, H);
  }
  g.fillStyle = css(DECK_COLOR[d.id]);
  for (let x = 0; x < W; x += 2) {
    const s = start + x * px;
    const i0 = Math.floor(s * PEAK_RATE), i1 = Math.floor((s + 2 * px) * PEAK_RATE);
    let m = 0;
    for (let i = Math.max(0, i0); i <= Math.min(d.peaks.length - 1, i1); i++) m = Math.max(m, d.peaks[i]);
    const h = Math.max(1, m * H * 0.9);
    g.fillRect(x, (H - h) / 2, 2, h);
  }
  // Grille : temps, mesures, phrases de 16 temps.
  if (gr) {
    const bl = beatLen(d);
    const first = Math.ceil(beatIndex(d, start));
    for (let i = first; beatPos(d, i) < start + span; i++) {
      const x = (beatPos(d, i) - start) / px;
      const bar = i % 4 === 0, phrase = i % 16 === 0;
      g.fillStyle = phrase ? "rgba(255,255,255,.75)" : bar ? "rgba(255,255,255,.4)" : "rgba(255,255,255,.14)";
      if (i < 0) continue;
      g.fillRect(Math.round(x), 0, phrase ? 2 : 1, bar ? H : H * 0.25);
    }
    void bl;
    for (const [s, col] of [[d.inPt, "#3cc878"], [d.outPt, "#ffaa28"]]) {
      const x = (s - start) / px;
      if (x < 0 || x > W) continue;
      g.fillStyle = col;
      g.fillRect(Math.round(x) - 1, 0, 3, H);
    }
  }
  g.fillStyle = css("--text");
  g.fillRect(Math.round(W / 2), 0, Math.max(1, devicePixelRatio), H);
}

function updateTimes(d) {
  const el = deckEl(d.id);
  if (!d.buf) return;
  const t = dctx?.currentTime ?? 0;
  const pos = posAt(d, t);
  el.querySelector(".d-pos").textContent = fmtT(pos);
  el.querySelector(".d-left").textContent = "-" + fmtT(d.buf.duration - pos);
  const bpm = d.grid ? (d.playing ? effBpm(d, t) : d.grid.bpm * baseRate(d)) : null;
  el.querySelector(".d-bpm").textContent = fmtBpm(bpm);
  const pct = d.playing ? (rateAt(d, t) - 1) * 100 : d.pitch;
  el.querySelector(".d-pitch").textContent = d.grid ? `${fmtBpm(d.grid.bpm)} d'origine${Math.abs(pct) >= 0.05 ? ` · ${pct > 0 ? "+" : ""}${pct.toFixed(1).replace(".", ",")} %` : ""}` : "";
}

let djRaf = 0;
function frame() {
  djRaf = 0;
  if (view !== "dj") return;
  for (const d of Object.values(decks)) {
    drawOverview(d);
    drawZoom(d);
    updateTimes(d);
  }
  setStatus();
  djRaf = requestAnimationFrame(frame);
}

// ---------- Suggestions, paires, bibliothèque ----------

let pairs = [];
let browserTab = "all";

// Morceaux déjà passés dans la session (chemin → ordre de passage).
const played = new Map();
function markPlayed(t) {
  if (t && !played.has(t.path)) played.set(t.path, played.size + 1);
}

// Suggestions pour enchaîner après `ref`. Sans répétition (option), les morceaux
// déjà joués sont écartés, sinon deux morceaux très compatibles bouclent entre eux.
// `wide` : si rien de compatible, élargit au tempo proche puis à tout le reste.
function nextFor(ref, wide = false) {
  const onDecks = new Set(Object.values(decks).map((d) => d.track?.path).filter(Boolean));
  const skip = (p) => p === ref.path || onDecks.has(p) || (djOpts.noRepeat && played.has(p));
  const out = [];
  const seen = new Set();
  const add = (t, why) => {
    if (seen.has(t.path) || skip(t.path)) return;
    seen.add(t.path);
    out.push({ t, why });
  };
  for (const p of pairs.filter((p) => p.a === ref.path)) {
    const t = library.find((x) => x.path === p.b);
    if (t) add(t, "★ Paire favorite" + (p.note ? " · " + p.note : ""));
  }
  const pct = (g) => (g < 0.005 ? "même tempo" : "écart " + (g * 100).toFixed(1).replace(".", ",") + " %");
  const scored = library
    .filter((o) => o.bpm && !skip(o.path))
    .map((o) => ({ o, rel: keyRelation(ref.key, o.key), gap: bpmGap(ref.bpm, o.bpm) }))
    .filter((x) => x.gap != null);
  const intro = (o) => (grids.get(o.path)?.dj_intro ? " · intro DJ" : "");
  scored
    .filter((x) => x.rel && x.gap <= 0.06)
    .sort((a, b) => a.rel.rank * 4 + a.gap * 100 - (b.rel.rank * 4 + b.gap * 100))
    .forEach(({ o, rel, gap }) => add(o, `${rel.label} · ${pct(gap)}${intro(o)}`));
  if (wide && !out.length) {
    scored.sort((a, b) => a.gap - b.gap).forEach(({ o, gap }) => add(o, `Tempo proche · ${pct(gap)}${intro(o)}`));
  }
  return out;
}
const hiddenPlayed = (ref) =>
  djOpts.noRepeat ? [...played.keys()].filter((p) => p !== ref.path && !Object.values(decks).some((d) => d.track?.path === p)).length : 0;
const pairNote = (a, b) => pairs.find((p) => p.a === a && p.b === b)?.note || "";

function browserItems() {
  const q = $("#dj-search").value.trim().toLowerCase();
  const match = (t) =>
    !q || [t.title, t.artist, t.genre, notes.get(t.path), t.bpm && String(Math.round(t.bpm))].some((v) => v && String(v).toLowerCase().includes(q));
  if (browserTab === "pairs") {
    return pairs
      .map((p) => ({ a: library.find((t) => t.path === p.a), b: library.find((t) => t.path === p.b), p }))
      .filter((x) => x.a && x.b && (match(x.a) || match(x.b)));
  }
  if (browserTab === "next") {
    const ref = decks[masterDeck].track;
    if (!ref) return [];
    return nextFor(ref).filter((x) => match(x.t));
  }
  return library.filter(match).slice(0, 300).map((t) => ({ t, why: "" }));
}

function trackRow(t, why) {
  const li = document.createElement("li");
  li.className = "dj-item";
  li.dataset.path = t.path;
  li.innerHTML = `<div class="l-idx"><svg><use href="#i-note"/></svg><img alt=""/></div>
    <div class="s-meta"><div class="s-title"></div><div class="s-why muted small"></div></div>
    <div class="s-right"></div>
    <button class="ghost small" data-load="A" title="Charger sur la platine A">A</button>
    <button class="ghost small" data-load="B" title="Charger sur la platine B">B</button>`;
  li.querySelector(".s-title").textContent = `${t.title}${t.artist ? " · " + t.artist : ""}`;
  const n = notes.get(t.path);
  li.querySelector(".s-why").textContent = [why, n && "✎ " + n].filter(Boolean).join(" · ");
  const right = li.querySelector(".s-right");
  if (t.key) right.append(keyPill(t.key));
  right.append(` ${t.bpm ? Math.round(t.bpm) : "–"} BPM`);
  if (grids.get(t.path)?.dj_intro) right.prepend(badge("Intro", "ok"), " ");
  if (played.has(t.path)) {
    li.classList.add("played");
    right.prepend(badge("Déjà joué"), " ");
  }
  if (t.has_cover) coverFor(t.path).then((u) => setImg(li.querySelector("img"), u));
  li.onclick = (e) => {
    const b = e.target.closest("[data-load]");
    if (b) loadDeck(b.dataset.load, t);
  };
  li.ondblclick = (e) => !e.target.closest("button") && loadDeck(other(masterDeck), t);
  li.oncontextmenu = (e) => trackMenu(e, t, [t], 0);
  dragSource(li, () => [t.path]);
  return li;
}

function renderBrowser() {
  if (view !== "dj") return;
  for (const b of $("#dj-tabs").children) b.classList.toggle("on", b.dataset.v === browserTab);
  const ul = $("#dj-list");
  ul.replaceChildren();
  const items = browserItems();
  const ref = decks[masterDeck].track;
  const hidden = browserTab === "next" && ref ? hiddenPlayed(ref) : 0;
  const footer = () => {
    if (!hidden) return;
    const li = document.createElement("li");
    li.className = "empty-s muted small played-note";
    li.append(`${hidden} morceau${hidden > 1 ? "x" : ""} déjà joué${hidden > 1 ? "s" : ""} masqué${hidden > 1 ? "s" : ""}. `);
    const b = document.createElement("button");
    b.className = "link";
    b.textContent = "Remettre à zéro";
    b.onclick = () => {
      played.clear();
      for (const d of Object.values(decks)) if (d.playing) markPlayed(d.track);
      renderBrowser();
    };
    li.append(b);
    ul.appendChild(li);
  };
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty-s muted";
    li.textContent =
      browserTab === "pairs"
        ? "Aucune paire pour l'instant. Après une transition qui marche, clique « Garder cette paire »."
        : browserTab === "next"
          ? decks[masterDeck].track
            ? "Aucun morceau compatible (clé voisine, BPM à ±6 %)."
            : "Charge un morceau sur une platine pour voir quoi enchaîner."
          : "Aucun morceau.";
    ul.appendChild(li);
    return footer();
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (it.p) {
      const li = document.createElement("li");
      li.className = "dj-pair";
      li.innerHTML = `<div class="s-meta"><div class="s-title"></div><div class="s-why muted small"></div></div>
        <button class="ghost small" data-act="load" title="Charge A puis B">Charger</button>
        <button class="icon sm" data-act="note" title="Modifier la note"><svg><use href="#i-pen"/></svg></button>
        <button class="icon sm" data-act="del" title="Retirer la paire"><svg><use href="#i-x"/></svg></button>`;
      li.querySelector(".s-title").textContent = `${it.a.title} → ${it.b.title}`;
      li.querySelector(".s-why").textContent = [
        `${it.a.bpm ? Math.round(it.a.bpm) : "–"} → ${it.b.bpm ? Math.round(it.b.bpm) : "–"} BPM`,
        it.a.key && it.b.key ? `${it.a.key} → ${it.b.key}` : null,
        it.p.note,
      ].filter(Boolean).join(" · ");
      li.onclick = async (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "load") {
          masterDeck = "A";
          await loadDeck("A", it.a);
          await loadDeck("B", it.b);
          masterDeck = "A";
          renderAll();
        } else if (act === "note") {
          const n = await askText("Note de la paire", `${it.a.title} → ${it.b.title}`, it.p.note);
          if (n != null) pairs = await invoke("pair_add", { a: it.p.a, b: it.p.b, note: n });
          renderBrowser();
        } else if (act === "del") {
          pairs = await invoke("pair_remove", { a: it.p.a, b: it.p.b });
          renderBrowser();
        }
      };
      frag.appendChild(li);
    } else frag.appendChild(trackRow(it.t, it.why));
  }
  ul.appendChild(frag);
  footer();
}

$("#dj-tabs").onclick = (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v) return;
  browserTab = v;
  renderBrowser();
};
$("#dj-search").addEventListener("input", renderBrowser);

$("#mix-pair").onclick = async () => {
  let a = decks[masterDeck].track, b = decks[other(masterDeck)].track;
  // Juste après une transition : la paire, c'est celle qu'on vient d'entendre.
  if (decks[other(masterDeck)].spent && lastMix?.b === a?.path && lastMix?.a === b?.path) [a, b] = [b, a];
  if (!a || !b) return;
  const note = await askText("Garder cette paire", `${a.title} → ${b.title}`, pairNote(a.path, b.path), "Facultatif : ce qui marche (ex. « entrer au 2e couplet »)");
  if (note == null) return;
  pairs = await invoke("pair_add", { a: a.path, b: b.path, note });
  toast("Paire gardée");
  renderBrowser();
};

// Analyse des intros de toute la bibliothèque, un morceau à la fois.
let analyzing = false;
$("#dj-analyze").onclick = async () => {
  if (analyzing) return (analyzing = false);
  if (!libLoaded) await loadLibrary(true);
  const todo = library.filter((t) => !grids.has(t.path));
  if (!todo.length) return toast("Toute la bibliothèque est déjà analysée");
  analyzing = true;
  const b = $("#dj-analyze");
  let n = 0;
  for (const t of todo) {
    if (!analyzing) break;
    b.textContent = `Analyse ${++n}/${todo.length}… (clic pour arrêter)`;
    try {
      grids.set(t.path, await invoke("beat_grid", { path: t.path, bpm: t.bpm || null }));
    } catch {}
  }
  analyzing = false;
  b.textContent = "Analyser les intros";
  const intros = todo.filter((t) => grids.get(t.path)?.dj_intro).length;
  toast(`${n} morceaux analysés, ${intros} avec une intro DJ`);
  renderBrowser();
  if (typeof renderLibrary === "function" && libLoaded) renderLibrary();
};

// ---------- Mixeur : boutons et options ----------

$("#mix-go").onclick = () => (mix && !mix.auto ? cancelMix(true) : startMix(true));
$("#mix-preview").onclick = preview;
$("#xfader").oninput = () => {
  if (mix && !mix.armed) cancelMix(true);
  applyX();
};

function renderOpts() {
  for (const b of document.querySelectorAll("#mix-opts .switch")) b.setAttribute("aria-checked", djOpts[b.dataset.opt] ? "true" : "false");
  for (const c of document.querySelectorAll("#style-chips button")) c.classList.toggle("on", djOpts.styles.includes(c.dataset.style));
  for (const seg of document.querySelectorAll("#mix-opts .segmented"))
    for (const b of seg.children) b.classList.toggle("on", b.dataset.v === String(djOpts[seg.dataset.opt]));
  // La rampe n'a de sens qu'avec les battements alignés.
  document.querySelector('[data-opt="ramp"]').closest(".opt").classList.toggle("off", !djOpts.sync);
}
// Pastilles des styles : plusieurs cochés si « Varier », sinon un seul.
const chips = $("#style-chips");
for (const [k, st] of Object.entries(STYLES)) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.style = k;
  b.textContent = st.label;
  b.title = st.hint;
  chips.appendChild(b);
}
chips.onclick = (e) => {
  const k = e.target.closest("button")?.dataset.style;
  if (!k) return;
  if (!djOpts.vary) djOpts.styles = [k];
  else if (djOpts.styles.includes(k)) {
    if (djOpts.styles.length > 1) djOpts.styles = djOpts.styles.filter((x) => x !== k);
  } else djOpts.styles = [...djOpts.styles, k];
  plannedStyle = djOpts.vary ? null : k;
  saveOpts();
  renderOpts();
  renderMixer();
};
$("#style-all").onclick = () => {
  djOpts.styles = Object.keys(STYLES);
  djOpts.vary = true;
  plannedStyle = null;
  saveOpts();
  renderOpts();
  renderMixer();
};

$("#mix-opts").onclick = (e) => {
  if (e.target.closest("#style-chips, #style-all")) return;
  const sw = e.target.closest(".switch");
  const seg = e.target.closest(".segmented button");
  if (sw) djOpts[sw.dataset.opt] = !djOpts[sw.dataset.opt];
  else if (seg) djOpts[seg.parentElement.dataset.opt] = seg.dataset.v;
  else return;
  saveOpts();
  if (sw?.dataset.opt === "keylock") for (const d of Object.values(decks)) setKeylock(d, djOpts.keylock);
  if (sw?.dataset.opt === "autoPoint" && !djOpts.autoPoint && mix?.auto) mix = null;
  if (sw?.dataset.opt === "vary") {
    if (!djOpts.vary) djOpts.styles = [nextStyle()];
    plannedStyle = null;
    saveOpts();
  }
  renderOpts();
  renderMixer();
};

// Raccourcis : Q / P lecture des platines, Espace = mixer.
document.addEventListener("keydown", (e) => {
  if (view !== "dj" || e.target.closest("input, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "q") decks.A.playing ? pause(decks.A) : play(decks.A);
  else if (k === "p") decks.B.playing ? pause(decks.B) : play(decks.B);
  else if (e.key === " ") {
    e.preventDefault();
    $("#mix-go").click();
  } else return;
});

function djShow() {
  if (!libLoaded) loadLibrary().then(renderBrowser);
  invoke("pairs_get").then((p) => ((pairs = p || []), renderBrowser()));
  for (const id of ["A", "B"]) if (!deckEl(id).firstElementChild) renderDeck(decks[id]);
  renderOpts();
  renderBrowser();
  if (!djRaf) djRaf = requestAnimationFrame(frame);
}

// ---------- Notes (206) ----------

async function saveNote(path, text) {
  text = (text || "").trim();
  if (text) notes.set(path, text);
  else notes.delete(path);
  await invoke("note_set", { path, text });
}

async function editNote(t) {
  const n = await askText("Note", `${t.title}${t.artist ? " · " + t.artist : ""}`, notes.get(t.path) || "", "Ex. : drop à 1:32, parfait pour ouvrir");
  if (n == null) return;
  await saveNote(t.path, n);
  if (libLoaded) renderLibrary();
  renderAll();
}

// Petite fenêtre de saisie (renvoie null si annulé).
function askText(title, sub, value = "", placeholder = "") {
  return new Promise((resolve) => {
    const m = $("#ask");
    $("#ask-title").textContent = title;
    $("#ask-sub").textContent = sub || "";
    const ta = $("#ask-text");
    ta.value = value;
    ta.placeholder = placeholder;
    m.classList.remove("hidden");
    setTimeout(() => ta.focus(), 30);
    const done = (v) => {
      m.classList.add("hidden");
      $("#ask-ok").onclick = $("#ask-cancel").onclick = $("#ask-close").onclick = ta.onkeydown = null;
      resolve(v);
    };
    $("#ask-ok").onclick = () => done(ta.value);
    $("#ask-cancel").onclick = $("#ask-close").onclick = () => done(null);
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || !e.shiftKey)) {
        e.preventDefault();
        done(ta.value);
      } else if (e.key === "Escape") done(null);
    };
  });
}

// ---------- Glisser vers Rekordbox, l'Explorateur… (81) ----------

let dragging = null;
let dragIcon = null;
function dragImage() {
  if (dragIcon) return dragIcon;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, "#7c5cff");
  grad.addColorStop(1, "#ff4d8d");
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(4, 4, 56, 56, 12);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 30px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("♪", 32, 34);
  return (dragIcon = c.toDataURL("image/png"));
}

async function nativeDrag(paths) {
  dragging = paths;
  try {
    if (!T.core.Channel) throw new Error("glisser indisponible");
    const ch = new T.core.Channel();
    ch.onmessage = () => setTimeout(() => (dragging = null), 300);
    await invoke("plugin:drag|start_drag", { item: paths, image: dragImage(), options: { mode: "copy" }, onEvent: ch });
  } catch (e) {
    dragging = null;
    console.warn(e);
  }
}

// Un appui puis un déplacement de quelques pixels démarre le glisser natif.
function dragSource(el, paths) {
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("button, input, .check")) return;
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      stop();
      nativeDrag(paths());
    };
    const stop = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  });
}

// Bibliothèque : glisser un morceau (ou toute la sélection).
function libDragPaths(path) {
  return sel.library.has(path) && sel.library.size > 1 ? [...sel.library] : [path];
}
for (const id of ["#lib-rows", "#lib-grid"]) {
  $(id).addEventListener("mousedown", (e) => {
    const item = e.target.closest("[data-path].lib-row, .tile");
    if (!item || e.button !== 0 || e.target.closest("button, input, .check, .cover-play")) return;
    const path = item.dataset.path;
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      stop();
      nativeDrag(libDragPaths(path));
    };
    const stop = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
  });
}

// Le fichier qu'on fait glisser revient sur notre fenêtre : pas d'import,
// mais on peut le déposer sur une platine.
for (const ev of ["dragenter", "dragover", "dragleave", "drop"])
  window.addEventListener(
    ev,
    (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const deck = e.target.closest?.(".deck");
      for (const el of document.querySelectorAll(".deck.drop")) if (el !== deck || ev !== "dragover") el.classList.remove("drop");
      if (ev === "dragover" && deck) deck.classList.add("drop");
      if (ev === "drop" && deck) {
        const t = library.find((x) => x.path === dragging[0]);
        if (t) loadDeck(deck.dataset.deck, t);
      }
    },
    true
  );

// ---------- Export CSV (85) ----------

async function exportCsv(list) {
  if (!list.length) return toast("Rien à exporter", true);
  const path = await T.dialog.save({
    title: "Exporter la bibliothèque",
    defaultPath: "TrackFetcher.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return;
  const rows = [["Titre", "Artiste", "Album", "Genre", "BPM", "Clé", "Intro DJ", "Note", "Source", "Fichier"]];
  for (const t of list) {
    const g = grids.get(t.path);
    rows.push([
      t.title || "",
      t.artist || "",
      t.album || "",
      t.genre || "",
      t.bpm ? String(Math.round(t.bpm * 10) / 10).replace(".", ",") : "",
      t.key || "",
      g ? (g.dj_intro ? `${g.intro_beats / 4} mesures` : "non") : "",
      notes.get(t.path) || "",
      t.source || "",
      t.path,
    ]);
  }
  try {
    const n = await invoke("export_csv", { path: /\.csv$/i.test(path) ? path : path + ".csv", rows });
    toastAction(`${n} morceaux exportés`, "Afficher", () => T.opener.revealItemInDir(/\.csv$/i.test(path) ? path : path + ".csv"));
  } catch (e) {
    toast(String(e), true);
  }
}
$("#lib-csv").onclick = () => exportCsv(sel.library.size ? selectedTracks() : filteredLibrary());

// ---------- Intro DJ dans la bibliothèque (242) ----------

$("#lib-intro").onclick = async () => {
  introOnly = !introOnly;
  $("#lib-intro").classList.toggle("on", introOnly);
  renderLibrary();
  if (introOnly && library.some((t) => !grids.has(t.path))) {
    toast("Analyse des intros en cours, la liste se complète au fur et à mesure");
    if (!analyzing) $("#dj-analyze").click();
  }
};

// ---------- Démarrage ----------

(async () => {
  try {
    const n = await invoke("notes_get");
    for (const [k, v] of Object.entries(n || {})) notes.set(k, v);
  } catch {}
  for (const id of ["A", "B"]) renderDeck(decks[id]);
  renderOpts();
  await listen("settings-changed", (e) => {
    settings = e.payload;
    fillSettings();
  });
})();

// Le lecteur principal et les platines ne jouent pas en même temps.
audio.addEventListener("play", () => {
  for (const d of Object.values(decks)) if (d.playing) pause(d);
});

Object.assign(window, { djShow, loadDeck, editNote, exportCsv });
// Pour les tests.
window.__dj = { level: () => { const a = new Float32Array(2048); fx.meter.getFloatTimeDomainData(a); return Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length); }, decks, posAt, rateAt, beatIndex, effBpm, seek, play, getMix: () => mix, ctx: () => dctx };
})();
