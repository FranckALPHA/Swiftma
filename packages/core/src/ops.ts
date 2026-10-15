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
      for (const key of Object.keys(op.props) as (keyof NodeProps)[]) {
        (before as Record<string, unknown>)[key] = structuredClone(node[key as keyof DesignNode]);
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
      const before: DocProps = {};
      if (op.props.name !== undefined) (before.name = doc.name), (doc.name = op.props.name);
      if (op.props.background !== undefined) (before.background = doc.background ?? DEFAULT_BACKGROUND), (doc.background = op.props.background);
      return [{ kind: "set-doc", props: before }];
    }
  }
}

/** Applique un lot de façon atomique : si une opération échoue, rien n'est gardé.
 *  Puis l'auto-layout replace ce qui doit l'être ; l'inverse renvoyé restaure aussi ces positions. */
export function applyOps(doc: DesignDocument, ops: Op[]): Op[] {
  const inverses: Op[][] = [];
  try {
    for (const op of ops) inverses.push(applyOp(doc, op));
  } catch (err) {
    for (const inv of inverses.reverse()) for (const o of inv) applyOp(doc, o);
    throw err;
  }
  const moved = relayout(doc);
  // À l'annulation, on remet d'abord les positions d'avant le recalcul, puis on défait les opérations
  const layoutInverse: Op[] = [...moved].map(([id, props]) => ({ kind: "update", id, props }));
  return [...layoutInverse, ...inverses.reverse().flat()];
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
