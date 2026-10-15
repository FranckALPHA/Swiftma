#!/usr/bin/env node
// Banc de fidélité Nyota : SVG → import Nyota → export React → rendu navigateur → comparaison pixel par pixel
// avec le SVG d'origine rendu par le même navigateur, avec les mêmes polices.
//
// Usage : node tests/fidelity/run.mjs <fichiers ou dossiers…> [--out results/nom] [--jobs 4] [--every N] [--match regex]
// Prérequis : npm install (racine) et npm install dans tests/fidelity/harness ; Chromium de Playwright.
//   Variable CHROMIUM_PATH pour utiliser un Chromium déjà installé.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const casesDir = path.join(here, "harness/cases");

// ---------- Arguments ----------
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const outBase = opt("--out", path.join(here, "results", new Date().toISOString().replace(/[:.]/g, "-")));
const jobs = Number(opt("--jobs", 4));
const every = Number(opt("--every", 1));
const match = opt("--match", null);
// --canvas : compare le canevas de l'éditeur (Konva) à l'original au lieu de l'export React
const canvasMode = argv.includes("--canvas") && (argv.splice(argv.indexOf("--canvas"), 1), true);
// --responsive : convertit la maquette en auto-layout (flexbox) avant l'export ; le rendu doit rester identique
const responsive = argv.includes("--responsive") && (argv.splice(argv.indexOf("--responsive"), 1), true);
// --styles : détecte les styles partagés avant l'export (variables CSS) ; le rendu doit rester identique
const stylesMode = argv.includes("--styles") && (argv.splice(argv.indexOf("--styles"), 1), true);
// --strict : code de sortie 1 si un fichier n'est pas fidèle (pour la CI)
const strict = argv.includes("--strict") && (argv.splice(argv.indexOf("--strict"), 1), true);
const files = argv.flatMap((p) => walk(path.resolve(p))).filter((f, i) => i % every === 0).filter((f) => !match || new RegExp(match).test(f));
if (!files.length) {
  console.error("Aucun fichier SVG. Usage : node tests/fidelity/run.mjs <fichiers ou dossiers…>");
  process.exit(1);
}

function walk(p) {
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isDirectory()) return fs.readdirSync(p).sort().flatMap((f) => walk(path.join(p, f)));
  return p.toLowerCase().endsWith(".svg") ? [p] : [];
}

// ---------- Serveurs ----------
async function startVite(cwd, port) {
  const proc = spawn("npx", ["vite", "--port", String(port), "--strictPort"], { cwd, stdio: "ignore", detached: false });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.status < 500) return proc;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Vite ne démarre pas sur le port ${port}`);
}

// ---------- Comparaison ----------
// Encre = pixel non blanc dans l'un des deux rendus. Erreur = écart fort sur un canal (> 64 / 255).
// Score = erreurs / encre : un petit icône sur fond blanc n'est pas noyé dans le blanc.
const DIFF = `async ([a, b, makeImage]) => {
  const load = (src) => new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
  const px = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h); };
  const da = px(ia).data, db = px(ib).data;
  let ink = 0, bad = 0;
  const mask = makeImage ? new Uint8ClampedArray(w * h * 4) : null;
  for (let i = 0; i < da.length; i += 4) {
    const inkA = Math.max(255 - da[i], 255 - da[i + 1], 255 - da[i + 2]) > 24;
    const inkB = Math.max(255 - db[i], 255 - db[i + 1], 255 - db[i + 2]) > 24;
    if (inkA || inkB) ink++;
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    if (d > 64) { bad++; if (mask) { mask[i] = 255; mask[i + 3] = 255; } }
    else if (mask) { mask[i] = mask[i + 1] = mask[i + 2] = 255 - Math.round((255 - (da[i] + da[i + 1] + da[i + 2]) / 3) * 0.25); mask[i + 3] = 255; }
  }
  let image = null;
  if (makeImage) {
    // Côte à côte : original | Nyota | écarts en rouge
    const c = document.createElement("canvas"); c.width = w * 3 + 20; c.height = h; const x = c.getContext("2d");
    x.fillStyle = "#888"; x.fillRect(0, 0, c.width, h);
    x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.fillRect(w + 10, 0, w, h);
    x.drawImage(ia, 0, 0); x.drawImage(ib, w + 10, 0); x.putImageData(new ImageData(mask, w, h), 2 * w + 20, 0);
    image = c.toDataURL("image/png");
  }
  return { w, h, ink, bad, sizeA: [ia.width, ia.height], sizeB: [ib.width, ib.height], image };
}`;

// ---------- Un cas ----------
let editorPages = [];
async function runCase(browser, file, idx, editor) {
  const id = String(idx).padStart(4, "0");
  const dirId = `${runId}-${id}`; // dossier unique par exécution (le serveur ne surveille pas les fichiers)
  const rel = path.relative(process.cwd(), file);
  const res = { id, file: rel, status: "ok" };
  const svg = fs.readFileSync(file, "utf8");
  // 1. Import + export avec le vrai code de l'éditeur
  let conv;
  try {
    conv = await withTimeout(
      editor.evaluate(async ([s, r, st]) => {
        const m = await import("/test/harness.ts");
        return m.convert(s, "Case", { responsive: r, styles: st });
      }, [svg, responsive, stylesMode]),
      90000,
    );
  } catch (e) {
    return { ...res, status: "import-error", error: String(e.message ?? e).slice(0, 300) };
  }
  res.layers = conv.layers;
  if (responsive) res.layoutFrames = conv.layoutFrames;
  if (stylesMode) res.styles = conv.styles;
  res.skipped = conv.stats.skipped;
  const W = Math.max(1, Math.ceil(conv.width)), H = Math.max(1, Math.ceil(conv.height));
  const dpr = Math.min(8, Math.max(1, Math.ceil(700 / Math.max(W, H))));
  res.size = [W, H];
  res.dpr = dpr;

  // 2. Écriture du projet React exporté
  const dir = path.join(casesDir, dirId);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [p, content] of Object.entries(conv.files)) {
    const target = path.join(dir, p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof content === "string") {
      fs.writeFileSync(target, p === "index.html" ? content.replace('src="/src/main.jsx"', 'src="./src/main.jsx"') : content);
    } else fs.writeFileSync(target, Buffer.from(content.base64, "base64"));
  }
  const fontLinks = (conv.files["index.html"].match(/<link href="https:\/\/fonts[^>]*>/g) || []).join("");

  const ctx = await browser.newContext({
    viewport: canvasMode ? { width: Math.min(W + 800, 4800), height: Math.min(H + 300, 6000) } : { width: Math.min(W + 100, 4000), height: Math.min(H + 100, 6000) },
    deviceScaleFactor: dpr,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    let react;
    if (canvasMode) { react = await canvasShot(page, svg, W, H); if (process.env.NYOTA_DUMP) fs.writeFileSync(path.join(outBase, `canvas-${id}.png`), react); }
    else {
    // 3. Rendu de l'export React
    await page.goto(`http://localhost:4300/cases/${dirId}/index.html`, { waitUntil: "load", timeout: 60000 });
    await page.addStyleTag({ content: "html,body{background:#fff!important} .stage{padding:0!important;display:block!important;min-height:0!important;width:" + conv.width + "px}" });
    await page.waitForSelector('[data-nyota="Case"]', { timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    // Grosses images : on attend qu'elles soient décodées (sinon, sous charge, la capture les montre à moitié)
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    await page.waitForTimeout(150);
    react = await page.locator('[data-nyota="Case"]').screenshot({ timeout: 30000 });
    }

    // 4. Rendu de référence : le SVG d'origine, à la même taille, avec les mêmes polices
    // Le SVG est analysé comme du XML (comme un fichier .svg ouvert dans le navigateur : entités, CDATA…),
    // puis inséré dans la page à la taille d'affichage calculée par l'import.
    await page.setContent(`<!doctype html><html><head>${fontLinks}<style>html,body{margin:0;background:#fff}svg{display:block}</style></head><body></body></html>`, { timeout: 60000 });
    await page.evaluate(([text, w, h]) => {
      const el = document.importNode(new DOMParser().parseFromString(text, "image/svg+xml").documentElement, true);
      if (!el.getAttribute("viewBox") && el.getAttribute("width") && el.getAttribute("height") && !/%/.test(el.getAttribute("width") + el.getAttribute("height"))) {
        el.setAttribute("viewBox", `0 0 ${parseFloat(el.getAttribute("width"))} ${parseFloat(el.getAttribute("height"))}`);
      }
      el.setAttribute("width", String(w));
      el.setAttribute("height", String(h));
      document.body.appendChild(el);
    }, [svg, conv.width, conv.height]);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const ref = await page.locator("svg").first().screenshot({ timeout: 30000 });

    // 5. Comparaison
    const cmp = await page.evaluate(`(${DIFF})(${JSON.stringify(["data:image/png;base64," + ref.toString("base64"), "data:image/png;base64," + react.toString("base64"), false])})`);
    res.ink = cmp.ink;
    res.bad = cmp.bad;
    res.score = cmp.ink ? cmp.bad / cmp.ink : 0;
    if (Math.abs(cmp.sizeA[0] - cmp.sizeB[0]) > dpr * 2 || Math.abs(cmp.sizeA[1] - cmp.sizeB[1]) > dpr * 2) res.sizeMismatch = [cmp.sizeA, cmp.sizeB];
    if (errors.length) res.renderErrors = errors.slice(0, 3);
    if (res.score > 0.02) {
      const img = await page.evaluate(`(${DIFF})(${JSON.stringify(["data:image/png;base64," + ref.toString("base64"), "data:image/png;base64," + react.toString("base64"), true])})`);
      fs.writeFileSync(path.join(outBase, `fail-${id}.png`), Buffer.from(img.image.split(",")[1], "base64"));
    }
  } catch (e) {
    res.status = "render-error";
    res.error = String(e.message ?? e).split("\n")[0].slice(0, 300);
    res.renderErrors = errors.slice(0, 3);
  } finally {
    await ctx.close();
  }
  return res;
}

// Rendu par le vrai éditeur : import, vue à l'échelle 1, rien de sélectionné, capture de la zone du cadre racine.
async function canvasShot(page, svg, W, H) {
  await page.goto("http://localhost:5173/local", { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__nyota && document.querySelector(".konvajs-content"), null, { timeout: 30000 });
  await page.evaluate(async (s) => {
    const n = window.__nyota;
    await n.importSvgText(s, "Case");
    n.select([]);
    n.setView({ x: 0, y: 0, scale: 1 });
    document.querySelector(".konvajs-content").parentElement.style.background = "#fff";
  }, svg);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400); // polices chargées → le canevas se redessine
  const box = await page.locator(".konvajs-content").boundingBox();
  return page.screenshot({ clip: { x: box.x, y: box.y, width: W, height: H }, timeout: 30000 });
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(new Error(`délai dépassé (${ms} ms)`)), ms))]);
}

// ---------- Programme ----------
const runId = Date.now().toString(36);
fs.rmSync(casesDir, { recursive: true, force: true }); // on repart de zéro à chaque exécution
fs.mkdirSync(outBase, { recursive: true });
fs.mkdirSync(casesDir, { recursive: true });
console.log(`${files.length} SVG à tester → ${path.relative(process.cwd(), outBase)}`);
const editorVite = await startVite(path.join(repo, "apps/editor"), 5173);
const harnessVite = await startVite(path.join(here, "harness"), 4300);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = [];
try {
  for (let j = 0; j < jobs; j++) {
    const p = await browser.newPage();
    await p.goto("http://localhost:5173/test/blank.html");
    editorPages.push(p);
  }
  let next = 0;
  const started = Date.now();
  await Promise.all(
    editorPages.map(async (editor) => {
      while (next < files.length) {
        const i = next++;
        const r = await runCase(browser, files[i], i, editor);
        results.push(r);
        fs.appendFileSync(path.join(outBase, "results.jsonl"), JSON.stringify(r) + "\n");
        const tag = r.status !== "ok" ? r.status : r.score <= 0.02 ? "ok" : r.score <= 0.05 ? "proche" : "ÉCART";
        process.stdout.write(`[${results.length}/${files.length}] ${tag.padEnd(12)} ${(r.score ?? 0) * 100 >= 0 ? ((r.score ?? 0) * 100).toFixed(2).padStart(6) + " %" : ""}  ${r.file}\n`);
      }
    }),
  );
  console.log(`Terminé en ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await browser.close();
  editorVite.kill();
  harnessVite.kill();
}

// ---------- Synthèse par dossier ----------
const groups = new Map();
for (const r of results) {
  const g = path.dirname(r.file);
  const s = groups.get(g) ?? { n: 0, ok: 0, close: 0, fail: 0, errors: 0 };
  s.n++;
  if (r.status !== "ok") s.errors++;
  else if (r.score <= 0.02) s.ok++;
  else if (r.score <= 0.05) s.close++;
  else s.fail++;
  groups.set(g, s);
}
const lines = ["| Dossier | SVG | Fidèles (≤ 2 %) | Proches (≤ 5 %) | Écarts | Erreurs |", "|---|---|---|---|---|---|"];
for (const [g, s] of [...groups].sort()) lines.push(`| ${g} | ${s.n} | ${s.ok} (${Math.round((100 * s.ok) / s.n)} %) | ${s.close} | ${s.fail} | ${s.errors} |`);
fs.writeFileSync(path.join(outBase, "summary.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
if (strict) {
  const bad = results.filter((r) => r.status !== "ok" || r.score > 0.02);
  if (bad.length) {
    console.error(`${bad.length} fichier(s) non fidèle(s) : ${bad.map((r) => r.file).join(", ")}`);
    process.exitCode = 1;
  }
}
