// Auto-layout : les frames qui en ont un placent et dimensionnent leurs enfants toutes seules.
//
// Le moteur est une fonction pure du document : après chaque lot d'opérations, il recalcule x/y/largeur/hauteur
// des enfants concernés. Il tourne à l'identique dans l'éditeur et sur le serveur, donc les positions restent
// synchronisées sans être envoyées. Ses règles sont celles de Figma, que l'export React traduit en flexbox :
//  - « fixed » : la taille reste celle du nœud ;
//  - « fill »  : le nœud se partage l'espace libre de son parent (axe principal) ou s'étire (axe secondaire) ;
//  - « hug »   : une frame en auto-layout prend la taille de son contenu.

import { type AutoLayout, type DesignDocument, type DesignNode, type NodeProps, type Sizing, makeNode, newId, resizeProps } from "./model.js";
import { type Op, applyOps } from "./ops.js";

type Axis = "h" | "v";
type Changes = Map<string, NodeProps>;

const EPS = 1e-6;

export const sizingOf = (n: DesignNode, axis: Axis): Sizing => (axis === "h" ? n.sizingH : n.sizingV) ?? "fixed";

/** Le nœud suit-il l'auto-layout de son parent ? */
export function inFlow(doc: DesignDocument, n: DesignNode): boolean {
  const parent = n.parentId ? doc.nodes[n.parentId] : undefined;
  return !!parent?.layout && n.visible && !n.absolute;
}

/** Recalcule toutes les frames en auto-layout. Renvoie, pour chaque nœud modifié, ses anciennes valeurs. */
export function relayout(doc: DesignDocument): Changes {
  const changes: Changes = new Map();
  if (!Object.values(doc.nodes).some((n) => n.layout)) return changes;
  for (const id of doc.roots) place(doc, doc.nodes[id]!, changes);
  return changes;
}

/** Taille « ajustée au contenu » d'un nœud sur chaque axe (sa taille actuelle s'il n'est pas en « hug »). */
function hugSize(doc: DesignDocument, n: DesignNode): { w: number; h: number } {
  const L = n.layout;
  const hugW = L && sizingOf(n, "h") === "hug";
  const hugV = L && sizingOf(n, "v") === "hug";
  if (!hugW && !hugV) return { w: n.width, h: n.height };
  const kids = flowChildren(doc, n).map((k) => hugSize(doc, k));
  const [pt, pr, pb, pl] = L!.padding;
  const row = L!.direction === "row";
  const gaps = Math.max(0, kids.length - 1) * L!.gap;
  const main = kids.reduce((s, k) => s + (row ? k.w : k.h), 0) + gaps;
  const cross = kids.reduce((m, k) => Math.max(m, row ? k.h : k.w), 0);
  const contentW = row ? main : cross;
  const contentH = row ? cross : main;
  return { w: hugW ? contentW + pl + pr : n.width, h: hugV ? contentH + pt + pb : n.height };
}

const flowChildren = (doc: DesignDocument, n: DesignNode) =>
  n.children.map((id) => doc.nodes[id]!).filter((k) => k.visible && !k.absolute);

/** Place récursivement : la taille du nœud est déjà décidée (par son parent ou par lui-même). */
function place(doc: DesignDocument, n: DesignNode, changes: Changes) {
  const L = n.layout;
  if (L) {
    // Une frame « hug » qui n'est pas dans un auto-layout se dimensionne elle-même
    if (!inFlow(doc, n)) {
      const s = hugSize(doc, n);
      set(n, { width: s.w, height: s.h }, changes);
    }
    arrange(doc, n, L, changes);
  }
  for (const id of n.children) place(doc, doc.nodes[id]!, changes);
}

function arrange(doc: DesignDocument, n: DesignNode, L: AutoLayout, changes: Changes) {
  const kids = flowChildren(doc, n);
  if (!kids.length) return;
  const [pt, pr, pb, pl] = L.padding;
  const row = L.direction === "row";
  const innerMain = Math.max(0, (row ? n.width - pl - pr : n.height - pt - pb));
  const innerCross = Math.max(0, (row ? n.height - pt - pb : n.width - pl - pr));
  const mainAxis: Axis = row ? "h" : "v";
  const crossAxis: Axis = row ? "v" : "h";

  // Taille de base de chaque enfant sur les deux axes
  const items = kids.map((k) => {
    const hug = hugSize(doc, k);
    const fillMain = sizingOf(k, mainAxis) === "fill";
    const fillCross = sizingOf(k, crossAxis) === "fill";
    return {
      k,
      fillMain,
      main: fillMain ? 0 : row ? hug.w : hug.h,
      cross: fillCross ? innerCross : row ? hug.h : hug.w,
      fillCross,
    };
  });

  // Découpage en lignes (retour à la ligne) ; un enfant « fill » garde alors sa taille actuelle
  const lines: (typeof items)[] = [];
  if (row && L.wrap) {
    for (const it of items) if (it.fillMain) (it.fillMain = false), (it.main = it.k.width);
    let line: typeof items = [];
    let used = 0;
    for (const it of items) {
      const next = used + (line.length ? L.gap : 0) + it.main;
      if (line.length && next > innerMain + EPS) {
        lines.push(line);
        line = [];
        used = 0;
      }
      used += (line.length ? L.gap : 0) + it.main;
      line.push(it);
    }
    lines.push(line);
  } else lines.push(items);

  const lineGap = L.wrapGap ?? L.gap;
  let crossPos = row ? pt : pl;
  for (const line of lines) {
    const fills = line.filter((it) => it.fillMain);
    const fixed = line.reduce((s, it) => s + it.main, 0);
    let free = innerMain - fixed - L.gap * (line.length - 1);
    if (fills.length) {
      const share = Math.max(0, free) / fills.length;
      for (const it of fills) it.main = share;
      free = 0;
    }
    let gap = L.gap;
    let pos = row ? pl : pt;
    if (!fills.length) {
      if (L.justify === "center") pos += free / 2;
      else if (L.justify === "end") pos += free;
      else if (L.justify === "space-between" && line.length > 1) gap = L.gap + free / (line.length - 1);
      else if (L.justify === "space-between") pos += 0;
    }
    // Hauteur de la ligne : celle de l'enfant le plus grand (sans retour à la ligne : tout l'intérieur)
    const lineCross = lines.length > 1 ? Math.max(...line.map((it) => (it.fillCross ? 0 : it.cross))) : innerCross;
    for (const it of line) {
      const cross = it.fillCross ? lineCross : it.cross;
      let c = crossPos;
      if (!it.fillCross) {
        if (L.align === "center") c += (lineCross - cross) / 2;
        else if (L.align === "end") c += lineCross - cross;
      }
      const w = row ? it.main : cross;
      const h = row ? cross : it.main;
      set(it.k, { x: row ? pos : c, y: row ? c : pos, width: w, height: h }, changes);
      pos += it.main + gap;
    }
    crossPos += lineCross + lineGap;
  }
}

/** Modifie un nœud en gardant ses anciennes valeurs ; un vecteur redimensionné voit son dessin étiré. */
function set(n: DesignNode, p: { x?: number; y?: number; width: number; height: number }, changes: Changes) {
  const props: NodeProps = {};
  if (p.x !== undefined && Math.abs(p.x - n.x) > EPS) props.x = p.x;
  if (p.y !== undefined && Math.abs(p.y - n.y) > EPS) props.y = p.y;
  if (Math.abs(p.width - n.width) > EPS || Math.abs(p.height - n.height) > EPS) Object.assign(props, resizeProps(n, p.width, p.height));
  if (!Object.keys(props).length) return;
  const before = changes.get(n.id) ?? {};
  for (const key of Object.keys(props) as (keyof NodeProps)[]) {
    if (!(key in before)) (before as Record<string, unknown>)[key] = structuredClone(n[key as keyof DesignNode]);
  }
  changes.set(n.id, before);
  Object.assign(n, props);
}

// ---------- Détection : passer d'une maquette en positions fixes à l'auto-layout ----------

export interface InferredLayout {
  layout: AutoLayout;
  order: string[]; // ordre des enfants dans le flux
  /** L'auto-layout reproduit-il exactement les positions actuelles (à `tolerance` près) ? */
  exact: boolean;
  sizing: Record<string, { sizingH?: Sizing; sizingV?: Sizing }>;
  frameSizing: { sizingH?: Sizing; sizingV?: Sizing };
}

/**
 * Devine l'auto-layout d'une frame à partir de la disposition de ses enfants (comme Maj+A dans Figma) :
 * direction, espacement, marges, alignement. `exact` dit si le résultat garde chaque enfant à sa place.
 */
export function inferLayout(doc: DesignDocument, frameId: string, tolerance = 0.5): InferredLayout | null {
  const f = doc.nodes[frameId];
  if (!f) return null;
  const kids = f.children.map((id) => doc.nodes[id]!).filter((k) => k.visible && !k.absolute);
  if (!kids.length) {
    return { layout: { direction: "column", gap: 0, padding: [0, 0, 0, 0], justify: "start", align: "start" }, order: [], exact: true, sizing: {}, frameSizing: {} };
  }
  const box = (k: DesignNode) => ({ x: k.x, y: k.y, r: k.x + k.width, b: k.y + k.height });
  const try_ = (row: boolean) => {
    const sorted = [...kids].sort((a, b) => (row ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
    let overlap = false;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = box(sorted[i - 1]!);
      const cur = box(sorted[i]!);
      const g = row ? cur.x - prev.r : cur.y - prev.b;
      if (g < -tolerance) overlap = true;
      gaps.push(g);
    }
    return { row, sorted, overlap, gaps };
  };
  const h = try_(true);
  const v = try_(false);
  const spread = (sel: (k: DesignNode) => number) => Math.max(...kids.map(sel)) - Math.min(...kids.map(sel));
  // Sans chevauchement d'un côté seulement : c'est lui ; sinon, l'axe où les enfants sont le plus étalés
  const pick = h.overlap !== v.overlap ? (h.overlap ? v : h) : spread((k) => k.x) > spread((k) => k.y) ? h : v;
  const { row, sorted, gaps } = pick;

  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)]! : 0;
  const gap = Math.max(0, Math.round(median * 100) / 100);
  const minX = Math.min(...kids.map((k) => k.x));
  const minY = Math.min(...kids.map((k) => k.y));
  const maxR = Math.max(...kids.map((k) => k.x + k.width));
  const maxB = Math.max(...kids.map((k) => k.y + k.height));
  const r2 = (n: number) => Math.max(0, Math.round(n * 100) / 100);
  const rawPadding = [minY, f.width - maxR, f.height - maxB, minX];
  const padding: [number, number, number, number] = [r2(rawPadding[0]!), r2(rawPadding[1]!), r2(rawPadding[2]!), r2(rawPadding[3]!)];

  // Alignement secondaire : bord de départ, centre ou bord d'arrivée communs à tous les enfants
  const [pt, pr, pb, pl] = padding;
  const innerStart = row ? pt : pl;
  const innerEnd = row ? f.height - pb : f.width - pr;
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const starts = kids.map((k) => (row ? k.y : k.x));
  const ends = kids.map((k) => (row ? k.y + k.height : k.x + k.width));
  const centers = kids.map((k, i) => (starts[i]! + ends[i]!) / 2);
  const align: AutoLayout["align"] = starts.every((s) => near(s, innerStart))
    ? "start"
    : centers.every((c) => near(c, (innerStart + innerEnd) / 2))
      ? "center"
      : ends.every((e) => near(e, innerEnd))
        ? "end"
        : "start";

  const layout: AutoLayout = { direction: row ? "row" : "column", gap, padding, justify: "start", align };

  // Enfants qui occupent toute la largeur (colonne) ou hauteur (ligne) intérieure : « remplir » sur cet axe.
  // C'est ce qui rend la mise en page responsive, sans rien changer à l'écran.
  const sizing: InferredLayout["sizing"] = {};
  const innerCross = innerEnd - innerStart;
  for (const k of kids) {
    // (en colonne seulement : dans une rangée, des hauteurs étirées empêcheraient le retour à la ligne de grandir)
    const cross = row ? k.height : k.width;
    if (!row && near(cross, innerCross) && innerCross > 0 && k.type !== "path" && k.type !== "image" && k.type !== "ellipse") {
      sizing[k.id] = row ? { sizingV: "fill" } : { sizingH: "fill" };
    }
  }

  // Vérification : on simule l'auto-layout et on compare aux positions actuelles.
  // Un enfant qui déborde de la frame (marge négative) ne peut pas être reproduit.
  let exact = rawPadding.every((p) => p >= -tolerance);
  let pos = row ? pl : pt;
  for (const k of sorted) {
    const main = row ? k.x : k.y;
    if (!near(main, pos)) exact = false;
    pos += (row ? k.width : k.height) + gap; // position simulée : les petits écarts ne doivent pas s'additionner
    const s = row ? k.y : k.x;
    const size = row ? k.height : k.width;
    const expected = align === "start" ? innerStart : align === "center" ? innerStart + (innerCross - size) / 2 : innerEnd - size;
    if (!near(s, expected)) exact = false;
  }
  // La frame « ajuste » son contenu sur l'axe principal si rien ne dépasse ni ne manque
  const frameSizing: InferredLayout["frameSizing"] = {};
  if (near(pos - gap + (row ? pr : pb), row ? f.width : f.height)) frameSizing[row ? "sizingH" : "sizingV"] = "hug";

  return { layout, order: sorted.map((k) => k.id), exact, sizing, frameSizing };
}

// ---------- Opérations prêtes à l'emploi ----------

/** Ajoute l'auto-layout deviné à une frame (Maj+A). Les enfants sont réordonnés dans l'ordre du flux. */
export function addAutoLayoutOps(doc: DesignDocument, frameId: string): Op[] {
  const inf = inferLayout(doc, frameId);
  if (!inf) return [];
  return layoutOps(doc, frameId, inf);
}

function layoutOps(doc: DesignDocument, frameId: string, inf: InferredLayout): Op[] {
  const f = doc.nodes[frameId]!;
  const ops: Op[] = [];
  // Ordre du flux = ordre des enfants ; les enfants hors flux gardent leur place relative
  const flow = new Set(inf.order);
  const others = f.children.filter((id) => !flow.has(id));
  const target = [...inf.order, ...others];
  if (target.some((id, i) => f.children[i] !== id)) target.forEach((id, i) => ops.push({ kind: "move", id, parentId: frameId, index: i }));
  for (const [id, s] of Object.entries(inf.sizing)) ops.push({ kind: "update", id, props: s });
  ops.push({ kind: "update", id: frameId, props: { layout: inf.layout, ...inf.frameSizing } });
  return ops;
}

/** Englobe des nœuds frères dans une nouvelle frame en auto-layout qui ajuste son contenu (Maj+A sur une sélection). */
export function wrapInAutoLayoutOps(doc: DesignDocument, ids: string[]): { ops: Op[]; frameId: string } | null {
  const nodes = ids.map((id) => doc.nodes[id]).filter((n): n is DesignNode => !!n);
  if (!nodes.length || nodes.some((n) => n.parentId !== nodes[0]!.parentId)) return null;
  const parentId = nodes[0]!.parentId;
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  const w = Math.max(...nodes.map((n) => n.x + n.width)) - x;
  const h = Math.max(...nodes.map((n) => n.y + n.height)) - y;
  const siblings = parentId ? doc.nodes[parentId]!.children : doc.roots;
  const index = Math.min(...nodes.map((n) => siblings.indexOf(n.id)));
  const frame = makeNode("frame", { name: "Auto-layout", x, y, width: w, height: h, fill: null, clip: false }, newId());
  frame.parentId = parentId;
  const ops: Op[] = [{ kind: "create", node: frame, index }];
  for (const n of nodes) {
    ops.push({ kind: "move", id: n.id, parentId: frame.id });
    ops.push({ kind: "update", id: n.id, props: { x: n.x - x, y: n.y - y } });
  }
  // On devine la mise en page sur une copie où le déplacement est déjà fait
  const sim: DesignDocument = structuredClone(doc);
  sim.nodes[frame.id] = { ...structuredClone(frame), children: nodes.map((n) => n.id) };
  for (const n of nodes) Object.assign(sim.nodes[n.id]!, { parentId: frame.id, x: n.x - x, y: n.y - y });
  const inf = inferLayout(sim, frame.id)!;
  ops.push(...layoutOps(sim, frame.id, { ...inf, frameSizing: { sizingH: "hug", sizingV: "hug" } }).filter((o) => o.kind !== "move"));
  // Ordre du flux
  inf.order.forEach((id, i) => ops.push({ kind: "move", id, parentId: frame.id, index: i }));
  return { ops, frameId: frame.id };
}

/**
 * Rend une maquette responsive sans la changer à l'écran : chaque frame dont les enfants forment une pile
 * régulière (ligne ou colonne) passe en auto-layout, les éléments pleine largeur passent en « remplir »,
 * et la racine prend toute la largeur disponible. Les frames irrégulières gardent leurs positions fixes.
 */
export function makeResponsiveOps(source: DesignDocument, rootId: string): { ops: Op[]; frames: number } {
  const ops: Op[] = [];
  let frames = 0;
  let rootConverted = false;
  // On travaille sur une copie : la fusion des fonds change la structure avant la détection
  const doc: DesignDocument = structuredClone(source);
  const merges = backgroundMergeOps(doc, rootId);
  applyOps(doc, merges);
  ops.push(...merges);
  const walk = (id: string) => {
    const n = doc.nodes[id]!;
    n.children.forEach(walk);
    if (n.type !== "frame" || n.layout || !n.children.length) return;
    const kids = n.children.map((k) => doc.nodes[k]!).filter((k) => k.visible && !k.absolute);
    if (!kids.length || kids.some((k) => k.rotation)) return;
    // Tolérance de 1 px : les maquettes réelles ont souvent un espacement à 1 px près (96, 96, 97…)
    const inf = inferLayout(doc, id, 1);
    if (!inf?.exact) return;
    frames++;
    if (id === rootId) rootConverted = true;
    const L = inf.layout;
    // La frame s'ajuste à son contenu : quand une rangée passe à la ligne, elle grandit au lieu de rogner
    // (sauf sur un axe où un enfant la remplit : elle garde alors sa taille, ou celle que lui donne son parent)
    const fillsH = Object.values(inf.sizing).some((z) => z.sizingH === "fill");
    const fillsV = Object.values(inf.sizing).some((z) => z.sizingV === "fill");
    inf.frameSizing = { sizingH: fillsH ? "fixed" : "hug", sizingV: fillsV ? "fixed" : "hug" };
    if (L.direction === "row" && kids.length > 1) {
      // Rangée : retour à la ligne quand la place manque. On garde une marge infime pour qu'à la taille
      // de la maquette tout tienne sur une ligne malgré les arrondis du navigateur.
      const inner = n.width - L.padding[1] - L.padding[3];
      const total = kids.reduce((sum, k) => sum + k.width, 0) + L.gap * (kids.length - 1);
      let over = total - (inner - 0.05);
      if (over > 0) {
        // On prend sur la marge de droite (rien ne bouge), sinon sur l'espacement (écart invisible)
        const fromPadding = Math.min(over, L.padding[1]);
        L.padding = [L.padding[0], L.padding[1] - fromPadding, L.padding[2], L.padding[3]];
        over -= fromPadding;
        if (over > 0) L.gap = Math.max(0, L.gap - over / (kids.length - 1));
      }
      L.wrap = true;
      L.wrapGap = Math.min(L.gap, 24);
      if (L.gap > 48 && !fillsH) {
        // Grand écart régulier = éléments repoussés aux bords (logo à gauche, menu à droite…) : on répartit
        // l'espace (space-between) sur une largeur fixe ; à l'écran rien ne change, et sur un écran étroit
        // les éléments se rapprochent au lieu de déborder.
        L.justify = "space-between";
        L.gap = 16;
        L.wrapGap = 16;
        inf.frameSizing.sizingH = "fixed";
      }
    }
    ops.push(...layoutOps(doc, id, inf));
  };
  walk(rootId);
  ops.push({ kind: "update", id: rootId, props: { sizingH: "fill", ...(rootConverted ? { sizingV: "hug" } : {}) } });
  return { ops, frames };
}

/**
 * Un export SVG de Figma dessine le fond d'une frame comme un rectangle posé derrière tout son contenu.
 * Ce rectangle chevauche tout et empêche de voir la pile d'éléments : on le rend à la frame (remplissage,
 * contour, rayon, ombres), comme dans Figma. Le rendu ne change pas.
 */
export function backgroundMergeOps(doc: DesignDocument, rootId: string): Op[] {
  const ops: Op[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  for (const id of subtreeIds(doc, rootId)) {
    const f = doc.nodes[id]!;
    if (f.type !== "frame" || f.fill || f.gradient || f.stroke || f.shadows?.length || f.layerBlur || f.backgroundBlur) continue;
    const bg = f.children.map((c) => doc.nodes[c]!).find((c) => c.visible);
    if (!bg || bg.type !== "rect" || bg.children.length || bg.opacity !== 1 || bg.rotation || bg.layerBlur || bg.backgroundBlur || bg.clipPath) continue;
    if (!near(bg.x, 0) || !near(bg.y, 0) || !near(bg.width, f.width) || !near(bg.height, f.height)) continue;
    // Une frame qui rogne avec des coins arrondis rognerait aussi ses enfants : seulement sans arrondi ou avec un masque propre
    if (f.clip && !f.clipPath && bg.radius) continue;
    if (f.clip && bg.shadows?.length) continue; // l'ombre était rognée par la frame
    ops.push({ kind: "update", id: f.id, props: { fill: bg.fill, gradient: bg.gradient ?? null, stroke: bg.stroke, radius: bg.radius, shadows: bg.shadows ?? null } });
    ops.push({ kind: "delete", id: bg.id });
  }
  return ops;
}

function subtreeIds(doc: DesignDocument, id: string): string[] {
  const out = [id];
  for (const c of doc.nodes[id]!.children) out.push(...subtreeIds(doc, c));
  return out;
}
