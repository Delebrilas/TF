try {
  const t = localStorage.getItem("tf-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  if (t === "time") {
    const h = new Date().getHours();
    document.documentElement.dataset.theme = h >= 8 && h < 19 ? "light" : "dark";
    if (h >= 22 || h < 6) document.documentElement.dataset.night = "";
  }
} catch {}
