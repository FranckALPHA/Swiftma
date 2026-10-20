// État de l'éditeur. Le document est une copie locale du document du serveur :
// on applique nos opérations tout de suite (réactivité) puis on les envoie ; celles des autres
// (IA intégrée, IA via MCP, autres onglets) arrivent par WebSocket.

import { useSyncExternalStore } from "react";
import { importSvg } from "./svgImport";
import { ensureFonts } from "./fonts";
import { fitTextOps } from "./textFit";
import { ApiError, api, setUnauthorizedHandler } from "./api";
import {
  type AiEvent, type ClientMessage, type DesignDocument, type DesignNode, type FileMeta, type Op, type PresenceUser, type Role, type User, type ServerMessage,
  addAutoLayoutOps, applyOps, applyOpsDetailed, createComponentOps, createDocument, createInstanceOps, withOverrides, withStyleDetach, fontVariants, makeResponsiveOps, makeNode, newId, wrapInAutoLayoutOps,
  type Reorder, groupOps, removeAutoLayoutOps, reorderOps, ungroupOps,
  type NodeTree, absolutePosition, subtree, toTree,
} from "@swiftma/core";

export interface AiImage {
  dataUrl: string;
  width: number; // dimensions de l'image (après réduction éventuelle)
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export interface View { x: number; y: number; scale: number }
export type LeftTab = "file" | "assets" | "plugins" | "ai";
export type RightTab = "design" | "code";

export type Tool = "select" | "frame" | "rect" | "ellipse" | "text" | "hand";

export interface EditorState {
  doc: DesignDocument;
  connected: boolean;
  selection: string[];
  tool: Tool;
  editingTextId: string | null;
  aiLog: AiEvent[];
  aiBusy: boolean;
  aiImage: AiImage | null;
  lastError: string | null;
  version: number; // incrémenté à chaque changement du document
  view: View;
  canvasSize: { w: number; h: number };
  leftTab: LeftTab;
  rightTab: RightTab;
  presence: { users: PresenceUser[]; mcpLastSeen: number | null };
  fileId: string | null; // fichier ouvert (null = écran Projets)
  file: FileMeta | null;
  user: User | null | undefined; // personne connectée (undefined = on vérifie, null = écran de connexion)
  role: Role | null; // son rôle dans le projet du fichier ouvert
  fontsVersion: number; // incrémenté quand de nouvelles polices sont chargées (le canevas re-mesure les textes)
}

const ORIGIN = newId();

let state: EditorState = {
  doc: createDocument(),
  connected: false,
  selection: [],
  tool: "select",
  editingTextId: null,
  aiLog: [],
  aiBusy: false,
  aiImage: null,
  lastError: null,
  version: 0,
  view: { x: 120, y: 80, scale: 1 },
  canvasSize: { w: 800, h: 600 },
  leftTab: "file",
  rightTab: "design",
  presence: { users: [], mcpLastSeen: null },
  fileId: null,
  file: null,
  user: undefined,
  role: null,
  fontsVersion: 0,
};

const listeners = new Set<() => void>();
function set(patch: Partial<EditorState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Prévenu à chaque changement d'état (hors React : plugins). Renvoie la fonction de désabonnement. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useEditor<T>(select: (s: EditorState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}
export const getState = () => state;

// ---- Connexion au hub ----
//
// Le document local = l'état confirmé par le hub + nos lots pas encore confirmés, rejoués par-dessus.
// Quand un lot d'un autre arrive, on le pose sur l'état confirmé puis on rejoue les nôtres : tout le monde
// converge vers l'ordre du hub, sans écraser le travail de personne.

let ws: WebSocket | null = null;
let queue: ClientMessage[] = [];
let serverDoc: DesignDocument | null = null;
let pending: { origin: string; ops: Op[]; label?: string }[] = [];
let seq = 0;
let openFileId: string | null = null;
let pendingImport: { text: string; name: string } | null = null;
/** SVG à importer dès que le fichier (nouvellement créé) sera ouvert. */
export function setPendingImport(text: string, name: string) {
  pendingImport = { text, name };
}

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else if (openFileId && (msg.type === "ops" || msg.type === "undo" || msg.type === "redo")) queue.push(msg);
}

/** Nom affiché aux autres (mémorisé dans ce navigateur). */
export function userName(): string {
  try {
    let n = localStorage.getItem("swiftma-name");
    if (!n) localStorage.setItem("swiftma-name", (n = `Invité ${Math.floor(100 + Math.random() * 900)}`));
    return n;
  } catch {
    return "Invité";
  }
}
export function setUserName(name: string) {
  try {
    localStorage.setItem("swiftma-name", name);
  } catch {
    /* stockage indisponible */
  }
  if (openFileId) connectFile(openFileId); // la présence reprend le nouveau nom
}
export const USER_ID = ORIGIN;

/** Ouvre un fichier : connexion WebSocket à sa salle sur le hub. */
export function connectFile(fileId: string) {
  closeFile();
  openFileId = fileId;
  set({ fileId, role: null, connected: false, presence: { users: [], mcpLastSeen: null }, version: 0, selection: [], aiLog: [] });
  openSocket(fileId);
  loadFileMeta(fileId);
}

/**
 * Coupure réseau : on se reconnecte SANS rien jeter. Nos lots non confirmés sont renvoyés ; un lot que le hub
 * avait déjà appliqué est refusé et il renvoie alors son état complet : ni perte, ni doublon.
 */
function reconnect(fileId: string) {
  if (openFileId !== fileId) return;
  resyncing = true;
  openSocket(fileId);
  loadFileMeta(fileId);
}

let resyncing = false;
let retries = 0;

function openSocket(fileId: string) {
  const params = new URLSearchParams({ file: fileId, user: ORIGIN, name: state.user?.name ?? userName() });
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${params}`;
  const socket = new WebSocket(url);
  ws = socket;
  socket.onopen = () => {
    retries = 0;
    set({ connected: true });
    if (resyncing) {
      // Tout ce qui n'a pas été confirmé repart, dans l'ordre (la file d'attente en est un sous-ensemble)
      queue = [...pending.map((p): ClientMessage => ({ type: "ops", ops: p.ops, label: p.label, origin: p.origin })), ...queue.filter((m) => m.type !== "ops")];
    }
    const out = queue;
    queue = [];
    out.forEach(send);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    set({ connected: false });
    // 1 s, 2 s, 4 s… jusqu'à 10 s entre deux tentatives
    const delay = Math.min(10_000, 1000 * 2 ** retries++);
    setTimeout(() => openFileId === fileId && ws === socket && reconnect(fileId), delay);
  };
  socket.onmessage = (e) => receive(JSON.parse(e.data) as ServerMessage);
}

function loadFileMeta(fileId: string) {
  void api
    .file(fileId)
    .then(({ file, role }) => openFileId === fileId && set({ file, role }))
    .catch((err) => {
      // Hors ligne (« Failed to fetch ») : l'indicateur de connexion le montre déjà, la reconnexion rechargera
      if (!(err instanceof ApiError)) return;
      set({ lastError: err.message });
      setTimeout(() => set({ lastError: null }), 4000);
    });
}

export function closeFile() {
  const old = ws;
  ws = null;
  old?.close();
  openFileId = null;
  serverDoc = null;
  pending = [];
  queue = [];
  resyncing = false;
}

/** Reconstruit le document local : état confirmé + nos lots en attente. */
function rebuild() {
  if (!serverDoc) return;
  const doc = structuredClone(serverDoc);
  pending = pending.filter((p) => {
    try {
      applyOps(doc, p.ops);
      return true;
    } catch {
      return false; // devenu impossible après le changement d'un autre : abandonné
    }
  });
  set({ doc, version: state.version + 1, selection: state.selection.filter((id) => doc.nodes[id]) });
}

function receive(msg: ServerMessage) {
  switch (msg.type) {
    case "doc": {
      void loadDocFonts(msg.doc);
      const first = !serverDoc;
      serverDoc = msg.doc;
      if (resyncing) {
        // Retour après une coupure : nos lots renvoyés sont rejoués par-dessus l'état du hub
        resyncing = false;
        rebuild();
        break;
      }
      pending = [];
      set({ doc: structuredClone(msg.doc), version: state.version + 1, selection: state.selection.filter((id) => msg.doc.nodes[id]) });
      // À l'ouverture, on cadre tout le document (après que le canevas a pris sa taille)
      if (first && msg.doc.roots.length) requestAnimationFrame(() => zoomToFit(msg.doc.roots));
      if (first && pendingImport) {
        const { text, name } = pendingImport;
        pendingImport = null;
        requestAnimationFrame(() => void importSvgText(text, name));
      }
      break;
    }
    case "ops": {
      if (!serverDoc) return;
      try {
        applyOps(serverDoc, msg.ops);
      } catch {
        // Ne devrait pas arriver (le hub a appliqué ce lot) : on redemande l'état complet
        if (openFileId) connectFile(openFileId);
        return;
      }
      if (msg.origin && pending[0]?.origin === msg.origin) {
        pending.shift(); // notre lot, confirmé : le document local l'a déjà
        if (!pending.length) {
          set({ doc: structuredClone(serverDoc), version: state.version + 1 });
        }
      } else {
        rebuild();
        scheduleFit();
      }
      void loadDocFonts(state.doc);
      break;
    }
    case "error":
      set({ lastError: msg.message });
      setTimeout(() => set({ lastError: null }), 4000);
      // Accès retiré ou session terminée pendant la connexion : le hub ferme la WebSocket, on ne se reconnecte pas
      if (msg.message.startsWith("Session terminée")) {
        closeFile();
        set({ user: null, fileId: null, file: null });
      } else if (msg.message.startsWith("Accès retiré") || msg.message === "Fichier introuvable") {
        openFile(null);
      }
      break;
    case "role":
      set({ role: msg.role });
      break;
    case "ai":
      set({ aiLog: [...state.aiLog, msg.event].slice(-300) });
      break;
    case "presence":
      set({ presence: { users: msg.users, mcpLastSeen: msg.mcpLastSeen } });
      break;
  }
}

/** Textes « Ajuster » arrivés d'ailleurs (IA, autre personne) : mesurés ici, puis corrigés si besoin. */
let fitTimer = 0;
function scheduleFit() {
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => {
    const ops = fitTextOps(state.doc);
    if (ops.length) dispatch(ops, "Ajuster les textes");
  }, 300);
}

/** Position du pointeur sur le canevas (coordonnées du document), partagée avec les autres (au plus 20 fois/s). */
let cursorTimer = 0;
let cursorNext: { x: number | null; y: number | null } | null = null;
export function sendCursor(x: number | null, y: number | null) {
  cursorNext = { x: x === null ? null : Math.round(x), y: y === null ? null : Math.round(y) };
  if (cursorTimer) return;
  cursorTimer = window.setTimeout(() => {
    cursorTimer = 0;
    if (cursorNext) send({ type: "cursor", ...cursorNext });
  }, 50);
}

// ---- Actions ----

export function dispatch(ops: Op[], label?: string) {
  if (!ops.length) return;
  if (state.role === "viewer") {
    set({ lastError: "Lecture seule : tu n'as pas les droits de modification sur ce projet" });
    setTimeout(() => set({ lastError: null }), 4000);
    return;
  }
  // Modifier un élément d'une instance mémorise la surcharge (il ne suivra plus le composant pour cette propriété)
  // …et modifier directement une propriété liée à un style partagé détache l'élément de ce style
  ops = withStyleDetach(state.doc, withOverrides(state.doc, ops));
  const doc = structuredClone(state.doc);
  let derived: Op[];
  try {
    derived = applyOpsDetailed(doc, ops).derived;
  } catch (err) {
    set({ lastError: err instanceof Error ? err.message : String(err) });
    return;
  }
  // Textes qui s'ajustent à leur contenu : mesurés ici (le cœur ne sait pas mesurer), dans le même lot
  const fit = fitTextOps(doc);
  if (fit.length) {
    try {
      const res = applyOpsDetailed(doc, fit);
      derived.push(...fit, ...res.derived);
    } catch {
      /* mesure impossible : on garde le lot tel quel */
    }
  }
  set({ doc, version: state.version + 1, selection: state.selection.filter((id) => doc.nodes[id]) });
  // Lot « résolu » : le hub l'applique tel quel, sans connaître les règles du design
  const resolved = [...ops, ...derived];
  const origin = `${ORIGIN}#${++seq}`;
  pending.push({ origin, ops: resolved, label });
  send({ type: "ops", ops: resolved, label, origin });
  scheduleThumbnail();
}

/** Maj+A : une frame seule reçoit l'auto-layout deviné ; sinon la sélection est englobée dans une frame en auto-layout. */
export function addAutoLayout(ids: string[]) {
  const { doc } = state;
  const only = ids.length === 1 ? doc.nodes[ids[0]!] : undefined;
  if (only?.type === "frame" && !only.layout) return dispatch(addAutoLayoutOps(doc, only.id), "Ajouter l'auto-layout");
  const res = wrapInAutoLayoutOps(doc, ids);
  if (!res) return set({ lastError: "Sélectionne des éléments qui ont le même parent" });
  dispatch(res.ops, "Englober dans un auto-layout");
  select([res.frameId]);
}

/** Alt+Maj+A : retire l'auto-layout des frames sélectionnées ; leurs enfants restent à leur place. */
export function removeAutoLayout(ids: string[]) {
  const ops = ids.flatMap((id) => removeAutoLayoutOps(state.doc, id));
  if (!ops.length) return set({ lastError: "Sélectionne une frame en auto-layout" });
  dispatch(ops, "Retirer l'auto-layout");
}

/** Ctrl+G : englobe la sélection dans un groupe (frame transparente, sans auto-layout). */
export function group(ids: string[]) {
  const res = groupOps(state.doc, ids);
  if (!res) return set({ lastError: "Sélectionne des éléments qui ont le même parent" });
  dispatch(res.ops, "Grouper");
  select([res.frameId]);
}

/** Ctrl+Maj+G : dissout les groupes et auto-layouts sélectionnés ; leurs enfants restent à leur place. */
export function ungroup(ids: string[]) {
  const children: string[] = [];
  for (const id of ids) {
    const res = ungroupOps(state.doc, id); // le document local est à jour après chaque dispatch
    if (!res) continue;
    dispatch(res.ops, "Dissocier");
    children.push(...res.childIds);
  }
  if (!children.length) return set({ lastError: "Sélectionne un groupe ou un auto-layout (pas un composant)" });
  select(children);
}

const REORDER_LABELS: Record<Reorder, string> = { front: "Premier plan", forward: "Avancer", backward: "Reculer", back: "Arrière-plan" };

/** Ctrl+] / Ctrl+[ (avec Maj : tout devant / tout derrière) : ordre d'empilement de la sélection. */
export function reorder(ids: string[], where: Reorder) {
  const ops = reorderOps(state.doc, ids, where);
  if (ops.length) dispatch(ops, REORDER_LABELS[where]);
}

// ---- Presse-papiers, duplication, visibilité ----

const CLIP_PREFIX = "swiftma-clipboard:";
/** Dernière copie : le menu « Coller » s'en sert quand le navigateur refuse l'accès au presse-papiers. */
let clipboard: string | null = null;
let pasteCount = 0;

interface ClipItem { tree: NodeTree; parentId: string | null; abs: { x: number; y: number } }

/** Le haut de la sélection : un nœud dont un ancêtre est aussi sélectionné part déjà avec lui. */
export function topLevel(doc: DesignDocument, ids: string[]): string[] {
  return ids.filter((id) => doc.nodes[id] && !ids.some((o) => o !== id && subtree(doc, o).includes(id)));
}

/** Recrée un arbre de nœuds avec de nouveaux identifiants. */
function cloneTree(tree: NodeTree, parentId: string | null, x: number, y: number, ops: Op[]): string {
  const { id: _id, type, children, ...props } = tree;
  const node = makeNode(type, { ...props, text: tree.text ?? undefined, x, y }, newId());
  node.parentId = parentId;
  ops.push({ kind: "create", node });
  for (const c of children) cloneTree(c, node.id, c.x, c.y, ops);
  return node.id;
}

/** Ctrl+C : la sélection, en texte (pour le presse-papiers du système : d'un onglet ou d'un fichier à l'autre). */
export function copySelection(): string | null {
  const { doc, selection } = state;
  const ids = topLevel(doc, selection);
  if (!ids.length) return null;
  const items: ClipItem[] = ids.map((id) => ({ tree: toTree(doc, id), parentId: doc.nodes[id]!.parentId, abs: absolutePosition(doc, id) }));
  clipboard = CLIP_PREFIX + JSON.stringify({ v: 1, items });
  pasteCount = 0;
  return clipboard;
}

export function deleteSelection() {
  const { doc, selection } = state;
  const ids = topLevel(doc, selection);
  if (ids.length) dispatch(ids.map((id) => ({ kind: "delete", id })), "Supprimer");
}

/** Ctrl+X */
export function cutSelection(): string | null {
  const text = copySelection();
  if (text) deleteSelection();
  return text;
}

export const isClipboardText = (text: string | null | undefined) => !!text?.startsWith(CLIP_PREFIX);

/**
 * Ctrl+V : dans la frame sélectionnée (centré), sinon à côté des originaux (décalé de 16 px à chaque
 * collage), sinon au centre de la vue (originaux absents : un autre fichier).
 */
export function pasteClipboard(text: string | null = clipboard): boolean {
  if (!isClipboardText(text)) return false;
  let items: ClipItem[];
  try {
    items = (JSON.parse(text!.slice(CLIP_PREFIX.length)) as { items: ClipItem[] }).items;
  } catch {
    return false;
  }
  if (!items?.length) return false;
  if (text !== clipboard) (clipboard = text), (pasteCount = 0);
  const { doc, selection, view, canvasSize } = state;
  const x0 = Math.min(...items.map((i) => i.abs.x));
  const y0 = Math.min(...items.map((i) => i.abs.y));
  const w = Math.max(...items.map((i) => i.abs.x + i.tree.width)) - x0;
  const h = Math.max(...items.map((i) => i.abs.y + i.tree.height)) - y0;
  const copiedIds = new Set(items.map((i) => i.tree.id));
  const sel = selection.length === 1 ? doc.nodes[selection[0]!] : undefined;
  const into = sel?.type === "frame" && !sel.instanceOf && !sel.isComponentSet && !copiedIds.has(sel.id) ? sel : undefined;
  const ops: Op[] = [];
  const ids: string[] = [];
  if (into) {
    // Dans la frame sélectionnée : le groupe collé est centré dedans
    const ox = Math.round((into.width - w) / 2);
    const oy = Math.round((into.height - h) / 2);
    for (const i of items) ids.push(cloneTree(i.tree, into.id, ox + i.abs.x - x0, oy + i.abs.y - y0, ops));
  } else if (items.every((i) => i.parentId === null || doc.nodes[i.parentId])) {
    // Même fichier : à côté des originaux, dans le même parent
    const d = 16 * ++pasteCount;
    for (const i of items) {
      const p = i.parentId ? absolutePosition(doc, i.parentId) : { x: 0, y: 0 };
      ids.push(cloneTree(i.tree, i.parentId, Math.round(i.abs.x - p.x + d), Math.round(i.abs.y - p.y + d), ops));
    }
  } else {
    // Autre fichier : au centre de la vue
    const cx = (canvasSize.w / 2 - view.x) / view.scale - w / 2;
    const cy = (canvasSize.h / 2 - view.y) / view.scale - h / 2;
    for (const i of items) ids.push(cloneTree(i.tree, null, Math.round(cx + i.abs.x - x0), Math.round(cy + i.abs.y - y0), ops));
  }
  dispatch(ops, "Coller");
  select(ids);
  return true;
}

/** Ctrl+D : copie de la sélection (avec ses enfants), décalée de 16 px. */
export function duplicateSelection() {
  const { doc, selection } = state;
  const ops: Op[] = [];
  const ids = topLevel(doc, selection).map((id) => {
    const n = doc.nodes[id]!;
    return cloneTree(toTree(doc, id), n.parentId, n.x + 16, n.y + 16, ops);
  });
  if (!ids.length) return;
  dispatch(ops, "Dupliquer");
  select(ids);
}

/** Ctrl+Maj+H / Ctrl+Maj+L : masquer-afficher, verrouiller-déverrouiller (tous comme le premier). */
export function toggleSelection(prop: "visible" | "locked") {
  const { doc, selection } = state;
  const ids = selection.filter((id) => doc.nodes[id]);
  if (!ids.length) return;
  const value = !doc.nodes[ids[0]!]![prop];
  dispatch(ids.map((id) => ({ kind: "update", id, props: { [prop]: value } })), prop === "visible" ? (value ? "Afficher" : "Masquer") : value ? "Verrouiller" : "Déverrouiller");
}

/** Ctrl+Alt+K : une frame devient un composant ; sinon la sélection est englobée dans un nouveau composant. */
export function createComponent(ids: string[]) {
  const res = createComponentOps(state.doc, ids);
  if (!res) return set({ lastError: "Sélectionne une frame, ou des éléments qui ont le même parent" });
  dispatch(res.ops, "Créer un composant");
  select([res.id]);
}

/** Pose une instance d'un composant au centre de la vue. */
export function insertInstance(componentId: string) {
  const { doc, view, canvasSize } = state;
  const main = doc.nodes[componentId];
  if (!main) return;
  const x = Math.round((canvasSize.w / 2 - view.x) / view.scale - main.width / 2);
  const y = Math.round((canvasSize.h / 2 - view.y) / view.scale - main.height / 2);
  const res = createInstanceOps(doc, componentId, null, x, y);
  if (!res) return;
  dispatch(res.ops, `Insérer ${main.name}`);
  select([res.id]);
}

/** Frame d'un format prédéfini (téléphone, ordinateur, publication…), posée à droite des maquettes existantes. */
export function insertFrame(name: string, width: number, height: number) {
  const { doc, view, canvasSize } = state;
  const roots = doc.roots.map((id) => doc.nodes[id]!).filter((n) => n.visible);
  const x = roots.length
    ? Math.max(...roots.map((n) => n.x + n.width)) + 100
    : (canvasSize.w / 2 - view.x) / view.scale - width / 2;
  const y = roots.length ? Math.min(...roots.map((n) => n.y)) : (canvasSize.h / 2 - view.y) / view.scale - height / 2;
  const node = makeNode("frame", { name, x: Math.round(x), y: Math.round(y), width, height });
  node.parentId = null;
  dispatch([{ kind: "create", node }], "Créer " + name);
  select([node.id]);
  setTool("select");
  zoomToFit([node.id]);
}

/** Convertit une maquette en auto-layout là où c'est exact ; renvoie le nombre de frames converties. */
export function makeResponsive(id: string): number {
  const { ops, frames } = makeResponsiveOps(state.doc, id);
  dispatch(ops, "Rendre responsive");
  return frames;
}

export const undo = () => send({ type: "undo" });
export const redo = () => send({ type: "redo" });

export function select(ids: string[]) {
  set({ selection: ids, editingTextId: null });
  send({ type: "selection", ids });
}

export const setTool = (tool: Tool) => set({ tool });
export const setLeftTab = (leftTab: LeftTab) => set({ leftTab });
export const setRightTab = (rightTab: RightTab) => set({ rightTab });
export const setCanvasSize = (canvasSize: { w: number; h: number }) => set({ canvasSize });
export const setView = (view: View | ((v: View) => View)) =>
  set({ view: typeof view === "function" ? view(state.view) : view });

const clampScale = (s: number) => Math.min(32, Math.max(0.05, s));

/** Zoom autour du centre du canevas. */
export function zoomTo(scale: number) {
  const { view, canvasSize } = state;
  const next = clampScale(scale);
  const cx = canvasSize.w / 2;
  const cy = canvasSize.h / 2;
  const wx = (cx - view.x) / view.scale;
  const wy = (cy - view.y) / view.scale;
  setView({ scale: next, x: cx - wx * next, y: cy - wy * next });
}
export const zoomBy = (factor: number) => zoomTo(state.view.scale * factor);

/** Cadre la sélection (ou tout le document) dans le canevas. */
export function zoomToFit(ids = state.selection.length ? state.selection : state.doc.roots) {
  const { doc, canvasSize } = state;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    let ax = 0, ay = 0;
    for (let cur: typeof n | undefined = n; cur; cur = cur.parentId ? doc.nodes[cur.parentId] : undefined) (ax += cur.x), (ay += cur.y);
    x0 = Math.min(x0, ax); y0 = Math.min(y0, ay);
    x1 = Math.max(x1, ax + n.width); y1 = Math.max(y1, ay + n.height);
  }
  if (!Number.isFinite(x0)) return setView({ x: 120, y: 80, scale: 1 });
  const pad = 64;
  const scale = clampScale(Math.min((canvasSize.w - pad * 2) / (x1 - x0 || 1), (canvasSize.h - pad * 2) / (y1 - y0 || 1), 2));
  setView({ scale, x: (canvasSize.w - (x1 - x0) * scale) / 2 - x0 * scale, y: (canvasSize.h - (y1 - y0) * scale) / 2 - y0 * scale });
}
export const setEditingText = (id: string | null) => set({ editingTextId: id });

export async function askAi(body: unknown) {
  set({ aiBusy: true });
  try {
    const res = await fetch("/api/ai/design", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(body as object), fileId: state.fileId }),
    });
    const json = await res.json();
    if (!json.ok) set({ lastError: json.error });
  } catch (err) {
    set({ lastError: String(err) });
  } finally {
    set({ aiBusy: false });
  }
}

export const setAiImage = (aiImage: AiImage | null) => set({ aiImage });

/** Charge une image (collée, déposée ou choisie) et la réduit à 1568 px max, la taille idéale pour la vision. */
export async function attachImage(file: Blob) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
    set({ leftTab: "ai" });
    setAiImage({ dataUrl: canvas.toDataURL("image/png"), width: w, height: h, originalWidth: img.naturalWidth, originalHeight: img.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Ctrl+V ou glisser-déposer d'une image : elle devient un calque image sur le canevas, sélectionné,
 * prêt à être mis en arrière-plan et rendu transparent pour décalquer une maquette.
 * `at` = point du document où la poser (sinon le centre de la vue).
 */
export async function insertImage(file: Blob, at?: { x: number; y: number }, name = "Image collée"): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    // Le fichier reste léger : il est stocké dans le document et envoyé à chaque éditeur
    const px = Math.min(1, 2400 / Math.max(nw, nh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(nw * px);
    canvas.height = Math.round(nh * px);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const src = file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp"
      ? canvas.toDataURL("image/png") // transparence conservée
      : canvas.toDataURL("image/jpeg", 0.9);
    // Taille à l'écran : une capture de téléphone (@2x, @3x) prend la largeur d'un écran mobile
    const { w, h } = guessFrameSize(nw, nh);
    const { view, canvasSize } = state;
    const cx = at?.x ?? (canvasSize.w / 2 - view.x) / view.scale;
    const cy = at?.y ?? (canvasSize.h / 2 - view.y) / view.scale;
    const node = makeNode("image", { name, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h, image: { src } });
    node.parentId = null;
    dispatch([{ kind: "create", node }], "Coller une image");
    select([node.id]);
    setTool("select");
    return node.id;
  } catch {
    set({ lastError: "Image illisible : formats acceptés PNG, JPEG, GIF, WebP" });
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Image venant d'un plugin (https: avec CORS, ou data:image/…), insérée comme une image collée. */
export async function insertImageUrl(url: string, name: string): Promise<string> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Image introuvable (${res.status}).`);
  const id = await insertImage(await res.blob(), undefined, name);
  if (!id) throw new Error("Image illisible.");
  return id;
}

/**
 * Insère un SVG (icône, illustration… venant d'un plugin) en calques éditables : au centre de la frame
 * sélectionnée, sinon au centre de la vue. `scaleWithFrame` : ses tracés suivent quand on le redimensionne.
 */
export async function insertSvg(source: string, name: string, opts: { scaleWithFrame?: boolean } = {}): Promise<string> {
  const { ops, rootId } = await importSvg(source, name, { x: 0, y: 0 });
  const root = (ops[0] as Extract<Op, { kind: "create" }>).node;
  const { doc, selection, view, canvasSize } = state;
  const sel = selection.length === 1 ? doc.nodes[selection[0]!] : undefined;
  if (sel && isInsertedGraphic(doc, sel)) {
    // Une icône déjà insérée est sélectionnée : la suivante se pose à côté, pas dedans
    root.parentId = sel.parentId;
    root.x = Math.round(sel.x + sel.width + 8);
    root.y = Math.round(sel.y + (sel.height - root.height) / 2);
  } else if (sel?.type === "frame" && !sel.instanceOf && !sel.isComponentSet) {
    const target = sel;
    root.parentId = target.id;
    root.x = Math.round((target.width - root.width) / 2);
    root.y = Math.round((target.height - root.height) / 2);
  } else {
    root.x = Math.round((canvasSize.w / 2 - view.x) / view.scale - root.width / 2);
    root.y = Math.round((canvasSize.h / 2 - view.y) / view.scale - root.height / 2);
  }
  if (opts.scaleWithFrame) {
    for (const op of ops) if (op.kind === "create" && op.node.id !== rootId) op.node.constraints = { h: "scale", v: "scale" };
  }
  dispatch(ops, `Insérer ${name}`);
  select([rootId]);
  setTool("select");
  return rootId;
}

/** Une icône ou illustration insérée : frame dont tous les enfants suivent sa taille (contraintes « échelle »). */
export function isInsertedGraphic(doc: DesignDocument, n: DesignNode): boolean {
  return n.type === "frame" && n.children.length > 0 && n.children.every((c) => doc.nodes[c]?.constraints?.h === "scale");
}

/** Taille probable d'une capture : un écran mobile @2x/@3x fait 390 px de large, un grand écran 1440. */
export function guessFrameSize(w: number, h: number): { w: number; h: number } {
  if (h > w && w > 500) return { w: 390, h: Math.round((h * 390) / w) };
  if (w > 1920) return { w: 1440, h: Math.round((h * 1440) / w) };
  return { w, h };
}

/** Importe un SVG comme maquette éditable, posée à droite de ce qui existe déjà. */
export async function importSvgText(source: string, name = "Import SVG") {
  const { doc } = state;
  let maxX = -100;
  for (const id of doc.roots) {
    const n = doc.nodes[id]!;
    maxX = Math.max(maxX, n.x + n.width);
  }
  try {
    const t0 = performance.now();
    const { ops, rootId, stats } = await importSvg(source, name, { x: Math.round(maxX + 100), y: 0 });
    dispatch(ops, `Importer ${name}`);
    select([rootId]);
    set({ leftTab: "file" });
    zoomToFit([rootId]);
    const skipped = Object.entries(stats.skipped).map(([k, v]) => `${v} ${k}`).join(", ");
    console.info(`SVG importé : ${stats.nodes} calques en ${Math.round(performance.now() - t0)} ms` + (skipped ? ` (ignorés : ${skipped})` : ""));
    return stats;
  } catch (err) {
    set({ lastError: err instanceof Error ? err.message : String(err) });
    setTimeout(() => set({ lastError: null }), 4000);
    return null;
  }
}

export async function importSvgFile(file: File) {
  return importSvgText(await file.text(), file.name.replace(/\.svg$/i, ""));
}

/** Charge les polices du document ; une fois prêtes, on redessine le canevas avec elles. */
async function loadDocFonts(doc: DesignDocument) {
  if (await ensureFonts(fontVariants(Object.values(doc.nodes)))) set({ fontsVersion: state.fontsVersion + 1 });
}

// ---- Vignette du fichier (écran Projets) ----

let thumbTimer = 0;
let lastThumb = 0;
let thumbnailCapture: (() => string | null) | null = null;
/** Le canevas fournit la fonction de capture (il connaît la scène Konva). */
export function setThumbnailCapture(fn: (() => string | null) | null) {
  thumbnailCapture = fn;
}
function scheduleThumbnail() {
  clearTimeout(thumbTimer);
  // Après 3 s sans modification, et au plus une fois toutes les 20 s
  thumbTimer = window.setTimeout(() => {
    const id = state.fileId;
    if (!id || id === LOCAL_FILE || !thumbnailCapture || Date.now() - lastThumb < 20_000) return;
    const url = thumbnailCapture();
    if (!url) return;
    lastThumb = Date.now();
    void api.putThumbnail(id, url).catch(() => {});
  }, 3000);
}
/** En quittant un fichier : vignette à jour tout de suite. */
export async function flushThumbnail() {
  clearTimeout(thumbTimer);
  const id = state.fileId;
  if (!id || id === LOCAL_FILE) return;
  const url = thumbnailCapture?.();
  if (url) await api.putThumbnail(id, url).catch(() => {});
}

// ---- Routage : / = Projets, /file/<id> = éditeur ----

/** Brouillon hors ligne (/local) : l'éditeur sans hub, rien n'est sauvegardé (essais, banc de fidélité). */
export const LOCAL_FILE = "local";

export function routeFromPath(path = location.pathname): string | null {
  if (path === "/local") return LOCAL_FILE;
  if (path === "/reset") return null;
  const m = /^\/file\/([^/]+)/.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}
export function openFile(id: string | null) {
  const path = id ? `/file/${encodeURIComponent(id)}` : "/";
  if (location.pathname !== path) history.pushState(null, "", path);
  applyRoute();
}
export function applyRoute() {
  const id = routeFromPath();
  if (id === state.fileId) return;
  if (state.fileId && state.fileId !== LOCAL_FILE) void flushThumbnail();
  if (id === LOCAL_FILE) {
    closeFile();
    set({ fileId: LOCAL_FILE, file: null, role: "owner", doc: createDocument("Brouillon local"), selection: [], connected: false });
  } else if (id) connectFile(id);
  else {
    closeFile();
    set({ fileId: null, file: null, doc: createDocument(), selection: [] });
  }
}

// ---- Compte ----

setUnauthorizedHandler(() => {
  if (state.user) {
    closeFile();
    set({ user: null, fileId: null, file: null });
  }
});

/** Au démarrage : qui est connecté ? (null = écran de connexion) */
export async function loadUser() {
  try {
    set({ user: await api.me() });
  } catch {
    set({ user: null });
  }
}
export function setUser(user: User | null) {
  set({ user });
  if (user) applyRoute();
}
export async function logout() {
  await api.logout().catch(() => {});
  closeFile();
  set({ user: null, fileId: null, file: null });
  history.pushState(null, "", "/");
}
