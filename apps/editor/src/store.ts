// État de l'éditeur. Le document est une copie locale du document du serveur :
// on applique nos opérations tout de suite (réactivité) puis on les envoie ; celles des autres
// (IA intégrée, IA via MCP, autres onglets) arrivent par WebSocket.

import { useSyncExternalStore } from "react";
import { importSvg } from "./svgImport";
import { ensureFonts } from "./fonts";
import {
  type AiEvent, type ClientMessage, type DesignDocument, type Op, type ServerMessage,
  addAutoLayoutOps, applyOps, applyOpsDetailed, createDocument, fontVariants, makeResponsiveOps, newId, wrapInAutoLayoutOps,
} from "@nyota/core";

export interface AiImage {
  dataUrl: string;
  width: number; // dimensions de l'image (après réduction éventuelle)
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export interface View { x: number; y: number; scale: number }
export type LeftTab = "file" | "ai";
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
  presence: { editors: number; mcpLastSeen: number | null };
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
  presence: { editors: 1, mcpLastSeen: null },
  fontsVersion: 0,
};

const listeners = new Set<() => void>();
function set(patch: Partial<EditorState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useEditor<T>(select: (s: EditorState) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => select(state),
  );
}
export const getState = () => state;

// ---- Connexion ----

let ws: WebSocket | null = null;
let queue: ClientMessage[] = [];

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else queue.push(msg);
}

export function connect() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    set({ connected: true });
    queue.forEach(send);
    queue = [];
  };
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => receive(JSON.parse(e.data) as ServerMessage);
}

function receive(msg: ServerMessage) {
  switch (msg.type) {
    case "doc": {
      void loadDocFonts(msg.doc);
      const first = state.version === 0;
      set({ doc: msg.doc, version: state.version + 1, selection: state.selection.filter((id) => msg.doc.nodes[id]) });
      // À l'ouverture, on cadre tout le document (après que le canevas a pris sa taille)
      if (first && msg.doc.roots.length) requestAnimationFrame(() => zoomToFit(msg.doc.roots));
      break;
    }
    case "ops": {
      if (msg.origin === ORIGIN) return; // déjà appliqué localement
      const doc = structuredClone(state.doc);
      try {
        applyOps(doc, msg.ops);
      } catch {
        return; // le serveur nous renverra le document complet
      }
      set({ doc, version: state.version + 1, selection: state.selection.filter((id) => doc.nodes[id]) });
      void loadDocFonts(doc);
      break;
    }
    case "error":
      set({ lastError: msg.message });
      setTimeout(() => set({ lastError: null }), 4000);
      break;
    case "ai":
      set({ aiLog: [...state.aiLog, msg.event].slice(-300) });
      break;
    case "presence":
      set({ presence: { editors: msg.editors, mcpLastSeen: msg.mcpLastSeen } });
      break;
  }
}

// ---- Actions ----

export function dispatch(ops: Op[], label?: string) {
  if (!ops.length) return;
  const doc = structuredClone(state.doc);
  let derived: Op[];
  try {
    derived = applyOpsDetailed(doc, ops).derived;
  } catch (err) {
    set({ lastError: err instanceof Error ? err.message : String(err) });
    return;
  }
  set({ doc, version: state.version + 1, selection: state.selection.filter((id) => doc.nodes[id]) });
  // Lot « résolu » : le serveur l'applique tel quel, sans connaître les règles du design
  send({ type: "ops", ops: [...ops, ...derived], label, origin: ORIGIN });
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
      body: JSON.stringify(body),
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
