// Test de bout en bout : hub Rust + service MCP/IA + éditeur (lancés par « npm run dev », ou l'image Docker).
// Comptes et partage, deux personnes sur le même fichier, une lectrice, une IA externe par MCP avec un jeton,
// versions, vignettes, et les accès refusés.
// Usage : npm run dev   (dans un autre terminal)   puis   node tests/e2e/collaboration.mjs [dossier-captures]
// SWIFTMA_URL : adresse de Swiftma (défaut http://localhost:5173, ex. http://localhost:4000 pour l'image Docker).
// CHROMIUM_PATH pour utiliser un Chromium déjà installé.
import { chromium } from "playwright";
import fs from "node:fs";

const SP = process.argv[2] ?? "tests/e2e/captures";
const BASE = (process.env.SWIFTMA_URL ?? "http://localhost:5173").replace(/\/$/, "");
fs.mkdirSync(SP, { recursive: true });
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "ÉCHEC"} ${msg}`);
  if (!ok) failures++;
};

const run = Math.random().toString(36).slice(2, 7);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];

/** Un navigateur par personne : compte créé par l'API (le cookie de session reste dans le contexte). */
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await ctx.addInitScript(() => localStorage.setItem("swiftma-test", "1"));
  const email = `${name.toLowerCase()}-${run}@exemple.cm`;
  const res = await ctx.request.post(`${BASE}/api/auth/register`, { data: { email, name, password: "motdepasse-solide" } });
  if (!res.ok()) throw new Error(`inscription de ${name} : ${res.status()} ${await res.text()}`);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name} : ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/40[134]/.test(m.text()) && errors.push(`${name} : ${m.text()}`));
  const api = async (method, path, data) => {
    const r = await ctx.request.fetch(`${BASE}${path}`, { method, data });
    return { status: r.status(), body: await r.json().catch(() => null) };
  };
  return { name, email, ctx, page, api };
}

// --- Sans compte : tout est fermé ---
const anon = await (await fetch(`${BASE}/api/projects`)).status;
check(anon === 401, `API sans compte → 401 (reçu ${anon})`);
const anonMcp = (await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status;
check(anonMcp === 401, `MCP sans jeton → 401 (reçu ${anonMcp})`);

const A = await person("Amina");
const B = await person("Bakary");
const C = await person("Chloe");

// --- Amina crée un projet et un fichier, le partage (Bakary éditeur, Chloé lectrice) ---
const project = (await A.api("POST", "/api/projects", { name: `Projet E2E ${run}` })).body;
const file = (await A.api("POST", `/api/projects/${project.id}/files`, { name: "Écran d'accueil" })).body;
check((await B.api("GET", `/api/files/${file.id}`)).status === 404, "avant le partage, Bakary ne voit pas le fichier (404)");
await A.api("POST", `/api/projects/${project.id}/members`, { email: B.email, role: "editor" });
await A.api("POST", `/api/projects/${project.id}/members`, { email: C.email, role: "viewer" });
const members = (await A.api("GET", `/api/projects/${project.id}/members`)).body;
check(members.length === 3, `le projet a 3 membres (${members.map((m) => `${m.name}:${m.role}`).join(", ")})`);
check((await B.api("POST", `/api/projects/${project.id}/members`, { email: C.email, role: "owner" })).status === 403, "un éditeur ne gère pas les membres (403)");

// --- Écran Projets, puis le même fichier ouvert par Amina et Bakary ---
await A.page.goto(`${BASE}/`);
await A.page.getByText(`Projet E2E ${run}`).first().waitFor();
await A.page.getByText(`Projet E2E ${run}`).first().click();
await A.page.screenshot({ path: `${SP}/projets.png` });
const fileUrl = `${BASE}/file/${file.id}`;
for (const p of [A, B, C]) {
  await p.page.goto(fileUrl);
  await p.page.waitForFunction(() => window.__swiftma?.getState().connected, null, { timeout: 15000 });
}

const frame = { id: "f1", type: "frame", name: "Écran", parentId: null, children: [], x: 0, y: 0, width: 390, height: 600, rotation: 0, fill: "#FFFFFF", stroke: null, radius: 0, opacity: 1, visible: true, locked: false, clip: true, text: null };
await A.page.evaluate((node) => window.__swiftma.dispatch([{ kind: "create", node }], "Créer"), frame);
await B.page.waitForFunction(() => !!window.__swiftma.getState().doc.nodes.f1, null, { timeout: 5000 });
check(true, "Bakary voit en direct la frame créée par Amina");

// Modifications simultanées
await Promise.all([
  A.page.evaluate(() => window.__swiftma.dispatch([{ kind: "update", id: "f1", props: { fill: "#FDE68A" } }])),
  B.page.evaluate(() => window.__swiftma.dispatch([{ kind: "update", id: "f1", props: { radius: 24 } }])),
]);
await A.page.waitForTimeout(700);
const state = (p) => p.page.evaluate(() => { const n = window.__swiftma.getState().doc.nodes.f1; return [n.fill, n.radius]; });
const sa = await state(A), sb = await state(B);
check(JSON.stringify(sa) === JSON.stringify(sb) && sa[0] === "#FDE68A" && sa[1] === 24, `modifications simultanées : les deux éditeurs convergent ${JSON.stringify(sa)}`);

// Ctrl+Z d'Amina n'annule que sa modification
await A.page.locator("canvas").first().click({ position: { x: 700, y: 400 } });
await A.page.keyboard.press("Control+z");
await A.page.waitForTimeout(700);
const ub = await state(B);
check(ub[0] === "#FFFFFF" && ub[1] === 24, `Ctrl+Z d'Amina n'annule que sa propre modification ${JSON.stringify(ub)}`);

// Présence : noms des comptes, curseur et sélection
await A.page.mouse.move(600, 300);
await A.page.mouse.move(640, 320);
await A.page.evaluate(() => window.__swiftma.select(["f1"]));
await B.page.waitForFunction(() => window.__swiftma.getState().presence.users.some((u) => u.name === "Amina" && u.cursor && u.selection.includes("f1")), null, { timeout: 5000 });
const names = await B.page.evaluate(() => window.__swiftma.getState().presence.users.map((u) => u.name).sort());
check(JSON.stringify(names) === JSON.stringify(["Amina", "Bakary", "Chloe"]), `présence vue par Bakary : ${names.join(", ")}`);
await B.page.screenshot({ path: `${SP}/presence.png` });

// Chloé (lectrice) voit tout mais ne peut rien modifier
await C.page.waitForFunction(() => !!window.__swiftma.getState().doc.nodes.f1);
const cBefore = await state(C);
await C.page.evaluate(() => window.__swiftma.dispatch([{ kind: "update", id: "f1", props: { fill: "#000000" } }]));
await C.page.waitForTimeout(400);
const cError = await C.page.evaluate(() => window.__swiftma.getState().lastError);
check(/Lecture seule/.test(cError ?? ""), `lectrice : modification refusée dans l'éditeur (« ${cError} »)`);
check((await C.api("POST", `/api/files/${file.id}/ops`, { ops: [{ kind: "update", id: "f1", props: { fill: "#000000" } }] })).status === 403, "lectrice : lot REST refusé (403)");
check(JSON.stringify(await state(A)) === JSON.stringify(cBefore), "le fichier n'a pas changé");
await C.page.screenshot({ path: `${SP}/lectrice.png` });

// --- Une IA externe (MCP) avec le jeton d'Amina ajoute un bouton dans le fichier ouvert ---
const token = (await A.api("POST", "/api/auth/tokens", { name: "Claude Code" })).body.token;
check(/^swiftma_/.test(token ?? ""), "jeton d'accès créé");
const mcp = async (method, params, id, bearer = token) => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data:"));
  return { status: r.status, body: r.ok ? JSON.parse(line ? line.slice(5) : t) : null };
};
await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } }, 1);
const tools = (await mcp("tools/list", {}, 2)).body;
check(tools.result.tools.length >= 20, `outils MCP : ${tools.result.tools.length}`);
const created = (await mcp("tools/call", { name: "create_nodes", arguments: { fileId: file.id, nodes: [
  { ref: "btn", parent: "f1", type: "frame", name: "Bouton", x: 24, y: 520, fill: "#0D99FF", radius: 12, layout: { direction: "row", gap: 8, padding: [12, 20, 12, 20], align: "center" }, sizingH: "hug", sizingV: "hug" },
  { ref: "lbl", parent: "btn", type: "text", name: "Libellé", sizingH: "hug", sizingV: "hug", text: { content: "Continuer", color: "#FFFFFF", fontWeight: 600 } },
] } }, 3)).body;
check(!created.result.isError, `create_nodes par MCP : ${created.result.content[0].text.slice(0, 80)}`);
await B.page.waitForFunction(() => Object.values(window.__swiftma.getState().doc.nodes).some((n) => n.name === "Bouton"), null, { timeout: 5000 });
await B.page.waitForTimeout(900);
const btn = await B.page.evaluate(() => { const d = window.__swiftma.getState().doc; const b = Object.values(d.nodes).find((n) => n.name === "Bouton"); const l = d.nodes[b.children[0]]; return { w: b.width, lw: l.width }; });
check(btn.lw > 40 && btn.w > btn.lw + 30, `le bouton de l'IA s'ajuste au texte mesuré ${JSON.stringify(btn)}`);
// Le jeton de Chloé (lectrice) ne permet pas d'écrire ; un jeton révoqué ne marche plus
const cToken = (await C.api("POST", "/api/auth/tokens", { name: "IA de Chloé" })).body;
const cTry = (await mcp("tools/call", { name: "delete_nodes", arguments: { fileId: file.id, ids: ["f1"] } }, 4, cToken.token)).body;
check(cTry.result.isError && /Lecture seule/.test(cTry.result.content[0].text), "MCP avec le jeton d'une lectrice : écriture refusée");
await C.api("DELETE", `/api/auth/tokens/${cToken.id}`);
check((await mcp("tools/list", {}, 5, cToken.token)).status === 401, "jeton révoqué → 401");

// --- Versions : enregistrer, supprimer, restaurer ---
await A.api("POST", `/api/files/${file.id}/versions`, { label: "Avant suppression" });
await A.page.evaluate(() => window.__swiftma.dispatch([{ kind: "delete", id: "f1" }]));
await B.page.waitForFunction(() => !window.__swiftma.getState().doc.nodes.f1);
const v = (await A.api("GET", `/api/files/${file.id}/versions`)).body.find((x) => x.label === "Avant suppression");
await A.api("POST", `/api/files/${file.id}/versions/${v.id}/restore`);
await B.page.waitForFunction(() => !!window.__swiftma.getState().doc.nodes.f1, null, { timeout: 5000 });
check(true, "version restaurée, vue en direct par Bakary");

// --- Retour aux projets : vignette ---
await A.page.evaluate(() => window.__swiftma.dispatch([{ kind: "update", id: "f1", props: { fill: "#E0F2FE" } }]));
await A.page.waitForTimeout(3500);
await A.page.getByTitle("Tous les projets").click({ timeout: 5000 });
await A.page.waitForURL(`${BASE}/`);
await A.page.waitForTimeout(1500);
await A.page.screenshot({ path: `${SP}/projets-vignette.png` });
check((await A.api("GET", `/api/projects/${project.id}/files`)).body.some((f) => f.id === file.id && f.hasThumbnail), "la vignette du fichier est enregistrée");

// --- Accès retiré : la lectrice encore dans le fichier en sort tout de suite, sans avoir à écrire ---
const cId = (await C.api("GET", "/api/auth/me")).body.id;
await A.api("DELETE", `/api/projects/${project.id}/members/${cId}`);
const kicked = await C.page.waitForURL(`${BASE}/`, { timeout: 5000 }).then(() => true, () => false);
check(kicked, "membre retiré : renvoyée aux projets en direct");
check((await C.api("GET", `/api/files/${file.id}`)).status === 404, "membre retiré : fichier introuvable (404)");

// --- Mot de passe oublié : lien de réinitialisation créé par l'administrateur ---
if ((await A.api("GET", "/api/auth/me")).body.isAdmin) {
  const bId = (await B.api("GET", "/api/auth/me")).body.id;
  const link = (await A.api("POST", `/api/admin/users/${bId}/reset`, {})).body;
  await B.page.goto(`${BASE}${link.path}`);
  await B.page.getByLabel("Nouveau mot de passe").fill("nouveau-secret-42");
  await B.page.getByLabel("Confirmer").fill("nouveau-secret-42");
  await B.page.getByRole("button", { name: "Enregistrer et se connecter" }).click();
  await B.page.waitForURL(`${BASE}/`, { timeout: 5000 });
  check((await B.api("GET", "/api/auth/me")).body?.email === B.email, "réinitialisation : connecté avec le nouveau mot de passe");
  const reuse = await B.api("POST", "/api/auth/reset", { token: link.token, password: "encore-autre-1" });
  check(reuse.status === 400, "réinitialisation : lien à usage unique");
} else {
  console.log("—    réinitialisation non testée : le premier compte de cette instance n'est pas Amina");
}

// --- Déconnexion ---
await A.api("POST", "/api/auth/logout");
check((await A.api("GET", "/api/auth/me")).status === 401, "après déconnexion → 401");

check(!errors.length, `aucune erreur dans la console${errors.length ? " : " + errors.slice(0, 3).join(" | ") : ""}`);
await browser.close();
console.log(failures ? `${failures} échec(s)` : "Tout est bon.");
process.exitCode = failures ? 1 : 0;
