"use strict";
// Cast vers la télé (DLNA) : la télé joue le morceau du lecteur, le PC reste
// la télécommande (lecture, pause, avance, suivant). Le lecteur local continue
// en silence pour garder la position et le visualiseur ; la télécommande de
// la télé agit aussi dans l'autre sens.

(() => {
const btn = $("#p-cast");
let tv = null; // télé en cours de cast
let castPath = null; // morceau envoyé à la télé
let busy = false;
let lastTv = null;
try { lastTv = JSON.parse(localStorage.getItem("tf-cast") || "null"); } catch {}

const on = () => window.ux?.get("cast") !== false;
function refresh() {
  btn.classList.toggle("hidden", !on());
  btn.classList.toggle("active", !!tv);
  btn.title = tv ? `Sur « ${tv.name} » : clic pour arrêter` : "Caster sur la télé";
  document.body.classList.toggle("casting", !!tv);
  $("#p-artist").dataset.cast = tv ? `📺 ${tv.name}` : "";
  if (!on() && tv) stopCast();
}

function mute(m) {
  ensureAudioGraph();
  if (outGain) outGain.gain.value = m ? 0 : 1;
}

const ctl = (action, at) => tv && invoke("cast_control", { control: tv.control, action, at }).catch((e) => toast(String(e), true));

async function sendCurrent() {
  const t = current();
  if (!tv || !t) return;
  castPath = t.path;
  try {
    await invoke("cast_play", {
      control: tv.control,
      path: t.path,
      title: t.title || "Sans titre",
      artist: t.artist || "",
      duration: Number.isFinite(audio.duration) ? audio.duration : null,
      start: audio.currentTime > 1 ? audio.currentTime : null,
    });
    if (audio.paused) ctl("pause");
  } catch (e) {
    toast(String(e), true);
  }
}

async function startCast(target) {
  tv = target;
  lastTv = target;
  try { localStorage.setItem("tf-cast", JSON.stringify(target)); } catch {}
  mute(true);
  refresh();
  toast(`📺 Lecture sur « ${tv.name} »`);
  if (current()) await sendCurrent();
}

function stopCast() {
  if (!tv) return;
  ctl("stop");
  tv = null;
  castPath = null;
  mute(false);
  refresh();
  toast("Cast arrêté : la musique revient sur le PC");
}

btn.onclick = async (e) => {
  e.stopPropagation();
  hideCtx();
  const at = { clientX: e.clientX, clientY: e.clientY, preventDefault() {} };
  if (tv) return showCtx(at, [{ label: `Arrêter le cast sur « ${tv.name} »`, icon: "i-x", run: stopCast }]);
  if (busy) return;
  busy = true;
  btn.classList.add("searching");
  const found = await invoke("cast_discover").catch(() => []);
  busy = false;
  btn.classList.remove("searching");
  if (!found.length) {
    const items = [{ label: "Aucune télé trouvée : réessayer", icon: "i-retry", run: () => btn.click() }];
    if (lastTv) items.push({ label: `Essayer « ${lastTv.name} » quand même`, icon: "i-cast", run: () => startCast(lastTv) });
    toast("Aucune télé trouvée. Vérifie qu'elle est allumée, sur le même Wi-Fi, et autorise TrackFetcher dans le pare-feu Windows si on te le demande.", true);
    return showCtx(at, items);
  }
  showCtx(at, found.map((x) => ({ label: x.model ? `${x.name} (${x.model})` : x.name, icon: "i-cast", run: () => startCast(x) })));
};

// Le lecteur pilote la télé.
audio.addEventListener("loadedmetadata", () => tv && current()?.path !== castPath && sendCurrent());
audio.addEventListener("play", () => {
  if (!tv) return;
  mute(true);
  if (current()?.path === castPath) ctl("play");
});
audio.addEventListener("pause", () => tv && !audio.ended && ctl("pause"));
audio.addEventListener("seeked", () => tv && current()?.path === castPath && !syncing && ctl("seek", audio.currentTime));

// La télé (sa télécommande) pilote le lecteur, et le lecteur suit sa position.
let syncing = false;
setInterval(async () => {
  if (!tv || !castPath || busy) return;
  let s;
  try {
    s = await invoke("cast_status", { control: tv.control });
  } catch {
    return;
  }
  if (!tv || current()?.path !== castPath) return;
  if (s.state === "PAUSED_PLAYBACK" && !audio.paused) audio.pause();
  else if (s.state === "PLAYING" && audio.paused && !audio.ended) play();
  if (s.state === "PLAYING" && s.position != null && Math.abs(s.position - audio.currentTime) > 2) {
    syncing = true;
    audio.currentTime = s.position;
    setTimeout(() => (syncing = false), 300);
  }
}, 3000);

window.castUi = { refresh };
refresh();
})();
