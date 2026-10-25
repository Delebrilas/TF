"use strict";

const T = window.__TAURI__ || window.__TF_MOCK__;
const invoke = T.core.invoke;
const listen = T.event.listen;

const $ = (s) => document.querySelector(s);
const jobs = new Map();
let settings = null;
const notes = new Map(); // chemin → note perso (206)
const grids = new Map(); // chemin → grille / intro DJ (242)
let introOnly = false;

const STATUS = {
  queued: "En attente",
  searching: "Recherche sur YouTube…",
  downloading: "Téléchargement",
  converting: "Conversion en MP3…",
  analyzing: "Analyse du tempo…",
  verifying: "Vérification en ligne…",
  tagging: "Écriture des tags…",
  done: "Terminé",
  error: "Erreur",
};
const VERDICT = {
  confirmed: "✓ Confirmé",
  corrected: "↕ Corrigé",
  local_only: "Analyse seule",
  conflict: "⚠ À vérifier",
  manual: "✎ Manuel",
};
const HINT = {
  confirmed: "L'analyse et les sources en ligne concordent.",
  corrected: "Analyse ajustée (double ou moitié) d'après les sources en ligne.",
  local_only: "Aucune source en ligne trouvée : valeur de l'analyse.",
  conflict: "Les valeurs divergent. Clique pour corriger.",
  manual: "Valeur saisie à la main.",
};

function detect(url) {
  const u = url.toLowerCase();
  if (u.includes("spotify")) return "spotify";
  if (u.includes("youtu")) return "youtube";
  if (u.includes("soundcloud")) return "soundcloud";
  return "";
}
const isCollection = (u) => /\/collection\/tracks|\/playlist|\/album\/|spotify:album:|spotify:playlist:|\/sets\/|list=/i.test(u);

function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3500);
}

function toastAction(msg, label, fn) {
  const el = document.createElement("div");
  el.className = "toast";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.gap = "12px";
  const span = document.createElement("span");
  span.textContent = msg;
  const b = document.createElement("button");
  b.className = "link";
  b.style.color = "var(--accent)";
  b.style.fontWeight = "600";
  b.textContent = label;
  b.onclick = () => {
    el.remove();
    fn();
  };
  el.append(span, b);
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

const fmt = (b) => (Number.isInteger(b) ? String(b) : b.toFixed(1));
const fmtTime = (s) => {
  if (!isFinite(s)) return "0:00";
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/// Couleurs de la roue Camelot (1 = jaune-vert … 12 = jaune), A plus sombre.
function keyColor(k) {
  const m = /^(\d{1,2})([AB])$/.exec(k || "");
  if (!m) return "var(--muted)";
  const hue = (75 + (Number(m[1]) - 1) * 30) % 360;
  return `hsl(${hue}, 70%, ${m[2] === "A" ? 42 : 52}%)`;
}
function keyPill(k) {
  const span = document.createElement("span");
  span.className = "key-pill";
  span.textContent = k;
  span.style.background = keyColor(k);
  span.title = "Tonalité (notation Camelot)";
  return span;
}
const keySortValue = (k) => {
  const m = /^(\d{1,2})([AB])$/.exec(k || "");
  return m ? Number(m[1]) * 2 + (m[2] === "B" ? 1 : 0) : 99;
};

const srcIcon = (src) => ({ local: "#i-file", other: "#i-link" })[src] || "#i-" + src;

// ---------- Onglets ----------

let view = "queue";
function showView(v) {
  view = v;
  for (const b of $("#tabs").children) b.classList.toggle("on", b.dataset.view === v);
  for (const s of document.querySelectorAll(".view")) s.classList.toggle("hidden", s.id !== "view-" + v);
  if (v === "library") loadLibrary();
  if (v === "dj") djShow(), helpOnFirstDj();
  hideCtx();
  renderSelBar();
}
$("#tabs").onclick = (e) => {
  const b = e.target.closest("button");
  if (b) showView(b.dataset.view);
};

// ---------- Pochettes (tag ID3 → blob) ----------

const coverCache = new Map();
async function coverFor(path) {
  if (coverCache.has(path)) return coverCache.get(path);
  const p = invoke("cover_art", { path })
    .then((buf) => URL.createObjectURL(new Blob([buf])))
    .catch(() => null);
  coverCache.set(path, p);
  return p;
}
function setImg(img, url) {
  if (url) {
    img.onerror = () => img.removeAttribute("src");
    if (img.getAttribute("src") !== url) img.src = url;
  } else img.removeAttribute("src");
}

// ---------- File d'attente ----------

function render(job) {
  jobs.set(job.id, job);
  let el = document.getElementById("job-" + job.id);
  if (!el) {
    el = $("#tpl-job").content.firstElementChild.cloneNode(true);
    el.id = "job-" + job.id;
    el.querySelector(".act-remove").onclick = () => invoke("remove_job", { id: job.id });
    el.querySelector(".act-retry").onclick = () => invoke("retry_job", { id: job.id });
    el.querySelector(".act-priority").onclick = () => invoke("toggle_priority", { id: job.id });
    el.querySelector(".act-reveal").onclick = () => {
      const j = jobs.get(job.id);
      if (j.path) T.opener.revealItemInDir(j.path);
    };
    el.querySelector(".cover-play").onclick = () => playFromQueue(job.id);
    el.querySelector(".check").onclick = (e) => toggleSel("queue", job.id, e);
    el.querySelector(".act-source").onclick = () => {
      const u = jobSourceUrl(jobs.get(job.id));
      if (u) openSource(u);
    };
    el.querySelector(".bpm").onclick = () => editBpm(job.id);
    $("#queue").prepend(el);
  }
  el.dataset.status = job.status;
  el.classList.toggle("no-source", !jobSourceUrl(job));
  el.classList.toggle("selected", sel.queue.has(job.id));
  el.querySelector(".check").setAttribute("aria-checked", sel.queue.has(job.id));
  el.dataset.source = job.source;
  el.classList.toggle("priority", !!job.priority);
  el.querySelector(".act-priority").title = job.priority ? "Retirer la priorité" : "Passer en priorité";

  setImg(el.querySelector(".cover img"), job.cover);
  el.querySelector(".title").textContent = job.title || job.url || "Piste";
  el.querySelector(".src use").setAttribute("href", srcIcon(job.source));
  el.querySelector(".artist").textContent =
    [job.artist, job.album, job.genre].filter(Boolean).join(" · ") || (job.source === "local" ? "Fichier local" : "");

  let status = STATUS[job.status] || job.status;
  if (job.status === "downloading" && job.progress > 0) status += ` ${Math.round(job.progress * 100)} %`;
  if (job.status === "error") status = job.error || status;
  if (job.status === "queued" && settings?.paused) status = "En pause";
  if (job.status === "queued" && job.note) status = job.note;
  const st = el.querySelector(".status");
  st.textContent = status;
  st.title = status;
  st.classList.toggle("note", job.status === "queued" && !!job.note);

  const bar = el.querySelector(".state .bar");
  const determinate = job.status === "downloading" && job.progress > 0;
  bar.classList.toggle("indeterminate", !determinate && !["queued", "done", "error"].includes(job.status));
  bar.querySelector("i").style.width = determinate ? job.progress * 100 + "%" : "";

  renderBpm(el.querySelector(".bpm"), job);
  const div = el.querySelector(".diverge");
  const pending = job.status === "done" && job.existing_bpm != null && job.bpm;
  div.classList.toggle("hidden", !pending);
  if (pending) {
    div.querySelector("span").textContent = `Tag actuel : ${fmt(job.existing_bpm)} BPM · nouvelle analyse : ${fmt(job.bpm.bpm)} BPM`;
    const btn = div.querySelector(".apply");
    btn.textContent = `Appliquer ${fmt(job.bpm.bpm)}`;
    btn.onclick = async () => {
      try {
        render(await invoke("apply_bpm", { id: job.id }));
        toast(`BPM ${fmt(job.bpm.bpm)} écrit dans le fichier`);
      } catch (e) {
        toast(String(e), true);
      }
    };
  }
  if (job.status === "done") libraryChanged();
  if (sel.queue.size) renderSelBar();
  sortQueue();
  updateCount();
  markPlaying();
}

/// En cours d'abord, puis en attente (priorité, ordre d'arrivée), puis le reste.
let sortPending = false;
function sortQueue() {
  if (sortPending) return;
  sortPending = true;
  requestAnimationFrame(() => {
    sortPending = false;
    const group = (j) => (j.status === "queued" ? 1 : j.status === "error" ? 2 : j.status === "done" ? 3 : 0);
    const list = [...jobs.values()].sort((a, b) => {
      const g = group(a) - group(b);
      if (g) return g;
      if (group(a) === 1 && a.priority !== b.priority) return a.priority ? -1 : 1;
      return group(a) === 3 ? b.id - a.id : a.seq - b.seq;
    });
    const q = $("#queue");
    list.forEach((j, i) => {
      const el = document.getElementById("job-" + j.id);
      if (el && q.children[i] !== el) q.insertBefore(el, q.children[i] || null);
    });
  });
}

function renderBpm(box, job) {
  if (box.querySelector("input")) return; // édition en cours
  const r = job.bpm;
  box.classList.toggle("has", !!r || !!job.key);
  box.dataset.verdict = r ? r.verdict : "";
  box.querySelector(".value").innerHTML = r ? `${fmt(r.bpm)}<small>BPM</small>` : "";
  box.querySelector(".verdict").textContent = r ? VERDICT[r.verdict] : "";
  box.querySelector(".key-pill")?.remove();
  if (job.key) {
    const pill = keyPill(job.key.camelot);
    pill.title = `Tonalité : ${job.key.name} (${job.key.camelot})`;
    box.insertBefore(pill, box.querySelector(".details"));
  }
  const d = box.querySelector(".details");
  d.replaceChildren();
  if (!r) return;
  const line = (k, v) => {
    const row = document.createElement("div");
    row.className = "line";
    row.innerHTML = `<span></span><b></b>`;
    row.children[0].textContent = k;
    row.children[1].textContent = v;
    d.appendChild(row);
  };
  if (r.local != null) line("Analyse audio", `${fmt(r.local)}${r.confidence != null ? `  (${Math.round(r.confidence * 100)} %)` : ""}`);
  for (const s of r.sources) line(s.source, fmt(s.bpm));
  if (r.local == null && !r.sources.length) line("Aucune donnée", "");
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = HINT[r.verdict] + (r.verdict !== "conflict" ? " Clique pour modifier." : "");
  d.appendChild(hint);
}

function editBpm(id) {
  const job = jobs.get(id);
  if (!job || !job.bpm || job.status !== "done") return;
  const box = document.querySelector(`#job-${id} .bpm`);
  const value = box.querySelector(".value");
  if (value.querySelector("input")) return;
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.value = fmt(job.bpm.bpm);
  value.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = parseFloat(input.value.replace(",", "."));
    input.remove();
    if (save && !isNaN(v) && v !== job.bpm.bpm) {
      try {
        render(await invoke("set_bpm", { id, bpm: v }));
        toast(`BPM mis à jour : ${fmt(v)}`);
        return;
      } catch (e) {
        toast(String(e), true);
      }
    }
    render(jobs.get(id));
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}

function updateCount() {
  const n = jobs.size;
  $("#count").textContent = n ? `· ${n}` : "";
  $("#empty").classList.toggle("hidden", n > 0);
  const all = [...jobs.values()];
  $("#btn-clear").classList.toggle("hidden", !all.some((j) => j.status === "done"));
  $("#btn-clear-all").classList.toggle("hidden", all.length < 2);
  $("#btn-sel-queue").classList.toggle("hidden", all.length < 2);
  const failed = all.filter((j) => j.status === "error").length;
  $("#btn-retry-all").classList.toggle("hidden", failed < 1);
  $("#btn-retry-all").textContent = failed > 1 ? `Réessayer les ${failed} échecs` : "Réessayer l'échec";
  const active = all.filter((j) => !["done", "error"].includes(j.status)).length;
  $("#badge-queue").textContent = active || "";
}

function renderPause() {
  $("#btn-pause").textContent = settings.paused ? "Reprendre" : "Mettre en pause";
  jobs.forEach((j) => j.status === "queued" && render(j));
}
$("#btn-pause").onclick = () =>
  saveSettings({ paused: !settings.paused }).then(() => {
    renderPause();
    T.event.emit?.("pause-changed", !!settings.paused);
  });

// ---------- Ajout ----------

function onUrlInput() {
  const v = $("#url").value;
  const src = detect(v);
  $("#src-icon").dataset.src = src;
  $("#src-icon use").setAttribute("href", src ? "#i-" + src : "#i-link");
  $("#follow-wrap").classList.toggle("hidden", !(src && isCollection(v)));
  $("#follow-menu").classList.remove("open");
  const query = v.trim() && !isUrl(v);
  if (query) $("#src-icon use").setAttribute("href", "#i-search");
  $("#btn-add use").setAttribute("href", query ? "#i-search" : "#i-arrow");
  $("#btn-add span").textContent = query ? "Chercher" : "Télécharger";
  if (!v.trim()) closeResults();
}
const isUrl = (v) => /^\s*(https?:\/\/|spotify:|www\.)/i.test(v) || /\.(com|be|fm|co)\//i.test(v);
$("#url").addEventListener("input", onUrlInput);

async function addUrl(url, force = false) {
  const box = $("#omnibox");
  box.classList.add("busy");
  try {
    const r = await invoke("add_url", { url, force });
    if ($("#url").value.trim() === url) {
      $("#url").value = "";
      onUrlInput();
    }
    if (r.skipped && !r.added) {
      const what = r.skipped === 1 ? `« ${r.skipped_titles[0] || "Ce morceau"} » est déjà dans ta bibliothèque` : `Ces ${r.skipped} morceaux sont déjà dans ta bibliothèque`;
      toastAction(what, "Télécharger quand même", () => addUrl(url, true));
      return;
    }
    if (r.skipped) toast(`${r.added} piste${r.added > 1 ? "s" : ""} ajoutée${r.added > 1 ? "s" : ""}, ${r.skipped} déjà présente${r.skipped > 1 ? "s" : ""} ignorée${r.skipped > 1 ? "s" : ""}`);
    else if (r.added > 1) toast(`${r.added} pistes ajoutées`);
    showView("queue");
  } catch (err) {
    toast(String(err), true);
  } finally {
    box.classList.remove("busy");
  }
}

$("#omnibox").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#url").value.trim();
  if (!url) return $("#url").focus();
  if (!isUrl(url)) return runSearch(url);
  closeResults();
  addUrl(url);
});

// ---------- Recherche universelle ----------

let searchSeq = 0;
function closeResults() {
  searchSeq++;
  $("#search-results").classList.add("hidden");
  $("#omnibox").classList.remove("busy");
}

async function runSearch(q) {
  const seq = ++searchSeq;
  const box = $("#search-results");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="sr-note">Recherche de « <b></b> » sur YouTube et SoundCloud…</div>`;
  box.querySelector("b").textContent = q;
  $("#omnibox").classList.add("busy");
  let results = [];
  try {
    results = await invoke("search", { query: q });
  } catch (e) {
    if (seq === searchSeq) box.innerHTML = `<div class="sr-note err"></div>`, (box.firstChild.textContent = String(e));
    return;
  } finally {
    if (seq === searchSeq) $("#omnibox").classList.remove("busy");
  }
  if (seq !== searchSeq) return;
  box.replaceChildren();
  if (!results.length) {
    box.innerHTML = `<div class="sr-note">Rien trouvé. Essaie avec l'artiste et le titre.</div>`;
    return;
  }
  for (const src of ["youtube", "soundcloud"]) {
    const list = results.filter((r) => r.source === src);
    if (!list.length) continue;
    const h = document.createElement("div");
    h.className = "sr-head";
    h.innerHTML = `<svg><use href="#i-${src}"/></svg>${src === "youtube" ? "YouTube" : "SoundCloud"}`;
    h.dataset.src = src;
    box.appendChild(h);
    for (const r of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sr-item";
      b.innerHTML = `<span class="sr-thumb"><svg><use href="#i-note"/></svg><img alt=""/></span>
        <span class="sr-meta"><b></b><small></small></span><span class="sr-dur"></span><svg class="sr-dl"><use href="#i-arrow"/></svg>`;
      b.querySelector("b").textContent = r.title;
      b.querySelector("small").textContent = r.artist || "";
      b.querySelector(".sr-dur").textContent = r.duration ? fmtTime(r.duration) : "";
      if (r.thumbnail) setImg(b.querySelector("img"), r.thumbnail);
      b.title = "Télécharger";
      b.onclick = () => {
        closeResults();
        $("#url").value = "";
        onUrlInput();
        addUrl(r.url);
      };
      box.appendChild(b);
    }
  }
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#omnibox")) $("#search-results").classList.add("hidden");
});
$("#url").addEventListener("focus", () => {
  if ($("#search-results").children.length && $("#url").value.trim() && !isUrl($("#url").value)) $("#search-results").classList.remove("hidden");
});
$("#url").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeResults();
  if (e.key === "ArrowDown" && !$("#search-results").classList.contains("hidden")) {
    e.preventDefault();
    $("#search-results .sr-item")?.focus();
  }
});
$("#search-results").addEventListener("keydown", (e) => {
  const items = [...document.querySelectorAll("#search-results .sr-item")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown" && i >= 0) (items[i + 1] || items[i]).focus(), e.preventDefault();
  if (e.key === "ArrowUp" && i >= 0) (i ? items[i - 1] : $("#url")).focus(), e.preventDefault();
  if (e.key === "Escape") closeResults(), $("#url").focus();
});

$("#btn-follow").onclick = (e) => {
  e.stopPropagation();
  $("#follow-menu").classList.toggle("open");
};
$("#follow-menu").onclick = async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $("#follow-menu").classList.remove("open");
  const url = $("#url").value.trim();
  $("#omnibox").classList.add("busy");
  try {
    const n = await invoke("watch_add", { url, downloadExisting: b.dataset.existing === "1" });
    $("#url").value = "";
    onUrlInput();
    toast(n ? `Playlist suivie, ${n} morceaux en file` : "Playlist suivie : les nouveautés seront téléchargées");
    showView("watch");
  } catch (err) {
    toast(String(err), true);
  } finally {
    $("#omnibox").classList.remove("busy");
  }
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".follow-wrap")) $("#follow-menu").classList.remove("open");
});

async function addFiles(paths) {
  const n = await invoke("add_files", { paths });
  if (!n) toast("Aucun fichier MP3 dans la sélection", true);
  else showView("queue");
}

$("#btn-files").onclick = async () => {
  const picked = await T.dialog.open({ multiple: true, filters: [{ name: "MP3", extensions: ["mp3"] }] });
  if (picked && picked.length) addFiles(Array.isArray(picked) ? picked : [picked]);
};
$("#btn-folder").onclick = () => settings && T.opener.openPath(settings.output_dir);
$("#btn-clear").onclick = () => invoke("clear_finished");
$("#btn-retry-all").onclick = () => invoke("retry_failed");
$("#btn-clear-all").onclick = async () => {
  const n = jobs.size;
  if (!n) return;
  const active = [...jobs.values()].filter((j) => !["done", "error", "queued"].includes(j.status)).length;
  const msg = `Retirer les ${n} morceaux de la file d'attente ?` + (active ? `\n${active} téléchargement${active > 1 ? "s" : ""} en cours ser${active > 1 ? "ont" : "a"} annulé${active > 1 ? "s" : ""}.` : "") + "\nLes fichiers déjà téléchargés sont conservés.";
  if (!(await T.dialog.ask(msg, { title: "Vider la file d'attente", kind: "warning", okLabel: "Tout vider", cancelLabel: "Annuler" }))) return;
  const removed = await invoke("clear_all");
  toast(`File vidée (${removed} morceau${removed > 1 ? "x" : ""})`);
};

// ---------- Glisser-déposer : liens et MP3 ----------

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging");
});
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const dt = e.dataTransfer;
  if (!dt) return;
  const files = [...dt.files].filter((f) => /\.mp3$/i.test(f.name));
  if (files.length) {
    for (const f of files) {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        await invoke("import_file", buf, { headers: { "x-name": encodeURIComponent(f.name) } });
      } catch (err) {
        toast(String(err), true);
      }
    }
    toast(files.length > 1 ? `${files.length} MP3 copiés dans ton dossier et analysés` : "MP3 copié dans ton dossier et analysé");
    showView("queue");
    return;
  }
  const text = (dt.getData("text/uri-list") || dt.getData("text/plain") || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const links = text.filter((l) => /^https?:\/\/|^spotify:/i.test(l));
  if (!links.length) return toast("Rien à télécharger dans ce que tu as déposé", true);
  for (const l of links) addUrl(l);
});

// ---------- Bibliothèque ----------

let library = [];
let libLoaded = false;
let libTimer = null;
let libFolder = ""; // "" = tout
let libDesc = false;
function libraryChanged() {
  if (!libLoaded) return;
  clearTimeout(libTimer);
  libTimer = setTimeout(() => loadLibrary(true), 1500);
}

async function loadLibrary(force = false) {
  if (libLoaded && !force) return renderLibrary();
  try {
    library = await invoke("library_scan");
    libLoaded = true;
    const known = await invoke("cached_grids", { paths: library.map((t) => t.path) }).catch(() => ({}));
    for (const [k, g] of Object.entries(known || {})) grids.set(k, g);
  } catch (e) {
    toast(String(e), true);
  }
  renderFolders();
  renderLibrary();
}

const inFolder = (t, f) => !f || t.folder === f || t.folder.startsWith(f + "/");

/// Arbre des dossiers aplati : chaque dossier (et ses parents) devient une playlist.
function renderFolders() {
  const counts = new Map();
  for (const t of library) {
    const parts = t.folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const f = parts.slice(0, i).join("/");
      counts.set(f, (counts.get(f) || 0) + 1);
    }
  }
  const roots = ["TrackFetcher", ...(settings.library_folders || []).map((p) => p.split(/[\\/]/).filter(Boolean).pop())];
  for (const r of roots) if (!counts.has(r)) counts.set(r, 0);
  if (libFolder && !counts.has(libFolder)) libFolder = "";
  const ul = $("#lib-folders");
  ul.replaceChildren();
  const item = (key, label, n, depth, extraIdx) => {
    const li = document.createElement("li");
    li.classList.toggle("on", key === libFolder);
    li.style.paddingLeft = 8 + depth * 14 + "px";
    li.innerHTML = `<svg class="f-ico"><use href="${depth ? "#i-folder" : key ? "#i-folder" : "#i-note"}"/></svg><span class="f-name"></span><span class="f-count"></span>`;
    li.querySelector(".f-name").textContent = label;
    li.querySelector(".f-count").textContent = n;
    li.title = key || "Toute la bibliothèque";
    li.onclick = () => {
      libFolder = key;
      renderFolders();
      renderLibrary();
    };
    if (extraIdx != null) {
      const del = document.createElement("button");
      del.className = "f-del icon";
      del.title = "Retirer ce dossier de la bibliothèque (les fichiers ne sont pas supprimés)";
      del.innerHTML = `<svg><use href="#i-x"/></svg>`;
      del.onclick = (e) => {
        e.stopPropagation();
        const list = [...settings.library_folders];
        list.splice(extraIdx, 1);
        saveSettings({ library_folders: list }).then(() => loadLibrary(true));
      };
      li.appendChild(del);
    }
    ul.appendChild(li);
  };
  item("", "Toute la bibliothèque", library.length, 0);
  const keys = [...counts.keys()].sort((a, b) => {
    const ra = roots.indexOf(a.split("/")[0]), rb = roots.indexOf(b.split("/")[0]);
    return ra - rb || a.localeCompare(b, "fr", { numeric: true, sensitivity: "base" });
  });
  for (const k of keys) {
    const parts = k.split("/");
    const extra = parts.length === 1 ? roots.indexOf(k) - 1 : -1;
    item(k, parts[parts.length - 1], counts.get(k), parts.length - 1 + 0, extra >= 0 ? extra : null);
  }
}

$("#lib-add-folder").onclick = async () => {
  const dir = await T.dialog.open({ directory: true });
  if (!dir) return;
  if ((settings.library_folders || []).includes(dir) || dir === settings.output_dir) return toast("Ce dossier est déjà dans la bibliothèque");
  await saveSettings({ library_folders: [...(settings.library_folders || []), dir] });
  libFolder = dir.split(/[\\/]/).filter(Boolean).pop();
  loadLibrary(true);
};

function filteredLibrary() {
  const q = $("#lib-search").value.trim().toLowerCase();
  const sort = $("#lib-sort").value;
  const [lo, hi] = bpmRange();
  let list = library.filter((t) =>
    inFolder(t, libFolder) &&
    (lo <= BPM_MIN && hi >= BPM_MAX || (t.bpm && t.bpm >= lo - 0.5 && t.bpm <= hi + 0.5)) &&
    (!introOnly || grids.get(t.path)?.dj_intro) &&
    (!q || [t.title, t.artist, t.album, t.genre, notes.get(t.path), t.bpm && String(Math.round(t.bpm))].some((v) => v && String(v).toLowerCase().includes(q)))
  );
  const cmp = (a, b) => (a || "\uffff").localeCompare(b || "\uffff", "fr", { sensitivity: "base", numeric: true });
  const bpm = (t) => t.bpm ?? 9999;
  list.sort((a, b) => {
    switch (sort) {
      case "title": return cmp(a.title, b.title);
      case "artist": return cmp(a.artist, b.artist) || cmp(a.title, b.title);
      case "album": return cmp(a.album, b.album) || cmp(a.title, b.title);
      case "bpm": return bpm(a) - bpm(b) || cmp(a.title, b.title);
      case "genre": return cmp(a.genre, b.genre) || bpm(a) - bpm(b);
      case "key": return keySortValue(a.key) - keySortValue(b.key) || bpm(a) - bpm(b);
      default: return b.added - a.added;
    }
  });
  if (libDesc) list.reverse();
  return list;
}

const coverObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    coverObserver.unobserve(e.target);
    const img = e.target.querySelector("img");
    coverFor(e.target.dataset.path).then((u) => setImg(img, u));
  }
});

function renderLibrary() {
  const list = filteredLibrary();
  const rows = $("#lib-rows");
  rows.replaceChildren();
  const name = libFolder ? libFolder.split("/").pop() : "Toute la bibliothèque";
  $("#lib-name").textContent = name;
  $("#lib-count").textContent = `· ${list.length}`;
  $("#lib-empty").classList.toggle("hidden", list.length > 0);
  $("#lib-table").classList.toggle("hidden", list.length === 0 || libMode === "grid");
  $("#lib-grid").classList.toggle("hidden", list.length === 0 || libMode !== "grid");
  for (const b of $("#lib-mode").children) b.classList.toggle("on", b.dataset.v === libMode);
  if (libMode === "grid") {
    $("#lib-rows").replaceChildren();
    renderMosaic(list);
    markPlaying();
    return refreshSel();
  }
  $("#lib-grid").replaceChildren();
  $("#lib-dir").textContent = libDesc ? "↑" : "↓";
  for (const b of document.querySelectorAll(".lib-header button")) b.classList.toggle("on", b.dataset.sort === $("#lib-sort").value);
  const frag = document.createDocumentFragment();
  list.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "lib-row";
    row.dataset.path = t.path;
    row.innerHTML = `<span class="l-check"></span>
      <div class="l-idx"><svg><use href="#i-note"/></svg><img alt=""/><span class="cover-play"><svg><use href="#i-play"/></svg></span></div>
      <div class="l-main"><div class="l-title"></div><div class="l-artist"></div></div>
      <div class="l-album"></div><div class="l-genre"></div><div class="l-key"></div><div class="l-bpm"></div>`;
    if (t.key) row.querySelector(".l-key").appendChild(keyPill(t.key));
    row.querySelector(".l-check").replaceWith(makeCheck("library", t.path));
    row.classList.toggle("selected", sel.library.has(t.path));
    row.querySelector(".check").setAttribute("aria-checked", sel.library.has(t.path));
    row.oncontextmenu = (e) => trackMenu(e, t, list, i);
    row.querySelector(".l-title").textContent = t.title;
    row.querySelector(".l-artist").textContent = t.artist || "";
    decorate(row.querySelector(".l-title"), t);
    row.querySelector(".l-album").textContent = t.album || "";
    row.querySelector(".l-genre").textContent = t.genre || "";
    row.querySelector(".l-bpm").textContent = t.bpm ? fmt(Math.round(t.bpm * 10) / 10) : "–";
    const idx = row.querySelector(".l-idx");
    idx.dataset.path = t.path;
    if (t.has_cover) coverObserver.observe(idx);
    row.ondblclick = () => playList(list.map(libTrack), i);
    row.onclick = (e) => {
      if (e.target.closest(".cover-play, .check")) return;
      if (sel.library.size || e.ctrlKey || e.metaKey || e.shiftKey) toggleSel("library", t.path, e);
    };
    hoverPreview(idx, t);
    row.querySelector(".cover-play").onclick = () => {
      if (current()?.path === t.path) togglePlay();
      else playList(list.map(libTrack), i);
    };
    frag.appendChild(row);
  });
  rows.appendChild(frag);
  markPlaying();
  refreshSel();
  window.ux?.afterLibrary();
}
$("#lib-search").addEventListener("input", renderLibrary);
$("#lib-sort").addEventListener("change", () => {
  libDesc = false;
  renderLibrary();
});
$("#lib-dir").onclick = () => {
  libDesc = !libDesc;
  renderLibrary();
};
document.querySelector(".lib-header").onclick = (e) => {
  const k = e.target.closest("button")?.dataset.sort;
  if (!k) return;
  if ($("#lib-sort").value === k) libDesc = !libDesc;
  else {
    $("#lib-sort").value = k;
    libDesc = false;
  }
  renderLibrary();
};
$("#lib-play").onclick = () => {
  const list = filteredLibrary();
  if (list.length) playList(list.map(libTrack), 0);
};

// Petits repères dans la bibliothèque : intro DJ et note.
function decorate(el, t) {
  const g = grids.get(t.path);
  const e = g?.energy || t.energy;
  if (e) {
    const b = document.createElement("span");
    b.className = "badge-s energy";
    b.textContent = "E" + e;
    b.title = `Énergie ${e}/10 (volume, densité de frappes, brillance, tempo)`;
    el.append(" ", b);
  }
  if (g?.dj_intro) {
    const b = document.createElement("span");
    b.className = "badge-s ok";
    b.textContent = "Intro";
    b.title = `Intro DJ : ${g.intro_beats / 4} mesures de rythmique seule`;
    el.append(" ", b);
  }
  const n = notes.get(t.path);
  if (n) {
    const i = document.createElement("span");
    i.className = "note-mark";
    i.textContent = "✎";
    i.title = n;
    el.append(" ", i);
  }
}

const libTrack = (t) => ({ path: t.path, title: t.title, artist: t.artist, bpm: t.bpm, key: t.key, hasCover: t.has_cover });

// ---------- Suggestions d'enchaînement (roue Camelot + BPM) ----------

function keyRelation(a, b) {
  const ma = /^(\d{1,2})([AB])$/.exec(a || ""), mb = /^(\d{1,2})([AB])$/.exec(b || "");
  if (!ma || !mb) return null;
  const d = Math.abs(Number(ma[1]) - Number(mb[1]));
  const dist = Math.min(d, 12 - d);
  if (dist === 0 && ma[2] === mb[2]) return { rank: 0, label: "Même clé" };
  if (dist === 1 && ma[2] === mb[2]) return { rank: 1, label: "Clé voisine" };
  if (dist === 0) return { rank: 1, label: ma[2] === "A" ? "Relative majeure" : "Relative mineure" };
  return null;
}

/// Écart de tempo relatif, en acceptant le double ou la moitié.
function bpmGap(ref, b) {
  if (!ref || !b) return null;
  return Math.min(...[b, b * 2, b / 2].map((x) => Math.abs(x - ref) / ref));
}

function suggestionsFor(t) {
  return library
    .filter((o) => o.path !== t.path)
    .map((o) => {
      const rel = keyRelation(t.key, o.key);
      const gap = bpmGap(t.bpm, o.bpm);
      if (!rel || gap == null || gap > 0.06) return null;
      return { o, rel, gap, score: rel.rank * 4 + gap * 100 };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .slice(0, 15);
}

async function showSuggestions(t) {
  if (!t) return;
  if (!libLoaded) await loadLibrary(true);
  const full = library.find((o) => o.path === t.path);
  if (full) t = { ...t, key: t.key || full.key, bpm: t.bpm || full.bpm };
  $("#suggest").classList.remove("hidden");
  $("#suggest-ref").replaceChildren(`${t.title || ""} · ${t.bpm ? Math.round(t.bpm) + " BPM" : "BPM inconnu"} · `, t.key ? keyPill(t.key) : "clé inconnue");
  const ul = $("#suggest-list");
  ul.replaceChildren();
  const list = t.key && t.bpm ? suggestionsFor(t) : [];
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty-s";
    li.textContent = !t.key || !t.bpm
      ? "Ce morceau n'a pas encore de clé ou de BPM : analyse-le d'abord."
      : "Aucun morceau compatible dans ta bibliothèque pour l'instant.";
    ul.appendChild(li);
    return;
  }
  for (const { o, rel, gap } of list) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="l-idx"><svg><use href="#i-note"/></svg><img alt=""/></div>
      <div class="s-meta"><div class="s-title"></div><div class="s-why"></div></div><div class="s-right"></div>`;
    li.querySelector(".s-title").textContent = `${o.title}${o.artist ? " · " + o.artist : ""}`;
    li.querySelector(".s-why").textContent = `${rel.label} · ${gap < 0.005 ? "même tempo" : "écart " + (gap * 100).toFixed(1) + " %"}`;
    const right = li.querySelector(".s-right");
    right.append(keyPill(o.key), document.createElement("br"), `${Math.round(o.bpm)} BPM`);
    if (o.has_cover) coverFor(o.path).then((u) => setImg(li.querySelector("img"), u));
    li.title = "Lire ensuite";
    li.onclick = () => {
      const tr = libTrack(o);
      if (current()) {
        player.list.splice(player.index + 1, 0, tr);
        player.order = player.list.map((_, k) => k);
        toast(`« ${o.title} » sera lu ensuite`);
      } else playList([tr], 0);
    };
    ul.appendChild(li);
  }
}
$("#p-suggest").onclick = () =>
  $("#suggest").classList.contains("hidden") ? showSuggestions(current()) : $("#suggest").classList.add("hidden");
$("#suggest-close").onclick = () => $("#suggest").classList.add("hidden");

// ---------- Lecteur ----------

const audio = $("#audio");
let audioUrl = null;
const player = { list: [], index: -1, shuffle: false, repeat: "off", order: [] };

function playFromQueue(id) {
  const done = [...jobs.values()].filter((j) => j.status === "done" && j.path).sort((a, b) => b.id - a.id);
  const list = done.map((j) => ({ path: j.path, title: j.title, artist: j.artist, bpm: j.bpm?.bpm, key: j.key?.camelot, cover: j.cover, hasCover: true }));
  const i = done.findIndex((j) => j.id === id);
  if (player.list[player.index]?.path === list[i]?.path) return togglePlay();
  playList(list, Math.max(0, i));
}

function playList(list, i) {
  player.list = list;
  player.order = list.map((_, k) => k);
  if (player.shuffle) shuffleOrder(i);
  player.index = i;
  loadTrack(true);
}

function shuffleOrder(keepFirst) {
  const rest = player.list.map((_, k) => k).filter((k) => k !== keepFirst);
  for (let k = rest.length - 1; k > 0; k--) {
    const r = Math.floor(Math.random() * (k + 1));
    [rest[k], rest[r]] = [rest[r], rest[k]];
  }
  player.order = keepFirst == null ? rest : [keepFirst, ...rest];
}

const current = () => player.list[player.index];

async function loadTrack(autoplay) {
  const t = current();
  if (!t) return;
  $("#player").classList.remove("hidden");
  try {
    const buf = await invoke("audio_bytes", { path: t.path });
    if (current() !== t) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
    audio.src = audioUrl;
  } catch (e) {
    toast("Fichier illisible : " + e, true);
    return;
  }
  $("#p-title").textContent = $("#np-title").textContent = t.title || "Sans titre";
  $("#p-artist").textContent = $("#np-artist").textContent = t.artist || "";
  $("#p-bpm").textContent = t.bpm ? `${Math.round(t.bpm)} BPM` : "";
  $("#np-bpm").textContent = t.bpm ? `${Math.round(t.bpm)} BPM` : "";
  const url = t.cover || (t.hasCover ? await coverFor(t.path) : null);
  if (current() !== t) return;
  setImg($("#p-cover img"), url);
  setImg($("#np-cover img"), url);
  $("#np-bg").style.backgroundImage = url ? `url("${url}")` : "";
  setAmbient(url, t);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title || "",
      artist: t.artist || "",
      artwork: url ? [{ src: url, sizes: "512x512" }] : [],
    });
  }
  beatInterval = t.bpm ? 60 / t.bpm : 0;
  if (!$("#suggest").classList.contains("hidden")) showSuggestions(t);
  if (autoplay) play();
  markPlaying();
}

async function play() {
  ensureAudioGraph();
  if (actx?.state === "suspended") await actx.resume();
  try {
    await audio.play();
  } catch (e) {
    toast("Lecture impossible : " + (e.message || e), true);
  }
}
function togglePlay() {
  if (!current()) return;
  audio.paused ? play() : audio.pause();
}

function step(dir) {
  if (!player.list.length) return;
  const pos = player.order.indexOf(player.index);
  let next = pos + dir;
  if (next >= player.order.length) {
    if (player.repeat !== "all") return audio.pause();
    if (player.shuffle) shuffleOrder(null);
    next = 0;
  }
  if (next < 0) next = 0;
  player.index = player.order[next];
  loadTrack(true);
}

$("#p-play").onclick = togglePlay;
$("#p-next").onclick = () => step(1);
$("#p-prev").onclick = () => (audio.currentTime > 3 ? (audio.currentTime = 0) : step(-1));
$("#p-shuffle").onclick = () => {
  player.shuffle = !player.shuffle;
  $("#p-shuffle").classList.toggle("active", player.shuffle);
  if (player.shuffle) shuffleOrder(player.index);
  else player.order = player.list.map((_, k) => k);
};
$("#p-repeat").onclick = () => {
  player.repeat = { off: "all", all: "one", one: "off" }[player.repeat];
  const b = $("#p-repeat");
  b.classList.toggle("active", player.repeat !== "off");
  b.title = { off: "Répéter", all: "Répéter la liste", one: "Répéter le morceau" }[player.repeat];
  b.style.position = "relative";
  b.dataset.one = player.repeat === "one" ? "1" : "";
};

audio.addEventListener("play", () => setPlayIcon(true));
audio.addEventListener("pause", () => setPlayIcon(false));
audio.addEventListener("ended", () => {
  if (player.repeat === "one") {
    audio.currentTime = 0;
    play();
  } else step(1);
});
audio.addEventListener("error", () => {
  if (current()) toast("Fichier illisible : " + (current().title || ""), true);
});
function setPlayIcon(playing) {
  $("#p-play use").setAttribute("href", playing ? "#i-pause" : "#i-play");
  markPlaying();
}

const pos = $("#p-pos");
let seeking = false;
function fill(input) {
  input.style.setProperty("--fill", (input.value / input.max) * 100 + "%");
}
audio.addEventListener("timeupdate", () => {
  if (seeking || !audio.duration) return;
  pos.value = (audio.currentTime / audio.duration) * 1000;
  fill(pos);
  $("#p-time").textContent = fmtTime(audio.currentTime);
});
audio.addEventListener("loadedmetadata", () => ($("#p-dur").textContent = fmtTime(audio.duration)));
pos.addEventListener("input", () => {
  seeking = true;
  fill(pos);
  $("#p-time").textContent = fmtTime((pos.value / 1000) * (audio.duration || 0));
});
pos.addEventListener("change", () => {
  if (audio.duration) audio.currentTime = (pos.value / 1000) * audio.duration;
  seeking = false;
});

const vol = $("#p-vol");
function setVolume(v) {
  audio.volume = v / 100;
  vol.value = v;
  fill(vol);
  $("#p-mute use").setAttribute("href", v == 0 || audio.muted ? "#i-mute" : "#i-volume");
  try { localStorage.setItem("tf-volume", v); } catch {}
}
vol.addEventListener("input", () => {
  audio.muted = false;
  setVolume(vol.value);
});
$("#p-mute").onclick = () => {
  audio.muted = !audio.muted;
  $("#p-mute use").setAttribute("href", audio.muted ? "#i-mute" : "#i-volume");
};
try { setVolume(Number(localStorage.getItem("tf-volume") ?? 80)); } catch { setVolume(80); }

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", play);
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
  navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
}

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (view === "dj") return; // Espace = mixer dans l'onglet DJ
    togglePlay();
  } else if (e.key === "ArrowRight" && e.altKey) step(1);
  else if (e.key === "ArrowLeft" && e.altKey) step(-1);
});

function markPlaying() {
  const t = current();
  const path = t && !audio.paused ? t.path : null;
  document.querySelectorAll(".job").forEach((el) => {
    const j = jobs.get(Number(el.id.slice(4)));
    const on = !!path && j?.path === path;
    el.classList.toggle("playing", on);
    el.querySelector(".cover-play use").setAttribute("href", on ? "#i-pause" : "#i-play");
  });
  document.querySelectorAll("#lib-grid .tile").forEach((el) => {
    const on = !!t && el.dataset.path === t.path;
    el.classList.toggle("playing", on);
    el.querySelector(".cover-play use").setAttribute("href", on && path ? "#i-pause" : "#i-play");
  });
  document.querySelectorAll("#lib-rows .lib-row").forEach((el) => {
    const on = !!t && el.dataset.path === t.path;
    el.classList.toggle("playing", on);
    el.querySelector(".cover-play use").setAttribute("href", on && path ? "#i-pause" : "#i-play");
  });  window.ux?.compat();
}

// ---------- Visualiseur ----------

let actx = null;
let analyser = null;
let outGain = null;
let freq = null;
let wave = null;
let beatInterval = 0;
let vizMode = "radial";
try { vizMode = localStorage.getItem("tf-viz") || "radial"; } catch {}

function ensureAudioGraph() {
  if (actx) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const src = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.78;
    src.connect(analyser);
    // Sortie coupée pendant un cast : le visualiseur continue, le son part sur la télé.
    outGain = actx.createGain();
    analyser.connect(outGain).connect(actx.destination);
    freq = new Uint8Array(analyser.frequencyBinCount);
    wave = new Uint8Array(analyser.fftSize);
    requestAnimationFrame(draw);
  } catch (e) {
    console.warn("Visualiseur indisponible", e);
  }
}

/// Bandes logarithmiques (20 Hz → 16 kHz), 0..1.
function bands(n) {
  const out = new Float32Array(n);
  const nyq = actx.sampleRate / 2;
  const bins = freq.length;
  for (let i = 0; i < n; i++) {
    const f0 = 20 * Math.pow(16000 / 20, i / n);
    const f1 = 20 * Math.pow(16000 / 20, (i + 1) / n);
    const b0 = Math.floor((f0 / nyq) * bins);
    const b1 = Math.max(b0 + 1, Math.floor((f1 / nyq) * bins));
    let m = 0;
    for (let b = b0; b < b1 && b < bins; b++) m = Math.max(m, freq[b]);
    out[i] = m / 255;
  }
  return out;
}

function gradient(ctx, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, "#7c5cff");
  g.addColorStop(1, "#ff4d8d");
  return g;
}

function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return [w, h, dpr];
}

let bassAvg = 0;
function draw() {
  requestAnimationFrame(draw);
  if (!analyser) return;
  analyser.getByteFrequencyData(freq);
  pulseFrame();
  const npOpen = !$("#np").classList.contains("hidden");

  // Mini visualiseur dans la barre de lecture.
  const mini = $("#p-viz");
  if (mini.offsetParent) {
    const [w, h, dpr] = sizeCanvas(mini);
    const ctx = mini.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    const b = bands(24);
    const bw = w / b.length;
    ctx.fillStyle = gradient(ctx, 0, 0, w, 0);
    b.forEach((v, i) => {
      const bh = Math.max(2 * dpr, v * v * h);
      ctx.beginPath();
      ctx.roundRect(i * bw + bw * 0.2, h - bh, bw * 0.6, bh, 2 * dpr);
      ctx.fill();
    });
  }
  if (!npOpen) return;

  const c = $("#np-viz");
  const [w, h, dpr] = sizeCanvas(c);
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const b = bands(96);
  const bass = (b[2] + b[3] + b[4] + b[5]) / 4;
  bassAvg = bassAvg * 0.9 + bass * 0.1;
  const kick = Math.max(0, bass - bassAvg) * 2.2;
  $("#np-cover").style.transform = `scale(${1 + kick * 0.12})`;

  const cx = w / 2;
  const cy = h * 0.46 - 40 * dpr;
  if (vizMode === "radial") {
    const coverR = Math.min(h * 0.15, 130 * dpr) * (1 + kick * 0.12);
    const r0 = coverR + 14 * dpr;
    const maxLen = Math.min(w, h) * 0.22;
    const n = b.length;
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2, ((Math.PI * 2 * r0) / (n * 2)) * 0.55);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < n; i++) {
        const v = b[i];
        const a = -Math.PI / 2 + side * (i / n) * Math.PI;
        const len = 4 * dpr + v * v * maxLen;
        const x0 = cx + Math.cos(a) * r0, y0 = cy + Math.sin(a) * r0;
        const x1 = cx + Math.cos(a) * (r0 + len), y1 = cy + Math.sin(a) * (r0 + len);
        ctx.strokeStyle = `hsl(${255 + (i / n) * 85}, 95%, ${55 + v * 15}%)`;
        ctx.globalAlpha = 0.55 + v * 0.45;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 0.25 + kick * 0.6;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, r0 - 6 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (vizMode === "bars") {
    const n = 72;
    const bb = bands(n);
    const bw = w / n;
    const base = h - 100 * dpr;
    ctx.fillStyle = gradient(ctx, 0, base - h * 0.5, 0, base);
    for (let i = 0; i < n; i++) {
      const bh = 3 * dpr + bb[i] * bb[i] * h * 0.5;
      ctx.beginPath();
      ctx.roundRect(i * bw + bw * 0.15, base - bh, bw * 0.7, bh, 3 * dpr);
      ctx.fill();
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.roundRect(i * bw + bw * 0.15, base + 4 * dpr, bw * 0.7, bh * 0.35, 3 * dpr);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  } else {
    analyser.getByteTimeDomainData(wave);
    const y = h - 170 * dpr;
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = gradient(ctx, 0, 0, w, 0);
    ctx.shadowColor = "#ff4d8d";
    ctx.shadowBlur = 18 * dpr;
    ctx.beginPath();
    for (let i = 0; i < wave.length; i += 2) {
      const x = (i / wave.length) * w;
      const v = (wave[i] - 128) / 128;
      const yy = y + v * h * 0.18;
      i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function openNp() {
  if (!current()) return;
  $("#np").classList.remove("hidden");
  document.body.classList.add("np-open");
}
function closeNp() {
  $("#np").classList.add("hidden");
  document.body.classList.remove("np-open");
}
$("#p-expand").onclick = () => ($("#np").classList.contains("hidden") ? openNp() : closeNp());
$("#p-cover").onclick = openNp;
$("#np-close").onclick = closeNp;
document.addEventListener("keydown", (e) => e.key === "Escape" && closeNp());
function setVizMode(m) {
  vizMode = m;
  for (const b of $("#np-modes").children) b.classList.toggle("on", b.dataset.mode === m);
  try { localStorage.setItem("tf-viz", m); } catch {}
}
$("#np-modes").onclick = (e) => {
  if (e.target.dataset.mode) setVizMode(e.target.dataset.mode);
};
setVizMode(vizMode);

// ---------- Playlists suivies ----------

function ago(ts) {
  if (!ts) return "jamais";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

let watched = [];
function renderWatched(list) {
  watched = list;
  const ul = $("#watch-list");
  ul.replaceChildren();
  $("#watch-empty").classList.toggle("hidden", list.length > 0);
  $("#badge-watch").textContent = list.length || "";
  for (const w of list) {
    const li = document.createElement("li");
    li.className = "watch";
    li.dataset.source = w.source;
    li.innerHTML = `
      <div class="w-icon"><svg><use href="${srcIcon(w.source)}"/></svg></div>
      <div><div class="w-title"></div><div class="w-sub"></div></div>
      <button class="ghost w-check"><svg><use href="#i-retry"/></svg><span>Vérifier</span></button>
      <div class="w-actions">
        <button class="icon w-open" title="Ouvrir dans le navigateur"><svg><use href="#i-link"/></svg></button>
        <button class="icon w-remove" title="Ne plus suivre"><svg><use href="#i-x"/></svg></button>
      </div>`;
    li.querySelector(".w-title").textContent = w.title;
    const sub = li.querySelector(".w-sub");
    sub.textContent = w.error
      ? `Erreur : ${w.error}`
      : `${w.tracks} morceaux · vérifiée ${ago(w.last_check)}${w.last_new ? ` · ${w.last_new} nouveau${w.last_new > 1 ? "x" : ""}` : ""}`;
    sub.classList.toggle("err", !!w.error);
    const check = li.querySelector(".w-check");
    check.disabled = w.checking;
    check.querySelector("svg").classList.toggle("spin", w.checking);
    check.onclick = async () => {
      try {
        const n = await invoke("watch_check", { id: w.id });
        toast(n ? `${n} nouveau${n > 1 ? "x" : ""} morceau${n > 1 ? "x" : ""} en file` : "Rien de nouveau");
      } catch (e) {
        toast(String(e), true);
      }
    };
    li.querySelector(".w-open").onclick = () => T.opener.openUrl(w.url);
    li.querySelector(".w-remove").onclick = () => invoke("watch_remove", { id: w.id });
    ul.appendChild(li);
  }
}
$("#btn-check-all").onclick = async () => {
  const n = await invoke("watch_check", { id: null });
  toast(n ? `${n} nouveaux morceaux en file` : "Rien de nouveau");
};
setInterval(() => watched.length && renderWatched(watched), 60000);

// ---------- Réglages ----------

const SAMPLE = { artist: "Daft Punk", title: "One More Time", album: "Discovery", bpm: "123", genre: "Electro", key: "4B" };
function previewName(tpl) {
  // Même logique que le moteur : un groupe () ou [] aux balises vides disparaît.
  let s = tpl.replace(/\s*[(\[][^()\[\]]*[)\]]/g, (g) => {
    const toks = [...g.matchAll(/\{(\w+)\}/g)];
    return toks.length && toks.every((t) => !SAMPLE[t[1]]) ? "" : g;
  });
  s = s.replace(/\{(\w+)\}/g, (_, k) => SAMPLE[k] ?? "");
  s = s.replace(/([(\[])\s*[-·]\s*/g, "$1").replace(/\s*[-·]\s*([)\]])/g, "$1").replace(/\s*(\(\s*\)|\[\s*\])/g, "");
  s = s.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim().replace(/^[-_·\s]+|[-_·\s]+$/g, "");
  return (s || "Daft Punk - One More Time") + ".mp3";
}

function setSwitch(id, on) {
  $(id).setAttribute("aria-checked", on ? "true" : "false");
}

const SORT_HINT = {
  none: "Tous les MP3 dans le même dossier.",
  bpm: "Exemple : 120-124 BPM/Daft Punk - One More Time.mp3",
  genre: "Exemple : Electro/Daft Punk - One More Time.mp3",
  genre_bpm: "Exemple : Electro/120-124 BPM/Daft Punk - One More Time.mp3",
  key: "Exemple : 4B/Daft Punk - One More Time.mp3",
  key_bpm: "Exemple : 4B/120-124 BPM/Daft Punk - One More Time.mp3",
};

function fillSettings() {
  $("#s-dir").value = settings.output_dir;
  $("#s-key").value = settings.getsongbpm_key;
  if (document.activeElement !== $("#s-template")) $("#s-template").value = settings.filename_template;
  $("#s-preview").innerHTML = "";
  $("#s-preview").append("Aperçu : ", Object.assign(document.createElement("b"), { textContent: previewName($("#s-template").value) }));
  setSwitch("#s-verify", settings.verify_online);
  setSwitch("#s-hdcover", settings.hd_cover);
  setSwitch("#s-skip", settings.skip_existing);
  setSwitch("#s-clip", settings.watch_clipboard);
  setSwitch("#s-ambient", settings.ambient);
  setSwitch("#s-pulse", settings.pulse);
  setSwitch("#s-notify", settings.notify);
  setSwitch("#s-autoupdate", settings.auto_update);
  setSwitch("#s-tray", settings.close_to_tray);
  document.body.classList.toggle("ambient-on", !!settings.ambient);
  const seg = (id, v) => { for (const b of $(id).children) b.classList.toggle("on", b.dataset.v === String(v)); };
  seg("#s-quality", settings.quality);
  seg("#s-parallel", settings.parallel);
  seg("#s-sort", settings.sort_by);
  seg("#s-sort2", settings.sort_by);
  seg("#s-interval", settings.watch_interval);
  seg("#s-cookies", settings.cookies_browser);
  $("#s-sort-hint").textContent = SORT_HINT[settings.sort_by] || "";
  const iv = { 15: "toutes les 15 min", 60: "toutes les heures", 360: "toutes les 6 h", 1440: "une fois par jour" }[settings.watch_interval];
  $("#watch-interval-label").textContent = iv ? `Vérification ${iv}, app ouverte` : "";
  $("#btn-pause").textContent = settings.paused ? "Reprendre" : "Mettre en pause";
}

async function saveSettings(patch) {
  try {
    settings = await invoke("save_settings", { settings: { ...settings, ...patch } });
    fillSettings();
  } catch (e) {
    toast(String(e), true);
  }
}

const drawer = $("#drawer");
$("#btn-settings").onclick = () => drawer.classList.add("open");
$("#btn-close-settings").onclick = () => drawer.classList.remove("open");
drawer.onclick = (e) => {
  if (e.target === drawer) drawer.classList.remove("open");
};
document.addEventListener("keydown", (e) => e.key === "Escape" && drawer.classList.remove("open"));

$("#s-dir-pick").onclick = async () => {
  const dir = await T.dialog.open({ directory: true, defaultPath: settings.output_dir });
  if (dir) {
    await saveSettings({ output_dir: dir });
    libLoaded = false;
    if (view === "library") loadLibrary();
  }
};
const segClick = (id, key, num) => ($(id).onclick = (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (v !== undefined) saveSettings({ [key]: num ? Number(v) : v });
});
segClick("#s-quality", "quality");
segClick("#s-parallel", "parallel", true);
segClick("#s-sort", "sort_by");
segClick("#s-sort2", "sort_by");
segClick("#s-interval", "watch_interval", true);
$("#s-verify").onclick = () => saveSettings({ verify_online: !settings.verify_online });
$("#s-hdcover").onclick = () => saveSettings({ hd_cover: !settings.hd_cover });
$("#s-skip").onclick = () => saveSettings({ skip_existing: !settings.skip_existing });
$("#s-clip").onclick = () => saveSettings({ watch_clipboard: !settings.watch_clipboard });
$("#s-ambient").onclick = () => saveSettings({ ambient: !settings.ambient });
$("#s-pulse").onclick = () => saveSettings({ pulse: !settings.pulse });
$("#s-notify").onclick = () => saveSettings({ notify: !settings.notify });
$("#s-autoupdate").onclick = () => saveSettings({ auto_update: !settings.auto_update });
$("#s-tray").onclick = () => saveSettings({ close_to_tray: !settings.close_to_tray });
segClick("#s-cookies", "cookies_browser");
$("#s-key").onchange = (e) => saveSettings({ getsongbpm_key: e.target.value.trim() });

const tplInput = $("#s-template");
tplInput.addEventListener("input", () => {
  $("#s-preview").lastChild.textContent = previewName(tplInput.value);
});
tplInput.addEventListener("change", () => saveSettings({ filename_template: tplInput.value.trim() || "{artist} - {title}" }));
$("#s-tokens").onclick = (e) => {
  const t = e.target.closest("button")?.dataset.t;
  if (!t) return;
  const s = tplInput.selectionStart ?? tplInput.value.length;
  const end = tplInput.selectionEnd ?? s;
  tplInput.value = tplInput.value.slice(0, s) + t + tplInput.value.slice(end);
  tplInput.focus();
  tplInput.setSelectionRange(s + t.length, s + t.length);
  tplInput.dispatchEvent(new Event("input"));
  saveSettings({ filename_template: tplInput.value });
};

// ---------- Lien copié (presse-papiers) ----------

let clipTimer = null;
function showClipboard(url) {
  const b = $("#clip-banner");
  const src = detect(url);
  b.dataset.src = src;
  b.querySelector(".clip-src use").setAttribute("href", src ? "#i-" + src : "#i-link");
  $("#clip-url").textContent = url;
  b.classList.remove("hidden");
  $("#clip-add").onclick = () => {
    b.classList.add("hidden");
    addUrl(url);
  };
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => b.classList.add("hidden"), 15000);
}
$("#clip-dismiss").onclick = () => $("#clip-banner").classList.add("hidden");

// ---------- Thème ----------

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let theme = "system";
try { theme = localStorage.getItem("tf-theme") || "system"; } catch {}
const isDark = () => (theme === "system" ? darkQuery.matches : theme === "time" ? document.documentElement.dataset.theme === "dark" : theme === "dark");
// Thème « Heure » : clair de 8 h à 19 h, sombre le soir, sombre et chaud (moins de bleu) de 22 h à 6 h.
function timeTheme() {
  const h = new Date().getHours();
  return { mode: h >= 8 && h < 19 ? "light" : "dark", night: h >= 22 || h < 6 };
}
function applyTheme(t) {
  theme = t;
  delete document.documentElement.dataset.night;
  if (t === "system") delete document.documentElement.dataset.theme;
  else if (t === "time") {
    const tt = timeTheme();
    document.documentElement.dataset.theme = tt.mode;
    if (tt.night) document.documentElement.dataset.night = "";
  } else document.documentElement.dataset.theme = t;
  try { localStorage.setItem("tf-theme", t); } catch {}
  for (const b of $("#s-theme").children) b.classList.toggle("on", b.dataset.v === t);
  $("#btn-theme use").setAttribute("href", isDark() ? "#i-sun" : "#i-moon");
  $("#btn-theme").title = isDark() ? "Passer en mode clair" : "Passer en mode sombre";
}
$("#s-theme").onclick = (e) => {
  if (e.target.dataset.v) applyTheme(e.target.dataset.v);
};
$("#btn-theme").onclick = () => applyTheme(isDark() ? "light" : "dark");
darkQuery.addEventListener("change", () => applyTheme(theme));
setInterval(() => theme === "time" && applyTheme("time"), 5 * 60 * 1000);
applyTheme(theme);

// ---------- Composants (yt-dlp, ffmpeg) ----------

function showTools(t) {
  const missing = !t.ytdlp || !t.ffmpeg;
  $("#setup").classList.toggle("hidden", !missing);
  $("#btn-add").disabled = missing;
  if (missing && !t.ffmpeg && !t.ffmpeg_auto) {
    $("#setup-text").textContent =
      "TrackFetcher a besoin de ffmpeg. Installe-le avec ton gestionnaire de paquets (sudo apt install ffmpeg), puis clique sur Installer pour yt-dlp.";
  }
}

$("#btn-install").onclick = async () => {
  const btn = $("#btn-install");
  btn.disabled = true;
  btn.textContent = "Installation…";
  $("#setup-bar").classList.remove("hidden");
  try {
    showTools(await invoke("install_tools"));
    toast("Composants installés, c'est parti !");
  } catch (e) {
    toast(String(e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Installer";
    $("#setup-bar").classList.add("hidden");
  }
};

// ---------- Filtre BPM (double curseur) ----------

const BPM_MIN = 60, BPM_MAX = 200;
function bpmRange() {
  const a = Number($("#bpm-min").value), b = Number($("#bpm-max").value);
  return [Math.min(a, b), Math.max(a, b)];
}
function renderBpmRange() {
  const [lo, hi] = bpmRange();
  const all = lo <= BPM_MIN && hi >= BPM_MAX;
  $("#bpm-label").textContent = all ? "Tous BPM" : `${lo}–${hi} BPM`;
  $("#bpm-dual").style.setProperty("--lo", ((lo - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100 + "%");
  $("#bpm-dual").style.setProperty("--hi", ((hi - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100 + "%");
  $(".bpm-range").classList.toggle("on", !all);
}
for (const id of ["#bpm-min", "#bpm-max"]) {
  $(id).addEventListener("input", (e) => {
    // Les deux poignées ne se croisent pas.
    const lo = $("#bpm-min"), hi = $("#bpm-max");
    if (Number(lo.value) > Number(hi.value)) e.target === lo ? (lo.value = hi.value) : (hi.value = lo.value);
    renderBpmRange();
    renderLibrary();
    try { localStorage.setItem("tf-bpm", `${lo.value}-${hi.value}`); } catch {}
  });
}
$(".bpm-range").addEventListener("dblclick", () => {
  $("#bpm-min").value = BPM_MIN;
  $("#bpm-max").value = BPM_MAX;
  $("#bpm-min").dispatchEvent(new Event("input"));
});
try {
  const [a, b] = (localStorage.getItem("tf-bpm") || "").split("-").map(Number);
  if (a && b) ($("#bpm-min").value = a), ($("#bpm-max").value = b);
} catch {}
renderBpmRange();

// ---------- Mosaïque de pochettes ----------

let libMode = "grid";
try { libMode = localStorage.getItem("tf-libmode") || "grid"; } catch {}
$("#lib-mode").onclick = (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v) return;
  libMode = v;
  try { localStorage.setItem("tf-libmode", v); } catch {}
  renderLibrary();
};

function hashHue(s) {
  let h = 0;
  for (const c of s || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function renderMosaic(list) {
  const grid = $("#lib-grid");
  grid.replaceChildren();
  const frag = document.createDocumentFragment();
  list.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.path = t.path;
    const hue = hashHue(t.artist || t.title);
    el.style.setProperty("--h1", hue);
    el.style.setProperty("--h2", (hue + 50) % 360);
    el.innerHTML = `<div class="t-art"><span class="t-initial"></span><img alt=""/></div>
      <span class="cover-play"><svg><use href="#i-play"/></svg></span>
      <div class="t-info"><b></b><small></small><span class="t-tags"></span></div>`;
    el.querySelector(".t-initial").textContent = (t.artist || t.title || "?").trim().charAt(0).toUpperCase();
    el.querySelector("b").textContent = t.title;
    el.querySelector("small").textContent = t.artist || "";
    decorate(el.querySelector("b"), t);
    const tags = el.querySelector(".t-tags");
    if (t.bpm) tags.append(`${Math.round(t.bpm)} BPM`);
    if (t.key) tags.append(" ", keyPill(t.key));
    if (t.has_cover) coverObserver.observe(el);
    el.onclick = (e) => {
      // En mode sélection (ou Ctrl/Maj + clic), un clic coche au lieu de lire.
      if (sel.library.size || e.ctrlKey || e.metaKey || e.shiftKey) return toggleSel("library", t.path, e);
      current()?.path === t.path ? togglePlay() : playList(list.map(libTrack), i);
    };
    el.oncontextmenu = (e) => trackMenu(e, t, list, i);
    const ck = makeCheck("library", t.path);
    ck.setAttribute("aria-checked", sel.library.has(t.path));
    el.classList.toggle("selected", sel.library.has(t.path));
    el.appendChild(ck);
    hoverPreview(el, t);
    frag.appendChild(el);
  });
  grid.appendChild(frag);
}

// ---------- Aperçu de 10 s au survol ----------

const preview = new Audio();
let previewTimer = null, previewStop = null, previewEl = null, duckedVolume = null;

function stopPreview() {
  clearTimeout(previewTimer);
  clearTimeout(previewStop);
  previewTimer = previewStop = null;
  if (previewEl) previewEl.classList.remove("previewing");
  previewEl = null;
  if (!preview.paused) preview.pause();
  if (preview.src) {
    URL.revokeObjectURL(preview.src);
    preview.removeAttribute("src");
  }
  if (duckedVolume != null) {
    audio.volume = duckedVolume;
    duckedVolume = null;
  }
}

async function startPreview(el, t) {
  stopPreview();
  if (current()?.path === t.path && !audio.paused) return;
  previewEl = el;
  let buf;
  try {
    buf = await invoke("audio_bytes", { path: t.path });
  } catch {
    return;
  }
  if (previewEl !== el) return;
  preview.src = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
  await new Promise((r) => preview.addEventListener("loadedmetadata", r, { once: true }));
  if (previewEl !== el) return;
  // On démarre vers le tiers du morceau, souvent après l'intro.
  preview.currentTime = (preview.duration || 0) * 0.33;
  preview.volume = audio.muted ? 0 : Math.max(0.15, Number(vol.value) / 100);
  if (!audio.paused) {
    duckedVolume = audio.volume;
    audio.volume = duckedVolume * 0.2;
  }
  try {
    await preview.play();
  } catch {
    return stopPreview();
  }
  el.classList.add("previewing");
  previewStop = setTimeout(stopPreview, 10000);
}

function hoverPreview(el, t) {
  el.addEventListener("mouseenter", () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => startPreview(el, t), 700);
  });
  el.addEventListener("mouseleave", () => {
    if (previewEl === el || previewTimer) stopPreview();
  });
  el.addEventListener("click", stopPreview, true);
}

// ---------- Fusion des artistes mal orthographiés ----------

const normArtist = (a) =>
  (a || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");

/// Distance de Levenshtein, abandonnée au-delà de `max`.
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function artistGroups() {
  const spell = new Map(); // orthographe → pistes
  for (const t of library) {
    if (!t.artist) continue;
    if (!spell.has(t.artist)) spell.set(t.artist, []);
    spell.get(t.artist).push(t);
  }
  const byNorm = new Map();
  for (const a of spell.keys()) {
    const n = normArtist(a);
    if (!n) continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(a);
  }
  // Union des clés normalisées proches (fautes de frappe).
  const keys = [...byNorm.keys()];
  const parent = keys.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      const max = Math.min(a.length, b.length) >= 9 ? 2 : Math.min(a.length, b.length) >= 5 ? 1 : 0;
      if (max && lev(a, b, max) <= max) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  keys.forEach((k, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(...byNorm.get(k));
  });
  let ignored = [];
  try { ignored = JSON.parse(localStorage.getItem("tf-merge-ignored") || "[]"); } catch {}
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.map((a) => ({ name: a, tracks: spell.get(a) })).sort((x, y) => spellScore(y) - spellScore(x)))
    .filter((g) => !ignored.includes(g.map((x) => x.name).sort().join("|")));
}

/// Orthographe proposée par défaut : la plus fréquente, puis la plus propre.
const spellScore = (a) =>
  a.tracks.length * 10 - (/\s{2,}|^\s|\s$/.test(a.name) ? 5 : 0) - (a.name === a.name.toLowerCase() ? 2 : 0);

async function openMerge() {
  if (!libLoaded) await loadLibrary(true);
  const list = $("#merge-list");
  list.replaceChildren();
  const groups = artistGroups();
  if (!groups.length) {
    list.innerHTML = `<p class="merge-none">Aucun doublon d'artiste repéré dans ta bibliothèque.</p>`;
  }
  for (const g of groups) {
    const card = document.createElement("div");
    card.className = "merge-group";
    let chosen = g[0].name;
    const opts = document.createElement("div");
    opts.className = "merge-opts";
    for (const a of g) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.classList.toggle("on", a.name === chosen);
      b.append(a.name, Object.assign(document.createElement("small"), { textContent: ` ${a.tracks.length}` }));
      b.onclick = () => {
        chosen = a.name;
        for (const c of opts.children) c.classList.toggle("on", c === b);
      };
      opts.appendChild(b);
    }
    const actions = document.createElement("div");
    actions.className = "merge-actions";
    const skip = Object.assign(document.createElement("button"), { className: "link", textContent: "Ce sont des artistes différents" });
    skip.onclick = () => {
      try {
        const ig = JSON.parse(localStorage.getItem("tf-merge-ignored") || "[]");
        ig.push(g.map((x) => x.name).sort().join("|"));
        localStorage.setItem("tf-merge-ignored", JSON.stringify(ig));
      } catch {}
      card.remove();
    };
    const go = Object.assign(document.createElement("button"), { className: "primary small", textContent: "Fusionner" });
    go.onclick = async () => {
      chosen = chosen.replace(/\s+/g, " ").trim();
      const paths = g.filter((a) => a.name !== chosen).flatMap((a) => a.tracks.map((t) => t.path));
      go.disabled = true;
      try {
        const n = await invoke("rename_artist", { paths, artist: chosen });
        toast(`${n} morceau${n > 1 ? "x" : ""} renommé${n > 1 ? "s" : ""} en « ${chosen} »`);
        card.remove();
        await loadLibrary(true);
      } catch (e) {
        toast(String(e), true);
        go.disabled = false;
      }
    };
    actions.append(skip, go);
    card.append(opts, actions);
    list.appendChild(card);
  }
  $("#merge").classList.remove("hidden");
}
$("#lib-artists").onclick = openMerge;
$("#merge-close").onclick = () => $("#merge").classList.add("hidden");
$("#merge").onclick = (e) => {
  if (e.target.id === "merge") $("#merge").classList.add("hidden");
};
document.addEventListener("keydown", (e) => e.key === "Escape" && $("#merge").classList.add("hidden"));

// ---------- Fond animé aux couleurs de la pochette ----------

/// Trois couleurs dominantes et vives d'une image (histogramme de teintes).
async function paletteOf(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, ch = max - min;
    if (ch < 0.08) continue;
    let h = max === r ? ((g - b) / ch) % 6 : max === g ? (b - r) / ch + 2 : (r - g) / ch + 4;
    h = (h * 60 + 360) % 360;
    const w = ch * (1 - Math.abs(2 * l - 1)) + 0.02;
    const bin = bins[Math.floor(h / 30) % 12];
    bin.w += w;
    bin.r += d[i] * w;
    bin.g += d[i + 1] * w;
    bin.b += d[i + 2] * w;
  }
  const top = bins.filter((x) => x.w > 0).sort((a, b) => b.w - a.w).slice(0, 3);
  const cols = top.map((x) => `rgb(${Math.round(x.r / x.w)}, ${Math.round(x.g / x.w)}, ${Math.round(x.b / x.w)})`);
  while (cols.length && cols.length < 3) cols.push(cols[cols.length - 1]);
  return cols;
}

async function setAmbient(url, t) {
  let cols = null;
  if (url) {
    try { cols = await paletteOf(url); } catch {}
  }
  if (current() !== t) return;
  if (!cols || !cols.length) {
    const h = hashHue(t.artist || t.title);
    cols = [`hsl(${h} 70% 55%)`, `hsl(${(h + 50) % 360} 70% 55%)`, `hsl(${(h + 300) % 360} 60% 50%)`];
  }
  const amb = $("#ambient");
  cols.forEach((c, i) => document.documentElement.style.setProperty(`--a${i + 1}`, c));
  amb.classList.add("live");
}

// ---------- Pulsation de la fenêtre au BPM ----------

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let pulseLevel = 0, pulseBass = 0, lastBeat = 0;
function pulseFrame() {
  const el = $("#pulse");
  if (!settings?.pulse || reduceMotion.matches || audio.paused || !beatInterval) {
    if (pulseLevel) el.style.opacity = pulseLevel = 0;
    return;
  }
  const b = bands(32);
  const bass = (b[1] + b[2] + b[3] + b[4]) / 4;
  pulseBass = pulseBass * 0.92 + bass * 0.08;
  const now = audio.currentTime;
  // Un battement = pic de basses, au plus une fois par demi-temps du BPM.
  if (bass > pulseBass * 1.12 && bass > 0.35 && (now - lastBeat > beatInterval * 0.55 || now < lastBeat)) {
    lastBeat = now;
    pulseLevel = Math.min(1, 0.45 + bass * 0.6);
  } else {
    pulseLevel *= Math.exp(-1 / (60 * beatInterval * 0.35));
  }
  el.style.opacity = pulseLevel.toFixed(3);
  document.documentElement.style.setProperty("--beat", (1 + pulseLevel * 0.06).toFixed(3));
}

// ---------- Sélection multiple (cases à cocher) ----------

const sel = { queue: new Set(), library: new Set() };
const selAnchor = { queue: null, library: null };
const selScope = () => (view === "queue" || view === "library" ? view : null);

/// Ordre affiché, pour la sélection au clic + Maj.
function orderedKeys(scope) {
  if (scope === "queue") return [...document.querySelectorAll("#queue .job")].map((el) => Number(el.id.slice(4)));
  return filteredLibrary().map((t) => t.path);
}

function toggleSel(scope, key, e) {
  const set = sel[scope];
  const anchor = selAnchor[scope];
  if (e?.shiftKey && anchor != null) {
    const keys = orderedKeys(scope);
    const a = keys.indexOf(anchor), b = keys.indexOf(key);
    if (a >= 0 && b >= 0) {
      const on = !set.has(key) || set.has(anchor);
      for (const k of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? set.add(k) : set.delete(k);
    }
  } else if (set.has(key)) set.delete(key);
  else set.add(key);
  selAnchor[scope] = key;
  refreshSel();
}

function makeCheck(scope, key) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "check";
  b.setAttribute("role", "checkbox");
  b.title = "Sélectionner";
  b.onclick = (e) => {
    e.stopPropagation();
    toggleSel(scope, key, e);
  };
  b.ondblclick = (e) => e.stopPropagation();
  return b;
}

function selectAll(scope, invert = false) {
  const keys = orderedKeys(scope);
  const set = sel[scope];
  if (invert) {
    for (const k of keys) set.has(k) ? set.delete(k) : set.add(k);
  } else keys.forEach((k) => set.add(k));
  refreshSel();
}

function clearSel(scope = selScope()) {
  if (!scope) return;
  sel[scope].clear();
  selAnchor[scope] = null;
  refreshSel();
}

function refreshSel() {
  // Oublie ce qui a disparu.
  for (const id of sel.queue) if (!jobs.has(id)) sel.queue.delete(id);
  if (libLoaded) {
    const paths = new Set(library.map((t) => t.path));
    for (const p of sel.library) if (!paths.has(p)) sel.library.delete(p);
  }
  document.querySelectorAll("#queue .job").forEach((el) => {
    const on = sel.queue.has(Number(el.id.slice(4)));
    el.classList.toggle("selected", on);
    el.querySelector(".check").setAttribute("aria-checked", on);
  });
  document.querySelectorAll("#lib-rows .lib-row, #lib-grid .tile").forEach((el) => {
    const on = sel.library.has(el.dataset.path);
    el.classList.toggle("selected", on);
    el.querySelector(".check")?.setAttribute("aria-checked", on);
  });
  const shown = libLoaded ? filteredLibrary().length : 0;
  const nLib = sel.library.size;
  $("#lib-check-all").setAttribute("aria-checked", nLib && nLib >= shown ? "true" : nLib ? "mixed" : "false");
  $("#queue").classList.toggle("selecting", sel.queue.size > 0);
  $("#lib-grid").classList.toggle("selecting", nLib > 0);
  renderSelBar();
}

function selectedJobs() {
  return [...sel.queue].map((id) => jobs.get(id)).filter(Boolean);
}
function selectedTracks() {
  return library.filter((t) => sel.library.has(t.path));
}

function selAction(label, icon, fn, cls = "") {
  const b = document.createElement("button");
  b.className = "sel-act " + cls;
  b.innerHTML = `<svg><use href="#${icon}"/></svg><span></span>`;
  b.querySelector("span").textContent = label;
  b.onclick = fn;
  return b;
}

function renderSelBar() {
  const scope = selScope();
  const n = scope ? sel[scope].size : 0;
  $("#selbar").classList.toggle("hidden", !n);
  if (!n) return;
  $("#sel-count").textContent = `${n} sélectionné${n > 1 ? "s" : ""}`;
  const box = $("#sel-actions");
  box.replaceChildren();
  if (scope === "queue") {
    const list = selectedJobs();
    const failed = list.filter((j) => j.status === "error");
    const done = list.filter((j) => j.status === "done" && j.path);
    if (failed.length) box.append(selAction(`Réessayer (${failed.length})`, "i-retry", () => failed.forEach((j) => invoke("retry_job", { id: j.id }))));
    if (done.length === 1) box.append(selAction("Dossier", "i-folder", () => T.opener.revealItemInDir(done[0].path)));
    const srcs = list.map(jobSourceUrl).filter(Boolean);
    if (srcs.length && srcs.length <= 5) box.append(selAction("Source", "i-external", () => srcs.forEach(openSource)));
    box.append(selAction("Retirer de la file", "i-x", async () => {
      await invoke("remove_jobs", { ids: list.map((j) => j.id) });
      clearSel("queue");
    }));
    if (done.length) box.append(selAction(`Corbeille (${done.length})`, "i-trash", () => trashPaths(done.map((j) => j.path)), "danger"));
  } else {
    const list = selectedTracks();
    box.append(selAction("Lire", "i-play", () => playList(list.map(libTrack), 0)));
    if (list.length === 1) box.append(selAction("Dossier", "i-folder", () => T.opener.revealItemInDir(list[0].path)));
    const srcs = list.map((t) => t.source).filter(Boolean);
    if (srcs.length && srcs.length <= 5) box.append(selAction("Source", "i-external", () => srcs.forEach(openSource)));
    box.append(selAction("Analyser BPM/clé", "i-sync", () => reanalyze(list)));
    box.append(selAction("Corbeille", "i-trash", () => trashPaths(list.map((t) => t.path)), "danger"));
  }
}

$("#sel-all").onclick = () => selectAll(selScope());
$("#btn-sel-queue").onclick = () => selectAll("queue");
$("#lib-select").onclick = () => (sel.library.size ? clearSel("library") : selectAll("library"));
$("#sel-invert").onclick = () => selectAll(selScope(), true);
$("#sel-close").onclick = () => clearSel();
$("#lib-check-all").onclick = () => (sel.library.size ? clearSel("library") : selectAll("library"));
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  const scope = selScope();
  if (!scope) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selectAll(scope);
  } else if (e.key === "Escape" && sel[scope].size) clearSel(scope);
  else if (e.key === "Delete" && sel[scope].size) {
    if (scope === "library") trashPaths(selectedTracks().map((t) => t.path));
    else invoke("remove_jobs", { ids: [...sel.queue] }).then(() => clearSel("queue"));
  }
});

// ---------- Source d'origine, dossier, corbeille ----------

function keyUrl(k) {
  if (!k) return null;
  const i = k.indexOf(":");
  if (i < 0) return null;
  const src = k.slice(0, i), id = k.slice(i + 1);
  if (id.startsWith("http")) return id;
  if (src === "youtube") return "https://www.youtube.com/watch?v=" + id;
  if (src === "spotify" && id.startsWith("spotify:track:")) return "https://open.spotify.com/track/" + id.slice(14);
  if (src === "soundcloud" && /^\d+$/.test(id)) return `https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/${id}&visual=true`;
  return null;
}
const jobSourceUrl = (j) => (j.source === "local" ? null : keyUrl(j.source_key) || (/^https?:/.test(j.url) ? j.url : null));
function openSource(url) {
  T.opener.openUrl(url).catch((e) => toast(String(e), true));
}

async function trashPaths(paths) {
  if (!paths.length) return;
  const n = paths.length;
  const ok = await T.dialog.ask(
    `Mettre ${n === 1 ? "ce morceau" : `ces ${n} morceaux`} à la corbeille ?\nTu pourras les récupérer depuis la corbeille de Windows.`,
    { title: "Supprimer du disque", kind: "warning", okLabel: "Mettre à la corbeille", cancelLabel: "Annuler" }
  );
  if (!ok) return;
  if (current() && paths.includes(current().path)) audio.pause();
  let gone;
  try {
    gone = new Set(await invoke("trash_files", { paths }));
    const k = gone.size;
    toast(`${k} morceau${k > 1 ? "x" : ""} mis à la corbeille` + (k < n ? `, ${n - k} impossible${n - k > 1 ? "s" : ""}` : ""), k < n);
  } catch (e) {
    return toast(String(e), true);
  }
  const ids = [...jobs.values()].filter((j) => j.path && gone.has(j.path)).map((j) => j.id);
  if (ids.length) await invoke("remove_jobs", { ids });
  library = library.filter((t) => !gone.has(t.path));
  for (const p of gone) sel.library.delete(p);
  if (libLoaded) {
    renderFolders();
    renderLibrary();
  }
  refreshSel();
}

// ---------- Menu clic droit ----------

function showCtx(e, items) {
  e.preventDefault();
  const m = $("#ctx");
  m.replaceChildren();
  for (const it of items) {
    if (!it) continue;
    if (it === "-") {
      m.appendChild(document.createElement("hr"));
      continue;
    }
    const b = document.createElement("button");
    b.className = it.danger ? "danger" : "";
    b.innerHTML = `<svg><use href="#${it.icon}"/></svg><span></span>`;
    b.querySelector("span").textContent = it.label;
    b.onclick = () => {
      hideCtx();
      it.run();
    };
    m.appendChild(b);
  }
  m.classList.remove("hidden");
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + "px";
}
const hideCtx = () => $("#ctx").classList.add("hidden");
// Pas de menu natif du navigateur (Précédent, Actualiser…) hors des champs de saisie.
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("input, textarea")) e.preventDefault();
});
document.addEventListener("click", hideCtx);
document.addEventListener("keydown", (e) => e.key === "Escape" && hideCtx());
window.addEventListener("blur", hideCtx);
$("main").addEventListener("scroll", hideCtx, true);

function trackMenu(e, t, list, i) {
  // Clic droit sur un morceau sélectionné : le menu agit sur toute la sélection.
  if (sel.library.has(t.path) && sel.library.size > 1) {
    const many = selectedTracks();
    return showCtx(e, [
      { label: `Lire les ${many.length} morceaux`, icon: "i-play", run: () => playList(many.map(libTrack), 0) },
      { label: `Exporter ${many.length} morceaux en CSV`, icon: "i-csv", run: () => exportCsv(many) },
      { label: `Réanalyser BPM et clé (${many.length})`, icon: "i-sync", run: () => reanalyze(many) },
      "-",
      { label: `Mettre ${many.length} morceaux à la corbeille`, icon: "i-trash", danger: true, run: () => trashPaths(many.map((x) => x.path)) },
    ]);
  }
  showCtx(e, [
    { label: "Lire", icon: "i-play", run: () => playList(list.map(libTrack), i) },
    { label: "Morceaux à enchaîner", icon: "i-mix", run: () => showSuggestions(libTrack(t)) },
    { label: "Charger sur la platine A", icon: "i-cue", run: () => (showView("dj"), loadDeck("A", t)) },
    { label: "Charger sur la platine B", icon: "i-cue", run: () => (showView("dj"), loadDeck("B", t)) },
    { label: notes.get(t.path) ? "Modifier la note" : "Ajouter une note", icon: "i-pen", run: () => editNote(t) },
    { label: t.bpm && t.key ? "Réanalyser BPM et clé" : "Analyser BPM et clé", icon: "i-sync", run: () => reanalyze([t]) },
    "-",
    { label: "Ouvrir le dossier", icon: "i-folder", run: () => T.opener.revealItemInDir(t.path) },
    t.source && { label: "Ouvrir la page d'origine", icon: "i-external", run: () => openSource(t.source) },
    { label: sel.library.has(t.path) ? "Désélectionner" : "Sélectionner", icon: "i-check", run: () => toggleSel("library", t.path) },
    "-",
    { label: "Mettre à la corbeille", icon: "i-trash", danger: true, run: () => trashPaths([t.path]) },
  ]);
}

// ---------- (Ré)analyse BPM et clé depuis la bibliothèque ----------
const reanalyzing = new Set();
async function reanalyze(tracks) {
  const paths = tracks.map((t) => t.path).filter((p) => !reanalyzing.has(p));
  if (!paths.length) return toast("Analyse déjà en cours");
  paths.forEach((p) => reanalyzing.add(p));
  try {
    await invoke("reanalyze", { paths });
    toast(paths.length > 1 ? `${paths.length} morceaux en cours d'analyse (BPM et clé)` : "Analyse du BPM et de la clé en cours");
  } catch (e) {
    paths.forEach((p) => reanalyzing.delete(p));
    toast(String(e), true);
  }
}
// Résultat d'une réanalyse : mis à jour tout de suite dans la bibliothèque.
function reanalyzed(job) {
  if (!job.path || !reanalyzing.has(job.path) || !["done", "error"].includes(job.status)) return;
  reanalyzing.delete(job.path);
  const t = library.find((x) => x.path === job.path);
  if (t && job.status === "done") {
    if (job.bpm) t.bpm = job.bpm.bpm;
    if (job.key) t.key = job.key.camelot;
    renderLibrary();
  }
}
$("#lib-analyze").onclick = () => {
  const list = sel.library.size ? selectedTracks() : filteredLibrary().filter((t) => !t.bpm || !t.key);
  if (!list.length) return toast("Tous les morceaux affichés ont déjà un BPM et une clé. Sélectionne ceux à réanalyser.");
  reanalyze(list);
};

// ---------- Compte Spotify ----------

let spotify = { connected: false, name: null };
function renderSpotify() {
  $("#sp-state").textContent = spotify.connected ? `Connecté${spotify.name ? " : " + spotify.name : ""}` : "Non connecté";
  $("#sp-login").textContent = spotify.connected ? "Se déconnecter" : "Se connecter";
  $("#sp-login").className = spotify.connected ? "ghost small" : "primary small";
  $("#btn-myplaylists").classList.toggle("hidden", !spotify.connected);
}
$("#sp-login").onclick = async () => {
  if (spotify.connected) {
    await invoke("spotify_logout");
    spotify = { connected: false, name: null };
    return renderSpotify();
  }
  const id = $("#s-spid").value.trim();
  if (id !== settings.spotify_client_id) await saveSettings({ spotify_client_id: id });
  const b = $("#sp-login");
  b.disabled = true;
  b.textContent = "Termine dans le navigateur…";
  try {
    spotify = await invoke("spotify_login");
    toast(`Connecté à Spotify${spotify.name ? " : " + spotify.name : ""}`);
  } catch (e) {
    toast(String(e), true);
  } finally {
    b.disabled = false;
    renderSpotify();
  }
};
$("#s-spid").onchange = (e) => saveSettings({ spotify_client_id: e.target.value.trim() });
$("#s-scuser").onchange = (e) => saveSettings({ soundcloud_user: e.target.value.trim() });
document.querySelector(".howto").onclick = (e) => {
  const a = e.target.closest("a[data-url]");
  if (!a) return;
  e.preventDefault();
  openSource(a.dataset.url);
};

async function openMyPlaylists() {
  const list = $("#mp-list");
  list.innerHTML = `<p class="muted">Chargement de tes playlists…</p>`;
  $("#myplaylists").classList.remove("hidden");
  let pls;
  try {
    pls = await invoke("spotify_playlists");
  } catch (e) {
    list.replaceChildren(Object.assign(document.createElement("p"), { className: "err-text", textContent: String(e) }));
    return;
  }
  list.replaceChildren();
  for (const p of pls) {
    const row = document.createElement("div");
    row.className = "mp-row";
    row.innerHTML = `<span class="mp-cover"><svg><use href="#i-note"/></svg><img alt=""/></span>
      <span class="mp-meta"><b></b><small></small></span>
      <button class="ghost small mp-follow" title="Télécharger puis récupérer les nouveautés automatiquement"><svg><use href="#i-eye"/></svg><span>Suivre</span></button>
      <button class="primary small mp-dl"><svg><use href="#i-arrow"/></svg><span>Télécharger</span></button>`;
    if (p.url.includes("/collection/")) row.querySelector(".mp-cover").classList.add("liked");
    if (p.image) setImg(row.querySelector("img"), p.image);
    row.querySelector("b").textContent = p.name;
    row.querySelector("small").textContent = [
      p.total != null ? `${p.total} titre${p.total > 1 ? "s" : ""}` : null,
      p.owner,
      p.readable ? null : "lien public uniquement",
    ].filter(Boolean).join(" · ");
    row.querySelector(".mp-dl").onclick = () => {
      $("#myplaylists").classList.add("hidden");
      addUrl(p.url);
    };
    row.querySelector(".mp-follow").onclick = async () => {
      $("#myplaylists").classList.add("hidden");
      try {
        const n = await invoke("watch_add", { url: p.url, downloadExisting: true });
        toast(n ? `Playlist suivie, ${n} morceaux en file` : "Playlist suivie");
        showView("watch");
      } catch (e) {
        toast(String(e), true);
      }
    };
    list.appendChild(row);
  }
}
$("#btn-myplaylists").onclick = openMyPlaylists;

// ---------- Mes likes : titres likés Spotify et SoundCloud, à télécharger au choix ----------

let likes = [];
let likedTracks = []; // titres likés ; `likes` = ce qui est affiché (likés ou une playlist)
let likesFrom = "likes";
const plTracks = new Map(); // lien de playlist → titres
let likesSrc = "all";
let likesShown = [];
const likesSel = new Set();
const normT = (x) =>
  (x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[([].*?[)\]]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// Déjà dans la bibliothèque : même titre (et même artiste quand on le connaît).
function likeOwned(x) {
  const t = normT(x.title), a = normT((x.artist || "").split(/,| & | feat/)[0]);
  return library.some((l) => normT(l.title) === t && (!a || !l.artist || normT(l.artist).includes(a) || a.includes(normT(l.artist))));
}

async function openLikes() {
  $("#likes").classList.remove("hidden");
  if (!libLoaded) loadLibrary();
  loadMyPlaylists();
  // Le cache d'abord (instantané), puis la liste à jour.
  if (!likedTracks.length) {
    const cached = await invoke("ext_tracks").catch(() => []);
    likedTracks = (cached || []).filter((x) => x.from === "Titres likés" || x.from === "Likes SoundCloud");
  }
  if (likesFrom === "likes") {
    likes = likedTracks;
    renderLikes("Mise à jour de tes likes…");
  }
  try {
    const r = await invoke("likes_fetch");
    likedTracks = r.tracks;
    if (likesFrom === "likes") (likes = likedTracks), renderLikes(r.errors.join(" · "));
  } catch (e) {
    if (likesFrom === "likes") renderLikes(String(e), true);
  }
}

let playlistsLoaded = false;
async function loadMyPlaylists() {
  if (playlistsLoaded) return;
  try {
    const r = await invoke("my_playlists");
    playlistsLoaded = true;
    const sel = $("#lk-from");
    for (const [src, label] of [["spotify", "Playlists Spotify"], ["soundcloud", "Playlists SoundCloud"]]) {
      const pls = r.items.filter((p) => p.source === src);
      if (!pls.length) continue;
      const g = document.createElement("optgroup");
      g.label = label;
      for (const p of pls) g.append(new Option(p.total != null ? `${p.name} (${p.total})` : p.name, p.url));
      sel.append(g);
    }
    if (r.errors.length) toast(r.errors.join(" · "), true);
  } catch {}
}

$("#lk-from").onchange = async (e) => {
  const url = e.target.value;
  likesFrom = url;
  likesSel.clear();
  $("#lk-src").classList.toggle("hidden", url !== "likes");
  if (url === "likes") {
    likes = likedTracks;
    return renderLikes("");
  }
  const name = e.target.selectedOptions[0].textContent.replace(/ \(\d+\)$/, "");
  likes = plTracks.get(url) || [];
  renderLikes("Lecture de la playlist…");
  try {
    const t = await invoke("playlist_tracks", { url, name });
    plTracks.set(url, t);
    if (likesFrom === url) (likes = t), renderLikes("");
  } catch (err) {
    if (likesFrom === url) renderLikes(String(err), true);
  }
};

function renderLikes(status = "", isErr = false) {
  const st = $("#lk-status");
  st.textContent = status;
  st.classList.toggle("err-text", isErr);
  for (const b of $("#lk-src").children) b.classList.toggle("on", b.dataset.v === likesSrc);
  const q = normT($("#lk-q").value);
  const onlyNew = $("#lk-new").checked;
  const rows = likes.filter(
    (x) => (likesFrom !== "likes" || likesSrc === "all" || x.source === likesSrc) && (!q || normT(x.title + " " + x.artist).includes(q)) && !(onlyNew && likeOwned(x))
  );
  likesShown = rows.slice(0, 500);
  const ul = $("#lk-list");
  ul.replaceChildren();
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "muted lk-empty";
    const noSc = likesFrom === "likes" && likesSrc === "soundcloud" && !(settings?.soundcloud_user || "").trim();
    li.textContent = noSc
      ? "Indique ton profil SoundCloud dans Réglages › Profil SoundCloud pour voir tes likes."
      : likes.length ? "Aucun titre ne correspond." : status ? "" : likesFrom === "likes" ? "Aucun like trouvé." : "Playlist vide.";
    ul.append(li);
  }
  const frag = document.createDocumentFragment();
  for (const x of rows.slice(0, 500)) {
    const li = document.createElement("li");
    const owned = likeOwned(x);
    li.className = "lk-row" + (owned ? " owned" : "");
    li.dataset.id = x.id;
    li.innerHTML = `<input type="checkbox" />
      <button class="icon sm lk-play" title="Écouter un extrait (30 s)"><svg><use href="#i-play"/></svg></button>
      <span class="mp-cover"><svg><use href="#i-note"/></svg><img alt=""/></span>
      <span class="mp-meta"><b></b><small></small></span>
      <svg class="lk-src"><use href="#i-${x.source === "soundcloud" ? "soundcloud" : "spotify"}"/></svg>
      <button class="ghost small"><svg><use href="#i-arrow"/></svg><span>Télécharger</span></button>`;
    li.querySelector("b").textContent = x.title;
    li.querySelector("small").textContent = [x.artist, x.bpm && Math.round(x.bpm) + " BPM", x.key, owned && "déjà dans ta bibliothèque"].filter(Boolean).join(" · ");
    if (x.cover) setImg(li.querySelector("img"), x.cover);
    const cb = li.querySelector("input");
    cb.checked = likesSel.has(x.id);
    cb.onchange = () => {
      cb.checked ? likesSel.add(x.id) : likesSel.delete(x.id);
      likesCount();
    };
    li.querySelector("button:not(.lk-play)").onclick = () => downloadLikes([x]);
    li.querySelector(".lk-play").onclick = () => likePreview(x);
    if (lkPlaying?.id === x.id) li.classList.add(lkPlaying.loading ? "loading" : "playing");
    frag.append(li);
  }
  ul.append(frag);
  if (rows.length > 500) {
    const li = document.createElement("li");
    li.className = "muted small lk-empty";
    li.textContent = `${rows.length - 500} autres : affine la recherche.`;
    ul.append(li);
  }
  likesCount(rows.length);
}

function likesCount(shown) {
  const n = likesSel.size;
  $("#lk-dl").disabled = !n;
  $("#lk-dl span").textContent = n ? `Télécharger la sélection (${n})` : "Télécharger la sélection";
  if (shown != null) $("#lk-count").textContent = `${shown} titre${shown > 1 ? "s" : ""}`;
}

// Aperçu : extrait Deezer, sinon 30 s du milieu (SoundCloud ou YouTube), préparé par l'app.
const lkAudio = new Audio();
let lkPlaying = null;
function lkMark() {
  for (const li of document.querySelectorAll("#lk-list .lk-row")) {
    const on = lkPlaying?.id === li.dataset.id;
    li.classList.toggle("loading", on && lkPlaying.loading);
    li.classList.toggle("playing", on && !lkPlaying.loading);
    li.querySelector(".lk-play use").setAttribute("href", on && !lkPlaying.loading ? "#i-pause" : "#i-play");
  }
}
function stopLikePreview() {
  lkAudio.pause();
  if (lkAudio.src) URL.revokeObjectURL(lkAudio.src);
  lkAudio.removeAttribute("src");
  lkPlaying = null;
  lkMark();
}
lkAudio.onended = stopLikePreview;
async function likePreview(x) {
  if (lkPlaying?.id === x.id) return stopLikePreview();
  stopLikePreview();
  const me = (lkPlaying = { id: x.id, loading: true });
  lkMark();
  try {
    const bytes = await invoke("like_preview", { track: x });
    if (lkPlaying !== me) return;
    const ab = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
    if (typeof audio !== "undefined" && !audio.paused) audio.pause();
    lkAudio.src = URL.createObjectURL(new Blob([ab], { type: "audio/mpeg" }));
    await lkAudio.play();
    me.loading = false;
    lkMark();
  } catch (e) {
    if (lkPlaying === me) stopLikePreview();
    toast(String(e), true);
  }
}

async function downloadLikes(list, force = false) {
  try {
    const r = await invoke("likes_download", { tracks: list, force });
    if (r.skipped && !r.added) {
      const what = r.skipped === 1 ? `« ${r.skipped_titles[0] || list[0].title} » est déjà dans ta bibliothèque` : `Ces ${r.skipped} titres sont déjà dans ta bibliothèque`;
      return toastAction(what, "Télécharger quand même", () => downloadLikes(list, true));
    }
    toast(`${r.added} titre${r.added > 1 ? "s" : ""} en file${r.skipped ? `, ${r.skipped} déjà présent${r.skipped > 1 ? "s" : ""}` : ""}`);
    for (const x of list) likesSel.delete(x.id);
    likesCount();
    renderLikes($("#lk-status").textContent);
  } catch (e) {
    toast(String(e), true);
  }
}

$("#btn-likes").onclick = openLikes;
const closeLikes = () => {
  $("#likes").classList.add("hidden");
  stopLikePreview();
};
$("#lk-close").onclick = closeLikes;
// (Corps entre accolades : un « false » renvoyé par onclick annulerait le clic sur les cases.)
$("#likes").onclick = (e) => {
  if (e.target.id === "likes") closeLikes();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#likes").classList.contains("hidden")) closeLikes();
});
$("#lk-src").onclick = (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (v) (likesSrc = v), renderLikes($("#lk-status").textContent);
};
$("#lk-q").oninput = () => renderLikes($("#lk-status").textContent);
$("#lk-new").onchange = () => renderLikes($("#lk-status").textContent);
$("#lk-all").onclick = () => {
  const shown = likesShown;
  const all = shown.every((x) => likesSel.has(x.id));
  for (const x of shown) all ? likesSel.delete(x.id) : likesSel.add(x.id);
  renderLikes($("#lk-status").textContent);
};
$("#lk-dl").onclick = () => downloadLikes(likes.filter((x) => likesSel.has(x.id)));
$("#mp-close").onclick = () => $("#myplaylists").classList.add("hidden");
$("#myplaylists").onclick = (e) => {
  if (e.target.id === "myplaylists") $("#myplaylists").classList.add("hidden");
};
document.addEventListener("keydown", (e) => e.key === "Escape" && $("#myplaylists").classList.add("hidden"));

// ---------- Démarrage ----------

(async () => {
  const snap = await invoke("get_state");
  settings = snap.settings;
  fillSettings();
  $("#s-spid").value = settings.spotify_client_id || "";
  $("#s-scuser").value = settings.soundcloud_user || "";
  invoke("spotify_status").then((s) => ((spotify = s), renderSpotify()));
  showTools(snap.tools);
  snap.jobs.forEach(render);
  renderWatched(snap.watched);
  updateCount();
  if (!snap.jobs.length) showView("library");

  await listen("job", (e) => (render(e.payload), reanalyzed(e.payload)));
  await listen("job-removed", (e) => {
    jobs.delete(e.payload);
    document.getElementById("job-" + e.payload)?.remove();
    updateCount();
    if (sel.queue.delete(e.payload)) refreshSel();
  });
  await listen("watched", (e) => renderWatched(e.payload));
  await listen("clipboard-link", (e) => showClipboard(e.payload));
  await listen("tools-progress", (e) => {
    $("#setup-bar i").style.width = Math.round(e.payload.progress * 100) + "%";
    $("#setup-text").textContent = e.payload.message;
  });
  $("#url").focus();
})();

// ---------- Mises à jour automatiques ----------

let updateOffered = null;
async function checkUpdate(manual = false) {
  try {
    const u = await invoke("update_check");
    $("#s-version").textContent = `Version ${u.current}` + (u.version ? ` · ${u.version} disponible` : " · à jour");
    if (!u.version) return manual && toast("TrackFetcher est à jour");
    if (!manual && updateOffered === u.version) return;
    updateOffered = u.version;
    offerUpdate(u.version);
  } catch (e) {
    if (manual) toast(String(e), true);
  }
}
function offerUpdate(v) {
  const el = document.createElement("div");
  el.className = "toast";
  el.style.cssText = "display:flex;align-items:center;gap:12px";
  const span = document.createElement("span");
  span.textContent = `TrackFetcher ${v} est disponible.`;
  const go = document.createElement("button");
  go.className = "link";
  go.style.cssText = "color:var(--accent);font-weight:600";
  go.textContent = "Installer et redémarrer";
  const later = document.createElement("button");
  later.className = "link";
  later.textContent = "Plus tard";
  later.onclick = () => el.remove();
  go.onclick = async () => {
    go.disabled = later.disabled = true;
    span.textContent = "Téléchargement de la mise à jour…";
    const off = await listen("update-progress", (e) => (span.textContent = `Téléchargement de la mise à jour… ${e.payload} %`));
    try {
      await invoke("update_install");
    } catch (e) {
      off();
      el.remove();
      toast(String(e), true);
    }
  };
  el.append(span, go, later);
  $("#toasts").appendChild(el);
}
$("#s-update-check").onclick = () => checkUpdate(true);
setTimeout(() => {
  invoke("update_check").then((u) => ($("#s-version").textContent = `Version ${u.current}`)).catch(() => {});
  if (settings?.auto_update) checkUpdate(false);
}, 6000);
setInterval(() => settings?.auto_update && checkUpdate(false), 6 * 3600 * 1000);

// ---------- Sauvegarde et restauration ----------

const UI_KEYS = ["tf-dj", "tf-gps", "tf-gps-opts", "tf-help-dj", "tf-theme", "tf-volume", "tf-viz", "tf-bpm", "tf-libmode", "tf-merge-ignored", "tf-ui"];
$("#s-backup").onclick = async () => {
  const d = new Date();
  const name = `TrackFetcher-sauvegarde-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.json`;
  const path = await T.dialog.save({ defaultPath: name, filters: [{ name: "Sauvegarde TrackFetcher", extensions: ["json"] }] });
  if (!path) return;
  const ui = {};
  for (const k of UI_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v != null) ui[k] = v;
    } catch {}
  }
  try {
    await invoke("backup_export", { path, ui });
    toast("Sauvegarde enregistrée");
  } catch (e) {
    toast(String(e), true);
  }
};
$("#s-restore").onclick = async () => {
  const path = await T.dialog.open({ multiple: false, filters: [{ name: "Sauvegarde TrackFetcher", extensions: ["json"] }] });
  if (!path) return;
  const ok = await T.dialog.ask("Tes réglages, notes, paires et grilles actuels seront remplacés par ceux de la sauvegarde, puis TrackFetcher redémarrera.", {
    title: "Restaurer une sauvegarde",
    kind: "warning",
    okLabel: "Restaurer",
    cancelLabel: "Annuler",
  });
  if (!ok) return;
  try {
    const ui = await invoke("backup_import", { path: typeof path === "string" ? path : path.path });
    for (const [k, v] of Object.entries(ui || {}))
      if (UI_KEYS.includes(k) && typeof v === "string")
        try {
          localStorage.setItem(k, v);
        } catch {}
    await invoke("app_restart");
  } catch (e) {
    toast(String(e), true);
  }
};

// ---------- Tester mes sources ----------

async function runDiag() {
  $("#diag").classList.remove("hidden");
  const ul = $("#dg-list");
  ul.innerHTML = `<li><span class="wait">…</span><span>Test en cours</span><span class="muted">YouTube, SoundCloud, Spotify, Deezer… (jusqu'à une minute)</span></li>`;
  $("#dg-report").value = "";
  $("#dg-again").disabled = true;
  try {
    const r = await invoke("diagnose");
    ul.replaceChildren();
    for (const c of r.checks) {
      const li = document.createElement("li");
      const mark = document.createElement("span");
      mark.className = c.ok === true ? "ok" : c.ok === false ? "ko" : "skip";
      mark.textContent = c.ok === true ? "✓" : c.ok === false ? "✗" : "—";
      const n = document.createElement("b");
      n.textContent = c.name;
      const d = document.createElement("span");
      d.textContent = c.detail;
      li.append(mark, n, d);
      ul.append(li);
    }
    $("#dg-report").value = r.report;
  } catch (e) {
    ul.innerHTML = "";
    $("#dg-report").value = String(e);
  } finally {
    $("#dg-again").disabled = false;
  }
}
$("#s-diag").onclick = runDiag;
$("#dg-again").onclick = runDiag;
$("#dg-close").onclick = () => $("#diag").classList.add("hidden");
$("#dg-copy").onclick = async () => {
  const ta = $("#dg-report");
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch {
    ta.select();
    document.execCommand("copy");
  }
  toast("Rapport copié");
};

// ---------- Aide ----------

function showHelp(page = "dl") {
  $("#help").classList.remove("hidden");
  for (const b of $("#hp-tabs").children) b.classList.toggle("on", b.dataset.v === page);
  for (const p of document.querySelectorAll(".hp-page")) p.classList.toggle("hidden", p.dataset.p !== page);
}
$("#hp-tabs").onclick = (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (v) showHelp(v);
};
$("#btn-help").onclick = () => showHelp(view === "dj" ? "dj" : view === "library" ? "lib" : "dl");
$("#s-help").onclick = () => showHelp();
$("#hp-close").onclick = () => $("#help").classList.add("hidden");
for (const id of ["help", "diag"])
  $("#" + id).addEventListener("click", (e) => {
    if (e.target.id === id) $("#" + id).classList.add("hidden");
  });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") for (const id of ["help", "diag"]) $("#" + id).classList.add("hidden");
});
// Première visite de l'onglet DJ : la prise en main s'ouvre une fois.
function helpOnFirstDj() {
  try {
    if (localStorage.getItem("tf-help-dj")) return;
    localStorage.setItem("tf-help-dj", "1");
  } catch {
    return;
  }
  showHelp("dj");
}
