// Diagrammes UML → calques Swiftma (fusion d'Easy Analyst).
// Entrée : le JSON abstrait du skill « analyse-uml » (skills/analyse-uml, catalogue par type de diagramme) :
// l'IA décrit QUOI (acteurs, cas, classes, messages, actions…), jamais OÙ — la mise en page est calculée ici.
// Sortie : des opérations qui créent une frame contenant des formes, textes et vecteurs ordinaires, éditables
// comme le reste (et exportables en React, HTML/SVG).
// Types pris en charge : usecase, class, sequence, activity.

import { type DesignDocument, type DesignNode, type NodeProps, type NodeType, type Stroke, makeNode } from "./model.js";
import type { Op } from "./ops.js";

export type UmlDiagramType = "usecase" | "class" | "sequence" | "activity";
export const UML_DIAGRAM_TYPES: UmlDiagramType[] = ["usecase", "class", "sequence", "activity"];

type Json = Record<string, unknown>;
type Pt = [number, number];
type Shape = "rect" | "ellipse" | "diamond";
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  shape: Shape;
}
type Marker = "open" | "triangle" | "filled" | "diamond" | "filledDiamond";

export class UmlError extends Error {}

const C = {
  ink: "#1F2937",
  muted: "#6B7280",
  line: "#4B5563",
  fill: "#EEF2FF",
  stroke: "#6366F1",
  external: "#FDF2F8",
  externalStroke: "#DB2777",
  include: "#7C3AED",
  extend: "#059669",
  note: "#FEF3C7",
  noteStroke: "#D97706",
  lane: "#F9FAFB",
  frame: "#FFFFFF",
  proposed: "#F59E0B",
};
const FONT = "Inter";

// ---------------------------------------------------------------------------------------------------------------
// Lecture du JSON

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);
const id = (o: Json): string => str(o.id);
const label = (o: Json): string => str(o.label) || str(o.name) || id(o);

/** Type du diagramme : `type` ou `diagram_type` (« use_case » accepté). */
export function umlDiagramType(d: Json): UmlDiagramType {
  const t = (str(d.type) || str(d.diagram_type)).toLowerCase().replace(/[-_\s]/g, "");
  if (t === "usecase") return "usecase";
  if (t === "class" || t === "sequence" || t === "activity") return t;
  if (Array.isArray(d.elements)) return "usecase"; // ancien format d'Easy Analyst (elements « uml:… »)
  throw new UmlError(`Type de diagramme inconnu : « ${str(d.type) || str(d.diagram_type)} » (attendu : ${UML_DIAGRAM_TYPES.join(", ")})`);
}

/** Règles de fermeture du catalogue : tout id cité doit exister. */
function closure(known: Set<string>, refs: [string, string][], what: string) {
  const missing = refs.filter(([, ref]) => ref && !known.has(ref));
  if (missing.length) {
    const list = [...new Set(missing.map(([where, ref]) => `${ref} (${where})`))].slice(0, 12).join(", ");
    throw new UmlError(`${what} : id introuvable(s) : ${list}`);
  }
}

function uniqueIds(items: Json[], what: string): Set<string> {
  const seen = new Set<string>();
  for (const o of items) {
    const i = id(o);
    if (!i) throw new UmlError(`${what} : un élément n'a pas d'id`);
    if (seen.has(i)) throw new UmlError(`${what} : id en double : ${i}`);
    seen.add(i);
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------------------------
// Dessin

/** Largeur approximative d'un texte (Inter) : suffit pour dimensionner les formes. */
export function textWidth(s: string, size: number, weight = 400): number {
  let w = 0;
  for (const ch of s) w += /[il.,:;'|!]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.66 : 0.54;
  return w * size * (weight >= 600 ? 1.06 : 1);
}

function wrapLines(s: string, size: number, width: number, weight = 400): number {
  return s.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(textWidth(line, size, weight) / Math.max(width, 1))), 0);
}

interface TextOpts {
  size?: number;
  weight?: number;
  color?: string;
  align?: "left" | "center" | "right";
  italic?: boolean;
  decoration?: string | null;
  name?: string;
}

class Draw {
  readonly ops: Op[] = [];
  readonly root: DesignNode;
  private maxX = 0;
  private maxY = 0;

  constructor(name: string, x: number, y: number) {
    this.root = makeNode("frame", { name, x, y, fill: C.frame, clip: false, radius: 12 });
    this.ops.push({ kind: "create", node: this.root });
  }

  private grow(x: number, y: number) {
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
  }

  node(type: NodeType, props: NodeProps): DesignNode {
    const n = makeNode(type, props);
    n.parentId = this.root.id;
    this.ops.push({ kind: "create", node: n });
    this.grow(n.x + n.width, n.y + n.height);
    return n;
  }

  rect(b: { x: number; y: number; w: number; h: number }, props: NodeProps & { name: string }): DesignNode {
    return this.node("rect", { x: b.x, y: b.y, width: b.w, height: b.h, ...props });
  }

  text(content: string, x: number, y: number, w: number, o: TextOpts = {}): DesignNode {
    const size = o.size ?? 13;
    const lines = wrapLines(content, size, w, o.weight);
    return this.node("text", {
      name: o.name ?? content.slice(0, 40),
      x,
      y,
      width: w,
      height: Math.ceil(lines * size * 1.3),
      text: {
        content,
        fontFamily: FONT,
        fontSize: size,
        fontWeight: o.weight ?? 400,
        color: o.color ?? C.ink,
        align: o.align ?? "left",
        lineHeight: 1.3,
        italic: o.italic,
        decoration: o.decoration ?? null,
      },
    });
  }

  /** Texte centré sur un point (largeur au plus juste). */
  label(content: string, cx: number, cy: number, o: TextOpts = {}): DesignNode {
    const size = o.size ?? 12;
    const w = Math.ceil(Math.max(...content.split("\n").map((l) => textWidth(l, size, o.weight)))) + 6;
    const h = Math.ceil(content.split("\n").length * size * 1.3);
    return this.text(content, cx - w / 2, cy - h / 2, w, { align: "center", ...o, size });
  }

  /** Vecteur à partir de tracés en coordonnées de la frame. */
  path(parts: { pts: Pt[]; closed?: boolean }[], o: { name: string; stroke?: Stroke | null; fill?: string | null; arcs?: string }): DesignNode {
    const all = parts.flatMap((p) => p.pts);
    const minX = Math.min(...all.map((p) => p[0]));
    const minY = Math.min(...all.map((p) => p[1]));
    const maxX = Math.max(...all.map((p) => p[0]));
    const maxY = Math.max(...all.map((p) => p[1]));
    const f = (v: number) => Math.round(v * 100) / 100;
    const d = parts
      .map((p) => p.pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x - minX)} ${f(y - minY)}`).join(" ") + (p.closed ? " Z" : ""))
      .join(" ");
    return this.node("path", {
      name: o.name,
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      fill: o.fill ?? null,
      stroke: o.stroke === undefined ? null : o.stroke,
      path: { d, fillRule: "nonzero", matrix: [1, 0, 0, 1, 0, 0] },
    });
  }

  /** Trait (polyligne) avec ses extrémités : flèche ouverte, triangle, losange… */
  edge(pts: Pt[], o: { name: string; color?: string; dash?: boolean; start?: Marker; end?: Marker; width?: number }) {
    const color = o.color ?? C.line;
    const stroke: Stroke = { color, width: o.width ?? 1.5, cap: "round", join: "round", dash: o.dash ? [6, 4] : null };
    const parts: { pts: Pt[]; closed?: boolean }[] = [];
    let line = pts.slice();
    const closedShapes: { pts: Pt[]; fill: string }[] = [];
    const end = (marker: Marker | undefined, tip: Pt, from: Pt, atStart: boolean) => {
      if (!marker) return;
      const shape = markerShape(marker, tip, from);
      if (marker === "open") parts.push({ pts: shape });
      else {
        closedShapes.push({ pts: shape, fill: marker === "filled" || marker === "filledDiamond" ? color : C.frame });
        // le trait s'arrête à la base du marqueur
        const base = shape[marker === "diamond" || marker === "filledDiamond" ? 2 : 1]!;
        const b: Pt = marker === "diamond" || marker === "filledDiamond" ? base : [(shape[1]![0] + shape[2]![0]) / 2, (shape[1]![1] + shape[2]![1]) / 2];
        if (atStart) line = [b, ...line.slice(1)];
        else line = [...line.slice(0, -1), b];
      }
    };
    end(o.end, pts[pts.length - 1]!, pts[pts.length - 2]!, false);
    end(o.start, pts[0]!, pts[1]!, true);
    parts.unshift({ pts: line });
    this.path(parts, { name: o.name, stroke });
    for (const s of closedShapes) this.path([{ pts: s.pts, closed: true }], { name: `${o.name} (extrémité)`, stroke: { ...stroke, dash: null }, fill: s.fill });
  }

  /** Taille finale de la frame : le contenu plus une marge. */
  finish(margin = 40): Op[] {
    this.root.width = Math.ceil(this.maxX + margin);
    this.root.height = Math.ceil(this.maxY + margin);
    return this.ops;
  }
}

function markerShape(m: Marker, tip: Pt, from: Pt): Pt[] {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const at = (len: number, da: number): Pt => [tip[0] - len * Math.cos(a + da), tip[1] - len * Math.sin(a + da)];
  switch (m) {
    case "open":
      return [at(11, -0.45), tip, at(11, 0.45)];
    case "triangle":
    case "filled":
      return [tip, at(14, -0.42), at(14, 0.42)];
    case "diamond":
    case "filledDiamond":
      return [tip, at(9, -0.55), at(17, 0), at(9, 0.55)];
  }
}

/** Point du bord d'une forme dans la direction d'un autre point. */
function border(b: Box, toward: Pt): Pt {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const rx = b.w / 2;
  const ry = b.h / 2;
  const t =
    b.shape === "ellipse"
      ? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
      : b.shape === "diamond"
        ? 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry)
        : Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

const center = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2];

/** Segment droit entre deux formes, coupé à leurs bords. */
function between(a: Box, b: Box): Pt[] {
  return [border(a, center(b)), border(b, center(a))];
}

function title(d: Draw, json: Json, kind: string): number {
  const name = str(json.name) || str(json.title);
  const mode = str(json.analysisMode);
  d.text(`${kind}${name ? ` — ${name}` : ""}`, 40, 28, Math.max(320, textWidth(`${kind} — ${name}`, 18, 700) + 10), {
    size: 18,
    weight: 700,
    name: "Titre",
  });
  if (mode) d.text(`Mode d'analyse : ${mode}`, 40, 54, 320, { size: 12, color: C.muted, name: "Mode d'analyse" });
  return mode ? 96 : 80;
}

function notes(d: Draw, json: Json, y: number) {
  const list = strs(json.consistencyNotes);
  if (!list.length) return;
  const w = 520;
  const content = list.map((n) => `• ${n}`).join("\n");
  const h = Math.ceil(wrapLines(content, 12, w - 24) * 12 * 1.3) + 36;
  d.rect({ x: 40, y, w, h }, { name: "Notes de cohérence", fill: C.note, stroke: { color: C.noteStroke, width: 1 }, radius: 6 });
  d.text("Notes de cohérence", 52, y + 8, w - 24, { size: 12, weight: 600, color: "#92400E" });
  d.text(content, 52, y + 26, w - 24, { size: 12, color: "#92400E", name: "Notes" });
}

const isProposed = (o: Json) => /propos|à confirmer|a confirmer|to_verify|hypoth|implémenter|implementer|greenfield/i.test(str(o.status));

/** Couches d'un graphe orienté : plus long chemin depuis les sources, en ignorant les arcs qui ferment un cycle. */
function layers(nodes: string[], edges: [string, string][]): Map<string, number> {
  const out = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) out.get(a)?.push(b);
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const dfs = (v: string) => {
    state.set(v, 1);
    for (const w of out.get(v) ?? []) {
      if (state.get(w) === 1) back.add(`${v}\u0000${w}`);
      else if (!state.get(w)) dfs(w);
    }
    state.set(v, 2);
  };
  const incoming = new Set(edges.map(([, b]) => b));
  for (const n of [...nodes.filter((n) => !incoming.has(n)), ...nodes]) if (!state.get(n)) dfs(n);
  const level = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const [a, b] of edges) {
      if (back.has(`${a}\u0000${b}`) || !level.has(a) || !level.has(b)) continue;
      if (level.get(a)! + 1 > level.get(b)!) (level.set(b, level.get(a)! + 1), (changed = true));
    }
    if (!changed) break;
  }
  return level;
}

// ---------------------------------------------------------------------------------------------------------------
// Cas d'utilisation

function normalizeUseCase(d: Json): Json {
  if (!Array.isArray(d.elements)) return d;
  // Ancien format d'Easy Analyst : elements [{id, type: "uml:actor" | "uml:usecase" | …}], relations [{from|from_id, to, type}]
  const els = arr(d.elements);
  return {
    ...d,
    name: str(d.name) || str(d.title),
    actors: els.filter((e) => /actor/i.test(str(e.type))).map((e) => ({ ...e, kind: e.kind ?? (/ai/i.test(str(e.type)) ? "secondary" : undefined) })),
    useCases: els.filter((e) => /usecase/i.test(str(e.type))),
    notes: els.filter((e) => /note/i.test(str(e.type))),
    relations: arr(d.relations).map((r) => ({ ...r, from: r.from ?? r.from_id, kind: str(r.kind) || str(r.type).replace(/^uml:/, "") })),
  };
}

function drawStickFigure(d: Draw, x: number, y: number, color: string, name: string) {
  // tête (cercle) + corps, bras, jambes : 32 × 64
  d.node("ellipse", { name: `${name} (tête)`, x: x + 8, y, width: 16, height: 16, fill: C.frame, stroke: { color, width: 1.8 } });
  const s: Stroke = { color, width: 1.8, cap: "round", join: "round" };
  d.path(
    [
      { pts: [[x + 16, y + 16], [x + 16, y + 42]] },
      { pts: [[x + 2, y + 26], [x + 30, y + 26]] },
      { pts: [[x + 3, y + 64], [x + 16, y + 42], [x + 29, y + 64]] },
    ],
    { name: `${name} (corps)`, stroke: s },
  );
}

function useCaseOps(json: Json, d: Draw) {
  const j = normalizeUseCase(json);
  const actors = arr(j.actors);
  const cases = arr(j.useCases ?? j.usecases);
  const relations = arr(j.relations);
  const known = uniqueIds([...actors, ...cases], "Cas d'utilisation");
  closure(
    known,
    [
      ...relations.flatMap((r): [string, string][] => [["relations.from", str(r.from)], ["relations.to", str(r.to)]]),
      ...actors.filter((a) => a.parent).map((a): [string, string] => [`actors[${id(a)}].parent`, str(a.parent)]),
    ],
    "Cas d'utilisation",
  );
  for (const r of relations) if (str(r.kind) === "extend" && !str(r.condition)) throw new UmlError(`Relation extend ${str(r.from)} → ${str(r.to)} sans « condition » (obligatoire)`);

  const top = title(d, j, "Cas d'utilisation");
  // Colonnes : cas de base, puis cas inclus / extensions / spécialisations à droite
  const caseIds = new Set(cases.map(id));
  const secondary = new Set<string>();
  for (const r of relations) {
    const k = str(r.kind);
    if (k === "include" && caseIds.has(str(r.to))) secondary.add(str(r.to));
    if ((k === "extend" || k === "generalization") && caseIds.has(str(r.from))) secondary.add(str(r.from));
  }
  // un cas relié directement à un acteur principal reste dans la colonne de base
  const primary = new Set(actors.filter((a) => !/secondary|external/.test(str(a.kind))).map(id));
  for (const r of relations)
    if (str(r.kind) === "association" && (primary.has(str(r.from)) || primary.has(str(r.to)))) [str(r.from), str(r.to)].forEach((x) => caseIds.has(x) && secondary.delete(x));
  const col1 = cases.filter((c) => !secondary.has(id(c)));
  const col2 = cases.filter((c) => secondary.has(id(c)));

  const ucW = (c: Json) => Math.min(240, Math.max(150, textWidth(label(c), 13) * 0.75 + 50));
  const ucH = (c: Json) => Math.max(56, wrapLines(label(c), 13, ucW(c) - 40) * 17 + 26);
  const gap = 26;
  const leftActors = actors.filter((a) => !/secondary|external/.test(str(a.kind)));
  const rightActors = actors.filter((a) => /secondary|external/.test(str(a.kind)));
  if (!rightActors.length && leftActors.length > 2 && !col2.length) rightActors.push(...leftActors.splice(Math.ceil(leftActors.length / 2)));

  const actorColW = 130;
  const bx = 40 + (leftActors.length ? actorColW + 40 : 0);
  const by = top + 10;
  const c1x = bx + 40;
  const c1w = Math.max(150, ...col1.map(ucW));
  const c2x = c1x + c1w + 90;
  const c2w = col2.length ? Math.max(150, ...col2.map(ucW)) : 0;

  const boxes = new Map<string, Box>();
  let y = by + 50;
  for (const c of col1) {
    const w = ucW(c);
    const h = ucH(c);
    boxes.set(id(c), { x: c1x + (c1w - w) / 2, y, w, h, shape: "ellipse" });
    y += h + gap;
  }
  const col1Bottom = y;
  // colonne 2 : à hauteur des cas auxquels ils se rattachent
  let y2 = by + 50;
  for (const c of col2) {
    const linked = relations
      .filter((r) => str(r.from) === id(c) || str(r.to) === id(c))
      .map((r) => boxes.get(str(r.from) === id(c) ? str(r.to) : str(r.from)))
      .filter((b): b is Box => !!b);
    const w = ucW(c);
    const h = ucH(c);
    const want = linked.length ? linked.reduce((s, b) => s + b.y + b.h / 2, 0) / linked.length - h / 2 : y2;
    const yy = Math.max(y2, want);
    boxes.set(id(c), { x: c2x + (c2w - w) / 2, y: yy, w, h, shape: "ellipse" });
    y2 = yy + h + gap;
  }
  const bottom = Math.max(col1Bottom, y2, by + 150);
  const bw = (col2.length ? c2x + c2w : c1x + c1w) + 40 - bx;
  const bh = bottom - by + 10;
  d.rect({ x: bx, y: by, w: bw, h: bh }, { name: "Frontière du système", fill: null, stroke: { color: "#9CA3AF", width: 1.5, dash: [8, 6] }, radius: 10 });
  d.text(str(j.system) || str(j.name) || "Système", bx + 16, by + 14, bw - 32, { size: 14, weight: 600, color: C.muted, name: "Nom du système" });

  // acteurs
  const placeActors = (list: Json[], x: number) => {
    const span = list.length * 110;
    let ay = by + Math.max(20, (bh - span) / 2);
    for (const a of list) {
      const ext = /external/.test(str(a.kind));
      const color = ext ? C.externalStroke : C.ink;
      const fx = x + (actorColW - 32) / 2;
      drawStickFigure(d, fx, ay, color, label(a));
      const t = d.text(label(a), x, ay + 70, actorColW, { size: 12, weight: 600, align: "center", color, name: `Acteur ${label(a)}` });
      boxes.set(id(a), { x: fx - 4, y: ay, w: 40, h: 70 + t.height, shape: "rect" });
      ay += Math.max(110, 80 + t.height + 20);
    }
  };
  placeActors(leftActors, 40);
  placeActors(rightActors, bx + bw + 40);

  for (const c of cases) {
    const b = boxes.get(id(c))!;
    const proposed = isProposed(c);
    d.node("ellipse", {
      name: `Cas ${label(c)}`,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      fill: C.fill,
      stroke: { color: proposed ? C.proposed : C.stroke, width: 1.5, dash: proposed ? [5, 4] : null },
    });
    d.text(label(c), b.x + 20, b.y + b.h / 2 - (wrapLines(label(c), 13, b.w - 40) * 17) / 2, b.w - 40, { size: 13, align: "center", name: label(c) });
  }

  // relations (et généralisations d'acteurs via parent)
  const all: Json[] = [...relations, ...actors.filter((a) => a.parent).map((a) => ({ from: id(a), to: str(a.parent), kind: "generalization" }))];
  for (const r of all) {
    const a = boxes.get(str(r.from))!;
    const b = boxes.get(str(r.to))!;
    const k = str(r.kind) || "association";
    const pts = between(a, b);
    const mid: Pt = [(pts[0]![0] + pts[1]![0]) / 2, (pts[0]![1] + pts[1]![1]) / 2];
    const name = `${k} ${str(r.from)} → ${str(r.to)}`;
    if (k === "include" || k === "extend") {
      const color = k === "include" ? C.include : C.extend;
      d.edge(pts, { name, color, dash: true, end: "open" });
      const cond = k === "extend" && str(r.condition) ? `\n[${str(r.condition)}]` : "";
      d.label(`«${k}»${cond}`, mid[0], mid[1] - 10, { size: 11, color, name: `Libellé ${name}` });
    } else if (k === "generalization") d.edge(pts, { name, end: "triangle" });
    else d.edge(pts, { name });
    if (str(r.label)) d.label(str(r.label), mid[0], mid[1] + 10, { size: 11, color: C.muted });
  }
  notes(d, j, by + bh + 30);
}

// ---------------------------------------------------------------------------------------------------------------
// Classes

const VIS: Record<string, string> = { public: "+", private: "-", protected: "#", package: "~" };
const vis = (v: unknown) => VIS[str(v)] ?? (str(v) || "");

function member(m: Json, op: boolean): string {
  const v = vis(m.visibility ?? (op ? "+" : "-"));
  const params = op ? `(${Array.isArray(m.params) ? m.params.map((p) => (typeof p === "string" ? p : `${str((p as Json).name)}${(p as Json).type ? `: ${str((p as Json).type)}` : ""}`)).join(", ") : str(m.params)})` : "";
  const type = str(m.type) || str(m.returns);
  return `${v} ${str(m.name)}${params}${type ? ` : ${type}` : ""}`.trim();
}

function classOps(j: Json, d: Draw) {
  const classes = arr(j.classes);
  const relations = arr(j.relations);
  const known = uniqueIds(classes, "Classes");
  closure(known, relations.flatMap((r): [string, string][] => [["relations.from", str(r.from)], ["relations.to", str(r.to)]]), "Classes");
  const top = title(d, j, "Diagramme de classes");

  // tailles
  const size = new Map<string, { w: number; h: number; attrs: string[]; ops: string[]; header: number }>();
  for (const c of classes) {
    const attrs = (Array.isArray(c.attributes) ? c.attributes : []).map((a) => (typeof a === "string" ? a : member(a as Json, false)));
    const ops = (Array.isArray(c.operations) ? c.operations : []).map((o) => (typeof o === "string" ? o : member(o as Json, true)));
    const stereo = str(c.stereotype);
    const header = stereo ? 46 : 32;
    const w = Math.ceil(Math.max(150, textWidth(label(c), 14, 700) + 32, ...[...attrs, ...ops].map((l) => textWidth(l, 12) + 24), stereo ? textWidth(`«${stereo}»`, 11) + 24 : 0));
    const h = header + Math.max(1, attrs.length) * 18 + 12 + Math.max(1, ops.length) * 18 + 12;
    size.set(id(c), { w, h, attrs, ops, header });
  }

  // couches : parent au-dessus de l'enfant (généralisation), « tout » au-dessus de la « partie », appelant au-dessus
  const layerEdges = relations.map((r): [string, string] =>
    /generali[sz]ation|realization|implementation/.test(str(r.kind)) ? [str(r.to), str(r.from)] : [str(r.from), str(r.to)],
  );
  const level = layers(classes.map(id), layerEdges);
  const rows: string[][] = [];
  for (const c of classes) (rows[level.get(id(c))!] ??= []).push(id(c));
  const perRow = 4;
  const boxes = new Map<string, Box>();
  const neighbors = (n: string) => layerEdges.filter(([a, b]) => a === n || b === n).map(([a, b]) => (a === n ? b : a));
  let y = top + 10;
  for (const row of rows.filter(Boolean)) {
    // ordre : barycentre des voisins déjà placés (moins de croisements)
    const bary = (n: string) => {
      const xs = neighbors(n).map((m) => boxes.get(m)).filter((b): b is Box => !!b).map((b) => b.x + b.w / 2);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity;
    };
    const sorted = row.map((n, i) => ({ n, i, b: bary(n) })).sort((a, b) => (a.b === b.b ? a.i - b.i : a.b - b.b)).map((o) => o.n);
    for (let i = 0; i < sorted.length; i += perRow) {
      const chunk = sorted.slice(i, i + perRow);
      let x = 40;
      let h = 0;
      for (const n of chunk) {
        const sz = size.get(n)!;
        const want = bary(n);
        if (Number.isFinite(want)) x = Math.max(x, want - sz.w / 2);
        boxes.set(n, { x, y, w: sz.w, h: sz.h, shape: "rect" });
        x += sz.w + 110;
        h = Math.max(h, sz.h);
      }
      y += h + 100;
    }
  }

  for (const c of classes) {
    const b = boxes.get(id(c))!;
    const s = size.get(id(c))!;
    const proposed = isProposed(c);
    const stroke: Stroke = { color: proposed ? C.proposed : C.stroke, width: 1.5, dash: proposed ? [5, 4] : null };
    d.rect(b, { name: `Classe ${label(c)}`, fill: C.frame, stroke, radius: 4 });
    d.rect({ x: b.x, y: b.y, w: b.w, h: s.header }, { name: "En-tête", fill: C.fill, stroke: null, radius: 4 });
    if (str(c.stereotype)) d.text(`«${str(c.stereotype)}»`, b.x + 8, b.y + 6, b.w - 16, { size: 11, align: "center", color: C.muted });
    d.text(label(c), b.x + 8, b.y + s.header - 24, b.w - 16, { size: 14, weight: 700, align: "center", italic: /abstract|abstrait/i.test(str(c.stereotype)), name: label(c) });
    const sep1 = b.y + s.header;
    const sep2 = sep1 + Math.max(1, s.attrs.length) * 18 + 12;
    d.path([{ pts: [[b.x, sep1], [b.x + b.w, sep1]] }, { pts: [[b.x, sep2], [b.x + b.w, sep2]] }], { name: "Séparateurs", stroke: { color: stroke.color, width: 1 } });
    if (s.attrs.length) d.text(s.attrs.join("\n"), b.x + 10, sep1 + 6, b.w - 20, { size: 12, name: "Attributs" });
    if (s.ops.length) d.text(s.ops.join("\n"), b.x + 10, sep2 + 6, b.w - 20, { size: 12, name: "Opérations" });
  }

  for (const r of relations) {
    const a = boxes.get(str(r.from))!;
    const b = boxes.get(str(r.to))!;
    const k = str(r.kind) || "association";
    const pts = between(a, b);
    const name = `${k} ${str(r.from)} → ${str(r.to)}`;
    const nav = str(r.navigability);
    const o: Parameters<Draw["edge"]>[1] = { name };
    if (/generali[sz]ation/.test(k)) o.end = "triangle";
    else if (/realization|implementation/.test(k)) Object.assign(o, { end: "triangle", dash: true });
    else if (k === "composition") o.start = "filledDiamond";
    else if (k === "aggregation") o.start = "diamond";
    else if (k === "dependency") Object.assign(o, { end: "open", dash: true });
    if (!/generali|realiz|implement|dependency/.test(k)) {
      if (nav === "forward" || nav === "both") o.end = "open";
      if ((nav === "backward" || nav === "both") && !o.start) o.start = "open";
    }
    d.edge(pts, o);
    const [p, q] = pts as [Pt, Pt];
    const along = (t: number, off: number): Pt => {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const nx = -(q[1] - p[1]) / len;
      const ny = (q[0] - p[0]) / len;
      return [p[0] + (q[0] - p[0]) * t + nx * off, p[1] + (q[1] - p[1]) * t + ny * off];
    };
    const card = str(r.cardinality) || str(r.multiplicity);
    if (card) {
      const [m1, m2] = card.includes("->") ? card.split("->").map((s) => s.trim()) : ["", card.trim()];
      if (m1) d.label(m1, ...along(0.12, 12), { size: 11, color: C.muted });
      if (m2) d.label(m2, ...along(0.88, 12), { size: 11, color: C.muted });
    }
    if (str(r.role) || str(r.label)) d.label(str(r.role) || str(r.label), ...along(0.5, -12), { size: 11, italic: true, color: C.muted });
  }
  notes(d, j, y);
}

// ---------------------------------------------------------------------------------------------------------------
// Séquence

function sequenceOps(j: Json, d: Draw) {
  const parts = arr(j.participants);
  const messages = arr(j.messages);
  const returns = arr(j.returns);
  const known = uniqueIds(parts, "Séquence");
  closure(
    known,
    [
      ...messages.flatMap((m): [string, string][] => [[`messages[${id(m)}].from`, str(m.from)], [`messages[${id(m)}].to`, str(m.to)]]),
      ...returns.flatMap((r): [string, string][] => [[`returns[${id(r)}].from`, str(r.from)], [`returns[${id(r)}].to`, str(r.to)]]),
      ...arr(j.activations).map((a): [string, string] => [`activations[${id(a)}]`, str(a.participant)]),
    ],
    "Séquence",
  );
  const msgIds = new Set(messages.map(id));
  closure(msgIds, arr(j.fragments).flatMap((f) => strs(f.messages).map((m): [string, string] => [`fragments[${id(f)}]`, m])), "Séquence");
  const top = title(d, j, "Diagramme de séquence");

  // lignes : messages dans l'ordre, retours après le message qu'ils suivent
  type Row = { m: Json; ret: boolean };
  const rows: Row[] = [];
  const placed = new Set<string>();
  const after = new Map<string, Json[]>();
  for (const r of returns) {
    const anchor = msgIds.has(str(r.message)) ? str(r.message) : id(messages.find((m) => str(m.returns) === id(r)) ?? {});
    if (anchor) (after.get(anchor) ?? after.set(anchor, []).get(anchor)!).push(r);
  }
  for (const m of messages) {
    rows.push({ m, ret: str(m.kind) === "return" });
    for (const r of after.get(id(m)) ?? []) if (!placed.has(id(r))) (placed.add(id(r)), rows.push({ m: r, ret: true }));
  }
  for (const r of returns) if (!placed.has(id(r))) rows.push({ m: r, ret: true });

  // colonnes
  const colW = parts.map((p) => Math.max(150, textWidth(label(p), 13, 600) + 40));
  const msgW = Math.max(160, ...rows.map(({ m }) => textWidth(str(m.operation) || str(m.value) || str(m.label), 12) + 40));
  const x0 = 40;
  const cx = new Map<string, number>();
  let x = x0;
  parts.forEach((p, i) => {
    const w = Math.max(colW[i]!, msgW * 0.75);
    cx.set(id(p), x + w / 2);
    x += w + 30;
  });
  const headY = top + 10;
  const headH = 44;
  const rowH = 46;
  const firstRow = headY + headH + 40;
  const rowY = (i: number) => firstRow + i * rowH;
  const lastY = rowY(rows.length) + 10;

  // fragments (derrière)
  const rowOf = new Map<string, number>(rows.map((r, i) => [id(r.m), i]));
  for (const f of arr(j.fragments)) {
    const idx = strs(f.messages).map((m) => rowOf.get(m)).filter((v): v is number => v !== undefined);
    if (!idx.length) continue;
    const involved = strs(f.messages).flatMap((m) => {
      const msg = messages.find((x) => id(x) === m)!;
      return [cx.get(str(msg.from))!, cx.get(str(msg.to))!];
    });
    const fx = Math.min(...involved) - 70;
    const fw = Math.max(...involved) - fx + 70;
    const fy = rowY(Math.min(...idx)) - 30;
    const fh = rowY(Math.max(...idx)) - fy + 12;
    d.rect({ x: fx, y: fy, w: fw, h: fh }, { name: `Fragment ${str(f.kind)}`, fill: null, stroke: { color: "#9CA3AF", width: 1.2 }, radius: 2 });
    const tag = str(f.kind) || "opt";
    const tw = textWidth(tag, 11, 700) + 18;
    d.path([{ pts: [[fx, fy], [fx + tw, fy], [fx + tw, fy + 12], [fx + tw - 6, fy + 18], [fx, fy + 18]], closed: true }], {
      name: `Étiquette ${tag}`,
      fill: "#F3F4F6",
      stroke: { color: "#9CA3AF", width: 1.2 },
    });
    d.text(tag, fx + 4, fy + 2, tw - 8, { size: 11, weight: 700 });
    if (str(f.condition)) d.text(`[${str(f.condition)}]`, fx + tw + 8, fy + 2, fw - tw - 16, { size: 11, color: C.muted });
  }

  // participants et lignes de vie
  for (const p of parts) {
    const c = cx.get(id(p))!;
    const w = Math.max(130, textWidth(label(p), 13, 600) + 28);
    const ext = /external|externe/i.test(str(p.kind) + str(p.role));
    d.rect({ x: c - w / 2, y: headY, w, h: headH }, { name: `Participant ${label(p)}`, fill: ext ? C.external : C.fill, stroke: { color: ext ? C.externalStroke : C.stroke, width: 1.5 }, radius: 6 });
    d.text(label(p), c - w / 2 + 6, headY + 13, w - 12, { size: 13, weight: 600, align: "center", name: label(p) });
    d.path([{ pts: [[c, headY + headH], [c, lastY]] }], { name: `Ligne de vie ${label(p)}`, stroke: { color: "#9CA3AF", width: 1.2, dash: [5, 5] } });
  }

  // activations
  for (const a of arr(j.activations)) {
    const c = cx.get(str(a.participant))!;
    const r1 = rowOf.get(str(a.from));
    const r2 = rowOf.get(str(a.to));
    if (r1 === undefined || r2 === undefined) continue;
    d.rect({ x: c - 6, y: rowY(Math.min(r1, r2)) - 6, w: 12, h: rowY(Math.max(r1, r2)) - rowY(Math.min(r1, r2)) + 12 }, { name: "Activation", fill: "#E0E7FF", stroke: { color: C.stroke, width: 1 } });
  }

  // messages
  rows.forEach(({ m, ret }, i) => {
    const from = cx.get(str(m.from))!;
    const to = cx.get(str(m.to))!;
    const y = rowY(i);
    const kind = ret ? "return" : str(m.kind) || "sync";
    const text = `${str(m.number) ? `${str(m.number)} : ` : ""}${str(m.operation) || str(m.value) || str(m.label)}${str(m.guard) ? ` [${str(m.guard)}]` : ""}`;
    const name = `Message ${id(m)}`;
    const style = {
      sync: { end: "filled" as Marker },
      async: { end: "open" as Marker },
      return: { end: "open" as Marker, dash: true },
      create: { end: "open" as Marker, dash: true },
      destroy: { end: "filled" as Marker },
    }[kind] ?? { end: "filled" as Marker };
    if (from === to) {
      d.edge([[from, y - 8], [from + 44, y - 8], [from + 44, y + 12], [from + 4, y + 12]], { name, ...style });
      if (text) d.text(text, from + 52, y - 6, Math.max(120, textWidth(text, 12) + 8), { size: 12, name: `Libellé ${id(m)}` });
    } else {
      const dir = Math.sign(to - from);
      d.edge([[from + dir * 6, y], [to - dir * 6, y]], { name, ...style });
      const t = kind === "create" ? `«create» ${text}` : text;
      if (t) d.label(t, (from + to) / 2, y - 12, { size: 12, color: ret ? C.muted : C.ink, name: `Libellé ${id(m)}` });
    }
    if (kind === "destroy") d.path([{ pts: [[to - 9, y + 6], [to + 9, y + 24]] }, { pts: [[to + 9, y + 6], [to - 9, y + 24]] }], { name: "Destruction", stroke: { color: "#DC2626", width: 2 } });
  });
  notes(d, j, lastY + 30);
}

// ---------------------------------------------------------------------------------------------------------------
// Activité

interface ActNode {
  id: string;
  kind: "initial" | "final" | "localFinal" | "acceptEvent" | "decision" | "merge" | "fork" | "join" | "action" | "object" | "event";
  label: string;
  lane: string | null;
  proposed: boolean;
}

function activityOps(j: Json, d: Draw) {
  const partitions = arr(j.partitions);
  const nodes: ActNode[] = [];
  const add = (o: Json, kind: ActNode["kind"], lane: string | null) =>
    nodes.push({ id: id(o), kind, label: label(o), lane: lane && partitions.some((p) => id(p) === lane) ? lane : null, proposed: isProposed(o) });
  for (const c of arr(j.controlNodes)) add(c, (["initial", "final", "localFinal", "acceptEvent", "decision", "merge", "fork", "join"].includes(str(c.kind)) ? str(c.kind) : "initial") as ActNode["kind"], str(c.partition));
  for (const a of arr(j.actions)) add(a, "action", str(a.partition));
  for (const dc of arr(j.decisions)) add(dc, "decision", str(dc.partition));
  for (const o of arr(j.objects)) add(o, "object", str(o.partition));
  const flows = arr(j.controlFlows ?? j.flows);
  const objectFlows = arr(j.objectFlows);
  // événements : seulement s'ils sont reliés par un flux
  for (const e of arr(j.events)) if (flows.some((f) => str(f.from) === id(e) || str(f.to) === id(e))) add(e, "acceptEvent", str(e.partition));
  uniqueIds(nodes.map((n) => ({ id: n.id })), "Activité");
  const all = new Set(nodes.map((n) => n.id));
  closure(
    all,
    [
      ...flows.flatMap((f): [string, string][] => [["controlFlows.from", str(f.from)], ["controlFlows.to", str(f.to)]]),
      ...objectFlows.flatMap((f): [string, string][] => [["objectFlows.from", str(f.from)], ["objectFlows.to", str(f.to)]]),
      ...arr(j.decisions).filter((x) => x.after).map((x): [string, string] => [`decisions[${id(x)}].after`, str(x.after)]),
      ...arr(j.regions).flatMap((r) => strs(r.contains).map((c): [string, string] => [`regions[${id(r)}].contains`, c])),
    ],
    "Activité",
  );
  const top = title(d, j, "Diagramme d'activité");

  type E = { from: string; to: string; guard: string; object: boolean };
  const edges: E[] = flows.map((f) => ({ from: str(f.from), to: str(f.to), guard: str(f.guard), object: false }));
  for (const dc of arr(j.decisions)) if (dc.after && !edges.some((e) => e.from === str(dc.after) && e.to === id(dc))) edges.push({ from: str(dc.after), to: id(dc), guard: "", object: false });
  edges.push(...objectFlows.map((f) => ({ from: str(f.from), to: str(f.to), guard: "", object: true })));

  // couloir de chaque nœud : le sien, sinon celui d'un voisin (prédécesseur d'abord pour une décision ou une fin,
  // successeur d'abord pour un début ; producteur d'abord pour un objet)
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const control = edges.filter((e) => !e.object);
  const preds = (n: string, list = control) => list.filter((e) => e.to === n).map((e) => byId.get(e.from)!);
  const succs = (n: string, list = control) => list.filter((e) => e.from === n).map((e) => byId.get(e.to)!);
  const objectEdges = edges.filter((e) => e.object);
  for (let pass = 0; pass < 4; pass++)
    for (const n of nodes) {
      if (n.lane) continue;
      const order =
        n.kind === "object"
          ? [...preds(n.id, objectEdges), ...succs(n.id, objectEdges)]
          : ["initial", "fork", "acceptEvent", "event"].includes(n.kind)
            ? [...succs(n.id), ...preds(n.id)]
            : [...preds(n.id), ...succs(n.id)];
      const lane = order.map((m) => m.lane).find(Boolean);
      if (lane) n.lane = lane;
    }

  // niveaux : plus long chemin sur les flux de contrôle (boucles ignorées) ; un objet se place sous son producteur
  const level = layers(
    nodes.filter((n) => n.kind !== "object").map((n) => n.id),
    control.map((e): [string, string] => [e.from, e.to]),
  );
  const back = new Set<E>(control.filter((e) => level.get(e.to)! <= level.get(e.from)!));
  for (const n of nodes.filter((n) => n.kind === "object")) {
    const p = preds(n.id, objectEdges)[0];
    const c = succs(n.id, objectEdges)[0];
    level.set(n.id, p && level.has(p.id) ? level.get(p.id)! + 1 : c && level.has(c.id) ? Math.max(0, level.get(c.id)! - 1) : 0);
  }

  // placement : couloirs en colonnes, nœuds d'un même niveau côte à côte dans leur couloir
  const lanes = partitions.length ? partitions.map(id) : [""];
  const laneOf = (n: ActNode) => (n.lane && lanes.includes(n.lane) ? n.lane : lanes[0]!);
  const cellW = 210;
  const rowH = 96;
  const count = new Map<string, number>();
  for (const n of nodes) count.set(`${laneOf(n)}|${level.get(n.id)}`, (count.get(`${laneOf(n)}|${level.get(n.id)}`) ?? 0) + 1);
  const laneW = new Map(lanes.map((l) => [l, Math.max(1, ...[...count.entries()].filter(([k]) => k.startsWith(`${l}|`)).map(([, v]) => v)) * cellW]));
  const laneX = new Map<string, number>();
  let lx = 40;
  for (const l of lanes) (laneX.set(l, lx), (lx += laneW.get(l)!));
  const headH = partitions.length ? 40 : 0;
  const y0 = top + 10 + headH + 24;
  const maxLevel = Math.max(0, ...level.values());
  const totalH = headH + 24 + (maxLevel + 1) * rowH + 10;

  if (partitions.length) {
    partitions.forEach((p, i) => {
      const l = id(p);
      const x = laneX.get(l)!;
      const ext = p.external === true;
      d.rect({ x, y: top + 10, w: laneW.get(l)!, h: totalH }, { name: `Couloir ${label(p)}`, fill: i % 2 ? C.frame : C.lane, stroke: { color: "#E5E7EB", width: 1 } });
      d.rect({ x, y: top + 10, w: laneW.get(l)!, h: headH }, { name: "En-tête de couloir", fill: ext ? C.external : "#F3F4F6", stroke: { color: "#E5E7EB", width: 1 } });
      d.text(label(p), x + 8, top + 21, laneW.get(l)! - 16, { size: 13, weight: 600, align: "center", color: ext ? C.externalStroke : C.ink });
    });
  }

  const boxes = new Map<string, Box>();
  const SIZE: Record<ActNode["kind"], [number, number, Shape]> = {
    initial: [26, 26, "ellipse"],
    final: [30, 30, "ellipse"],
    localFinal: [28, 28, "ellipse"],
    acceptEvent: [160, 46, "rect"],
    event: [160, 46, "rect"],
    decision: [44, 44, "diamond"],
    merge: [44, 44, "diamond"],
    fork: [130, 8, "rect"],
    join: [130, 8, "rect"],
    action: [176, 52, "rect"],
    object: [156, 44, "rect"],
  };
  const maxLv = Math.max(0, ...level.values());
  for (let lv = 0; lv <= maxLv; lv++) {
    for (const l of lanes) {
      const group = nodes.filter((n) => laneOf(n) === l && level.get(n.id) === lv);
      // ordre dans la cellule : barycentre des prédécesseurs déjà placés (moins de croisements)
      const bary = (n: ActNode) => {
        const xs = edges.filter((e) => e.to === n.id).map((e) => boxes.get(e.from)).filter((b): b is Box => !!b).map((b) => b.x + b.w / 2);
        return xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : Infinity;
      };
      // les objets d'abord (à gauche) : les flux de contrôle partent vers la droite sans les traverser
      const sorted = group
        .map((n, i) => ({ n, i, b: bary(n), o: n.kind === "object" ? 0 : 1 }))
        .sort((x, y) => x.o - y.o || (x.b === y.b ? x.i - y.i : x.b - y.b));
      sorted.forEach(({ n }, slot) => {
        let [w, h, shape] = SIZE[n.kind];
        if (n.kind === "action" || n.kind === "object" || n.kind === "acceptEvent") h = Math.max(h, wrapLines(n.label, 13, w - 20) * 17 + 18);
        const cxl = laneX.get(l)! + (laneW.get(l)! - group.length * cellW) / 2 + slot * cellW + cellW / 2;
        const cy = y0 + lv * rowH + 26;
        boxes.set(n.id, { x: cxl - w / 2, y: cy - h / 2, w, h, shape });
      });
    }
  }

  // régions interruptibles (derrière les nœuds)
  for (const r of arr(j.regions)) {
    const bs = strs(r.contains).map((c) => boxes.get(c)!);
    if (!bs.length) continue;
    const x1 = Math.min(...bs.map((b) => b.x)) - 16;
    const y1 = Math.min(...bs.map((b) => b.y)) - 22;
    const x2 = Math.max(...bs.map((b) => b.x + b.w)) + 16;
    const y2 = Math.max(...bs.map((b) => b.y + b.h)) + 14;
    d.rect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, { name: `Région ${id(r)}`, fill: null, stroke: { color: "#DC2626", width: 1.2, dash: [6, 4] }, radius: 12 });
    const inter = arr(r.interruptions).map((i) => `⚡ ${str(i.event)}${str(i.handler) ? ` → ${str(i.handler)}` : ""}`).join("\n");
    d.text(inter || "région interruptible", x1 + 8, y1 + 3, x2 - x1 - 16, { size: 10, color: "#DC2626", name: "Interruptions" });
  }

  // flux
  let detour = 0;
  for (const e of edges) {
    const a = boxes.get(e.from)!;
    const b = boxes.get(e.to)!;
    const name = `Flux ${e.from} → ${e.to}`;
    const style = { name, end: "open" as Marker, dash: e.object, color: e.object ? C.muted : C.line };
    let pts: Pt[];
    if (back.has(e) || level.get(e.to)! <= level.get(e.from)!) {
      // retour en arrière : contourne par la droite
      const xr = Math.max(a.x + a.w, b.x + b.w) + 24 + (detour++ % 4) * 10;
      pts = [[a.x + a.w, a.y + a.h / 2], [xr, a.y + a.h / 2], [xr, b.y + b.h / 2], [b.x + b.w, b.y + b.h / 2]];
    } else {
      const [ax, ay] = [a.x + a.w / 2, a.y + a.h];
      const [bx, by] = [b.x + b.w / 2, b.y];
      const start: Pt = a.shape === "diamond" && Math.abs(bx - ax) > 4 ? [bx > ax ? a.x + a.w : a.x, a.y + a.h / 2] : [ax, ay];
      if (Math.abs(start[0] - bx) < 1) pts = [start, [bx, by]];
      else if (start[1] === a.y + a.h / 2) pts = [start, [bx, start[1]], [bx, by]];
      else {
        const my = by - 18;
        pts = [start, [ax, my], [bx, my], [bx, by]];
      }
    }
    d.edge(pts, style);
    if (e.guard) d.text(`[${e.guard}]`, pts[0]![0] + 6, pts[0]![1] + 2, Math.max(60, textWidth(`[${e.guard}]`, 11) + 6), { size: 11, color: C.muted, name: `Garde ${e.guard}` });
  }

  // nœuds
  for (const n of nodes) {
    const b = boxes.get(n.id)!;
    const stroke: Stroke = { color: n.proposed ? C.proposed : C.stroke, width: 1.5, dash: n.proposed ? [5, 4] : null };
    switch (n.kind) {
      case "initial":
        d.node("ellipse", { name: `Début ${n.label}`, x: b.x, y: b.y, width: b.w, height: b.h, fill: C.ink });
        break;
      case "final":
        d.node("ellipse", { name: `Fin ${n.label}`, x: b.x, y: b.y, width: b.w, height: b.h, fill: C.frame, stroke: { color: C.ink, width: 2 } });
        d.node("ellipse", { name: "Fin (centre)", x: b.x + 7, y: b.y + 7, width: b.w - 14, height: b.h - 14, fill: C.ink });
        if (n.label && n.label !== n.id) d.text(n.label, b.x + b.w + 6, b.y + 7, 120, { size: 11, color: C.muted });
        break;
      case "localFinal":
        d.node("ellipse", { name: `Fin de flux ${n.label}`, x: b.x, y: b.y, width: b.w, height: b.h, fill: C.frame, stroke: { color: C.ink, width: 2 } });
        d.path([{ pts: [[b.x + 6, b.y + 6], [b.x + b.w - 6, b.y + b.h - 6]] }, { pts: [[b.x + b.w - 6, b.y + 6], [b.x + 6, b.y + b.h - 6]] }], { name: "Croix", stroke: { color: C.ink, width: 2 } });
        if (n.label && n.label !== n.id) d.text(n.label, b.x + b.w + 6, b.y + 6, 120, { size: 11, color: C.muted });
        break;
      case "decision":
      case "merge":
        d.path([{ pts: [[b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]], closed: true }], { name: `${n.kind === "merge" ? "Fusion" : "Décision"} ${n.label}`, fill: "#FFF7ED", stroke: { ...stroke, color: n.proposed ? C.proposed : "#EA580C" } });
        if (n.label && n.label !== n.id) d.text(n.label, b.x + b.w + 8, b.y - 4, Math.max(100, textWidth(n.label, 11) + 6), { size: 11, color: C.muted });
        break;
      case "fork":
      case "join":
        d.rect(b, { name: n.kind === "fork" ? "Bifurcation" : "Jonction", fill: C.ink, radius: 2 });
        break;
      case "acceptEvent":
      case "event":
        d.path([{ pts: [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x + 16, b.y + b.h / 2]], closed: true }], { name: `Événement ${n.label}`, fill: "#F5F3FF", stroke: { ...stroke, color: n.proposed ? C.proposed : C.include } });
        d.text(n.label, b.x + 20, b.y + b.h / 2 - (wrapLines(n.label, 13, b.w - 30) * 17) / 2, b.w - 28, { size: 13, align: "center" });
        break;
      case "object":
        d.rect(b, { name: `Objet ${n.label}`, fill: C.frame, stroke: { ...stroke, color: n.proposed ? C.proposed : "#9CA3AF" } });
        d.text(n.label, b.x + 10, b.y + b.h / 2 - (wrapLines(n.label, 13, b.w - 20) * 17) / 2, b.w - 20, { size: 13, align: "center", decoration: "underline" });
        break;
      case "action":
        d.rect(b, { name: `Action ${n.label}`, fill: C.fill, stroke, radius: 14 });
        d.text(n.label, b.x + 10, b.y + b.h / 2 - (wrapLines(n.label, 13, b.w - 20) * 17) / 2, b.w - 20, { size: 13, align: "center" });
        break;
    }
  }
  notes(d, j, top + 10 + totalH + 30);
}

// ---------------------------------------------------------------------------------------------------------------

/** Position libre à droite du contenu existant du canevas. */
function freeSpot(doc: DesignDocument): [number, number] {
  let x = 0;
  let found = false;
  for (const rid of doc.roots) {
    const n = doc.nodes[rid];
    if (!n) continue;
    found = true;
    x = Math.max(x, n.x + n.width);
  }
  return [found ? Math.round(x + 120) : 0, 0];
}

export interface UmlResult {
  ops: Op[];
  /** Id de la frame créée. */
  id: string;
  type: UmlDiagramType;
  width: number;
  height: number;
}

/**
 * Construit les opérations qui dessinent un diagramme UML dans une nouvelle frame.
 * `diagram` suit le catalogue du skill analyse-uml ; les ids cités doivent exister (sinon UmlError).
 */
export function umlDiagramOps(doc: DesignDocument, diagram: Json, at?: { x?: number; y?: number }): UmlResult {
  const type = umlDiagramType(diagram);
  const [fx, fy] = freeSpot(doc);
  const name = str(diagram.name) || str(diagram.title) || { usecase: "Cas d'utilisation", class: "Classes", sequence: "Séquence", activity: "Activité" }[type];
  const d = new Draw(`UML ${type} — ${name}`, at?.x ?? fx, at?.y ?? fy);
  ({ usecase: useCaseOps, class: classOps, sequence: sequenceOps, activity: activityOps })[type](diagram, d);
  const ops = d.finish();
  return { ops, id: d.root.id, type, width: d.root.width, height: d.root.height };
}
