"use strict";

const T = window.__TAURI__ || window.__TF_MOCK__;
const invoke = T.core.invoke;
const listen = T.event.listen;

const $ = (s) => document.querySelector(s);
const jobs = new Map();
let settings = null;

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
const isCollection = (u) => /\/playlist|\/album\/|spotify:album:|spotify:playlist:|\/sets\/|list=/i.test(u);

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
    el.querySelector(".bpm").onclick = () => editBpm(job.id);
    $("#queue").prepend(el);
  }
  el.dataset.status = job.status;
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
  const active = all.filter((j) => !["done", "error"].includes(j.status)).length;
  $("#badge-queue").textContent = active || "";
}

function renderPause() {
  $("#btn-pause").textContent = settings.paused ? "Reprendre" : "Mettre en pause";
  jobs.forEach((j) => j.status === "queued" && render(j));
}
$("#btn-pause").onclick = () => saveSettings({ paused: !settings.paused }).then(renderPause);

// ---------- Ajout ----------

function onUrlInput() {
  const v = $("#url").value;
  const src = detect(v);
  $("#src-icon").dataset.src = src;
  $("#src-icon use").setAttribute("href", src ? "#i-" + src : "#i-link");
  $("#follow-wrap").classList.toggle("hidden", !(src && isCollection(v)));
  $("#follow-menu").classList.remove("open");
}
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
  addUrl(url);
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
  let list = library.filter((t) =>
    inFolder(t, libFolder) &&
    (!q || [t.title, t.artist, t.album, t.genre, t.bpm && String(Math.round(t.bpm))].some((v) => v && String(v).toLowerCase().includes(q)))
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
  $("#lib-table").classList.toggle("hidden", list.length === 0);
  $("#lib-dir").textContent = libDesc ? "↑" : "↓";
  for (const b of document.querySelectorAll(".lib-header button")) b.classList.toggle("on", b.dataset.sort === $("#lib-sort").value);
  const frag = document.createDocumentFragment();
  list.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "lib-row";
    row.dataset.path = t.path;
    row.innerHTML = `
      <div class="l-idx"><svg><use href="#i-note"/></svg><img alt=""/><span class="cover-play"><svg><use href="#i-play"/></svg></span></div>
      <div class="l-main"><div class="l-title"></div><div class="l-artist"></div></div>
      <div class="l-album"></div><div class="l-genre"></div><div class="l-key"></div><div class="l-bpm"></div>`;
    if (t.key) row.querySelector(".l-key").appendChild(keyPill(t.key));
    row.oncontextmenu = (e) => {
      e.preventDefault();
      showSuggestions(libTrack(t));
    };
    row.querySelector(".l-title").textContent = t.title;
    row.querySelector(".l-artist").textContent = t.artist || "";
    row.querySelector(".l-album").textContent = t.album || "";
    row.querySelector(".l-genre").textContent = t.genre || "";
    row.querySelector(".l-bpm").textContent = t.bpm ? fmt(Math.round(t.bpm * 10) / 10) : "–";
    const idx = row.querySelector(".l-idx");
    idx.dataset.path = t.path;
    if (t.has_cover) coverObserver.observe(idx);
    row.ondblclick = () => playList(list.map(libTrack), i);
    row.querySelector(".cover-play").onclick = () => {
      if (current()?.path === t.path) togglePlay();
      else playList(list.map(libTrack), i);
    };
    frag.appendChild(row);
  });
  rows.appendChild(frag);
  markPlaying();
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
  document.querySelectorAll("#lib-rows .lib-row").forEach((el) => {
    const on = !!t && el.dataset.path === t.path;
    el.classList.toggle("playing", on);
    el.querySelector(".cover-play use").setAttribute("href", on && path ? "#i-pause" : "#i-play");
  });
}

// ---------- Visualiseur ----------

let actx = null;
let analyser = null;
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
    analyser.connect(actx.destination);
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
$("#np-modes").onclick = (e) => e.target.dataset.mode && setVizMode(e.target.dataset.mode);
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
drawer.onclick = (e) => e.target === drawer && drawer.classList.remove("open");
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
const isDark = () => (theme === "system" ? darkQuery.matches : theme === "dark");
function applyTheme(t) {
  theme = t;
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { localStorage.setItem("tf-theme", t); } catch {}
  for (const b of $("#s-theme").children) b.classList.toggle("on", b.dataset.v === t);
  $("#btn-theme use").setAttribute("href", isDark() ? "#i-sun" : "#i-moon");
  $("#btn-theme").title = isDark() ? "Passer en mode clair" : "Passer en mode sombre";
}
$("#s-theme").onclick = (e) => e.target.dataset.v && applyTheme(e.target.dataset.v);
$("#btn-theme").onclick = () => applyTheme(isDark() ? "light" : "dark");
darkQuery.addEventListener("change", () => applyTheme(theme));
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

// ---------- Démarrage ----------

(async () => {
  const snap = await invoke("get_state");
  settings = snap.settings;
  fillSettings();
  showTools(snap.tools);
  snap.jobs.forEach(render);
  renderWatched(snap.watched);
  updateCount();

  await listen("job", (e) => render(e.payload));
  await listen("job-removed", (e) => {
    jobs.delete(e.payload);
    document.getElementById("job-" + e.payload)?.remove();
    updateCount();
  });
  await listen("watched", (e) => renderWatched(e.payload));
  await listen("clipboard-link", (e) => showClipboard(e.payload));
  await listen("tools-progress", (e) => {
    $("#setup-bar i").style.width = Math.round(e.payload.progress * 100) + "%";
    $("#setup-text").textContent = e.payload.message;
  });
  $("#url").focus();
})();
