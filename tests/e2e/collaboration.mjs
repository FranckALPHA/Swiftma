// Test de bout en bout : hub Rust + service MCP + éditeur (lancés par « npm run dev »).
// Deux personnes sur le même fichier, une IA externe par MCP, versions, vignettes.
// Usage : npm run dev   (dans un autre terminal)   puis   node tests/e2e/collaboration.mjs [dossier-captures]
// NYOTA_URL : adresse de Nyota (défaut http://localhost:5173, ex. http://localhost:4000 pour l'image Docker).
// CHROMIUM_PATH pour utiliser un Chromium déjà installé.
import { chromium } from "playwright";
import fs from "node:fs";
const SP = process.argv[2] ?? "tests/e2e/captures";
const BASE = (process.env.NYOTA_URL ?? "http://localhost:5173").replace(/\/$/, "");
fs.mkdirSync(`${SP}/resp`, { recursive: true }); // captures d'écran du parcours
const assert = (ok, msg) => { if (!ok) { console.error("ÉCHEC :", msg); process.exitCode = 1; } };
const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
const page = async (name) => {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 860 } });
  await ctx.addInitScript((n) => (localStorage.setItem("nyota-name", n), localStorage.setItem("nyota-test", "1")), name);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(name + ": " + e.message));
  p.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errors.push(name + ": " + m.text()));
  return p;
};
const A = await page("Amina");
await A.goto(`${BASE}/`);
await A.getByText("Mon premier projet").first().waitFor();
await A.screenshot({ path: `${SP}/resp/e2e-projects.png` });
// Nouveau fichier → éditeur
await A.getByRole("button", { name: "Nouveau fichier" }).click();
await A.waitForURL(/\/file\//);
await A.waitForFunction(() => window.__nyota?.getState().connected);
const fileUrl = A.url();
const B = await page("Bakary");
await B.goto(fileUrl);
await B.waitForFunction(() => window.__nyota?.getState().connected);

// A dessine une frame ; B la voit
await A.evaluate(() => window.__nyota.dispatch([{ kind: "create", node: { id: "f1", type: "frame", name: "Écran", parentId: null, children: [], x: 0, y: 0, width: 390, height: 600, rotation: 0, fill: "#FFFFFF", stroke: null, radius: 0, opacity: 1, visible: true, locked: false, clip: true, text: null } }], "Créer"));
await B.waitForFunction(() => !!window.__nyota.getState().doc.nodes.f1, null, { timeout: 5000 });
console.log("B voit la frame de A : oui");

// Modifications simultanées : A change la couleur, B le rayon, en même temps
await Promise.all([
  A.evaluate(() => window.__nyota.dispatch([{ kind: "update", id: "f1", props: { fill: "#FDE68A" } }])),
  B.evaluate(() => window.__nyota.dispatch([{ kind: "update", id: "f1", props: { radius: 24 } }])),
]);
await A.waitForTimeout(600);
const sa = await A.evaluate(() => { const n = window.__nyota.getState().doc.nodes.f1; return [n.fill, n.radius]; });
const sb = await B.evaluate(() => { const n = window.__nyota.getState().doc.nodes.f1; return [n.fill, n.radius]; });
console.log("après modifs simultanées — A :", JSON.stringify(sa), "B :", JSON.stringify(sb));
assert(JSON.stringify(sa) === JSON.stringify(sb) && sa[0] === "#FDE68A" && sa[1] === 24, "les deux éditeurs convergent");

// A annule : seule SA modification est défaite
await A.locator("canvas").first().click({ position: { x: 700, y: 400 } });
await A.keyboard.press("Control+z");
await A.waitForTimeout(600);
const ua = await B.evaluate(() => { const n = window.__nyota.getState().doc.nodes.f1; return [n.fill, n.radius]; });
console.log("après Ctrl+Z de A (vu par B) :", JSON.stringify(ua));
assert(ua[0] === "#FFFFFF" && ua[1] === 24, "Ctrl+Z n'annule que la modification de A");

// Présence : B voit le curseur et la sélection de A
await A.mouse.move(600, 300);
await A.mouse.move(640, 320);
await A.evaluate(() => window.__nyota.select(["f1"]));
await B.waitForFunction(() => window.__nyota.getState().presence.users.some((u) => u.name === "Amina" && u.cursor && u.selection.includes("f1")), null, { timeout: 5000 });
console.log("présence vue par B :", JSON.stringify(await B.evaluate(() => window.__nyota.getState().presence.users.map((u) => u.name))));
await B.screenshot({ path: `${SP}/resp/e2e-presence.png` });

// Une IA externe (MCP, via le hub) ajoute un bouton dans le fichier ouvert
const mcp = async (method, params, id) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : t);
};
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }, 1);
const tools = await mcp("tools/list", {}, 2);
console.log("outils MCP :", tools.result.tools.length);
const created = await mcp("tools/call", { name: "create_nodes", arguments: { nodes: [
  { ref: "btn", parent: "f1", type: "frame", name: "Bouton", x: 24, y: 520, fill: "#0D99FF", radius: 12, layout: { direction: "row", gap: 8, padding: [12, 20, 12, 20], align: "center" }, sizingH: "hug", sizingV: "hug" },
  { ref: "lbl", parent: "btn", type: "text", name: "Libellé", sizingH: "hug", sizingV: "hug", text: { content: "Continuer", color: "#FFFFFF", fontWeight: 600 } },
] } }, 3);
console.log("create_nodes :", created.result.content[0].text.slice(0, 120));
await B.waitForFunction(() => Object.values(window.__nyota.getState().doc.nodes).some((n) => n.name === "Bouton"), null, { timeout: 5000 });
await B.waitForTimeout(800);
const btn = await B.evaluate(() => { const d = window.__nyota.getState().doc; const b = Object.values(d.nodes).find((n) => n.name === "Bouton"); const l = d.nodes[b.children[0]]; return { w: b.width, h: b.height, lw: l.width }; });
console.log("bouton de l'IA vu par B (hug + texte mesuré) :", JSON.stringify(btn));
assert(btn.lw > 40 && btn.w > btn.lw + 30, "le bouton s'ajuste au texte mesuré");
const comp = await mcp("tools/call", { name: "create_component", arguments: { ids: [await B.evaluate(() => Object.values(window.__nyota.getState().doc.nodes).find((n) => n.name === "Bouton").id)] } }, 4);
console.log("create_component :", comp.result.content[0].text);
await B.screenshot({ path: `${SP}/resp/e2e-mcp.png` });

// Versions : enregistrer, modifier, restaurer
const fileId = fileUrl.split("/file/")[1];
await fetch(`${BASE}/api/files/${fileId}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Avant suppression" }) });
await A.evaluate(() => window.__nyota.dispatch([{ kind: "delete", id: "f1" }]));
await B.waitForFunction(() => !window.__nyota.getState().doc.nodes.f1);
const versions = await (await fetch(`${BASE}/api/files/${fileId}/versions`)).json();
const v = versions.find((x) => x.label === "Avant suppression");
await fetch(`${BASE}/api/files/${fileId}/versions/${v.id}/restore`, { method: "POST" });
await B.waitForFunction(() => !!window.__nyota.getState().doc.nodes.f1, null, { timeout: 5000 });
console.log("version restaurée, vue en direct par B : oui");

// Retour aux projets : vignette du fichier
await A.evaluate(() => window.__nyota.dispatch([{ kind: "update", id: "f1", props: { fill: "#E0F2FE" } }]));
await A.waitForTimeout(3500);
await A.getByTitle("Tous les projets").click({ timeout: 5000 });
await A.waitForURL(`${BASE}/`);
await A.waitForTimeout(1500);
await A.screenshot({ path: `${SP}/resp/e2e-projects-2.png` });
console.log("erreurs :", errors);
assert(!errors.length, "aucune erreur dans la console");
await b.close();
