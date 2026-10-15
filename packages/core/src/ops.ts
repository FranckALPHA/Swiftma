// Toute modification du document passe par une opération.
// Humain, IA intégrée, IA externe via MCP : même chemin, même historique, même synchro.

import { relayout } from "./layout.js";
import { DEFAULT_BACKGROUND, type DesignDocument, type DesignNode, type NodeProps, siblingsOf, subtree } from "./model.js";

export type Op =
  | { kind: "create"; node: DesignNode; index?: number }
  | { kind: "update"; id: string; props: NodeProps }
  | { kind: "delete"; id: string }
  | { kind: "move"; id: string; parentId: string | null; index?: number }
  | { kind: "set-doc"; props: DocProps };

export interface DocProps {
  name?: string;
  background?: string;
}

export type Author = "human" | "ai" | "mcp";

export interface OpBatch {
  ops: Op[];
  author: Author;
  label?: string;
}

export class OpError extends Error {}

/** Applique une opération en place et renvoie les opérations inverses (pour annuler). */
export function applyOp(doc: DesignDocument, op: Op): Op[] {
  switch (op.kind) {
    case "create": {
      const node = structuredClone(op.node);
      if (doc.nodes[node.id]) throw new OpError(`Le nœud ${node.id} existe déjà`);
      if (node.parentId && !doc.nodes[node.parentId]) throw new OpError(`Parent introuvable : ${node.parentId}`);
      node.children = [];
      doc.nodes[node.id] = node;
      insertAt(siblingsOf(doc, node.parentId), node.id, op.index);
      return [{ kind: "delete", id: node.id }];
    }
    case "update": {
      const node = mustGet(doc, op.id);
      const before: NodeProps = {};
      // Valeur absente = null, pour que l'inverse survive au JSON (réseau, hub Rust)
      for (const key of Object.keys(op.props) as (keyof NodeProps)[]) {
        (before as Record<string, unknown>)[key] = structuredClone(node[key as keyof DesignNode] ?? null);
      }
      const { text, ...rest } = op.props;
      Object.assign(node, structuredClone(rest));
      if (text) {
        if (!node.text) throw new OpError(`Le nœud ${op.id} n'est pas un texte`);
        node.text = { ...node.text, ...text };
      }
      return [{ kind: "update", id: op.id, props: before }];
    }
    case "delete": {
      const node = mustGet(doc, op.id);
      const siblings = siblingsOf(doc, node.parentId);
      const index = siblings.indexOf(op.id);
      const ids = subtree(doc, op.id);
      // Inverse : recréer le nœud puis ses descendants dans l'ordre
      const inverse: Op[] = ids.map((id, i) => ({
        kind: "create",
        node: structuredClone(doc.nodes[id]!),
        index: i === 0 ? index : undefined,
      }));
      siblings.splice(index, 1);
      for (const id of ids) delete doc.nodes[id];
      return inverse;
    }
    case "move": {
      const node = mustGet(doc, op.id);
      if (op.parentId && subtree(doc, op.id).includes(op.parentId)) {
        throw new OpError("Impossible de déplacer un nœud dans lui-même");
      }
      if (op.parentId) mustGet(doc, op.parentId);
      const oldSiblings = siblingsOf(doc, node.parentId);
      const oldIndex = oldSiblings.indexOf(op.id);
      const oldParent = node.parentId;
      oldSiblings.splice(oldIndex, 1);
      node.parentId = op.parentId;
      insertAt(siblingsOf(doc, op.parentId), op.id, op.index);
      return [{ kind: "move", id: op.id, parentId: oldParent, index: oldIndex }];
    }
    case "set-doc": {
      // Propriétés du document (nom, couleur de page, styles partagés…) : générique, valeur absente = null
      const before: Record<string, unknown> = {};
      const d = doc as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(op.props)) {
        if (key === "nodes" || key === "roots" || key === "id") throw new OpError(`Propriété de document non modifiable : ${key}`);
        before[key] = structuredClone(d[key] ?? (key === "background" ? DEFAULT_BACKGROUND : null));
        d[key] = structuredClone(value);
      }
      return [{ kind: "set-doc", props: before as DocProps }];
    }
  }
}

/**
 * Passes de dérivation : après un lot, elles calculent les opérations qui découlent des règles du design
 * (instances de composants synchronisées, styles partagés propagés…). Elles sont exécutées jusqu'à ce qu'il
 * n'y ait plus rien à faire, puis l'auto-layout replace les éléments.
 */
export type DerivePass = (doc: DesignDocument) => Op[];
const derivePasses: DerivePass[] = [];
export function registerDerivePass(pass: DerivePass) {
  if (!derivePasses.includes(pass)) derivePasses.push(pass);
}

/** Applique un lot de façon atomique : si une opération échoue, rien n'est gardé.
 *  Renvoie l'inverse (pour annuler) et les opérations dérivées (synchronisations, positions d'auto-layout) :
 *  le lot « résolu » = ops + derived, qu'un serveur générique peut appliquer sans connaître les règles du design. */
export function applyOpsDetailed(doc: DesignDocument, ops: Op[]): { inverse: Op[]; derived: Op[] } {
  const inverses: Op[][] = [];
  const derived: Op[] = [];
  try {
    for (const op of ops) inverses.push(applyOp(doc, op));
    for (let round = 0; round < 8; round++) {
      const extra = derivePasses.flatMap((pass) => pass(doc));
      if (!extra.length) break;
      for (const op of extra) {
        inverses.push(applyOp(doc, op));
        derived.push(op);
      }
    }
  } catch (err) {
    for (const inv of inverses.reverse()) for (const o of inv) applyOp(doc, o);
    throw err;
  }
  const moved = relayout(doc);
  // À l'annulation, on remet d'abord les positions d'avant le recalcul, puis on défait les opérations
  const layoutInverse: Op[] = [];
  for (const [id, before] of moved) {
    layoutInverse.push({ kind: "update", id, props: before });
    const node = doc.nodes[id]!;
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(before)) after[key] = structuredClone(node[key as keyof DesignNode] ?? null);
    derived.push({ kind: "update", id, props: after as NodeProps });
  }
  return { inverse: [...layoutInverse, ...inverses.reverse().flat()], derived };
}

/** Applique un lot de façon atomique et renvoie son inverse (voir applyOpsDetailed). */
export function applyOps(doc: DesignDocument, ops: Op[]): Op[] {
  return applyOpsDetailed(doc, ops).inverse;
}

function mustGet(doc: DesignDocument, id: string): DesignNode {
  const node = doc.nodes[id];
  if (!node) throw new OpError(`Nœud introuvable : ${id}`);
  return node;
}

function insertAt(list: string[], id: string, index?: number) {
  if (index === undefined || index < 0 || index > list.length) list.push(id);
  else list.splice(index, 0, id);
}
