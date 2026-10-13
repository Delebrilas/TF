"use strict";
// GPS de set (299) : un itinéraire de morceau en morceau, du départ à une
// destination (morceau ou ambiance), en douceur sur le BPM, la clé et l'énergie.
// Étapes épinglées (306), durée à remplir avec les horaires (307), recalcul
// en direct (309), destination floue (310), courbe de BPM dessinée (311),
// maillons manquants (316), bande-annonce (317) et pilote automatique (319).

// ---------- Calcul de l'itinéraire (sans DOM, testable) ----------

const GPS = (() => {
  const KEY_RE = /^(\d{1,2})([AB])$/;

  // Coût de passage d'une clé à l'autre (roue Camelot).
  function keyCost(a, b) {
    const ma = KEY_RE.exec(a || ""), mb = KEY_RE.exec(b || "");
    if (!ma || !mb) return 0.6;
    const d = Math.abs(Number(ma[1]) - Number(mb[1]));
    const dist = Math.min(d, 12 - d);
    if (ma[2] === mb[2]) return [0, 0.35, 0.9][dist] ?? 2.5; // +2 : montée d'énergie
    return dist === 0 ? 0.35 : 2.5;
  }

  // Écart de tempo relatif, en acceptant le demi ou le double tempo.
  // (en rapport de tempo : 67 n'est pas « plus près » de 100 que 134).
  const LN2 = Math.log(2);
  function gapOf(a, b) {
    const r = Math.abs(Math.log(b / a));
    return Math.expm1(Math.min(r, Math.abs(r - LN2)));
  }
  // BPM ramené au plus près d'une référence (demi / double tempo).
  function nearBpm(b, ref) {
    let best = b;
    for (const x of [b * 2, b / 2]) if (Math.abs(Math.log(x / ref)) < Math.abs(Math.log(best / ref))) best = x;
    return best;
  }
  // Nombre de pas sur la roue Camelot (changer de lettre compte pour un).
  function keySteps(a, b) {
    const ma = KEY_RE.exec(a || ""), mb = KEY_RE.exec(b || "");
    if (!ma || !mb) return 0;
    const d = Math.abs(Number(ma[1]) - Number(mb[1]));
    return Math.min(d, 12 - d) + (ma[2] === mb[2] ? 0 : 1);
  }

  // Coût d'une transition a → b. `weak` : transition difficile (maillon manquant).
  function edge(a, b, o) {
    const gap = gapOf(a.bpm, b.bpm);
    let c = (gap / 0.03) ** 2;
    let weak = gap > 0.06;
    if (o.useKey) {
      const k = keyCost(a.key, b.key);
      c += k;
      if (k >= 2.5) weak = true;
    }
    if (o.useEnergy && a.energy && b.energy) {
      const de = Math.abs(a.energy - b.energy);
      c += 0.4 * (de / 2) ** 2;
      if (de >= 4) weak = true;
    }
    if (o.pairs && o.pairs.has(a.path + "\n" + b.path)) c -= 0.8;
    if (weak) c += 6;
    return { c, weak, gap };
  }

  // Écart à la courbe guide (BPM, énergie) au moment `f` (0 → 1) du set.
  function guideCost(n, f, o) {
    if (!o.guide) return 0;
    const g = o.guide(Math.max(0, Math.min(1, f)));
    let c = 0;
    if (g.bpm) c += 1.0 * ((nearBpm(n.bpm, g.bpm) - g.bpm) / (g.bpm * 0.04)) ** 2;
    if (o.useEnergy && g.energy && n.energy) c += 0.3 * ((n.energy - g.energy) / 2) ** 2;
    return c;
  }

  // Distance à une destination floue (BPM, clé, énergie : chacun facultatif).
  function fuzzyCost(n, z, o) {
    let c = 0;
    if (z.bpm) c += 3 * ((nearBpm(n.bpm, z.bpm) - z.bpm) / (z.bpm * 0.02)) ** 2;
    if (z.key) c += 2 * keyCost(n.key, z.key);
    if (z.energy && n.energy && o.useEnergy) c += 1.5 * (n.energy - z.energy) ** 2;
    else if (z.energy && !n.energy) c += 1;
    return c;
  }

  // Un tronçon : de `from` à `to` ({node} ou {fuzzy} ou rien), en évitant `used`.
  // `budget` : secondes à remplir entre les deux (null = au plus court).
  function segment(from, to, nodes, used, budget, ctx, o) {
    const W = 24, K = 6, STEP = budget ? 0 : 0.8;
    const end = to && to.node;
    // Attraction vers le bout du tronçon : BPM (et énergie) en ligne droite.
    const toB = end ? end.bpm : to?.fuzzy?.bpm, toK = end ? end.key : to?.fuzzy?.key, toE = end ? end.energy : to?.fuzzy?.energy;
    const tB = toB ? nearBpm(toB, from.bpm) : null;
    const est = Math.max(1, tB ? Math.ceil(Math.abs(Math.log(tB / from.bpm)) / Math.log(1.03)) : 3, toK ? keySteps(from.key, toK) : 0);
    const maxSteps = budget ? 80 : est * 2 + 6;
    const pullW = o.guide ? 0.3 : 0.8;
    const pull = (n, time, steps) => {
      const f = Math.min(1, budget ? time / budget : steps / est);
      let c = 0;
      if (tB) {
        const g = from.bpm + (tB - from.bpm) * f;
        c += pullW * ((nearBpm(n.bpm, g) - g) / (g * 0.04)) ** 2;
      }
      // Clé : il faut encore pouvoir rejoindre celle du bout, un cran par morceau.
      if (o.useKey && toK) {
        const left = budget ? Math.max(0, (budget - time) / 240) : est - steps;
        c += 0.6 * Math.max(0, keySteps(n.key, toK) - Math.max(0, left));
      }
      if (o.useEnergy && toE && from.energy && n.energy) c += 0.3 * ((n.energy - (from.energy + (toE - from.energy) * f)) / 2) ** 2;
      return c;
    };
    const timePen = (time) => (budget ? 3 * ((time - budget) / Math.max(budget * 0.08, 120)) ** 2 : 0);
    const frac = (time, steps) => (ctx.total ? (ctx.t0 + time) / ctx.total : (ctx.index + steps) / ctx.stepsEst);
    const fz = to && to.fuzzy ? nodes.filter((n) => !used.has(n.path)).map((n) => ({ n, c: fuzzyCost(n, to.fuzzy, o) })).sort((x, y) => x.c - y.c).slice(0, 4).map((x) => x.n) : [];
    let beams = [{ path: [], last: from, cost: 0, time: 0 }];
    let best = null, bestStep = -1;
    for (let step = 0; step <= maxSteps && beams.length; step++) {
      for (const b of beams) {
        let cc = null, closing = null;
        if (end) {
          closing = edge(b.last, end, o);
          cc = b.cost + closing.c + timePen(b.time);
        } else if (to && to.fuzzy) {
          if (b.path.length) cc = b.cost + fuzzyCost(b.last, to.fuzzy, o) + timePen(b.time);
          // Ou finir sur l'un des morceaux qui collent le mieux à l'ambiance, même par une transition difficile.
          for (const z of fz) {
            if (z === b.last || b.path.some((x) => x.n === z)) continue;
            const e = edge(b.last, z, o);
            const c = b.cost + e.c + fuzzyCost(z, to.fuzzy, o) + timePen(b.time + z.dur);
            if (cc == null || c < cc) {
              cc = c;
              closing = { ...e, node: z };
            }
          }
        } else if (budget && b.time >= budget) cc = b.cost;
        if (cc != null && (!best || cc < best.cc)) {
          best = { ...b, cc, closing };
          bestStep = step;
        }
      }
      if (best && !budget && step - bestStep >= 4) break;
      if (budget && beams.every((b) => b.time >= budget * 1.15)) break;
      const next = [];
      for (const b of beams) {
        if (budget && b.time >= budget * 1.15) continue;
        const inPath = new Set(b.path.map((x) => x.n.path));
        const f = frac(b.time, b.path.length + 1);
        // Les K meilleurs suivants (sélection partielle, sans trier tout le graphe).
        const cand = [];
        for (const n of nodes) {
          if (used.has(n.path) || inPath.has(n.path) || n === end || n === b.last) continue;
          const e = edge(b.last, n, o);
          const sc = e.c + guideCost(n, f, o) + pull(n, b.time + n.dur / 2, b.path.length + 1) + STEP;
          if (cand.length === K && sc >= cand[K - 1].s) continue;
          let j = Math.min(cand.length, K - 1);
          while (j > 0 && cand[j - 1].s > sc) j--;
          cand.splice(j, 0, { n, e, s: sc });
          if (cand.length > K) cand.pop();
        }
        for (const c of cand)
          next.push({ path: [...b.path, { n: c.n, weak: c.e.weak, gap: c.e.gap }], last: c.n, cost: b.cost + c.s, time: b.time + c.n.dur });
      }
      // Un seul faisceau par dernier morceau (le moins cher) pour garder de la variété.
      next.sort((x, y) => x.cost - y.cost);
      const seen = new Set();
      beams = next.filter((b) => !seen.has(b.last.path) && seen.add(b.last.path)).slice(0, W);
    }
    if (!best) return { steps: [], closing: end ? edge(from, end, o) : null };
    const steps = best.path;
    if (best.closing?.node) steps.push({ n: best.closing.node, weak: best.closing.weak, gap: best.closing.gap });
    return { steps, closing: best.closing };
  }

  // Itinéraire complet. p : { start, dest: {node}|{fuzzy}|null, pins: [node], total: s|null, exclude: Set, o }
  function plan(nodes, p) {
    const o = p.o;
    const ends = [...p.pins.map((n) => ({ node: n })), ...(p.dest ? [p.dest] : [])];
    if (!ends.length && !p.total) return { error: "Choisis une destination, une étape ou une durée de set." };
    const used = new Set([p.start.path, ...p.pins.map((n) => n.path), ...(p.dest?.node ? [p.dest.node.path] : []), ...(p.exclude || [])]);
    const pool = nodes.filter((n) => !used.has(n.path));
    const fixed = p.start.dur + p.pins.reduce((s, n) => s + n.dur, 0) + (p.dest?.node ? p.dest.node.dur : 0);
    const segs = Math.max(1, ends.length + (p.dest || !p.total ? 0 : 1));
    // Temps à remplir, partagé selon l'écart de tempo de chaque tronçon.
    const legsBpm = [p.start, ...ends.map((e) => e.node || { bpm: e.fuzzy.bpm || p.start.bpm })];
    const dist = ends.map((_, i) => Math.abs(Math.log(nearBpm(legsBpm[i + 1].bpm, legsBpm[i].bpm) / legsBpm[i].bpm)) + 0.05);
    if (segs > ends.length) dist.push(0.05 * 3);
    const sumD = dist.reduce((a, b) => a + b, 0);
    const room = p.total ? Math.max(0, p.total - fixed) : 0;
    // Sans durée : nombre d'étapes estimé d'après l'écart de tempo à parcourir.
    const destBpm = p.dest?.node?.bpm || p.dest?.fuzzy?.bpm;
    const stepsEst = destBpm ? Math.ceil(Math.abs(Math.log(nearBpm(destBpm, p.start.bpm) / p.start.bpm)) / Math.log(1.03)) + 2 + p.pins.length : 8;
    const route = [{ n: p.start, weak: false, gap: 0 }];
    let from = p.start, t = p.start.dur;
    const legs = [...ends];
    if (p.total && !p.dest) legs.push(null); // durée seule : on remplit après la dernière étape
    legs.forEach((to, li) => {
      const share = p.total ? (room * dist[li]) / sumD : null;
      const ctx = { total: p.total, t0: t, index: route.length - 1, stepsEst };
      const s = segment(from, to, pool, used, share, ctx, o);
      for (const st of s.steps) {
        route.push(st);
        used.add(st.n.path);
        t += st.n.dur;
      }
      if (to && to.node) {
        route.push({ n: to.node, weak: s.closing.weak, gap: s.closing.gap, pinned: true });
        t += to.node.dur;
        from = to.node;
      } else from = route[route.length - 1].n;
    });
    let at = 0;
    for (const r of route) {
      r.t = at;
      at += r.n.dur;
    }
    return { route, total: at };
  }

  // Meilleur morceau pas encore téléchargé pour combler une transition difficile.
  function bridge(a, b, ext, o) {
    const out = [];
    // Au minimum, le tempo doit passer des deux côtés ; les ponts sans aucune transition difficile d'abord.
    for (const x of ext) {
      const e1 = edge(a, x, o), e2 = edge(x, b, o);
      if (e1.gap > 0.06 || e2.gap > 0.06) continue;
      out.push({ x, c: e1.c + e2.c - (e1.weak || e2.weak ? 0 : 100) });
    }
    return out.sort((p, q) => p.c - q.c).slice(0, 2).map((p) => p.x);
  }

  return { plan, edge, bridge, keyCost, gapOf, nearBpm };
})();

if (typeof module !== "undefined") module.exports = GPS;

// ---------- Interface ----------

if (typeof window !== "undefined" && window.djApi) (() => {
const dj = window.djApi;
const GPS_DEFAULTS = { useKey: true, useEnergy: true, useCurve: false, fill: false, minutes: 60, live: true, missing: true, autopilot: false, flExport: true };
const load = (k, d) => {
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(k) || "{}") };
  } catch {
    return { ...d };
  }
};
const store = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const gopt = load("tf-gps-opts", GPS_DEFAULTS);
const gs = load("tf-gps", { start: null, dest: { type: "none" }, pins: [], banned: [], curve: null });
gs.route = [];
gs.cur = -1;
gs.running = false;
gs.startedAt = 0;
let ext = [];
let extState = null; // progression de la recherche des likes
let trailer = null;
const save = () => {
  store("tf-gps-opts", gopt);
  store("tf-gps", { start: gs.start, dest: gs.dest, pins: gs.pins, banned: gs.banned, curve: gs.curve });
};

// Morceau → nœud du graphe (BPM, clé, énergie, temps joué).
function node(t) {
  if (!t || !t.bpm) return null;
  const g = grids.get(t.path);
  const span = g ? g.mix_out - g.mix_in : 0;
  const est = t.size ? (t.size * 8) / 320000 : 300;
  return { path: t.path, t, bpm: t.bpm, key: t.key, energy: g?.energy || t.energy || null, dur: span > 45 ? span : est * 0.75 };
}
const byPath = (p) => library.find((t) => t.path === p);
const energyOf = (t) => grids.get(t.path)?.energy || t.energy || null;

function guideFor(start, dest) {
  // Sans courbe dessinée, chaque tronçon file en ligne droite vers son bout (voir segment).
  const curve = gopt.useCurve && gs.curve?.length ? gs.curve : null;
  if (!curve) return null;
  return (f) => {
    const x = f * (curve.length - 1), i = Math.floor(x), k = x - i;
    return { bpm: curve[i] * (1 - k) + (curve[Math.min(i + 1, curve.length - 1)] ?? curve[i]) * k };
  };
}

function startTrack() {
  const p = gs.start || dj.decks[dj.getMaster()].track?.path || Object.values(dj.decks).find((d) => d.track)?.track.path;
  return p ? byPath(p) : null;
}

// Calcule (ou recalcule depuis `from`) l'itinéraire.
function compute(from, opts = {}) {
  const st = from || startTrack();
  if (!st) return toast("Choisis un morceau de départ (ou charge-en un sur une platine)", true);
  const start = node(st);
  if (!start) return toast("Le morceau de départ n'a pas de BPM", true);
  const nodes = library.map(node).filter(Boolean);
  let dest = null;
  if (gs.dest.type === "track" && gs.dest.path && gs.dest.path !== start.path) {
    const n = node(byPath(gs.dest.path));
    if (n) dest = { node: n };
  } else if (gs.dest.type === "fuzzy") {
    const z = { bpm: Number(gs.dest.bpm) || null, key: gs.dest.key || null, energy: Number(gs.dest.energy) || null };
    if (z.bpm || z.key || z.energy) dest = { fuzzy: z };
  }
  const passed = opts.passed || new Set();
  const pins = gs.pins.filter((p) => p !== start.path && !passed.has(p) && p !== gs.dest.path).map((p) => node(byPath(p))).filter(Boolean);
  const exclude = new Set(gs.banned);
  if (dj.opts().noRepeat) for (const p of dj.played.keys()) if (p !== start.path) exclude.add(p);
  for (const p of passed) exclude.add(p);
  let total = gopt.fill ? gopt.minutes * 60 : null;
  if (total && opts.elapsed) total = Math.max(120, total - opts.elapsed);
  const pairs = new Set(dj.pairs().map((p) => p.a + "\n" + p.b));
  const o = { useKey: gopt.useKey, useEnergy: gopt.useEnergy, pairs };
  o.guide = guideFor(start, dest);
  const r = GPS.plan(nodes, { start, dest, pins, total, exclude, o });
  if (r.error) return toast(r.error, true);
  gs.route = r.route.map((x) => ({ path: x.n.path, t: x.t + (opts.offset || 0), dur: x.n.dur, weak: x.weak, gap: x.gap, node: x.n }));
  gs.cur = opts.keepRunning ? 0 : -1;
  gs.o = o;
  render();
}

// ---------- Suivi pendant le set (309, 319) ----------

window.gpsHooks = {
  render,
  onPlay(t) {
    if (!gs.route.length || trailer || !t) return;
    const i = gs.route.findIndex((r) => r.path === t.path);
    if (i >= 0) {
      if (!gs.running) {
        gs.running = true;
        gs.startedAt = Date.now() - gs.route[i].t * 1000;
      }
      gs.cur = i;
      return render();
    }
    if (!gs.running || !gopt.live) return;
    // Hors itinéraire : on repart de ce morceau, avec le temps qu'il reste.
    const elapsed = (Date.now() - gs.startedAt) / 1000;
    const passed = new Set(gs.route.slice(0, gs.cur + 1).map((r) => r.path));
    compute(t, { elapsed, passed, offset: elapsed, keepRunning: true });
    toast(`Hors itinéraire : recalculé depuis « ${t.title} »`);
    // La platine libre attendait l'ancien morceau suivant : on la remplace.
    const free = Object.values(dj.decks).find((d) => d.track?.path !== t.path && !d.playing);
    const next = gs.route[1] && byPath(gs.route[1].path);
    if (free && next && free.track?.path !== next.path && !dj.getMix()) dj.loadDeck(free.id, next);
  },
  afterMix(a, b) {
    if (trailer) return true;
    if (!gs.running) return false;
    const i = gs.route.findIndex((r) => r.path === b.track.path);
    const next = i >= 0 && gs.route[i + 1] && byPath(gs.route[i + 1].path);
    if (!next) {
      if (i === gs.route.length - 1) toast("Destination atteinte 🎉");
      return i >= 0;
    }
    dj.loadDeck(a.id, next);
    return true;
  },
  forceAuto: () => !!(trailer || (gopt.autopilot && gs.running)),
};

async function launch() {
  if (!gs.route.length) compute();
  if (gs.route.length < 2) return;
  const [r0, r1] = gs.route;
  const deckWith = (p) => Object.values(dj.decks).find((d) => d.track?.path === p);
  let a = deckWith(r0.path);
  if (!a) {
    a = dj.decks.A;
    await dj.loadDeck("A", byPath(r0.path));
  }
  const b = dj.decks[dj.other(a.id)];
  if (b.track?.path !== r1.path) await dj.loadDeck(b.id, byPath(r1.path));
  dj.setMaster(a.id);
  gs.running = true;
  gs.cur = 0;
  gs.startedAt = Date.now();
  if (!a.playing) await dj.play(a);
  render();
}

// ---------- Bande-annonce (317) : chaque transition en ~20 s ----------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function playTrailer() {
  if (trailer) return stopTrailer();
  if (gs.route.length < 2) return toast("Calcule d'abord un itinéraire", true);
  if (Object.values(dj.decks).some((d) => d.playing) && !(await T.dialog.ask("La bande-annonce prend les deux platines. Continuer ?", { title: "Bande-annonce", okLabel: "Lancer", cancelLabel: "Annuler" })))
    return;
  trailer = { i: 0 };
  const me = trailer;
  for (const d of Object.values(dj.decks)) dj.pause(d);
  dj.setQuiet(true);
  dj.setOverride({ bars: 4 });
  render();
  try {
    let a = dj.decks.A;
    await dj.loadDeck("A", byPath(gs.route[0].path));
    for (let i = 0; i < gs.route.length - 1 && trailer === me; i++) {
      me.i = i;
      render();
      const b = dj.decks[dj.other(a.id)];
      await dj.loadDeck(b.id, byPath(gs.route[i + 1].path));
      if (trailer !== me || !a.grid || !b.grid) break;
      dj.setMaster(a.id);
      // ~8 s avant la sortie, puis transition sur 4 mesures.
      const lead = Math.min(4 * 4 * dj.beatLen(a), 9);
      if (a.playing) dj.seek(a, a.outPt - lead);
      else await dj.play(a, undefined, Math.max(0, a.outPt - lead));
      dj.arm(a.outPt);
      // Attend la fin de la transition (B devient maître), puis 2 s de B.
      const limit = Date.now() + 60000;
      while (trailer === me && (dj.getMix() || dj.getMaster() !== b.id) && Date.now() < limit) await wait(100);
      if (dj.getMaster() !== b.id) break;
      await wait(2000);
      a = b;
    }
    if (trailer === me) await wait(4000);
  } finally {
    if (trailer === me) stopTrailer();
  }
}
function stopTrailer() {
  trailer = null;
  dj.cancelMix();
  for (const d of Object.values(dj.decks)) dj.pause(d);
  dj.setOverride({});
  dj.setQuiet(false);
  dj.renderAll();
  render();
}

// ---------- Morceaux pas encore téléchargés (316) ----------

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[([].*?[)\]]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
function extNodes() {
  const have = new Set(library.map((t) => norm(t.title)));
  return ext
    .filter((x) => x.bpm && !have.has(norm(x.title)))
    .map((x) => ({ path: "ext:" + x.id, x, bpm: x.bpm, key: x.key, energy: null, dur: 240 }));
}
async function loadExt() {
  try {
    ext = (await invoke("ext_tracks")) || [];
  } catch {}
}
// Export FL Studio (348) : un FLAC par morceau, précédé du silence qui le cale.
let flBusy = "";
let flListening = false;
async function exportFl() {
  if (gs.route.length < 2 || flBusy) return;
  if (!flListening) {
    flListening = true;
    await listen("fl-export", (e) => {
      const [i, n] = e.payload;
      if (flBusy) (flBusy = `Export ${i + 1}/${n}…`), render();
    });
  }
  flBusy = "Analyse…";
  render();
  try {
    const bars = dj.opts().bars;
    const dir = await invoke("gps_export_fl", { paths: gs.route.map((r) => r.path), bars: bars === "auto" ? null : Number(bars) });
    toast("Export prêt : glisse tous les fichiers ensemble dans la Playlist de FL, mesure 1 (voir LISEZ-MOI)");
    Promise.resolve(T.opener.openPath(dir)).catch(() => {});
  } catch (e) {
    toast(String(e), true);
  } finally {
    flBusy = "";
    render();
  }
}

let extListening = false;
async function refreshExt() {
  if (!extListening) {
    extListening = true;
    await listen("ext-progress", async (e) => {
      extState = e.payload;
      if (e.payload.phase === "done") {
        await loadExt();
        if (e.payload.error) toast(e.payload.error, true);
      }
      render();
    });
  }
  // Avant l'appel : sans source, la fin arrive tout de suite.
  const before = extState;
  extState = { phase: "collect", done: 0, total: 0 };
  render();
  const started = await invoke("ext_refresh").catch((e) => (toast(String(e), true), null));
  if (started === null) extState = before;
  render();
}

// ---------- Rendu ----------

const fmtMin = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const clock = (ms) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const CAMELOT = [...Array(12)].flatMap((_, i) => [`${i + 1}A`, `${i + 1}B`]);

const OPTS = [
  ["useKey", "Clé", "Passe par des clés voisines sur la roue Camelot."],
  ["useEnergy", "Énergie", "Évite les sauts d'énergie (note 1 à 10 de chaque morceau)."],
  ["useCurve", "Courbe dessinée", "Suit la courbe de BPM tracée ci-dessous."],
  ["fill", "Durée du set", "Remplit la durée choisie, avec l'heure de chaque morceau."],
  ["live", "Recalcul en direct", "Si tu joues un morceau hors itinéraire, la route repart de lui."],
  ["missing", "Maillons manquants", "Propose des titres de tes likes pour les transitions difficiles."],
  ["autopilot", "Pilote auto", "Une fois lancé, enchaîne tout seul l'itinéraire avec les styles de transition."],
  ["flExport", "Export FL Studio", "Bouton qui prépare l'itinéraire pour la Playlist de FL, chaque morceau calé au point de transition."],
];

let built = false;
function build() {
  const el = $("#gps");
  el.innerHTML = `
    <div class="gps-grid">
      <div class="gps-field"><span class="gps-lbl">Départ</span><button type="button" class="ghost small gps-pick" id="gps-start"></button></div>
      <div class="gps-field"><span class="gps-lbl">Destination</span>
        <div class="segmented" id="gps-dest-type"><button data-v="track">Morceau</button><button data-v="fuzzy">Ambiance</button><button data-v="none">Aucune</button></div>
        <button type="button" class="ghost small gps-pick" id="gps-dest"></button>
        <span class="gps-fuzzy" id="gps-fuzzy">
          <label>BPM <input type="number" id="gps-f-bpm" min="60" max="200" step="1" placeholder="–"></label>
          <label>Clé <select id="gps-f-key"><option value="">–</option>${CAMELOT.map((k) => `<option>${k}</option>`).join("")}</select></label>
          <label>Énergie <input type="number" id="gps-f-energy" min="1" max="10" step="1" placeholder="–"></label>
        </span>
      </div>
      <div class="gps-field"><span class="gps-lbl">Étapes</span><div class="gps-pins" id="gps-pins"></div><button type="button" class="link" id="gps-add-pin">+ Ajouter une étape</button></div>
    </div>
    <div class="gps-opts" id="gps-opts">${OPTS.map(
      ([k, l, h]) => `<div class="opt"><button type="button" class="switch" role="switch" data-g="${k}"></button><span><b>${l}</b><small>${h}</small>${
        k === "fill" ? `<label class="gps-min"><input type="number" id="gps-minutes" min="10" max="600" step="5"> min</label>` : ""
      }</span></div>`
    ).join("")}</div>
    <div class="gps-curve" id="gps-curve">
      <canvas id="gps-canvas"></canvas>
      <div class="muted small">Dessine la courbe de BPM du set à la souris (de gauche à droite = du début à la fin). <button type="button" class="link" id="gps-curve-clear">Effacer</button></div>
    </div>
    <div class="gps-actions">
      <button type="button" class="primary" id="gps-go">Calculer l'itinéraire</button>
      <button type="button" class="ghost" id="gps-launch">Lancer le set</button>
      <button type="button" class="ghost" id="gps-trailer">Bande-annonce</button>
      <button type="button" class="ghost" id="gps-fl">Export FL Studio</button>
      <span class="muted small" id="gps-summary"></span>
    </div>
    <ul class="gps-route" id="gps-route"></ul>
    <div class="gps-ext muted small" id="gps-ext"></div>
    <div class="gps-picker hidden" id="gps-picker"><div class="gps-picker-box">
      <div class="gps-picker-head"><b id="gps-picker-title"></b><button type="button" class="icon sm" id="gps-picker-close"><svg><use href="#i-x"/></svg></button></div>
      <label class="search"><svg><use href="#i-search"/></svg><input type="text" id="gps-picker-q" placeholder="Titre, artiste, BPM…"></label>
      <ul class="dj-list" id="gps-picker-list"></ul>
    </div></div>`;

  $("#gps-start").onclick = async () => {
    const t = await pick("Morceau de départ", true);
    if (t === undefined) return;
    gs.start = t ? t.path : null;
    save();
    render();
  };
  $("#gps-dest").onclick = async () => {
    const t = await pick("Morceau de destination");
    if (!t) return;
    gs.dest = { ...gs.dest, type: "track", path: t.path };
    save();
    render();
  };
  $("#gps-dest-type").onclick = (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v) return;
    gs.dest = { ...gs.dest, type: v };
    save();
    render();
  };
  for (const id of ["bpm", "key", "energy"])
    $(`#gps-f-${id}`).onchange = (e) => {
      gs.dest = { ...gs.dest, [id]: e.target.value };
      save();
    };
  $("#gps-add-pin").onclick = async () => {
    const t = await pick("Étape (passage obligé)");
    if (!t || gs.pins.includes(t.path)) return;
    gs.pins.push(t.path);
    save();
    render();
  };
  $("#gps-opts").onclick = (e) => {
    const k = e.target.closest(".switch")?.dataset.g;
    if (!k) return;
    gopt[k] = !gopt[k];
    save();
    render();
  };
  $("#gps-minutes").onchange = (e) => {
    gopt.minutes = Math.max(10, Math.min(600, Number(e.target.value) || 60));
    save();
  };
  $("#gps-go").onclick = () => {
    gs.running = false;
    const b = $("#gps-go");
    b.disabled = true;
    b.textContent = "Calcul…";
    // Laisse le bouton se redessiner avant le calcul.
    setTimeout(() => {
      try {
        compute();
      } finally {
        b.disabled = false;
        b.textContent = "Calculer l'itinéraire";
      }
    }, 30);
  };
  $("#gps-launch").onclick = () => (gs.running ? ((gs.running = false), render()) : launch());
  $("#gps-trailer").onclick = playTrailer;
  $("#gps-fl").onclick = exportFl;
  $("#gps-curve-clear").onclick = () => {
    gs.curve = null;
    save();
    drawCurve();
  };
  initCanvas();
  built = true;
  loadExt().then(render);
}

// Sélecteur de morceau (renvoie le morceau, null = « platine », undefined = annulé).
function pick(title, allowDeck = false) {
  return new Promise((resolve) => {
    const box = $("#gps-picker");
    const q = $("#gps-picker-q");
    $("#gps-picker-title").textContent = title;
    box.classList.remove("hidden");
    q.value = "";
    const done = (v) => {
      box.classList.add("hidden");
      resolve(v);
    };
    $("#gps-picker-close").onclick = () => done(undefined);
    const list = () => {
      const s = q.value.trim().toLowerCase();
      const ul = $("#gps-picker-list");
      ul.replaceChildren();
      if (allowDeck) {
        const li = document.createElement("li");
        li.className = "empty-s gps-pick-deck";
        li.textContent = "Le morceau de la platine maîtresse";
        li.onclick = () => done(null);
        ul.append(li);
      }
      for (const t of library.filter((t) => t.bpm && (!s || [t.title, t.artist, String(Math.round(t.bpm))].some((v) => v && v.toLowerCase().includes(s)))).slice(0, 60)) {
        const li = document.createElement("li");
        li.className = "gps-pick-row";
        li.innerHTML = `<div class="s-meta"><div class="s-title"></div></div><div class="s-right muted small"></div>`;
        li.querySelector(".s-title").textContent = `${t.title}${t.artist ? " · " + t.artist : ""}`;
        const e = energyOf(t);
        li.querySelector(".s-right").textContent = [Math.round(t.bpm) + " BPM", t.key, e && "E" + e].filter(Boolean).join(" · ");
        li.onclick = () => done(t);
        ul.append(li);
      }
    };
    q.oninput = list;
    list();
    q.focus();
  });
}

function trackLabel(p) {
  const t = byPath(p);
  return t ? `${t.title}${t.artist ? " · " + t.artist : ""}` : "Morceau introuvable";
}

function render() {
  if (!$("#gps")) return;
  if (!built) build();
  if (!$(".dj-browser").classList.contains("gps-on")) return;
  const st = startTrack();
  $("#gps-start").textContent = gs.start ? trackLabel(gs.start) : st ? `Platine : ${st.title}` : "Choisir…";
  for (const b of $("#gps-dest-type").children) b.classList.toggle("on", b.dataset.v === gs.dest.type);
  $("#gps-dest").classList.toggle("hidden", gs.dest.type !== "track");
  $("#gps-dest").textContent = gs.dest.path ? trackLabel(gs.dest.path) : "Choisir…";
  $("#gps-fuzzy").classList.toggle("hidden", gs.dest.type !== "fuzzy");
  $("#gps-f-bpm").value = gs.dest.bpm || "";
  $("#gps-f-key").value = gs.dest.key || "";
  $("#gps-f-energy").value = gs.dest.energy || "";
  $("#gps-minutes").value = gopt.minutes;
  for (const s of document.querySelectorAll("#gps-opts .switch")) s.setAttribute("aria-checked", gopt[s.dataset.g] ? "true" : "false");
  $("#gps-curve").classList.toggle("off", !gopt.useCurve);

  const pins = $("#gps-pins");
  pins.replaceChildren();
  gs.pins.forEach((p, i) => {
    const c = document.createElement("span");
    c.className = "gps-pin";
    c.textContent = `${i + 1}. ${byPath(p)?.title || "?"}`;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "Retirer l'étape";
    x.onclick = () => {
      gs.pins.splice(i, 1);
      save();
      render();
    };
    c.append(x);
    pins.append(c);
  });
  if (!gs.pins.length) pins.innerHTML = `<span class="muted small">Aucune (épingle un morceau de l'itinéraire avec 📌)</span>`;

  $("#gps-launch").textContent = gs.running ? "Arrêter le guidage" : "Lancer le set";
  $("#gps-launch").disabled = !gs.route.length && !trailer;
  $("#gps-trailer").textContent = trailer ? `Arrêter (${trailer.i + 1}/${gs.route.length - 1})` : "Bande-annonce";
  $("#gps-trailer").disabled = gs.route.length < 2;
  $("#gps-fl").classList.toggle("hidden", !gopt.flExport);
  $("#gps-fl").disabled = gs.route.length < 2 || !!flBusy;
  $("#gps-fl").textContent = flBusy || "Export FL Studio";
  renderRoute();
  renderExt();
  drawCurve();
}

function renderRoute() {
  const ul = $("#gps-route");
  ul.replaceChildren();
  const r = gs.route;
  if (!r.length) {
    $("#gps-summary").textContent = "";
    ul.innerHTML = `<li class="empty-s muted">Choisis une destination (ou une durée), puis « Calculer l'itinéraire ».</li>`;
    return;
  }
  const last = r[r.length - 1];
  const total = last.t + last.dur;
  const weak = r.filter((x) => x.weak).length;
  const base = gs.running ? gs.startedAt : Date.now();
  $("#gps-summary").textContent = `${r.length} morceaux · ${fmtMin(total - (r[0].t || 0))}${gs.running ? " · fin vers " + clock(base + total * 1000) : ""}${weak ? ` · ${weak} transition${weak > 1 ? "s" : ""} difficile${weak > 1 ? "s" : ""}` : ""}`;
  const extN = gopt.missing ? extNodes() : [];
  r.forEach((x, i) => {
    const t = byPath(x.path);
    if (!t) return;
    if (i > 0 && x.weak) ul.append(missingRow(r[i - 1], x, extN));
    const li = document.createElement("li");
    li.className = "gps-step" + (i === gs.cur ? " now" : i < gs.cur ? " done" : "");
    const pinned = gs.pins.includes(x.path) || gs.dest.path === x.path;
    const e = energyOf(t);
    li.innerHTML = `<div class="gps-time"><b>${clock(base + x.t * 1000)}</b><small>+${fmtMin(x.t - r[0].t)}</small></div>
      <div class="s-meta"><div class="s-title"></div><div class="s-why muted small"></div></div>
      <div class="s-right"></div>
      <button type="button" class="icon sm ${pinned ? "on" : ""}" data-a="pin" title="${pinned ? "Retirer l'étape" : "Épingler : passage obligé"}">📌</button>
      <button type="button" class="icon sm" data-a="ban" title="Éviter ce morceau"><svg><use href="#i-x"/></svg></button>
      <button type="button" class="ghost small" data-a="load" title="Charger sur la platine libre">Charger</button>`;
    li.querySelector(".s-title").textContent = `${t.title}${t.artist ? " · " + t.artist : ""}`;
    li.querySelector(".s-why").textContent = `joué ${fmtMin(x.dur)}${i > 0 ? ` · tempo ${x.gap < 0.005 ? "identique" : "±" + (x.gap * 100).toFixed(1).replace(".", ",") + " %"}` : " · départ"}`;
    const right = li.querySelector(".s-right");
    if (t.key) right.append(keyPill(t.key), " ");
    if (e) {
      const b = document.createElement("span");
      b.className = "badge-s energy";
      b.textContent = "E" + e;
      b.title = `Énergie ${e}/10`;
      right.append(b, " ");
    }
    right.append(`${Math.round(t.bpm)} BPM`);
    li.onclick = (ev) => {
      const a = ev.target.closest("[data-a]")?.dataset.a;
      if (a === "pin") {
        if (gs.dest.path === x.path) return;
        const k = gs.pins.indexOf(x.path);
        if (k >= 0) gs.pins.splice(k, 1);
        else {
          gs.pins.push(x.path);
          // Garde l'ordre de passage de l'itinéraire.
          const order = (p) => {
            const j = r.findIndex((y) => y.path === p);
            return j < 0 ? 1e9 : j;
          };
          gs.pins.sort((p, q) => order(p) - order(q));
        }
        save();
        render();
      } else if (a === "ban") {
        gs.banned.push(x.path);
        gs.pins = gs.pins.filter((p) => p !== x.path);
        save();
        compute(byPath(r[0].path));
      } else if (a === "load") {
        const free = Object.values(dj.decks).find((d) => !d.playing) || dj.decks[dj.other(dj.getMaster())];
        dj.loadDeck(free.id, t);
      }
    };
    ul.append(li);
  });
  if (gs.banned.length) {
    const li = document.createElement("li");
    li.className = "empty-s muted small";
    li.append(`${gs.banned.length} morceau${gs.banned.length > 1 ? "x" : ""} évité${gs.banned.length > 1 ? "s" : ""}. `);
    const b = document.createElement("button");
    b.className = "link";
    b.textContent = "Tout réautoriser";
    b.onclick = () => {
      gs.banned = [];
      save();
      compute(byPath(r[0].path));
    };
    li.append(b);
    ul.append(li);
  }
}

function missingRow(a, b, extN) {
  const li = document.createElement("li");
  li.className = "gps-missing";
  const ta = byPath(a.path), tb = byPath(b.path);
  const why = [];
  if (b.gap > 0.06) why.push(`écart de tempo ${(b.gap * 100).toFixed(0)} %`);
  if (gopt.useKey && GPS.keyCost(ta?.key, tb?.key) >= 2.5) why.push(`clés éloignées (${ta?.key || "?"} → ${tb?.key || "?"})`);
  const ea = energyOf(ta || {}), eb = energyOf(tb || {});
  if (gopt.useEnergy && ea && eb && Math.abs(ea - eb) >= 4) why.push(`saut d'énergie ${ea} → ${eb}`);
  li.innerHTML = `<div class="gps-miss-head">⚠ Transition difficile : ${esc(why.join(", ") || "peu compatible")}</div>`;
  if (!gopt.missing) return li;
  const found = GPS.bridge(a.node, b.node, extN, gs.o || { useKey: gopt.useKey, useEnergy: gopt.useEnergy });
  if (!found.length) {
    const s = document.createElement("div");
    s.className = "muted small";
    s.textContent = ext.length ? "Rien dans tes likes pour faire le pont." : "Maillon manquant : cherche dans tes likes Spotify et SoundCloud ci-dessous.";
    li.append(s);
  }
  for (const n of found) {
    const row = document.createElement("div");
    row.className = "gps-miss-row";
    const x = n.x;
    row.innerHTML = `<span>Maillon manquant : <b></b> <span class="muted small"></span></span><button type="button" class="ghost small">Télécharger</button>`;
    row.querySelector("b").textContent = `${x.artist ? x.artist + " – " : ""}${x.title}`;
    row.querySelector(".muted").textContent = [Math.round(x.bpm) + " BPM", x.key, x.from].filter(Boolean).join(" · ");
    row.querySelector("button").onclick = async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await invoke("add_url", { url: x.url });
        toast(r.added ? "Ajouté à la file : recalcule l'itinéraire une fois téléchargé" : "Déjà téléchargé");
      } catch (e) {
        toast(String(e), true);
        ev.target.disabled = false;
      }
    };
    li.append(row);
  }
  return li;
}

function renderExt() {
  const el = $("#gps-ext");
  el.classList.toggle("hidden", !gopt.missing);
  const withBpm = ext.filter((x) => x.bpm).length;
  let txt;
  if (extState && extState.phase !== "done")
    txt = extState.phase === "collect" ? "Lecture de tes likes et playlists…" : `Recherche des BPM et clés : ${extState.done}/${extState.total}…`;
  else txt = ext.length ? `Tes likes : ${ext.length} titres, ${withBpm} avec un BPM connu.` : "Tes likes Spotify et SoundCloud ne sont pas encore lus.";
  el.replaceChildren(txt + " ");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "link";
  b.textContent = ext.length ? "Actualiser" : "Lire mes likes";
  b.title = "Spotify (connecté dans Réglages › Comptes) et le profil SoundCloud indiqué dans les réglages. BPM et clés via Deezer et GetSongBPM.";
  b.disabled = !!(extState && extState.phase !== "done");
  b.onclick = refreshExt;
  el.append(b);
}

// ---------- Courbe de BPM (311) ----------

const CURVE_N = 48;
function bpmRange() {
  const b = library.map((t) => t.bpm).filter((x) => x >= 60 && x <= 200).sort((x, y) => x - y);
  if (!b.length) return [90, 150];
  const lo = b[Math.floor(b.length * 0.03)], hi = b[Math.floor(b.length * 0.97)];
  return [Math.floor((lo - 4) / 5) * 5, Math.ceil((hi + 4) / 5) * 5];
}
function initCanvas() {
  const c = $("#gps-canvas");
  let drawing = false, lastI = null;
  const at = (e) => {
    const r = c.getBoundingClientRect();
    const [lo, hi] = bpmRange();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return { i: Math.round(x * (CURVE_N - 1)), bpm: Math.round((hi - (hi - lo) * y) * 10) / 10 };
  };
  const put = (e) => {
    const p = at(e);
    if (!gs.curve) {
      const st = node(startTrack() || {});
      gs.curve = Array(CURVE_N).fill(st?.bpm || p.bpm);
    }
    if (lastI != null && lastI !== p.i) {
      const from = gs.curve[lastI], n = Math.abs(p.i - lastI);
      for (let k = 1; k < n; k++) gs.curve[lastI + Math.sign(p.i - lastI) * k] = from + ((p.bpm - from) * k) / n;
    }
    gs.curve[p.i] = p.bpm;
    lastI = p.i;
    drawCurve();
  };
  c.onpointerdown = (e) => {
    drawing = true;
    lastI = null;
    c.setPointerCapture(e.pointerId);
    if (!gopt.useCurve) {
      gopt.useCurve = true;
      render();
    }
    put(e);
  };
  c.onpointermove = (e) => drawing && put(e);
  c.onpointerup = () => {
    drawing = false;
    save();
  };
}
function drawCurve() {
  const c = $("#gps-canvas");
  if (!c || !c.clientWidth) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = c.clientWidth * dpr;
  c.height = c.clientHeight * dpr;
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const w = c.clientWidth, h = c.clientHeight;
  const cs = getComputedStyle(document.documentElement);
  const col = (n) => cs.getPropertyValue(n).trim();
  const [lo, hi] = bpmRange();
  const y = (b) => h - ((b - lo) / (hi - lo)) * h;
  g.font = "10px system-ui";
  g.fillStyle = col("--muted");
  g.strokeStyle = col("--line");
  g.lineWidth = 1;
  for (let b = Math.ceil(lo / 10) * 10; b <= hi; b += 10) {
    g.beginPath();
    g.moveTo(28, y(b));
    g.lineTo(w, y(b));
    g.stroke();
    g.fillText(String(b), 2, y(b) + 3);
  }
  // Itinéraire calculé : BPM de chaque morceau à son heure de passage.
  const r = gs.route;
  if (r.length > 1) {
    const t0 = r[0].t, tot = r[r.length - 1].t + r[r.length - 1].dur - t0;
    g.strokeStyle = col("--accent-2");
    g.fillStyle = col("--accent-2");
    g.lineWidth = 2;
    g.beginPath();
    let ref = r[0].node?.bpm || 120;
    r.forEach((x, i) => {
      const b = GPS.nearBpm(x.node?.bpm || ref, ref);
      ref = b;
      const px = 28 + ((x.t - t0 + x.dur / 2) / tot) * (w - 28);
      i ? g.lineTo(px, y(b)) : g.moveTo(px, y(b));
    });
    g.stroke();
  }
  if (gs.curve) {
    g.strokeStyle = col("--accent");
    g.lineWidth = 2.5;
    g.setLineDash(gopt.useCurve ? [] : [4, 4]);
    g.beginPath();
    gs.curve.forEach((b, i) => {
      const px = 28 + (i / (CURVE_N - 1)) * (w - 28);
      i ? g.lineTo(px, y(b)) : g.moveTo(px, y(b));
    });
    g.stroke();
    g.setLineDash([]);
  } else {
    g.fillStyle = col("--muted");
    g.fillText("Clique-glisse ici pour dessiner la montée (ou la descente) du set", 40, h / 2);
  }
}
window.addEventListener("resize", () => built && drawCurve());
setInterval(() => gs.running && $(".dj-browser")?.classList.contains("gps-on") && renderRoute(), 30000);
})();
