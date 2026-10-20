// Organisation des calques : ordre d'empilement, groupes, retrait de l'auto-layout.
//
// Tout s'exprime avec les opérations génériques (create, update, move, delete) : le hub les applique sans
// connaître le design, et Ctrl+Z les annule comme le reste. Les enfants sont empilés du fond (index 0)
// vers l'avant (dernier index), comme dans le panneau Calques lu de bas en haut.

import { type DesignDocument, type DesignNode, type NodeProps, makeNode, newId } from "./model.js";
import type { Op } from "./ops.js";

export type Reorder = "front" | "forward" | "backward" | "back";

const siblingsOf = (doc: DesignDocument, parentId: string | null) => (parentId ? doc.nodes[parentId]!.children : doc.roots);

/** Premier plan, avancer, reculer, arrière-plan. Les nœuds sélectionnés gardent leur ordre entre eux. */
export function reorderOps(doc: DesignDocument, ids: string[], where: Reorder): Op[] {
  const ops: Op[] = [];
  // On travaille parent par parent, sur une copie de l'ordre des frères
  const byParent = new Map<string | null, string[]>();
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), id]);
  }
  for (const [parentId, moved] of byParent) {
    const order = [...siblingsOf(doc, parentId)];
    const set = new Set(moved);
    let next: string[];
    if (where === "front") next = [...order.filter((id) => !set.has(id)), ...order.filter((id) => set.has(id))];
    else if (where === "back") next = [...order.filter((id) => set.has(id)), ...order.filter((id) => !set.has(id))];
    else {
      next = [...order];
      // Un cran : chaque nœud échange sa place avec le voisin non sélectionné le plus proche
      const step = where === "forward" ? 1 : -1;
      const indexes = next.map((id, i) => (set.has(id) ? i : -1)).filter((i) => i >= 0);
      if (step === 1) indexes.reverse();
      for (const i of indexes) {
        const j = i + step;
        if (j < 0 || j >= next.length || set.has(next[j]!)) continue;
        [next[i], next[j]] = [next[j]!, next[i]!];
      }
    }
    if (next.every((id, i) => order[i] === id)) continue;
    next.forEach((id, i) => ops.push({ kind: "move", id, parentId, index: i }));
  }
  return ops;
}

/** Ctrl+G : englobe des frères dans une frame transparente, sans auto-layout, qui garde tout à sa place. */
export function groupOps(doc: DesignDocument, ids: string[]): { ops: Op[]; frameId: string } | null {
  const nodes = ids.map((id) => doc.nodes[id]).filter((n): n is DesignNode => !!n);
  if (!nodes.length || nodes.some((n) => n.parentId !== nodes[0]!.parentId)) return null;
  const parentId = nodes[0]!.parentId;
  const siblings = siblingsOf(doc, parentId);
  nodes.sort((a, b) => siblings.indexOf(a.id) - siblings.indexOf(b.id)); // l'ordre d'empilement est conservé
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  const w = Math.max(...nodes.map((n) => n.x + n.width)) - x;
  const h = Math.max(...nodes.map((n) => n.y + n.height)) - y;
  // Le groupe est créé juste au-dessus du nœud le plus en avant (avant que ses enfants n'y entrent)
  const index = Math.max(...nodes.map((n) => siblings.indexOf(n.id))) + 1;
  const frame = makeNode("frame", { name: "Groupe", x, y, width: w, height: h, fill: null, clip: false }, newId());
  frame.parentId = parentId;
  const ops: Op[] = [{ kind: "create", node: frame, index }];
  nodes.forEach((n, i) => {
    ops.push({ kind: "move", id: n.id, parentId: frame.id, index: i });
    ops.push({ kind: "update", id: n.id, props: { x: n.x - x, y: n.y - y, ...freeSizing(n) } });
  });
  return { ops, frameId: frame.id };
}

/**
 * Ctrl+Maj+G : dissout une frame (groupe, auto-layout…) ; ses enfants passent dans le parent, au même endroit
 * à l'écran et à la même place dans l'empilement. Les composants et instances ne se dissocient pas ainsi.
 */
export function ungroupOps(doc: DesignDocument, id: string): { ops: Op[]; childIds: string[] } | null {
  const f = doc.nodes[id];
  if (!f || f.type !== "frame" || !f.children.length || f.isComponent || f.isComponentSet || f.instanceOf) return null;
  if (f.rotation) return null; // les enfants changeraient d'orientation
  const siblings = siblingsOf(doc, f.parentId);
  const index = siblings.indexOf(id);
  const ops: Op[] = [];
  f.children.forEach((c, i) => {
    const k = doc.nodes[c]!;
    ops.push({ kind: "move", id: c, parentId: f.parentId, index: index + i });
    ops.push({ kind: "update", id: c, props: { x: f.x + k.x, y: f.y + k.y, ...freeSizing(k) } });
  });
  ops.push({ kind: "delete", id });
  return { ops, childIds: [...f.children] };
}

/** Alt+Maj+A : retire l'auto-layout d'une frame ; ses enfants restent exactement où ils sont, en position libre. */
export function removeAutoLayoutOps(doc: DesignDocument, id: string): Op[] {
  const f = doc.nodes[id];
  if (!f?.layout) return [];
  const ops: Op[] = [{ kind: "update", id, props: { layout: null, sizingH: "fixed", sizingV: "fixed" } }];
  for (const c of f.children) {
    const props = freeSizing(doc.nodes[c]!);
    if (Object.keys(props).length) ops.push({ kind: "update", id: c, props });
  }
  return ops;
}

/** « Remplir » n'a de sens que dans un auto-layout : hors de lui, le nœud garde sa taille actuelle. */
function freeSizing(n: DesignNode): NodeProps {
  const props: NodeProps = {};
  if (n.sizingH === "fill") props.sizingH = "fixed";
  if (n.sizingV === "fill") props.sizingV = "fixed";
  return props;
}
