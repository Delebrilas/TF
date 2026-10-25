"use strict";
// Confort et plaisir : fiche au survol (383), jauge de compatibilité en
// direct (388), effets visuels et surprises. Chaque option a son interrupteur
// (Réglages), gardé dans localStorage « tf-ui ».

(() => {
const UX_DEFAULTS = { fx: true, hoverCard: true, compat: true, eggs: true, cast: true };
let ux = { ...UX_DEFAULTS };
try { ux = { ...UX_DEFAULTS, ...JSON.parse(localStorage.getItem("tf-ui") || "{}") }; } catch {}
const saveUx = () => { try { localStorage.setItem("tf-ui", JSON.stringify(ux)); } catch {} };
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

function applyFx() {
  document.body.classList.toggle("fx", ux.fx && !reduced.matches);
}
for (const b of document.querySelectorAll("[data-ux]")) {
  const k = b.dataset.ux;
  const sync = () => b.setAttribute("aria-checked", String(!!ux[k]));
  sync();
  b.addEventListener("click", () => {
    ux[k] = !ux[k];
    saveUx();
    sync();
    applyFx();
    if (k === "compat") compat();
    window.castUi?.refresh();
    if (k === "hoverCard" && !ux.hoverCard) hideCard();
  });
}
reduced.addEventListener("change", applyFx);
applyFx();

const trackOf = (path) => library.find((t) => t.path === path);
const energyOf = (t) => grids.get(t.path)?.energy || t.energy || null;

// ---------- 388 : jauge de compatibilité avec le titre qui joue ----------

// Le titre de référence : le lecteur s'il joue, sinon la platine maîtresse du DJ.
function reference() {
  const p = current();
  if (p && !audio.paused) return trackOf(p.path) || p;
  const dj = window.djApi;
  const d = dj && dj.decks[dj.getMaster()];
  return d && d.playing && d.track ? trackOf(d.track.path) || d.track : null;
}
function score(ref, t) {
  if (!ref?.bpm || !t?.bpm) return null;
  const gap = GPS.gapOf(GPS.nearBpm(t.bpm, ref.bpm), ref.bpm);
  let s = Math.exp(-((gap / 0.045) ** 2));
  const kc = ref.key && t.key ? GPS.keyCost(ref.key, t.key) : null;
  s *= kc == null ? 0.8 : kc === 0 ? 1 : kc <= 0.35 ? 0.92 : kc <= 0.9 ? 0.7 : 0.35;
  const ea = energyOf(ref), eb = energyOf(t);
  if (ea && eb) s *= Math.max(0.45, 1 - Math.abs(ea - eb) * 0.09);
  return Math.round(s * 100);
}
let refPath = null;
function compat() {
  const ref = ux.compat ? reference() : null;
  refPath = ref?.path || null;
  for (const row of document.querySelectorAll("#lib-rows .lib-row")) {
    let bar = row.querySelector(".l-compat");
    const t = ref && row.dataset.path !== ref.path ? trackOf(row.dataset.path) : null;
    const s = t ? score(ref, t) : null;
    if (s == null) {
      bar?.remove();
      continue;
    }
    if (!bar) {
      bar = document.createElement("i");
      bar.className = "l-compat";
      row.append(bar);
    }
    bar.style.setProperty("--w", s);
    bar.style.setProperty("--h", Math.round(s * 1.25));
    bar.classList.toggle("top", s >= 85);
    bar.title = `Compatibilité avec « ${ref.title} » : ${s} %`;
  }
}
// La platine maîtresse peut changer sans passer par le lecteur.
setInterval(() => {
  if (!ux.compat || document.hidden) return;
  const r = reference();
  if ((r?.path || null) !== refPath) compat();
}, 1500);

// ---------- 383 : fiche au survol ----------

const card = document.createElement("div");
card.className = "hover-card hidden";
card.innerHTML = `<div class="hc-art"><svg><use href="#i-note"/></svg><img alt=""/></div>
  <div class="hc-body"><b class="hc-title"></b><span class="hc-artist"></span><div class="hc-tags"></div><div class="hc-note"></div></div>
  <button type="button" class="hc-play" title="Écouter un extrait"><svg><use href="#i-play"/></svg></button>`;
document.body.append(card);
let cardTimer = null, cardRow = null, cardTrack = null;

function hideCard() {
  clearTimeout(cardTimer);
  if (card.classList.contains("previewing")) stopPreview();
  card.classList.add("hidden");
  card.classList.remove("previewing");
  cardRow = cardTrack = null;
}
function showCard(row) {
  const t = trackOf(row.dataset.path);
  if (!t) return;
  cardRow = row;
  cardTrack = t;
  card.querySelector(".hc-title").textContent = t.title || "Sans titre";
  card.querySelector(".hc-artist").textContent = [t.artist, t.album].filter(Boolean).join(" · ");
  const img = card.querySelector("img");
  const src = row.querySelector(".l-idx img")?.src;
  img.toggleAttribute("hidden", !src);
  if (src) img.src = src;
  const tags = card.querySelector(".hc-tags");
  tags.replaceChildren();
  const tag = (txt, cls = "") => {
    const s = document.createElement("span");
    s.className = "hc-tag " + cls;
    s.textContent = txt;
    tags.append(s);
  };
  tag(t.bpm ? `${Math.round(t.bpm * 10) / 10} BPM` : "BPM ?");
  if (t.key) tags.append(keyPill(t.key));
  const e = energyOf(t);
  if (e) tag(`Énergie ${e}/10`, "en");
  const g = grids.get(t.path);
  if (g?.dj_intro) tag(`Intro ${g.intro_beats / 4} mesures`, "ok");
  if (g?.duration) tag(`${Math.floor(g.duration / 60)}:${String(Math.round(g.duration % 60)).padStart(2, "0")}`);
  const ref = ux.compat && reference();
  const s = ref && ref.path !== t.path ? score(ref, t) : null;
  if (s != null) tag(`${s} % avec ce qui joue`, s >= 85 ? "ok" : "");
  const note = notes.get(t.path);
  card.querySelector(".hc-note").textContent = note ? "📝 " + note : "";
  card.classList.remove("hidden", "previewing");
  const r = row.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  const title = row.querySelector(".l-main").getBoundingClientRect();
  let x = Math.min(title.left + 40, window.innerWidth - w - 12);
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 90) y = r.top - h - 6;
  card.style.left = Math.max(12, x) + "px";
  card.style.top = Math.max(12, y) + "px";
}
document.addEventListener("mouseover", (e) => {
  if (!ux.hoverCard) return;
  if (e.target.closest(".hover-card")) return clearTimeout(cardTimer);
  const row = e.target.closest("#lib-rows .lib-row");
  if (row === cardRow && row) return;
  clearTimeout(cardTimer);
  if (!row || e.target.closest(".l-idx, .check")) {
    if (cardRow) cardTimer = setTimeout(hideCard, 180);
    return;
  }
  cardTimer = setTimeout(() => showCard(row), cardRow ? 120 : 550);
});
document.addEventListener("scroll", () => cardRow && hideCard(), true);
document.addEventListener("mousedown", (e) => !e.target.closest(".hover-card") && cardRow && hideCard());
card.querySelector(".hc-play").onclick = () => {
  if (!cardTrack) return;
  if (card.classList.contains("previewing")) return stopPreview(), card.classList.remove("previewing");
  startPreview(card, cardTrack);
};

// ---------- Surprises ----------

function rain(chars, n = 36) {
  if (reduced.matches) return;
  const box = document.createElement("div");
  box.className = "rain";
  for (let i = 0; i < n; i++) {
    const s = document.createElement("span");
    s.textContent = chars[i % chars.length];
    s.style.left = Math.random() * 100 + "vw";
    s.style.animationDelay = Math.random() * 1.2 + "s";
    s.style.animationDuration = 2.2 + Math.random() * 1.6 + "s";
    s.style.fontSize = 16 + Math.random() * 22 + "px";
    box.append(s);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 5200);
}

// Konami : mode disco.
const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
let kIdx = 0;
document.addEventListener("keydown", (e) => {
  if (!ux.eggs) return;
  kIdx = e.key === KONAMI[kIdx] || e.key.toLowerCase() === KONAMI[kIdx] ? kIdx + 1 : e.key === KONAMI[0] ? 1 : 0;
  if (kIdx === KONAMI.length) {
    kIdx = 0;
    document.body.classList.add("disco");
    rain(["🪩", "✨", "🕺", "💃", "🎶"], 44);
    toast("🪩 Mode disco activé");
    setTimeout(() => document.body.classList.remove("disco"), 9000);
  }
});

// Sept clics sur le logo : le vinyle tourne et scratche.
let logoClicks = 0, logoTimer = null;
document.querySelector(".brand img")?.addEventListener("click", () => {
  if (!ux.eggs) return;
  clearTimeout(logoTimer);
  logoTimer = setTimeout(() => (logoClicks = 0), 1500);
  if (++logoClicks < 7) return;
  logoClicks = 0;
  const logo = document.querySelector(".brand img");
  logo.classList.remove("scratch");
  void logo.offsetWidth;
  logo.classList.add("scratch");
  scratch();
  toast("Wikka wikka 💿");
});
function scratch() {
  try {
    const ac = new AudioContext();
    const len = ac.sampleRate * 0.9;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-((i / len) * 3));
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 4;
    f.frequency.setValueAtTime(400, ac.currentTime);
    f.frequency.linearRampToValueAtTime(2600, ac.currentTime + 0.22);
    f.frequency.linearRampToValueAtTime(300, ac.currentTime + 0.45);
    f.frequency.linearRampToValueAtTime(2200, ac.currentTime + 0.7);
    const g = ac.createGain();
    g.gain.value = 0.25;
    src.connect(f).connect(g).connect(ac.destination);
    src.start();
    src.onended = () => ac.close();
  } catch {}
}

// Recherches secrètes dans la bibliothèque.
const SECRETS = [
  [/^daft punk$/i, ["🤖", "🎧", "✨"], "One more time 🤖"],
  [/^(128|bpm 128|128 bpm)$/i, ["🔊", "💥", "🎛️"], "128 BPM : le tempo de la house 🏠"],
  [/^(vinyle|vinyl)$/i, ["💿", "📀"], "Le son chaud du vinyle 💿"],
];
let lastSecret = "";
document.getElementById("lib-search")?.addEventListener("input", (e) => {
  if (!ux.eggs) return;
  const q = e.target.value.trim();
  const hit = SECRETS.find(([re]) => re.test(q));
  if (hit && lastSecret !== q) rain(hit[1], 30), toast(hit[2]);
  lastSecret = hit ? q : "";
});

// Il est minuit pile : un petit mot.
setInterval(() => {
  const d = new Date();
  if (ux.eggs && d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() < 30 && !document.body.dataset.midnight) {
    document.body.dataset.midnight = "1";
    rain(["🌙", "⭐", "✨"], 24);
    toast("Minuit : c'est l'heure du peak time 🌙");
    setTimeout(() => delete document.body.dataset.midnight, 60000);
  }
}, 30000);

window.ux = { afterLibrary: compat, compat, get: (k) => ux[k] };
compat();
})();
