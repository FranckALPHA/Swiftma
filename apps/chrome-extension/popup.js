const btnVisible = document.querySelector("#capture-visible");
const btnFull = document.querySelector("#capture-full");
const btnSite = document.querySelector("#capture-site");
const btnInspect = document.querySelector("#inspect-element");
const btnStop = document.querySelector("#stop-capture");
const status = document.querySelector("#status");

const setBusy = (busy) => {
  if (btnVisible) btnVisible.disabled = busy;
  if (btnFull) btnFull.disabled = busy;
  if (btnSite) btnSite.disabled = busy;
  if (btnInspect) btnInspect.disabled = busy;
};

/** Tailles d'écran proposées par la capture responsive (points CSS, comme dans Swiftma). */
const BREAKPOINT_HEIGHTS = { 390: 844, 768: 1024, 1280: 800, 1536: 900 };
const BREAKPOINT_LABELS = { 390: "Mobile", 768: "Tablette", 1280: "Laptop", 1536: "Bureau" };

/** Largeurs cochées dans le panneau, triées de la plus étroite à la plus large. */
function readBreakpoints() {
  const out = [];
  for (const input of document.querySelectorAll(".bp:checked")) {
    const width = Number(input.value);
    if (!(width >= 240 && width <= 4096)) continue;
    out.push({ width, height: BREAKPOINT_HEIGHTS[width] || 900, label: BREAKPOINT_LABELS[width] || `Écran ${width}` });
  }
  const customOn = document.querySelector("#bp-custom-on");
  const custom = document.querySelector("#bp-custom");
  if (customOn?.checked) {
    const width = Math.round(Number(custom?.value));
    if (width >= 240 && width <= 4096 && !out.some((b) => b.width === width)) {
      out.push({ width, height: BREAKPOINT_HEIGHTS[width] || 900, label: BREAKPOINT_LABELS[width] || `Écran ${width}` });
    }
  }
  return out.sort((a, b) => a.width - b.width);
}

/**
 * Émule une taille d'écran dans l'onglet actif (CDP), le temps d'une capture.
 * Les media queries et les unités relatives se recalculent donc comme sur un vrai appareil,
 * sans redimensionner la fenêtre de l'utilisateur.
 */
async function withViewport(tabId, width, height, run) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (error) {
    throw new Error(
      "Émulation d'écran impossible : ferme les DevTools de cet onglet puis réessaie." +
        (error instanceof Error && error.message ? ` (${error.message})` : "")
    );
  }
  try {
    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      screenWidth: width,
      screenHeight: height,
      deviceScaleFactor: 1,
      mobile: width <= 480,
    });
    // Laisse le navigateur rejouer la mise en page (ResizeObserver, images responsive…).
    await new Promise((resolve) => setTimeout(resolve, 450));
    return await run();
  } finally {
    try {
      await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride");
    } catch {}
    try {
      await chrome.debugger.detach(target);
    } catch {}
  }
}

async function downloadAsDataUrl(url) {
  try {
    let fetchUrl = url;
    try {
      const u = new URL(url);
      if (u.searchParams.get("fm") === "avif") {
        u.searchParams.set("fm", "png");
        fetchUrl = u.toString();
      }
    } catch {}

    const res = await fetch(fetchUrl);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result === "string" && result.startsWith("data:image/") && result.length < 25 * 1024 * 1024) {
          resolve(result);
        } else {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function inlineAllMedia(rootNode, onProgress) {
  const tasks = [];
  function collect(node) {
    if (node.type === "image" && node.image?.src) {
      const src = node.image.src;
      if (src.startsWith("http:") || src.startsWith("https:")) {
        tasks.push(async () => {
          const dataUrl = await downloadAsDataUrl(src);
          if (dataUrl) node.image.src = dataUrl;
        });
      }
    }
    if (node.children) {
      for (const child of node.children) collect(child);
    }
  }
  collect(rootNode);

  if (tasks.length === 0) return;
  let done = 0;
  const concurrency = 6;
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    await Promise.allSettled(batch.map(async (fn) => {
      await fn();
      done++;
      if (onProgress) onProgress(done, tasks.length);
    }));
  }
}

async function executeCapture(mode = "visible") {
  setBusy(true);
  const breakpoints = readBreakpoints();
  const sizes = breakpoints.map((b) => `${b.label} ${b.width}px`).join(", ");
  status.textContent = breakpoints.length
    ? `Capture responsive — ${sizes}…`
    : mode === "full"
      ? "Capture de la page entière…"
      : "Capture de la fenêtre visible…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
      throw new Error("Cette page ne peut pas être capturée.");
    }
    const captureOnce = async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: capturePage,
        args: [{ mode }],
      });
      if (!result?.result) throw new Error("Aucun contenu de page n’a été capturé.");
      return result.result;
    };

    if (breakpoints.length) {
      const captures = [];
      for (let i = 0; i < breakpoints.length; i++) {
        const bp = breakpoints[i];
        status.textContent = `Capture ${bp.label} (${bp.width} px) — ${i + 1}/${breakpoints.length}…`;
        const result = await withViewport(tab.id, bp.width, bp.height, captureOnce);
        captures.push({ bp, result });
      }

      status.textContent = "Téléchargement et intégration des images…";
      for (let i = 0; i < captures.length; i++) {
        const { bp, result } = captures[i];
        await inlineAllMedia(result.root, (done, total) => {
          status.textContent = `Images ${bp.label} (${bp.width} px)… (${done}/${total})`;
        });
      }

      const title = captures[0].result.source.title;
      const totalNodes = captures.reduce((sum, c) => sum + c.result.stats.nodes, 0);
      const snapshot = {
        format: "swiftma-html",
        version: 1,
        source: {
          title: `${title} — ${captures.length} tailles d'écran`,
          url: tab.url,
          capturedAt: new Date().toISOString(),
          isSite: true,
          pageCount: captures.length,
          responsive: true,
        },
        pages: captures.map(({ bp, result }) => ({
          title: `${title} — ${bp.label} (${bp.width} px)`,
          url: tab.url,
          breakpoint: { label: bp.label, width: bp.width, height: bp.height },
          root: result.root,
        })),
        root: captures[0].result.root,
        stats: {
          pages: captures.length,
          nodes: totalNodes,
          truncated: captures.some((c) => c.result.stats.truncated),
          breakpoints: captures.map(({ bp }) => bp.width),
        },
      };

      const json = JSON.stringify(snapshot);
      const blob = new Blob([json], { type: "application/json" });
      const objectUrl = URL.createObjectURL(blob);
      const filename = `${safeFilename(title)}-responsive.swiftma.json`;
      await chrome.downloads.download({ url: objectUrl, filename, saveAs: true });
      status.textContent = `Responsive prêt : ${captures.length} tailles (${sizes}) — ${totalNodes} calques.`;
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      return;
    }

    const result = await captureOnce();
    status.textContent = "Téléchargement et intégration des images…";
    await inlineAllMedia(result.root, (done, total) => {
      status.textContent = `Téléchargement des images… (${done}/${total})`;
    });

    const json = JSON.stringify(result);
    const blob = new Blob([json], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const filename = `${safeFilename(result.source.title)}.swiftma.json`;
    await chrome.downloads.download({ url: objectUrl, filename, saveAs: true });
    const note = result.stats.truncated ? " (capture partielle : limite atteinte)" : "";
    status.textContent = `Capture prête avec images intégrées : ${result.stats.nodes} calques${note}.`;
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "La capture a échoué.";
  } finally {
    setBusy(false);
  }
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, timeoutMs);

    const listener = (tid, changeInfo) => {
      if (tid === tabId && changeInfo.status === "complete") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function normalizeInternalUrl(rawUrl, baseOrigin) {
  try {
    const u = new URL(rawUrl, baseOrigin);
    if (u.origin !== baseOrigin) return null;
    if (/\.(pdf|zip|tar|gz|rar|exe|dmg|iso|apk|png|jpe?g|gif|svg|webp|mp4|webm|mp3|wav|docx?|xlsx?|pptx?)$/i.test(u.pathname)) return null;
    if (/\/(wp-admin|wp-login|logout|login|deconnexion|connexion|signin|signup|auth)\b/i.test(u.pathname)) return null;
    u.hash = "";
    u.search = "";
    const clean = u.href.replace(/\/$/, "");
    return clean || baseOrigin;
  } catch {
    return null;
  }
}

async function executeSiteCapture() {
  setBusy(true);
  if (btnStop) {
    btnStop.style.display = "block";
    btnStop.textContent = "Arrêter et télécharger";
    btnStop.disabled = false;
  }
  let stopRequested = false;
  if (btnStop) {
    btnStop.onclick = () => {
      stopRequested = true;
      btnStop.textContent = "Finalisation en cours…";
      btnStop.disabled = true;
    };
  }

  status.textContent = "Analyse du site et découverte des pages…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
      throw new Error("Cette page ne peut pas être capturée.");
    }

    const initialUrl = tab.url;
    const initialOrigin = new URL(initialUrl).origin;
    const siteHost = new URL(initialUrl).hostname;
    const startUrl = normalizeInternalUrl(initialUrl, initialOrigin) || initialUrl;

    const visited = new Set();
    const queue = [startUrl];
    const maxPages = 20;
    const capturedPages = [];

    const countNodes = (node) => 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0);

    while (queue.length > 0 && capturedPages.length < maxPages && !stopRequested) {
      const currentUrl = queue.shift();
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      const pageNum = capturedPages.length + 1;
      const displayUrl = currentUrl.replace(initialOrigin, "") || "/";
      status.textContent = `Page ${pageNum} : capture de ${displayUrl}…`;

      let pageResult = null;
      let rawLinks = [];

      if (currentUrl === startUrl) {
        // Page active actuelle
        const [capRes] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: capturePage,
          args: [{ mode: "full" }],
        });
        pageResult = capRes?.result;

        const [linksRes] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter(Boolean),
        });
        rawLinks = linksRes?.result || [];
      } else {
        // Chargement en onglet d'arrière-plan sans perturber la navigation de l'utilisateur
        let tempTab = null;
        try {
          tempTab = await chrome.tabs.create({ url: currentUrl, active: false });
          await waitForTabComplete(tempTab.id, 14000);
          await new Promise((r) => setTimeout(r, 1200));

          const [capRes] = await chrome.scripting.executeScript({
            target: { tabId: tempTab.id },
            func: capturePage,
            args: [{ mode: "full" }],
          });
          pageResult = capRes?.result;

          const [linksRes] = await chrome.scripting.executeScript({
            target: { tabId: tempTab.id },
            func: () => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter(Boolean),
          });
          rawLinks = linksRes?.result || [];
        } catch (err) {
          console.warn("Échec capture page:", currentUrl, err);
        } finally {
          if (tempTab?.id) {
            try { await chrome.tabs.remove(tempTab.id); } catch {}
          }
        }
      }

      if (pageResult?.root) {
        let pageTitle = pageResult.source?.title || "";
        if (!pageTitle || pageTitle === siteHost) {
          const pathPart = new URL(currentUrl).pathname.replace(/^\/|\/$/g, "");
          pageTitle = pathPart ? pathPart.charAt(0).toUpperCase() + pathPart.slice(1) : "Accueil";
        }
        capturedPages.push({
          title: pageTitle,
          url: currentUrl,
          root: pageResult.root,
        });
      }

      // Ajouter les nouveaux liens internes dans la file
      for (const raw of rawLinks) {
        const clean = normalizeInternalUrl(raw, initialOrigin);
        if (clean && !visited.has(clean) && !queue.includes(clean)) {
          queue.push(clean);
        }
      }
    }

    if (capturedPages.length === 0) {
      throw new Error("Aucune page n'a pu être capturée.");
    }

    status.textContent = `Téléchargement et intégration des images (${capturedPages.length} pages)…`;
    for (let i = 0; i < capturedPages.length; i++) {
      status.textContent = `Intégration des images : page ${i + 1}/${capturedPages.length}…`;
      await inlineAllMedia(capturedPages[i].root);
    }

    const totalNodes = capturedPages.reduce((sum, p) => sum + countNodes(p.root), 0);
    const mainTitle = capturedPages[0]?.title || siteHost;

    const siteSnapshot = {
      format: "swiftma-html",
      version: 1,
      source: {
        title: `${mainTitle} (Site complet - ${capturedPages.length} pages)`,
        url: initialUrl,
        capturedAt: new Date().toISOString(),
        isSite: true,
        pageCount: capturedPages.length,
      },
      pages: capturedPages,
      root: capturedPages[0].root,
      stats: {
        pages: capturedPages.length,
        nodes: totalNodes,
        truncated: false,
      },
    };

    const json = JSON.stringify(siteSnapshot);
    const blob = new Blob([json], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const filename = `${safeFilename(siteHost)}-site-complet.swiftma.json`;
    await chrome.downloads.download({ url: objectUrl, filename, saveAs: true });
    status.textContent = `Site cloné : ${capturedPages.length} pages, ${totalNodes} calques !`;
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "La capture du site a échoué.";
  } finally {
    setBusy(false);
    if (btnStop) {
      btnStop.style.display = "none";
      btnStop.disabled = false;
    }
  }
}

if (btnVisible) btnVisible.addEventListener("click", () => executeCapture("visible"));
if (btnFull) btnFull.addEventListener("click", () => executeCapture("full"));
if (btnSite) btnSite.addEventListener("click", () => executeSiteCapture());
if (btnInspect) {
  btnInspect.addEventListener("click", async () => {
    setBusy(true);
    status.textContent = "Survolez la page et cliquez sur le composant (Échap pour annuler)…";
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
        throw new Error("Cette page ne peut pas être capturée.");
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: startInspectorWithCapture,
        args: [capturePage.toString(), safeFilename.toString(), inlineAllMedia.toString(), downloadAsDataUrl.toString()],
      });
      window.close();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Impossible d'activer le sélecteur.";
      setBusy(false);
    }
  });
}

function safeFilename(title) {
  const name = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return name || "page";
}

function startInspectorWithCapture(captureCode, safeNameCode, inlineMediaCode, downloadCode) {
  if (document.querySelector("#__swiftma_inspector__")) return;

  const captureFn = new Function("options", "return (" + captureCode + ")(options)");
  const safeNameFn = new Function("title", "return (" + safeNameCode + ")(title)");
  const inlineMediaFn = (inlineMediaCode && downloadCode)
    ? new Function("rootNode", `
        ${downloadCode};
        const inlineFn = ${inlineMediaCode};
        return inlineFn(rootNode);
      `)
    : null;

  const overlay = document.createElement("div");
  overlay.id = "__swiftma_inspector__";
  overlay.style.cssText = "position:fixed;border:2px solid #0d99ff;background:rgba(13,153,255,0.14);pointer-events:none;z-index:2147483647;border-radius:4px;box-shadow:0 0 14px rgba(13,153,255,0.45);transition:all 40ms ease-out;display:none;";
  const badge = document.createElement("div");
  badge.style.cssText = "position:absolute;top:-30px;left:0;background:#0d99ff;color:#fff;font:bold 12px system-ui,-apple-system,sans-serif;padding:4px 9px;border-radius:4px;pointer-events:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.25);";
  overlay.appendChild(badge);
  document.body.appendChild(overlay);

  let currentTarget = null;

  const onMouseMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || overlay.contains(el) || el === document.documentElement || el === document.body) return;
    currentTarget = el;
    const r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = `${Math.max(0, r.left)}px`;
    overlay.style.top = `${Math.max(0, r.top)}px`;
    overlay.style.width = `${Math.max(4, r.width)}px`;
    overlay.style.height = `${Math.max(4, r.height)}px`;
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    badge.textContent = `<${tag}${id}> ${Math.round(r.width)} × ${Math.round(r.height)} (clic pour capturer, Échap pour annuler)`;
  };

  const cleanup = () => {
    overlay.remove();
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") cleanup();
  };

  const onClick = async (e) => {
    if (!currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    const target = currentTarget;
    cleanup();

    target.setAttribute("data-swiftma-target", "true");
    let result = null;
    try {
      result = await captureFn({ mode: "element", targetSelector: "[data-swiftma-target='true']" });
    } finally {
      target.removeAttribute("data-swiftma-target");
    }

    if (result) {
      if (inlineMediaFn) {
        try {
          await inlineMediaFn(result.root);
        } catch {}
      }
      const json = JSON.stringify(result);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeNameFn(result.source.title)}.swiftma.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      const toast = document.createElement("div");
      toast.style.cssText = "position:fixed;bottom:24px;right:24px;background:#24292f;color:#fff;font:500 13px system-ui,sans-serif;padding:12px 18px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.25);z-index:2147483647;display:flex;align-items:center;gap:10px;";
      toast.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:#10b981;border-radius:50%;"></span>Composant Swiftma capturé (${result.stats.nodes} calques) ! Téléchargement lancé.`;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.4s ease";
        setTimeout(() => toast.remove(), 400);
      }, 4000);
    }
  };

  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
}

async function capturePage(options = {}) {
  const mode = options?.mode || "visible";
  const targetSelector = options?.targetSelector || null;
  const targetElement = targetSelector ? document.querySelector(targetSelector) : null;

  const prevScrollX = window.scrollX || window.pageXOffset || 0;
  const prevScrollY = window.scrollY || window.pageYOffset || 0;

  // Pré-défilement fluide en mode capture complète pour activer tous les IntersectionObservers (animations d'apparition, opacités à 0) et lazy-loaders
  if (mode === "full") {
    try {
      const docHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0,
        window.innerHeight
      );
      const step = 500;
      for (let y = 0; y < docHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 100));
      }
      document.querySelectorAll("img[loading='lazy']").forEach((img) => {
        try { img.loading = "eager"; } catch {}
      });
      const decodePromises = Array.from(document.querySelectorAll("img")).map((img) => {
        try {
          return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        } catch {
          return Promise.resolve();
        }
      });
      await Promise.race([
        Promise.allSettled(decodePromises),
        new Promise((r) => setTimeout(r, 1200))
      ]);
    } catch {}
    try {
      const prevHtmlBehavior = document.documentElement.style.scrollBehavior;
      const prevBodyBehavior = document.body ? document.body.style.scrollBehavior : "";
      document.documentElement.style.scrollBehavior = "auto";
      if (document.body) document.body.style.scrollBehavior = "auto";
      window.scrollTo({ left: 0, top: 0, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 150));
      document.documentElement.style.scrollBehavior = prevHtmlBehavior;
      if (document.body) document.body.style.scrollBehavior = prevBodyBehavior;
    } catch {
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;

  let viewport;
  let targetOrigin = { left: 0, top: 0 };

  if (targetElement) {
    const tr = targetElement.getBoundingClientRect();
    viewport = { width: Math.max(1, tr.width), height: Math.max(1, tr.height) };
    targetOrigin = { left: tr.left, top: tr.top };
  } else if (mode === "full") {
    const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, window.innerWidth);
    const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight);
    viewport = { width: scrollWidth, height: scrollHeight };
  } else {
    viewport = { width: window.innerWidth, height: window.innerHeight };
  }

  const forbidden = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO"]);
  const maxNodes = 12_000;
  let count = 0;
  let truncated = false;
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = 1;
  colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext("2d", { willReadFrequently: true });

  const color = (value, keepTransparent = false) => {
    if (!value || typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || (trimmed === "transparent" && !keepTransparent)) return null;
    if (trimmed.includes("var(") || /\bcurrentcolor\b/i.test(trimmed)) return null;
    if (!CSS.supports("color", trimmed) || !colorContext) return null;
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = "#010203";
    colorContext.fillStyle = trimmed;
    colorContext.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
    // Never return the #010203 sentinel if Canvas2D rejected an unresolved CSS color expression
    if (red === 1 && green === 2 && blue === 3 && alpha === 255 && !/#010203\b|rgb\(\s*1\s*,\s*2\s*,\s*3\b/i.test(trimmed)) {
      return null;
    }
    if (alpha === 0 && !keepTransparent) return null;
    const hex = [red, green, blue].map((n) => n.toString(16).padStart(2, "0")).join("");
    return `#${hex}${alpha < 255 ? alpha.toString(16).padStart(2, "0") : ""}`;
  };

  let colorProbeEl = null;
  const resolveCssVars = (rawValue, element) => {
    if (!rawValue || typeof rawValue !== "string") return "";
    let expr = rawValue.trim();
    const elStyle = element ? window.getComputedStyle(element) : null;
    const rootStyle = window.getComputedStyle(document.documentElement);
    for (let depth = 0; depth < 6 && expr.includes("var("); depth++) {
      const next = expr.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (_, propName, fallback) => {
        const val = (elStyle && elStyle.getPropertyValue(propName).trim()) ||
          (rootStyle && rootStyle.getPropertyValue(propName).trim()) ||
          (fallback ? fallback.trim() : "");
        return val;
      });
      if (next === expr) break;
      expr = next;
    }
    if (/\bcurrentcolor\b/i.test(expr) && elStyle) {
      expr = expr.replace(/\bcurrentcolor\b/gi, elStyle.color || "#000000");
    }
    return expr.trim();
  };

  const resolveCssColor = (rawValue, element, keepTransparent = false) => {
    if (!rawValue || typeof rawValue !== "string") return null;
    const resolved = resolveCssVars(rawValue, element);
    if (!resolved) return null;
    const direct = color(resolved, keepTransparent);
    if (direct) return direct;
    try {
      if (!colorProbeEl) {
        colorProbeEl = document.createElement("span");
        colorProbeEl.style.cssText = "display:none!important;position:fixed!important;pointer-events:none!important;visibility:hidden!important;";
        (document.body || document.documentElement).appendChild(colorProbeEl);
      }
      colorProbeEl.style.color = "rgb(1, 2, 3)";
      colorProbeEl.style.color = resolved;
      const computed = window.getComputedStyle(colorProbeEl).color;
      if (computed && computed !== "rgb(1, 2, 3)") {
        return color(computed, keepTransparent);
      }
    } catch {}
    return null;
  };

  const renderGlyphToDataUrl = (glyph, fontFam, fSize, fWeight, fStyle, fColor, w, h) => {
    try {
      const off = document.createElement("canvas");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.max(16, Math.ceil(w));
      const ch = Math.max(16, Math.ceil(h));
      off.width = cw * dpr;
      off.height = ch * dpr;
      const octx = off.getContext("2d");
      if (!octx) return null;
      octx.scale(dpr, dpr);
      octx.font = `${fStyle || "normal"} ${fWeight || "normal"} ${fSize}px "${fontFam}", sans-serif`;
      octx.fillStyle = fColor || "#000000";
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.fillText(glyph, cw / 2, ch / 2);
      return off.toDataURL("image/png");
    } catch {
      return null;
    }
  };

  const isIconGlyphOrFont = (txt, fontFam) => {
    if (!txt) return false;
    if (/elementskit|eicon|fontawesome|fa-|icon-font|dashicon|material-icons/i.test(fontFam)) return true;
    for (let i = 0; i < txt.length; i++) {
      const code = txt.codePointAt(i);
      if (code >= 0xe000 && code <= 0xf8ff) return true;
    }
    return false;
  };

  const adjustColor = (hex, amount) => {
    if (!hex || typeof hex !== "string" || !hex.startsWith("#")) return hex;
    const raw = hex.slice(1);
    if (raw.length !== 6 && raw.length !== 8) return hex;
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    const a = raw.length === 8 ? raw.slice(6, 8) : "";
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const factor = lum > 128 ? -amount : amount;
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    const nr = clamp(r + factor * 255).toString(16).padStart(2, "0");
    const ng = clamp(g + factor * 255).toString(16).padStart(2, "0");
    const nb = clamp(b + factor * 255).toString(16).padStart(2, "0");
    return `#${nr}${ng}${nb}${a}`;
  };

  const safeMatches = (element, selector) => {
    try {
      return !!element.matches(selector);
    } catch {
      return false;
    }
  };

  const stateRules = {
    Survol: [],
    Actif: [],
    Focus: [],
    "Désactivé": [],
  };
  try {
    const expandNestedSelectors = (rawSelector, parentSelector) => {
      const parts = splitCssList(rawSelector);
      if (!parentSelector) return parts;
      const parents = splitCssList(parentSelector);
      const out = [];
      for (const p of parents) {
        for (const s of parts) {
          if (s.includes("&")) {
            out.push(s.replace(/&/g, p).trim());
          } else {
            out.push(`${p} ${s}`.trim());
          }
        }
      }
      return out;
    };

    const STATE_PATTERNS = [
      { key: "Survol", regex: /:hover\b/i, strip: /:is\([^)]*:hover[^)]*\)|:hover\b/gi },
      { key: "Actif", regex: /(:active\b|\[data-state=["']?active["']?\]|\[aria-pressed=["']?true["']?\])/i, strip: /:active\b|\[data-state=["']?active["']?\]|\[aria-pressed=["']?true["']?\]/gi },
      { key: "Focus", regex: /(:focus-visible\b|:focus\b)/i, strip: /:is\([^)]*:focus[^)]*\)|:focus-visible\b|:focus\b/gi },
      { key: "Désactivé", regex: /(:disabled\b|\[disabled\]|\[aria-disabled=["']?true["']?\])/i, strip: /:disabled\b|\[disabled\]|\[aria-disabled=["']?true["']?\]/gi },
    ];

    const collectRules = (ruleList, parentSelector = "") => {
      if (!ruleList) return;
      for (let i = 0; i < ruleList.length; i++) {
        try {
          const rule = ruleList[i];
          const currentSelector = rule.selectorText
            ? expandNestedSelectors(rule.selectorText, parentSelector).join(", ")
            : parentSelector;

          if (rule.selectorText && rule.style) {
            const parts = expandNestedSelectors(rule.selectorText, parentSelector);
            for (const part of parts) {
              for (const sp of STATE_PATTERNS) {
                if (!sp.regex.test(part)) continue;
                // Check if pseudo-state is on an ancestor (e.g. ".patrol-lib-summary:hover .patrol-lib-glyph")
                const hoverIdx = part.search(sp.regex);
                const afterHover = part.slice(hoverIdx).replace(sp.strip, "").trim();
                if (afterHover && /^[\s>+~]/.test( part.slice(hoverIdx).replace(sp.strip, "") )) {
                  const ancestorSel = part.slice(0, hoverIdx).trim();
                  const childSel = afterHover.replace(/^[>+~\s]+/, "").trim();
                  if (ancestorSel && childSel) {
                    stateRules[sp.key].push({ selector: ancestorSel, childSelector: childSel, style: rule.style });
                  }
                } else {
                  const clean = part.replace(sp.strip, "").trim();
                  if (clean && clean !== "&") {
                    stateRules[sp.key].push({ selector: clean, childSelector: null, style: rule.style });
                  }
                }
              }
            }
          }
          // Always recurse into nested cssRules (supports CSS Nesting, @media, @layer, @supports)
          if (rule.cssRules) {
            collectRules(rule.cssRules, currentSelector);
          }
        } catch {}
      }
    };
    for (let s = 0; s < document.styleSheets.length; s++) {
      try {
        const sheet = document.styleSheets[s];
        if (sheet.cssRules) collectRules(sheet.cssRules, "");
      } catch {}
    }
  } catch {}


  const getElementRect = (el) => {
    let r = el.getBoundingClientRect();
    if (mode === "full") {
      try {
        const pos = window.getComputedStyle(el).position;
        if (pos === "fixed" && r.top > 200 && r.bottom >= window.innerHeight - 20) {
          const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
          return {
            left: r.left + scrollX,
            top: docH - r.height,
            right: r.right + scrollX,
            bottom: docH,
            width: r.width,
            height: r.height,
          };
        }
      } catch {}
    }
    if (targetElement) {
      return {
        left: r.left - targetOrigin.left,
        top: r.top - targetOrigin.top,
        right: r.right - targetOrigin.left,
        bottom: r.bottom - targetOrigin.top,
        width: r.width,
        height: r.height,
      };
    }
    if (mode === "full") {
      return {
        left: r.left + scrollX,
        top: r.top + scrollY,
        right: r.right + scrollX,
        bottom: r.bottom + scrollY,
        width: r.width,
        height: r.height,
      };
    }
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };

  const splitCssTokens = (value) => {
    const tokens = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < value.length; i++) {
      if (/\s/.test(value[i]) && depth === 0) {
        if (start >= 0) tokens.push(value.slice(start, i));
        start = -1;
      } else {
        if (start < 0) start = i;
        if (value[i] === "(") depth++;
        else if (value[i] === ")") depth--;
      }
    }
    if (start >= 0) tokens.push(value.slice(start));
    return tokens;
  };

  const boxShadows = (value) => {
    if (!value || value === "none") return [];
    return splitCssList(value).slice(0, 8).flatMap((shadow) => {
      const tokens = splitCssTokens(shadow);
      const inset = tokens.includes("inset");
      const colorIndex = tokens.findIndex((token) => CSS.supports("color", token));
      const shadowColor = color(colorIndex < 0 ? "rgb(0, 0, 0)" : tokens[colorIndex], true);
      const dimensions = tokens
        .filter((token, index) => token !== "inset" && index !== colorIndex)
        .map((token) => {
          const match = token.match(/^(-?(?:\d+\.?\d*|\.\d+))(?:px)?$/);
          return match ? Number(match[1]) : NaN;
        });
      if (!shadowColor || dimensions.length < 2 || dimensions.length > 4 || dimensions.some((n) => !Number.isFinite(n))) return [];
      return [{
        type: inset ? "inner" : "drop",
        x: dimensions[0],
        y: dimensions[1],
        blur: dimensions[2] ?? 0,
        spread: dimensions[3] ?? 0,
        color: shadowColor,
      }];
    });
  };

  const splitCssList = (value) => {
    const items = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")") depth--;
      else if (value[i] === "," && depth === 0) {
        items.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    items.push(value.slice(start).trim());
    return items;
  };

  const parseGradientStop = (value) => {
    const match = value.match(/^(.*?)(?:\s+(-?(?:\d+\.?\d*|\.\d+)%))?$/);
    if (!match || !match[1]) return null;
    const stopColor = color(match[1].trim(), true);
    if (!stopColor) return null;
    return { color: stopColor, offset: match[2] ? Math.max(0, Math.min(1, parseFloat(match[2]) / 100)) : null };
  };

  const distributeStops = (stops) => {
    if (stops.length < 2) return null;
    if (stops[0].offset === null) stops[0].offset = 0;
    if (stops[stops.length - 1].offset === null) stops[stops.length - 1].offset = 1;
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].offset !== null) stops[i].offset = Math.max(stops[i - 1].offset, stops[i].offset);
    }
    let left = 0;
    while (left < stops.length - 1) {
      let right = left + 1;
      while (right < stops.length - 1 && stops[right].offset === null) right++;
      const start = stops[left].offset;
      const end = stops[right].offset;
      for (let i = left + 1; i < right; i++) stops[i].offset = start + (end - start) * (i - left) / (right - left);
      left = right;
    }
    return stops.map(({ color: stopColor, offset }) => ({ color: stopColor, offset }));
  };

  const parseCssGradient = (value, width, height) => {
    const match = value.match(/^(linear|radial)-gradient\((.*)\)$/i);
    if (!match) return null;
    const type = match[1].toLowerCase();
    const parts = splitCssList(match[2]);
    if (parts.length < 2) return null;
    const firstStop = parseGradientStop(parts[0]);
    const header = firstStop ? "" : parts.shift();
    const stops = (firstStop ? [firstStop, ...parts.slice(1).map(parseGradientStop)] : parts.map(parseGradientStop));
    if (stops.some((stop) => !stop)) return null;
    const normalizedStops = distributeStops(stops);
    if (!normalizedStops) return null;

    if (type === "linear") {
      let degrees = 180;
      if (header) {
        const angle = header.match(/^(-?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)$/i);
        if (angle) {
          const value = Number(angle[1]);
          degrees = angle[2].toLowerCase() === "turn" ? value * 360
            : angle[2].toLowerCase() === "rad" ? value * 180 / Math.PI
              : angle[2].toLowerCase() === "grad" ? value * 0.9 : value;
        } else if (header.startsWith("to ")) {
          const directions = header.slice(3).split(/\s+/);
          const dx = (directions.includes("right") ? 1 : 0) - (directions.includes("left") ? 1 : 0);
          const dy = (directions.includes("bottom") ? 1 : 0) - (directions.includes("top") ? 1 : 0);
          if (!dx && !dy) return null;
          degrees = Math.atan2(dx, -dy) * 180 / Math.PI;
        } else return null;
      }
      const radians = degrees * Math.PI / 180;
      const dx = Math.sin(radians);
      const dy = -Math.cos(radians);
      const halfLength = (Math.abs(dx) * width + Math.abs(dy) * height) / 2;
      const start = [0.5 - dx * halfLength / width, 0.5 - dy * halfLength / height];
      const end = [0.5 + dx * halfLength / width, 0.5 + dy * halfLength / height];
      return { type, stops: normalizedStops, start, end };
    }

    let center = [0.5, 0.5];
    let shape = "ellipse";
    let size = "farthest-corner";
    if (header) {
      const at = header.match(/\bat\s+(.+)$/i);
      const shapeHeader = at ? header.slice(0, at.index).trim() : header.trim();
      const shapeParts = shapeHeader ? shapeHeader.split(/\s+/) : [];
      if (shapeParts[0] === "circle" || shapeParts[0] === "ellipse") shape = shapeParts.shift();
      if (shapeParts.length) size = shapeParts.shift();
      if (shapeParts.length || !["closest-side", "farthest-side", "closest-corner", "farthest-corner"].includes(size)) return null;
      if (at) {
        const positions = at[1].trim().split(/\s+/);
        const coordinate = (token, axis) => {
          if (token.endsWith("%")) return Math.max(0, Math.min(1, parseFloat(token) / 100));
          if (token === "center") return 0.5;
          if (token === (axis === "x" ? "left" : "top")) return 0;
          if (token === (axis === "x" ? "right" : "bottom")) return 1;
          return null;
        };
        let x = coordinate(positions[0], "x");
        let y = coordinate(positions[1] || "center", "y");
        if (positions.length === 1 && ["top", "bottom"].includes(positions[0])) {
          x = 0.5;
          y = coordinate(positions[0], "y");
        } else if (positions.length === 1 && ["left", "right"].includes(positions[0])) {
          x = coordinate(positions[0], "x");
          y = 0.5;
        }
        if (x === null || y === null) return null;
        center = [x, y];
      }
    }
    const [cx, cy] = center;
    const left = cx * width;
    const right = (1 - cx) * width;
    const top = cy * height;
    const bottom = (1 - cy) * height;
    let radius;
    if (shape === "circle") {
      const distances = [left, right, top, bottom];
      let value;
      if (size === "closest-side") value = Math.min(...distances);
      else if (size === "farthest-side") value = Math.max(...distances);
      else {
        const corners = [
          Math.hypot(left, top), Math.hypot(right, top),
          Math.hypot(left, bottom), Math.hypot(right, bottom),
        ];
        value = size === "closest-corner" ? Math.min(...corners) : Math.max(...corners);
      }
      radius = [value / width, value / height];
    } else {
      radius = size === "closest-side" || size === "closest-corner"
        ? [Math.min(left, right) / width, Math.min(top, bottom) / height]
        : [Math.max(left, right) / width, Math.max(top, bottom) / height];
    }
    return { type, stops: normalizedStops, start: center, end: center, radius };
  };

  const parseCssUrl = (value) => {
    const match = value.match(/^url\((['"]?)(.*?)\1\)$/i);
    if (!match || !match[2]) return null;
    const raw = match[2].trim();
    if (raw.startsWith("data:image/")) return raw;
    try {
      const url = new URL(raw, location.href);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        return url.href;
      }
    } catch {}
    return null;
  };

  const backgroundLayers = (style, width, height, name, radius = 0) => {
    if (!style.backgroundImage || style.backgroundImage === "none") return [];
    const images = splitCssList(style.backgroundImage).slice(0, 8);
    return images.reverse().flatMap((image, index) => {
      const gradient = parseCssGradient(image, width, height);
      if (gradient) {
        return [{
          type: "rect",
          name: `${name} — dégradé ${index + 1}`,
          x: 0,
          y: 0,
          width,
          height,
          fill: null,
          radius,
          opacity: 1,
          clip: false,
          absolute: true,
          gradient,
          children: [],
        }];
      }
      const bgUrl = parseCssUrl(image);
      if (bgUrl) {
        return [{
          type: "image",
          name: `${name} — image de fond ${index + 1}`,
          x: 0,
          y: 0,
          width,
          height,
          fill: null,
          radius,
          opacity: 1,
          clip: false,
          absolute: true,
          image: { src: bgUrl },
          children: [],
        }];
      }
      return [];
    });
  };

  const nameOf = (element) => {
    const label = element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title");
    if (label) return label.slice(0, 100);
    const id = element.id ? `#${element.id}` : "";
    const rawClass = typeof element.className === "string"
      ? element.className
      : (element.className && typeof element.className.baseVal === "string" ? element.className.baseVal : "");
    const className = rawClass.trim()
      ? `.${rawClass.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
    return `${element.tagName.toLowerCase()}${id}${className}`.slice(0, 100);
  };

  const isSliderTrack = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const c = typeof el.className === "string" ? el.className : (el.className && typeof el.className.baseVal === "string" ? el.className.baseVal : "");
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("role") || ""} ${el.id || ""}`;
    if (/swiper-wrapper|slick-track|splide__list|owl-stage|flickity-slider|carousel-inner|slider-track|embla__container|marquee/i.test(c)) return true;
    if (/carousel|slider|marquee|latest\s+research/i.test(label)) return true;
    try {
      const st = window.getComputedStyle(el);
      if (st.gridAutoFlow && st.gridAutoFlow.includes("column") && el.children.length >= 3) return true;
      if (st.transform && st.transform !== "none" && el.children.length >= 3) {
        const p = el.parentElement;
        if (p) {
          const pst = window.getComputedStyle(p);
          if (/hidden|clip|scroll|auto/.test(`${pst.overflow} ${pst.overflowX}`)) return true;
        }
      }
    } catch {}
    return false;
  };

  const isInsideSliderTrack = (el) => {
    let cur = el;
    for (let d = 0; d < 5 && cur && cur !== document.body; d++) {
      if (isSliderTrack(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  };

  const detectElementAnimation = (el, style, rect) => {
    try {
      const c = typeof el.className === "string" ? el.className : "";
      const animName = (style.animationName || "").toLowerCase();
      const durSec = parseFloat(style.animationDuration) || 0;
      const delaySec = parseFloat(style.animationDelay) || 0;
      const iter = style.animationIterationCount || "1";
      const infinite = iter === "infinite" || parseFloat(iter) > 10;
      const easing = style.animationTimingFunction || "ease";

      // 1. Horizontal Carousel / Track (Embla, Swiper, or grid-flow-col with Prev/Next controls)
      if (isSliderTrack(el) && el.children.length >= 3) {
        let stepPx = 304;
        if (el.children.length >= 2) {
          const r0 = el.children[0].getBoundingClientRect();
          const r1 = el.children[1].getBoundingClientRect();
          const delta = Math.abs(r1.left - r0.left);
          if (delta > 40 && delta < 1600) stepPx = Math.round(delta * 100) / 100;
        }
        return {
          type: "carousel",
          duration: 500,
          delay: 0,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          infinite: true,
          autoPlay: true,
          stepPx,
        };
      }

      // 2. Active CSS @keyframes animation
      if (animName && animName !== "none" && durSec > 0) {
        const durMs = Math.round(durSec * (String(style.animationDuration).includes("ms") ? 1 : 1000));
        const delayMs = Math.round(delaySec * (String(style.animationDelay).includes("ms") ? 1 : 1000));
        let type = "pulse";
        if (/spin|rotate/i.test(animName) || /\bdm-spin\b|\banimate-spin\b/i.test(c)) type = "spin";
        else if (/shimmer|glint|shine|sweep/i.test(animName) || /\b(hd-glint|dm-shimmer)\b/i.test(c)) type = "shimmer";
        else if (/marquee|ticker|scroll/i.test(animName)) type = "marquee";
        else if (/float|bob|bounce|settle/i.test(animName)) type = "float";
        else if (/fade|appear|reveal/i.test(animName)) type = "fade-in";
        else if (/pulse|ping|blink|meter/i.test(animName)) type = "pulse";
        return {
          type,
          duration: durMs || 2000,
          delay: Math.max(0, delayMs),
          easing,
          infinite,
        };
      }

      // 3. Scroll-reveal / entrance attributes (data-reveal, dot-reveal, AOS, etc.)
      if (
        el.hasAttribute("data-reveal") ||
        el.hasAttribute("data-aos") ||
        /\b(dot-reveal)\b/i.test(c)
      ) {
        return {
          type: "reveal",
          duration: 650,
          delay: parseInt(el.getAttribute("data-reveal-delay") || el.getAttribute("data-aos-delay") || "0", 10) || 0,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          infinite: false,
        };
      }
    } catch {}
    return null;
  };

  const visible = (element, rect, style) => {
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (isInsideSliderTrack(element)) {
      return rect.bottom > 0 && rect.top < viewport.height;
    }
    return (
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewport.width &&
      rect.top < viewport.height
    );
  };

  const appendExtracted = (target, node) => {
    if (Array.isArray(node)) target.push(...node);
    else if (node) target.push(node);
  };

  const textNode = (text, parent, style, rect, name) => {
    const content = text.replace(/\s+/g, " ").trim();
    if (!content || !rect || rect.width <= 0 || rect.height <= 0) return null;
    const clipped = style.clip !== "auto" ||
      (style.clipPath !== "none" && style.clipPath !== "border-box") ||
      (style.position === "absolute" &&
        (parseFloat(style.width) <= 1 || parseFloat(style.height) <= 1) &&
        /hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`));
    if (clipped) return null;
    const fontSize = Math.max(1, parseFloat(style.fontSize) || 16);
    const lineHeight = style.lineHeight === "normal"
      ? 1.2
      : Math.max(0.5, Math.min(4, (parseFloat(style.lineHeight) || fontSize * 1.2) / fontSize));
    const align = ["left", "center", "right"].includes(style.textAlign) ? style.textAlign : "left";
    const fontFamily = style.fontFamily.split(",")[0].replace(/^["']|["']$/g, "").trim() || "Arial";

    if (isIconGlyphOrFont(content, fontFamily)) {
      const glyphSrc = renderGlyphToDataUrl(
        content,
        fontFamily,
        fontSize,
        style.fontWeight,
        style.fontStyle,
        color(style.color) || "#111111",
        rect.width,
        rect.height
      );
      if (glyphSrc) {
        return {
          type: "image",
          name: `${name} — icône`.slice(0, 100),
          x: rect.left - parent.left,
          y: rect.top - parent.top,
          width: Math.max(1, Math.ceil(rect.width)),
          height: Math.max(1, Math.ceil(rect.height)),
          fill: null,
          radius: 0,
          opacity: 1,
          clip: false,
          flowStyle: { grow: 0, alignSelf: "auto", order: 0 },
          image: { src: glyphSrc },
          children: [],
        };
      }
    }

    const isSingleLine = rect.height <= fontSize * lineHeight * 1.5;
    return {
      type: "text",
      name: `${name} — texte`.slice(0, 100),
      x: rect.left - parent.left,
      y: rect.top - parent.top,
      width: Math.ceil(Math.max(rect.width, fontSize * 0.4)) + 2,
      height: Math.ceil(Math.max(rect.height, fontSize * lineHeight)),
      fill: null,
      radius: 0,
      opacity: 1,
      clip: false,
      sizingH: isSingleLine ? "hug" : "fixed",
      sizingV: "hug",
      flowStyle: { grow: 0, alignSelf: "auto", order: 0 },
      text: {
        content: content.slice(0, 10_000),
        fontFamily,
        fontSize,
        fontWeight: Math.max(100, Math.min(900, parseInt(style.fontWeight, 10) || 400)),
        color: color(style.color) || "#111111",
        align,
        lineHeight,
        italic: style.fontStyle === "italic" || style.fontStyle === "oblique",
        letterSpacing: Math.max(-100, Math.min(100, parseFloat(style.letterSpacing) || 0)),
      },
      children: [],
    };
  };

  const pixel = (value) => Math.max(0, parseFloat(value) || 0);
  const flowLayout = (style, children, parentRect) => {
    if (style.display !== "flex" || !["row", "column"].includes(style.flexDirection) ||
        style.flexWrap === "wrap-reverse" || style.direction !== "ltr" ||
        style.writingMode !== "horizontal-tb" ||
        (style.flexWrap === "wrap" && !["flex-start", "start"].includes(style.alignContent))) return null;
    const flowChildren = children.filter((child) => !child.absolute);
    if (flowChildren.length < 2) return null;

    const direction = style.flexDirection;
    const isRow = direction === "row";
    const gap = pixel(isRow ? style.columnGap : style.rowGap);
    const padStart = pixel(isRow ? (style.paddingLeft || style.borderLeftWidth) : (style.paddingTop || style.borderTopWidth));

    // Verify sequential flow: children must not overlap or be out of order in the main axis
    for (let i = 1; i < flowChildren.length; i++) {
      const prev = flowChildren[i - 1];
      const curr = flowChildren[i];
      const prevEnd = isRow ? (prev.x + prev.width) : (prev.y + prev.height);
      const currStart = isRow ? curr.x : curr.y;
      if (currStart < prevEnd - 2) return null;
    }

    // Verify that positions actually match the computed gap/padding to avoid breaking custom margins / margin: auto
    if (["start", "flex-start"].includes(style.justifyContent) && style.flexWrap !== "wrap") {
      let expected = padStart;
      for (const child of flowChildren) {
        const pos = isRow ? child.x : child.y;
        if (Math.abs(pos - expected) > 6) {
          // A child has margin: auto or custom margins! Keep exact fixed coordinates to prevent overlap!
          return null;
        }
        expected += (isRow ? child.width : child.height) + gap;
      }
    }

    const justify = ({
      "flex-start": "start",
      start: "start",
      left: "start",
      center: "center",
      "flex-end": "end",
      end: "end",
      right: "end",
      "space-between": "space-between",
    })[style.justifyContent];
    const alignItems = style.alignItems;
    const align = ({
      "flex-start": "start",
      start: "start",
      "self-start": "start",
      center: "center",
      "flex-end": "end",
      end: "end",
      "self-end": "end",
    })[alignItems];
    if (!justify || (!align && alignItems !== "stretch" && alignItems !== "normal")) return null;

    const childStyles = flowChildren.map((child) => child.flowStyle);
    const defaultAlignSelf = alignItems === "normal" ? "stretch" : alignItems;
    if (childStyles.some((child) => !child ||
        (child.alignSelf !== "auto" && child.alignSelf !== defaultAlignSelf) || child.order !== 0)) return null;
    const grows = childStyles.map((child) => child.grow);
    const positiveGrows = grows.filter((grow) => grow > 0);
    if (positiveGrows.length && positiveGrows.some((grow) => Math.abs(grow - positiveGrows[0]) > 0.001)) return null;

    const layout = {
      direction,
      gap,
      padding: [
        pixel(style.paddingTop) + pixel(style.borderTopWidth),
        pixel(style.paddingRight) + pixel(style.borderRightWidth),
        pixel(style.paddingBottom) + pixel(style.borderBottomWidth),
        pixel(style.paddingLeft) + pixel(style.borderLeftWidth),
      ],
      justify,
      align: align || "start",
      ...(direction === "row" && style.flexWrap === "wrap"
        ? { wrap: true, wrapGap: pixel(style.rowGap) }
        : {}),
    };
    const mainAxis = direction === "row" ? "sizingH" : "sizingV";
    const crossAxis = direction === "row" ? "sizingV" : "sizingH";
    const crossFill = alignItems === "stretch" || alignItems === "normal";
    const parentCross = isRow
      ? Math.max(0, parentRect.height - layout.padding[0] - layout.padding[2])
      : Math.max(0, parentRect.width - layout.padding[1] - layout.padding[3]);

    flowChildren.forEach((child, index) => {
      if (positiveGrows.length && grows[index] > 0) child[mainAxis] = "fill";
      // ONLY set crossFill if child actually matches the cross-axis dimension in the browser!
      const childCross = isRow ? child.height : child.width;
      if (crossFill && Math.abs(childCross - parentCross) <= 3) {
        child[crossAxis] = "fill";
      }
    });
    return layout;
  };

  const rangeRect = (text) => {
    const range = document.createRange();
    range.selectNodeContents(text);
    const rects = [...range.getClientRects()];
    if (!rects.length) return null;
    const rawLeft = Math.min(...rects.map((r) => r.left));
    const rawTop = Math.min(...rects.map((r) => r.top));
    const rawRight = Math.max(...rects.map((r) => r.right));
    const rawBottom = Math.max(...rects.map((r) => r.bottom));
    let ox = 0, oy = 0;
    if (targetElement) {
      ox = -targetOrigin.left;
      oy = -targetOrigin.top;
    } else if (mode === "full") {
      ox = scrollX;
      oy = scrollY;
    }
    const left = rawLeft + ox;
    const top = rawTop + oy;
    const right = rawRight + ox;
    const bottom = rawBottom + oy;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  const extractElement = (element, parentRect, depth) => {
    if (++count > maxNodes || depth > 50) {
      truncated = true;
      return null;
    }
    if (forbidden.has(element.tagName)) return null;

    // 1. Skip non-open <details> content (only <summary> is displayed when closed)
    const details = element.closest("details");
    if (details && details !== element && !details.open && !element.closest("summary")) return null;

    // 2. Skip non-open <dialog>
    const dialog = element.closest("dialog");
    if (dialog && !dialog.open) return null;

    // 3. Skip elements with [hidden] attribute or aria-hidden dialogs/drawers/menus
    if (element.hasAttribute("hidden") || element.closest("[hidden]")) return null;
    if ((element.getAttribute("aria-hidden") === "true" || element.closest('[aria-hidden="true"]')) &&
        /dialog|menu|modal|drawer|popup/i.test(`${element.role || ""} ${element.className || ""}`)) {
      return null;
    }

    const style = getComputedStyle(element);
    const rect = getElementRect(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0) return null;
    if (rect.width <= 0 || rect.height <= 0) {
      // Si l'élément a display: contents OU si son overflow n'est pas caché et qu'il possède des enfants (ex. wrappers d'icônes/slots à hauteur zéro en CSS moderne), aplatir ses enfants
      const isClipped = /hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`);
      if (style.display === "contents" || (!isClipped && element.children.length > 0)) {
        const flattened = [];
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const text = textNode(child.textContent || "", parentRect, style, rangeRect(child), nameOf(element));
            if (text) flattened.push(text);
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            appendExtracted(flattened, extractElement(child, parentRect, depth + 1));
          }
        }
        return flattened;
      }
      return null;
    }
    if (!visible(element, rect, style)) return null;
    const name = nameOf(element);
    const pos = style.position;
    const isPos = pos === "relative" || pos === "absolute" || pos === "sticky" || pos === "fixed";
    const rawZ = parseInt(style.zIndex, 10);
    const zIdx = Number.isFinite(rawZ) ? rawZ : 0;
    const isNav = ["HEADER", "NAV"].includes(element.tagName) ||
      element.getAttribute("role") === "banner" ||
      element.getAttribute("role") === "navigation" ||
      /header|navbar|nav-bar|menu-bar/i.test(`${element.className || ""} ${element.id || ""}`);
    let stackOrder = 0;
    if (pos === "fixed") stackOrder = 100000 + (zIdx > 0 ? zIdx : 100);
    else if (pos === "sticky") stackOrder = 50000 + (zIdx > 0 ? zIdx : 50);
    else if (isPos && zIdx > 0) stackOrder = 10000 + zIdx;
    else if (isPos && zIdx === 0) stackOrder = 1000 + (isNav ? 500 : 0);
    else if (isNav) stackOrder = 500;
    else if (zIdx < 0) stackOrder = zIdx;

    const fill = color(style.backgroundColor);
    const rawRadius = Math.max(0, parseFloat(style.borderTopLeftRadius) || 0);
    const radius = Math.min(rawRadius, Math.max(rect.width, rect.height) / 2);
    const borderWidth = parseFloat(style.borderTopWidth) || 0;
    const strokeColor = color(style.borderTopColor);
    const sameBorder = style.borderTopWidth === style.borderRightWidth &&
      style.borderTopWidth === style.borderBottomWidth &&
      style.borderTopWidth === style.borderLeftWidth &&
      style.borderTopStyle !== "none" &&
      style.borderTopStyle === style.borderRightStyle &&
      style.borderTopStyle === style.borderBottomStyle &&
      style.borderTopStyle === style.borderLeftStyle;
    const stroke = sameBorder && borderWidth > 0 && strokeColor
      ? { color: strokeColor, width: borderWidth }
      : undefined;

    const borderLayers = [];
    if (!sameBorder) {
      const topW = parseFloat(style.borderTopWidth) || 0;
      const topC = color(style.borderTopColor);
      if (topW > 0 && topC && style.borderTopStyle !== "none") {
        borderLayers.push({
          type: "rect",
          name: `${name} — bordure haute`,
          x: 0,
          y: 0,
          width: rect.width,
          height: topW,
          fill: topC,
          radius: 0,
          opacity: 1,
          clip: false,
          absolute: true,
          children: [],
        });
      }
      const bottomW = parseFloat(style.borderBottomWidth) || 0;
      const bottomC = color(style.borderBottomColor);
      if (bottomW > 0 && bottomC && style.borderBottomStyle !== "none") {
        borderLayers.push({
          type: "rect",
          name: `${name} — bordure basse`,
          x: 0,
          y: Math.max(0, rect.height - bottomW),
          width: rect.width,
          height: bottomW,
          fill: bottomC,
          radius: 0,
          opacity: 1,
          clip: false,
          absolute: true,
          children: [],
        });
      }
      const leftW = parseFloat(style.borderLeftWidth) || 0;
      const leftC = color(style.borderLeftColor);
      if (leftW > 0 && leftC && style.borderLeftStyle !== "none") {
        borderLayers.push({
          type: "rect",
          name: `${name} — bordure gauche`,
          x: 0,
          y: 0,
          width: leftW,
          height: rect.height,
          fill: leftC,
          radius: 0,
          opacity: 1,
          clip: false,
          absolute: true,
          children: [],
        });
      }
      const rightW = parseFloat(style.borderRightWidth) || 0;
      const rightC = color(style.borderRightColor);
      if (rightW > 0 && rightC && style.borderRightStyle !== "none") {
        borderLayers.push({
          type: "rect",
          name: `${name} — bordure droite`,
          x: Math.max(0, rect.width - rightW),
          y: 0,
          width: rightW,
          height: rect.height,
          fill: rightC,
          radius: 0,
          opacity: 1,
          clip: false,
          absolute: true,
          children: [],
        });
      }
    }

    const shadows = boxShadows(style.boxShadow);
    const opacity = Math.max(0, Math.min(1, Number(style.opacity) || 1));
    const clip = /hidden|clip|scroll|auto/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`);
    const children = [];

    if (element.tagName.toUpperCase() === "IMG") {
      const image = element;
      const rawSrc = (
        image.currentSrc ||
        image.src ||
        image.getAttribute("src") ||
        image.dataset?.src ||
        image.dataset?.lazySrc ||
        image.getAttribute("data-src") ||
        image.getAttribute("data-lazy-src") ||
        ""
      ).trim();
      if (!rawSrc) return null;
      let finalSrc = null;
      if (rawSrc.startsWith("data:image/")) {
        finalSrc = rawSrc;
      } else {
        // Attempt to inline loaded image via canvas to avoid CORS/referrer blocking in editor
        let dataUrl = null;
        if (image.complete && image.naturalWidth > 0) {
          try {
            const maxDim = 1600;
            const scale = Math.min(1, maxDim / Math.max(image.naturalWidth, image.naturalHeight));
            const c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(image.naturalWidth * scale));
            c.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const ctx = c.getContext("2d");
            ctx.drawImage(image, 0, 0, c.width, c.height);
            const isJpeg = /\.jpe?g($|\?)/i.test(rawSrc);
            const generated = c.toDataURL(isJpeg ? "image/jpeg" : "image/png", 0.85);
            if (generated && generated.startsWith("data:image/") && generated.length < 5 * 1024 * 1024) {
              dataUrl = generated;
            }
          } catch {
            dataUrl = null;
          }
        }
        if (dataUrl) {
          finalSrc = dataUrl;
        } else {
          try {
            const parsed = new URL(rawSrc, location.href);
            if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password) {
              finalSrc = parsed.href;
            }
          } catch {
            return null;
          }
        }
      }
      if (!finalSrc) return null;
      return {
        type: "image",
        name,
        x: rect.left - parentRect.left,
        y: rect.top - parentRect.top,
        width: rect.width,
        height: rect.height,
        fill,
        radius,
        opacity,
        clip: false,
        ...(shadows.length ? { shadows } : {}),
        ...(style.position === "absolute" || style.position === "fixed" ? { absolute: true } : {}),
        flowStyle: {
          grow: Math.max(0, parseFloat(style.flexGrow) || 0),
          alignSelf: style.alignSelf,
          order: parseInt(style.order, 10) || 0,
        },
        image: { src: finalSrc },
        children,
      };
    }

    if (element.tagName.toUpperCase() === "SVG") {
      if (rect.width <= 0 || rect.height <= 0) return null;
      let dataUrl = null;
      try {
        const clone = element.cloneNode(true);
        if (!clone.getAttribute("xmlns")) {
          clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        }
        if (!clone.getAttribute("viewBox")) {
          clone.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
        }
        clone.setAttribute("width", String(rect.width));
        clone.setAttribute("height", String(rect.height));

        const computedColor = style.color || "#000000";
        clone.style.color = computedColor;
        if (style.fill && style.fill !== "none" && !clone.getAttribute("fill")) {
          clone.setAttribute("fill", style.fill);
        }

        // Resolve currentColor and CSS variables across all child elements so SVG renders independently in <img>
        const origNodes = Array.from(element.querySelectorAll("*"));
        const cloneNodes = Array.from(clone.querySelectorAll("*"));
        for (let i = 0; i < cloneNodes.length && i < origNodes.length; i++) {
          const cEl = cloneNodes[i];
          const oEl = origNodes[i];
          const oStyle = window.getComputedStyle(oEl);

          // 1. Resolve fill
          const rawFill = cEl.getAttribute("fill");
          if (rawFill === "currentColor" || rawFill?.includes("var(") || (!rawFill && oStyle.fill && oStyle.fill !== "none")) {
            const resolvedFill = oStyle.fill;
            if (resolvedFill && resolvedFill !== "none" && !resolvedFill.includes("var(")) {
              cEl.setAttribute("fill", resolvedFill);
            } else if (rawFill === "currentColor" || rawFill?.includes("var(")) {
              cEl.setAttribute("fill", computedColor);
            }
          }

          // 2. Resolve stroke
          const rawStroke = cEl.getAttribute("stroke");
          if (rawStroke === "currentColor" || rawStroke?.includes("var(") || (!rawStroke && oStyle.stroke && oStyle.stroke !== "none")) {
            const resolvedStroke = oStyle.stroke;
            if (resolvedStroke && resolvedStroke !== "none" && !resolvedStroke.includes("var(")) {
              cEl.setAttribute("stroke", resolvedStroke);
              if (oStyle.strokeWidth && !cEl.getAttribute("stroke-width")) {
                cEl.setAttribute("stroke-width", oStyle.strokeWidth);
              }
            } else if (rawStroke === "currentColor" || rawStroke?.includes("var(")) {
              cEl.setAttribute("stroke", computedColor);
            }
          }

          // 3. Resolve inline style
          if (cEl.hasAttribute("style")) {
            const s = cEl.getAttribute("style").replace(/var\(--[^)]+\)/g, computedColor);
            cEl.setAttribute("style", s);
          }
        }

        const uses = clone.querySelectorAll("use");
        for (const use of uses) {
          const href = (use.getAttribute("href") || use.getAttribute("xlink:href") || "").trim();
          if (href.startsWith("#")) {
            const targetId = href.slice(1);
            const targetEl = document.getElementById(targetId);
            if (targetEl) {
              if (targetEl.tagName.toLowerCase() === "symbol") {
                const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                for (const attr of targetEl.attributes) {
                  if (attr.name !== "id" && attr.name !== "viewBox") {
                    g.setAttribute(attr.name, attr.value);
                  }
                }
                g.innerHTML = targetEl.innerHTML;
                use.replaceWith(g);
              } else {
                const clonedTarget = targetEl.cloneNode(true);
                clonedTarget.removeAttribute("id");
                use.replaceWith(clonedTarget);
              }
            }
          }
        }

        const serializer = new XMLSerializer();
        let svgString = serializer.serializeToString(clone);
        if (svgString) {
          // Replace any remaining CSS variables with computedColor so SVG is never transparent
          svgString = svgString.replace(/var\(--[^)]+\)/g, computedColor);
          if (svgString.length < 2 * 1024 * 1024) {
            const base64 = btoa(unescape(encodeURIComponent(svgString)));
            dataUrl = `data:image/svg+xml;base64,${base64}`;
          }
        }
      } catch {
        dataUrl = null;
      }

      if (!dataUrl) return null;

      return {
        type: "image",
        name,
        x: rect.left - parentRect.left,
        y: rect.top - parentRect.top,
        width: rect.width,
        height: rect.height,
        fill,
        radius,
        opacity,
        clip: false,
        ...(shadows.length ? { shadows } : {}),
        ...(style.position === "absolute" || style.position === "fixed" ? { absolute: true } : {}),
        flowStyle: {
          grow: Math.max(0, parseFloat(style.flexGrow) || 0),
          alignSelf: style.alignSelf,
          order: parseInt(style.order, 10) || 0,
        },
        image: { src: dataUrl },
        children,
      };
    }

    if (element.tagName.toUpperCase() === "CANVAS") {
      if (rect.width <= 0 || rect.height <= 0) return null;
      let dataUrl = null;
      try {
        dataUrl = element.toDataURL("image/png");
      } catch {
        dataUrl = null;
      }
      if (!dataUrl || dataUrl === "data:," || dataUrl.length > 5 * 1024 * 1024) return null;
      return {
        type: "image",
        name,
        x: rect.left - parentRect.left,
        y: rect.top - parentRect.top,
        width: rect.width,
        height: rect.height,
        fill,
        radius,
        opacity,
        clip: false,
        ...(shadows.length ? { shadows } : {}),
        ...(style.position === "absolute" || style.position === "fixed" ? { absolute: true } : {}),
        flowStyle: {
          grow: Math.max(0, parseFloat(style.flexGrow) || 0),
          alignSelf: style.alignSelf,
          order: parseInt(style.order, 10) || 0,
        },
        image: { src: dataUrl },
        children,
      };
    }

    const ownStyle = getComputedStyle(element);
    const contentChildren = [];

    const extractPseudo = (pseudoName) => {
      let pseudoStyle;
      try {
        pseudoStyle = window.getComputedStyle(element, pseudoName);
      } catch {
        return null;
      }
      const content = pseudoStyle.content;
      if (!content || content === "none" || content === "normal") return null;
      const unquoted = content.replace(/^['"]|['"]$/g, "");
      const pseudoFill = color(pseudoStyle.backgroundColor);
      const pseudoW = parseFloat(pseudoStyle.width) || 0;
      const pseudoH = parseFloat(pseudoStyle.height) || 0;

      const isAbs = pseudoStyle.position === "absolute" || pseudoStyle.position === "fixed";
      let pLeft = 0;
      let pTop = 0;
      if (isAbs) {
        pLeft = parseFloat(pseudoStyle.left) || 0;
        pTop = parseFloat(pseudoStyle.top) || 0;
      } else {
        const pxPadL = parseFloat(pseudoStyle.paddingLeft) || 0;
        const pxMarginL = parseFloat(pseudoStyle.marginLeft) || 0;
        if (pseudoName === "::after") {
          const lastChild = contentChildren[contentChildren.length - 1];
          if (lastChild && !lastChild.absolute) {
            pLeft = lastChild.x + lastChild.width + pxPadL + pxMarginL;
            pTop = lastChild.y;
          } else {
            pLeft = (parseFloat(style.paddingLeft) || 0) + pxPadL + pxMarginL;
            pTop = parseFloat(style.paddingTop) || 0;
          }
        } else {
          pLeft = (parseFloat(style.paddingLeft) || 0) + pxPadL + pxMarginL;
          pTop = parseFloat(style.paddingTop) || 0;
        }
      }

      if (unquoted.trim()) {
        const fontSize = Math.max(1, parseFloat(pseudoStyle.fontSize) || 16);
        const textCol = color(pseudoStyle.color) || "#111111";
        const fontFamily = pseudoStyle.fontFamily.split(",")[0].replace(/^["']|["']$/g, "").trim() || "Arial";

        if (isIconGlyphOrFont(unquoted.trim(), fontFamily)) {
          const glyphSrc = renderGlyphToDataUrl(
            unquoted.trim(),
            fontFamily,
            fontSize,
            pseudoStyle.fontWeight,
            pseudoStyle.fontStyle,
            textCol,
            Math.max(pseudoW, fontSize),
            Math.max(pseudoH, fontSize * 1.2)
          );
          if (glyphSrc) {
            return {
              type: "image",
              name: `${name} — icône ${pseudoName.slice(2)}`,
              x: pLeft,
              y: pTop,
              width: Math.max(pseudoW, fontSize),
              height: Math.max(pseudoH, fontSize * 1.2),
              fill: null,
              radius: 0,
              opacity: Math.max(0, Math.min(1, Number(pseudoStyle.opacity) || 1)),
              clip: false,
              ...(isAbs ? { absolute: true } : {}),
              flowStyle: { grow: 0, alignSelf: "auto", order: 0 },
              image: { src: glyphSrc },
              children: [],
            };
          }
        }

        return {
          type: "text",
          name: `${name} — ${pseudoName.slice(2)}`,
          x: pLeft,
          y: pTop,
          width: Math.max(pseudoW, fontSize),
          height: Math.max(pseudoH, fontSize * 1.2),
          fill: null,
          radius: 0,
          opacity: Math.max(0, Math.min(1, Number(pseudoStyle.opacity) || 1)),
          clip: false,
          sizingH: "hug",
          sizingV: "hug",
          ...(isAbs ? { absolute: true } : {}),
          flowStyle: { grow: 0, alignSelf: "auto", order: 0 },
          text: {
            content: unquoted.trim().slice(0, 1000),
            fontFamily,
            fontSize,
            fontWeight: Math.max(100, Math.min(900, parseInt(pseudoStyle.fontWeight, 10) || 400)),
            color: textCol,
            align: "left",
            lineHeight: 1.2,
          },
          children: [],
        };
      }

      if (pseudoFill && pseudoW > 0 && pseudoH > 0) {
        return {
          type: "rect",
          name: `${name} — ${pseudoName.slice(2)}`,
          x: pLeft,
          y: pTop,
          width: pseudoW,
          height: pseudoH,
          fill: pseudoFill,
          radius: Math.min(Math.max(0, parseFloat(pseudoStyle.borderTopLeftRadius) || 0), Math.max(pseudoW, pseudoH) / 2),
          opacity: Math.max(0, Math.min(1, Number(pseudoStyle.opacity) || 1)),
          clip: false,
          ...(isAbs ? { absolute: true } : {}),
          flowStyle: { grow: 0, alignSelf: "auto", order: 0 },
          children: [],
        };
      }
      return null;
    };

    // Extract pseudo-elements only on elements likely to have them (improves speed and avoids false positives)
    const canHavePseudo = ["BUTTON", "A", "LI", "SPAN", "I", "LABEL", "H1", "H2", "H3", "H4", "H5", "H6"].includes(element.tagName) ||
      (typeof element.className === "string" && element.className.length > 0);
    if (canHavePseudo) {
      try {
        const beforeNode = extractPseudo("::before");
        if (beforeNode) contentChildren.push(beforeNode);
      } catch {}
    }

    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const content = child.textContent || "";
        const rectForText = rangeRect(child);
        const text = textNode(content, rect, ownStyle, rectForText, name);
        if (text) contentChildren.push(text);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        appendExtracted(contentChildren, extractElement(child, rect, depth + 1));
      }
    }

    if (canHavePseudo) {
      try {
        const afterNode = extractPseudo("::after");
        if (afterNode) contentChildren.push(afterNode);
      } catch {}
    }

    const formText = ["INPUT", "TEXTAREA"].includes(element.tagName)
      ? (element.value || element.placeholder || "").trim()
      : "";
    if (formText) {
      const inset = parseFloat(style.paddingLeft) || 0;
      const text = textNode(
        formText,
        { left: rect.left, top: rect.top },
        style,
        { left: rect.left + inset, top: rect.top, width: Math.max(1, rect.width - inset * 2), height: rect.height },
        name,
      );
      if (text) contentChildren.push(text);
    }

    let states = undefined;
    if (element.tagName === "DETAILS") {
      states = {};
      const wasOpen = element.open;
      try {
        element.open = !wasOpen;
        const toggledRect = getElementRect(element);
        const toggledChildren = [];
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            const content = child.textContent || "";
            const rectForText = rangeRect(child);
            const text = textNode(content, toggledRect, ownStyle, rectForText, name);
            if (text) toggledChildren.push(text);
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            appendExtracted(toggledChildren, extractElement(child, toggledRect, depth + 1));
          }
        }
        const stateKey = wasOpen ? "Fermé" : "Ouvert";
        states[stateKey] = {
          height: toggledRect.height,
          children: toggledChildren,
        };
      } catch {} finally {
        element.open = wasOpen;
      }
    }

    const isButtonLike = element.tagName === "BUTTON" ||
      element.getAttribute("role") === "button" ||
      element.getAttribute("role") === "tab" ||
      element.getAttribute("role") === "menuitem" ||
      element.getAttribute("role") === "switch" ||
      (typeof element.className === "string" && /\b(btn|button|cta)\b/i.test(element.className));

    const padL = parseFloat(style.paddingLeft) || 0;
    const isStyledLink = element.tagName === "A" && (
      (typeof element.className === "string" && (/\b(btn|button|cta)\b/i.test(element.className) || /\b(hover:|transition)\b/.test(element.className))) ||
      (fill && fill !== "transparent" && padL >= 6) ||
      (stroke && padL >= 6)
    );

    const isFormInput = ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName);

    const isGenericTagSelector = (sel) =>
      ["a", "*", "body a", "p a", "div a", "span a", "li a", "button", "input"].includes(sel.trim().toLowerCase());

    const extractStatePatchFor = (stateKey) => {
      const rules = stateRules[stateKey] || [];
      let stateFill = null;
      let stateTextColor = null;
      let stateStrokeColor = null;
      let stateStrokeWidth = null;
      let stateOpacity = null;
      let matchedExplicit = false;

      for (let i = 0; i < rules.length; i++) {
        const sr = rules[i];
        if (isGenericTagSelector(sr.selector)) continue;
        if (!safeMatches(element, sr.selector)) continue;

        if (sr.childSel) {
          // Rule targets a descendant on parent state (e.g. .btn:hover .icon)
          if (sr.style.color) {
            const c = resolveCssColor(sr.style.color, element);
            if (c) {
              stateTextColor = c;
              matchedExplicit = true;
            }
          }
          continue;
        }

        matchedExplicit = true;
        if (sr.style.backgroundColor) {
          const c = resolveCssColor(sr.style.backgroundColor, element);
          if (c) stateFill = c;
        }
        if (sr.style.color) {
          const c = resolveCssColor(sr.style.color, element);
          if (c) stateTextColor = c;
        }
        if (sr.style.borderColor) {
          const c = resolveCssColor(sr.style.borderColor, element);
          if (c) stateStrokeColor = c;
        }
        if (sr.style.outlineColor && stateKey === "Focus") {
          const c = resolveCssColor(sr.style.outlineColor, element);
          if (c) {
            stateStrokeColor = c;
            const ow = parseFloat(resolveCssVars(sr.style.outlineWidth || "2px", element));
            if (Number.isFinite(ow) && ow > 0) stateStrokeWidth = ow;
          }
        }
        if (sr.style.opacity) {
          const opVal = parseFloat(resolveCssVars(sr.style.opacity, element));
          if (Number.isFinite(opVal)) stateOpacity = opVal;
        }
      }

      if (stateKey === "Survol" && !matchedExplicit && (isButtonLike || (element.tagName === "A" && fill && fill !== "transparent" && padL >= 8)) && fill) {
        stateFill = adjustColor(fill, 0.12);
      }

      const patch = {};
      if (stateFill && stateFill !== fill) patch.fill = stateFill;
      if (stateOpacity !== null && stateOpacity !== opacity) patch.opacity = stateOpacity;
      if (stateTextColor) patch.textColor = stateTextColor;
      if (stateStrokeColor && (!stroke || stateStrokeColor !== stroke.color)) {
        patch.strokeColor = stateStrokeColor;
        if (stateStrokeWidth || stroke) {
          patch.stroke = {
            color: stateStrokeColor,
            width: stateStrokeWidth || (stroke ? stroke.width : 1.5),
            align: "inside",
          };
        }
      }

      return Object.keys(patch).length > 0 ? patch : null;
    };

    const isInteractive = isButtonLike || isStyledLink || isFormInput || element.tagName === "A";

    if (isInteractive && !states) {
      for (const stateKey of ["Survol", "Actif", "Focus", "Désactivé"]) {
        if (stateKey === "Focus" && !isButtonLike && !isFormInput) continue;
        if (stateKey === "Désactivé" && !isButtonLike && !isFormInput) continue;
        const patch = extractStatePatchFor(stateKey);
        if (patch) {
          states = states || {};
          states[stateKey] = patch;
        }
      }
    }

    // Détection des masques CSS (mask-image / -webkit-mask-image) utilisés notamment pour les logos clients ou graphiques teintés
    let maskImageSpec = null;
    if (fill && contentChildren.length === 0) {
      const rawMask = (style.maskImage && style.maskImage !== "none" ? style.maskImage : "") ||
        (style.webkitMaskImage && style.webkitMaskImage !== "none" ? style.webkitMaskImage : "");
      if (rawMask && rawMask.includes("url(")) {
        const mUrl = extractFirstCssUrl(rawMask);
        if (mUrl) {
          maskImageSpec = { src: mUrl, fill };
        }
      }
    }

    const animation = detectElementAnimation(element, style, rect);

    const layout = flowLayout(style, contentChildren, rect);
    for (const child of contentChildren) delete child.flowStyle;

    // Collapsing: when single text child has no styles, adjust coordinates to parentRect!
    if (!states && !animation && !maskImageSpec && contentChildren.length === 1 && contentChildren[0].type === "text" &&
        !fill && !stroke && radius === 0 && !borderLayers.length && !shadows.length && !clip && style.backgroundImage === "none") {
      const text = contentChildren[0];
      text.x += rect.left - parentRect.left;
      text.y += rect.top - parentRect.top;
      text.flowStyle = {
        grow: Math.max(0, parseFloat(style.flexGrow) || 0),
        alignSelf: style.alignSelf,
        order: parseInt(style.order, 10) || 0,
      };
      if (style.position === "absolute" || style.position === "fixed") text.absolute = true;
      return text;
    }
    const bgLayers = backgroundLayers(style, rect.width, rect.height, name, radius);
    if (!states && !animation && !maskImageSpec && element.tagName === "PICTURE" && contentChildren.length === 1 && contentChildren[0].type === "image" &&
        !fill && !stroke && radius === 0 && !borderLayers.length && !shadows.length && !clip && !bgLayers.length) {
      const img = contentChildren[0];
      img.x += rect.left - parentRect.left;
      img.y += rect.top - parentRect.top;
      return img;
    }
    const hasVisual = !!fill || !!stroke || radius > 0 || borderLayers.length > 0 || shadows.length > 0 || clip || bgLayers.length > 0 || !!states || !!animation || !!maskImageSpec;
    if (!contentChildren.length && !hasVisual) return null;
    // Swiftma empile les enfants dans l'ordre du tableau et son auto-layout les place dans cet ordre.
    // Le z-index ne doit donc JAMAIS réordonner les enfants d'un flux (il inversait la navbar :
    // le groupe « Log in / Sign up » passait à gauche et le menu à droite). On garde l'ordre visuel
    // du DOM le long de l'axe principal, puis on repousse les calques hors flux à la fin pour
    // qu'ils se peignent au-dessus, comme dans le navigateur.
    const flowOrder = (list, layout) => {
      if (!layout) return list;
      const flow = [];
      const overlays = [];
      for (const child of list) (child && child.absolute ? overlays : flow).push(child);
      const horizontal = layout.direction !== "column";
      flow.sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      overlays.sort((a, b) => (a?._stackOrder || 0) - (b?._stackOrder || 0));
      return [...flow, ...overlays];
    };
    const sortedContent = layout
      ? flowOrder(contentChildren, layout)
      : contentChildren.some((c) => c && c._stackOrder && c._stackOrder !== 0)
        ? contentChildren.slice().sort((a, b) => (a?._stackOrder || 0) - (b?._stackOrder || 0))
        : contentChildren;
    children.push(...bgLayers, ...borderLayers, ...sortedContent);
    return {
      type: contentChildren.length || clip || layout || bgLayers.length || borderLayers.length ? "frame" : "rect",
      name,
      x: rect.left - parentRect.left,
      y: rect.top - parentRect.top,
      width: rect.width,
      height: rect.height,
      fill,
      radius,
      opacity,
      clip,
      _stackOrder: stackOrder,
      ...(maskImageSpec ? { _maskImage: maskImageSpec } : {}),
      ...(stroke ? { stroke } : {}),
      ...(shadows.length ? { shadows } : {}),
      ...(layout ? { layout } : {}),
      ...(states ? { states } : {}),
      ...(animation ? { animation } : {}),
      ...(style.position === "absolute" || style.position === "fixed" ? { absolute: true } : {}),
      flowStyle: {
        grow: Math.max(0, parseFloat(style.flexGrow) || 0),
        alignSelf: style.alignSelf,
        order: parseInt(style.order, 10) || 0,
      },
      children,
    };
  };

  let root;
  if (targetElement) {
    const targetRect = getElementRect(targetElement);
    const targetNode = extractElement(targetElement, { left: targetRect.left, top: targetRect.top }, 0);
    const rootChildren = Array.isArray(targetNode) ? targetNode : (targetNode ? [targetNode] : []);
    root = {
      type: "frame",
      name: `${nameOf(targetElement)} — composant`.slice(0, 100),
      x: 0,
      y: 0,
      width: Math.max(1, targetRect.width),
      height: Math.max(1, targetRect.height),
      fill: null,
      radius: 0,
      opacity: 1,
      clip: true,
      children: rootChildren,
    };
  } else {
    const bodyStyle = getComputedStyle(document.body);
    const htmlStyle = getComputedStyle(document.documentElement);
    const rootFill = color(bodyStyle.backgroundColor) || color(htmlStyle.backgroundColor);
    const viewportRect = { left: 0, top: 0, width: viewport.width, height: viewport.height };
    const rootChildren = [];
    for (const child of document.body.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        appendExtracted(rootChildren, extractElement(child, viewportRect, 0));
      } else if (child.nodeType === Node.TEXT_NODE) {
        const rect = rangeRect(child);
        const node = textNode(child.textContent || "", viewportRect, bodyStyle, rect, "Texte de la page");
        if (node) rootChildren.push(node);
      }
    }
    const rootStyle = bodyStyle.backgroundImage !== "none" ? bodyStyle : htmlStyle;
    const rootLayers = backgroundLayers(rootStyle, viewport.width, viewport.height, "Fond de page");
    if (rootChildren.some((c) => c && c._stackOrder && c._stackOrder !== 0)) {
      rootChildren.sort((a, b) => (a?._stackOrder || 0) - (b?._stackOrder || 0));
    }
    rootChildren.forEach((child) => delete child.flowStyle);

    root = {
      type: "frame",
      name: (document.title || location.hostname).slice(0, 100),
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
      fill: rootFill,
      radius: 0,
      opacity: 1,
      clip: true,
      children: [...rootLayers, ...rootChildren],
    };
  }

  if (colorProbeEl) {
    try { colorProbeEl.remove(); } catch {}
    colorProbeEl = null;
  }

  const cleanStackOrder = (node) => {
    if (!node) return;
    delete node._stackOrder;
    if (node.children) {
      for (const child of node.children) cleanStackOrder(child);
    }
  };
  cleanStackOrder(root);

  const countNodes = (node) => 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);

  if (mode === "full" && (prevScrollX !== 0 || prevScrollY !== 0)) {
    window.scrollTo(prevScrollX, prevScrollY);
  }

  // Inlining autonome 100% in-page de tous les assets média dans le contexte d'origine de la page hôte
  try {
    const inPageImageCache = new Map();
    const fetchInPageDataUrl = async (url) => {
      if (!url || typeof url !== "string") return null;
      if (url.startsWith("data:image/")) return url;
      if (inPageImageCache.has(url)) return inPageImageCache.get(url);
      try {
        let fetchUrl = url;
        try {
          const u = new URL(url, location.href);
          if (u.searchParams.get("fm") === "avif") {
            u.searchParams.set("fm", "png");
            fetchUrl = u.toString();
          }
        } catch {}
        const res = await fetch(fetchUrl);
        if (!res.ok) return null;
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const resUrl = reader.result;
            resolve(typeof resUrl === "string" && resUrl.startsWith("data:image/") ? resUrl : null);
          };
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
        if (dataUrl) inPageImageCache.set(url, dataUrl);
        return dataUrl;
      } catch {
        return null;
      }
    };

    const compositeMaskedDataUrl = async (maskSrc, tintColor, w, h) => {
      const dataUrl = await fetchInPageDataUrl(maskSrc);
      if (!dataUrl) return null;
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const dpr = 2;
            const cw = Math.max(2, Math.round(w * dpr));
            const ch = Math.max(2, Math.round(h * dpr));
            const canvas = document.createElement("canvas");
            canvas.width = cw;
            canvas.height = ch;
            const ctx = canvas.getContext("2d");
            const iw = img.naturalWidth || cw;
            const ih = img.naturalHeight || ch;
            const scale = Math.min(cw / iw, ch / ih);
            const dw = iw * scale;
            const dh = ih * scale;
            const dx = (cw - dw) / 2;
            const dy = (ch - dh) / 2;
            ctx.drawImage(img, dx, dy, dw, dh);
            ctx.globalCompositeOperation = "source-in";
            ctx.fillStyle = tintColor || "#1A1614";
            ctx.fillRect(0, 0, cw, ch);
            resolve(canvas.toDataURL("image/png"));
          } catch {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
      });
    };

    const inliningTasks = [];
    const collectHttpImages = (node) => {
      if (node._maskImage?.src) {
        const maskSpec = node._maskImage;
        delete node._maskImage;
        inliningTasks.push(async () => {
          const maskedUrl = await compositeMaskedDataUrl(maskSpec.src, maskSpec.fill, node.width || 100, node.height || 40);
          if (maskedUrl) {
            node.type = "image";
            node.fill = null;
            node.image = { src: maskedUrl };
          }
        });
      } else if (node.type === "image" && node.image?.src && !node.image.src.startsWith("data:")) {
        inliningTasks.push(async () => {
          const dataUrl = await fetchInPageDataUrl(node.image.src);
          if (dataUrl) node.image.src = dataUrl;
        });
      }
      if (node.children) {
        for (const child of node.children) collectHttpImages(child);
      }
    };
    collectHttpImages(root);

    if (inliningTasks.length > 0) {
      const batchSize = 6;
      for (let i = 0; i < inliningTasks.length; i += batchSize) {
        await Promise.allSettled(inliningTasks.slice(i, i + batchSize).map((fn) => fn()));
      }
    }
  } catch {}

  const cleanInternalFields = (node) => {
    if (!node) return;
    delete node._maskImage;
    if (node.children) {
      for (const child of node.children) cleanInternalFields(child);
    }
  };
  cleanInternalFields(root);

  return {
    format: "swiftma-html",
    version: 1,
    source: {
      title: targetElement ? `${document.title || location.hostname} — ${nameOf(targetElement)}` : (document.title || location.hostname),
      url: location.href,
      capturedAt: new Date().toISOString(),
    },
    stats: { nodes: countNodes(root), truncated },
    root,
  };
}
