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

function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3500);
}

const fmt = (b) => (Number.isInteger(b) ? String(b) : b.toFixed(1));

// ---------- Rendu d'un job ----------

function render(job) {
  jobs.set(job.id, job);
  let el = document.getElementById("job-" + job.id);
  if (!el) {
    el = $("#tpl-job").content.firstElementChild.cloneNode(true);
    el.id = "job-" + job.id;
    el.querySelector(".act-remove").onclick = () => invoke("remove_job", { id: job.id });
    el.querySelector(".act-retry").onclick = () => invoke("retry_job", { id: job.id });
    el.querySelector(".act-reveal").onclick = () => {
      const j = jobs.get(job.id);
      if (j.path) T.opener.revealItemInDir(j.path);
    };
    el.querySelector(".bpm").onclick = () => editBpm(job.id);
    $("#queue").prepend(el);
  }
  el.dataset.status = job.status;
  el.dataset.source = job.source;

  const img = el.querySelector(".cover img");
  if (job.cover && img.getAttribute("src") !== job.cover) {
    img.onerror = () => img.removeAttribute("src");
    img.src = job.cover;
  }
  el.querySelector(".title").textContent = job.title || job.url || "Piste";
  const icon = { local: "#i-file", other: "#i-link" }[job.source] || "#i-" + job.source;
  el.querySelector(".src use").setAttribute("href", icon);
  el.querySelector(".artist").textContent =
    [job.artist, job.album].filter(Boolean).join(" · ") || (job.source === "local" ? "Fichier local" : "");

  let status = STATUS[job.status] || job.status;
  if (job.status === "downloading" && job.progress > 0) status += ` ${Math.round(job.progress * 100)} %`;
  if (job.status === "error") status = job.error || status;
  el.querySelector(".status").textContent = status;
  el.querySelector(".status").title = status;

  const bar = el.querySelector(".state .bar");
  const determinate = job.status === "downloading" && job.progress > 0;
  bar.classList.toggle("indeterminate", !determinate && !["queued", "done", "error"].includes(job.status));
  bar.querySelector("i").style.width = determinate ? job.progress * 100 + "%" : "";

  renderBpm(el.querySelector(".bpm"), job);
  updateCount();
}

function renderBpm(box, job) {
  if (box.querySelector("input")) return; // édition en cours
  const r = job.bpm;
  box.classList.toggle("has", !!r);
  box.dataset.verdict = r ? r.verdict : "";
  box.querySelector(".value").innerHTML = r ? `${fmt(r.bpm)}<small>BPM</small>` : "";
  box.querySelector(".verdict").textContent = r ? VERDICT[r.verdict] : "";
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
  const finished = [...jobs.values()].some((j) => j.status === "done");
  $("#btn-clear").classList.toggle("hidden", !finished);
}

// ---------- Ajout ----------

$("#url").addEventListener("input", (e) => {
  $("#src-icon").dataset.src = detect(e.target.value);
  $("#src-icon use").setAttribute("href", detect(e.target.value) ? "#i-" + detect(e.target.value) : "#i-link");
});

$("#omnibox").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("#url").value.trim();
  if (!url) return $("#url").focus();
  const box = $("#omnibox");
  box.classList.add("busy");
  try {
    const n = await invoke("add_url", { url });
    $("#url").value = "";
    $("#url").dispatchEvent(new Event("input"));
    if (n > 1) toast(`${n} pistes ajoutées`);
  } catch (err) {
    toast(String(err), true);
  } finally {
    box.classList.remove("busy");
  }
});

async function addFiles(paths) {
  const n = await invoke("add_files", { paths });
  if (!n) toast("Aucun fichier MP3 dans la sélection", true);
}

$("#btn-files").onclick = async () => {
  const picked = await T.dialog.open({ multiple: true, filters: [{ name: "MP3", extensions: ["mp3"] }] });
  if (picked && picked.length) addFiles(Array.isArray(picked) ? picked : [picked]);
};
$("#btn-folder").onclick = () => settings && T.opener.openPath(settings.output_dir);
$("#btn-clear").onclick = () => invoke("clear_finished");

// ---------- Réglages ----------

function fillSettings() {
  $("#s-dir").value = settings.output_dir;
  $("#s-key").value = settings.getsongbpm_key;
  $("#s-verify").checked = settings.verify_online;
  $("#s-bpmname").checked = settings.bpm_in_filename;
  for (const b of $("#s-quality").children) b.classList.toggle("on", b.dataset.v === settings.quality);
  for (const b of $("#s-parallel").children) b.classList.toggle("on", Number(b.dataset.v) === settings.parallel);
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
  if (dir) saveSettings({ output_dir: dir });
};
$("#s-quality").onclick = (e) => e.target.dataset.v && saveSettings({ quality: e.target.dataset.v });
$("#s-parallel").onclick = (e) => e.target.dataset.v && saveSettings({ parallel: Number(e.target.dataset.v) });
$("#s-verify").onchange = (e) => saveSettings({ verify_online: e.target.checked });
$("#s-bpmname").onchange = (e) => saveSettings({ bpm_in_filename: e.target.checked });
$("#s-key").onchange = (e) => saveSettings({ getsongbpm_key: e.target.value.trim() });

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
  updateCount();

  await listen("job", (e) => render(e.payload));
  await listen("job-removed", (e) => {
    jobs.delete(e.payload);
    document.getElementById("job-" + e.payload)?.remove();
    updateCount();
  });
  await listen("tools-progress", (e) => {
    $("#setup-bar i").style.width = Math.round(e.payload.progress * 100) + "%";
    $("#setup-text").textContent = e.payload.message;
  });

  // Glisser-déposer de MP3 sur la fenêtre.
  if (T.webview) {
    T.webview.getCurrentWebview().onDragDropEvent((e) => {
      const t = e.payload.type;
      document.body.classList.toggle("drop-hint", t === "enter" || t === "over");
      if (t === "drop" && e.payload.paths?.length) addFiles(e.payload.paths);
    });
  }
  $("#url").focus();
})();
