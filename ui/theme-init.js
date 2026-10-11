try { const t = localStorage.getItem("tf-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}
