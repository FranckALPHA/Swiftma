// Composants, instances et variantes, comme dans Figma.
//
// - Un composant principal est une frame marquée `isComponent`.
// - Une instance est une frame `instanceOf` = id du composant ; chacun de ses descendants porte `sourceId` = le nœud
//   correspondant du composant. Elle suit toutes les modifications du composant, sauf les propriétés modifiées
//   localement, listées dans `overrides` (« fill », « text.content »…).
// - Un ensemble de variantes est une frame `isComponentSet` dont les enfants sont des composants avec `variant`
//   (ex. { État: "Survol" }). Changer de variante = changer `instanceOf` : les surcharges suivent (par nom de calque).
//
// La synchronisation est une passe de dérivation (voir ops.ts) : elle produit des opérations ordinaires, incluses dans
// le lot résolu, donc le hub et les autres éditeurs n'ont rien à recalculer.

import { type DesignDocument, type DesignNode, type NodeProps, makeNode, newId, resizeProps } from "./model.js";
import { type Op, registerDerivePass } from "./ops.js";
import { applyConstraintsBox } from "./layout.js";

/** Clés jamais recopiées du composant vers l'instance. */
const NEVER = new Set(["id", "type", "parentId", "children", "sourceId", "overrides", "isComponent", "isComponentSet", "variant", "locked"]);
/** Clés propres à la racine d'une instance (sa place dans la page, son nom, sa visibilité). */
const ROOT_OWN = new Set(["x", "y", "name", "constraints", "absolute", "visible", "instanceOf"]);
const GEOMETRY = ["x", "y", "width", "height"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Passe de synchronisation : toutes les instances rattrapent leur composant principal. */
export function syncInstances(doc: DesignDocument): Op[] {
  const ops: Op[] = [];
  for (const node of Object.values(doc.nodes)) {
    // Une instance imbriquée dans une autre est synchronisée par l'instance qui la contient
    if (!node.instanceOf || node.sourceId) continue;
    const main = doc.nodes[node.instanceOf];
    if (!main?.isComponent || isInside(doc, node.id, main.id)) continue; // composant supprimé, ou instance dans son propre composant
    ops.push(...syncNode(doc, main, node, true, main, node));
  }
  return ops;
}
registerDerivePass(syncInstances);

function isInside(doc: DesignDocument, id: string, ancestor: string): boolean {
  for (let cur = doc.nodes[id]; cur; cur = cur.parentId ? doc.nodes[cur.parentId] : undefined) if (cur.id === ancestor) return true;
  return false;
}

function syncNode(doc: DesignDocument, geo: DesignNode, dst: DesignNode, isRoot: boolean, srcParent: DesignNode, dstParent: DesignNode): Op[] {
  const ops: Op[] = [];
  const over = new Set(dst.overrides ?? []);
  // Instance imbriquée dont on a changé la variante localement : son contenu vient de son nouveau composant
  const swapped = over.has("instanceOf") && dst.instanceOf ? doc.nodes[dst.instanceOf] : undefined;
  const src = swapped?.isComponent ? swapped : geo;
  const props: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(src), ...Object.keys(dst)]);

  // Géométrie : celle du composant, adaptée par les contraintes si le parent de l'instance n'a pas la même taille
  let box = { x: geo.x, y: geo.y, width: geo.width, height: geo.height };
  if (!isRoot && (!near(srcParent.width, dstParent.width) || !near(srcParent.height, dstParent.height))) {
    box = applyConstraintsBox(geo, srcParent.width, srcParent.height, dstParent.width, dstParent.height);
  }
  const resized = !near(box.width, src.width) || !near(box.height, src.height);
  const scaled = resized ? resizeProps(src, box.width, box.height) : {};

  for (const key of keys) {
    if (NEVER.has(key) || over.has(key) || (isRoot && ROOT_OWN.has(key))) continue;
    if (key === "text") continue;
    let want: unknown = (src as unknown as Record<string, unknown>)[key];
    if ((GEOMETRY as readonly string[]).includes(key)) {
      if (isRoot && (key === "x" || key === "y")) continue;
      want = box[key as keyof typeof box];
      if (isRoot) want = (src as unknown as Record<string, number>)[key];
      else if (swapped && (key === "width" || key === "height")) want = (src as unknown as Record<string, number>)[key];
    } else if ((key === "path" || key === "clipPath") && key in scaled) want = (scaled as Record<string, unknown>)[key];
    if (!same(want, (dst as unknown as Record<string, unknown>)[key])) props[key] = structuredClone(want ?? null);
  }
  // Texte : surchargé propriété par propriété (contenu, couleur…)
  if (src.text && dst.text) {
    const want = { ...src.text };
    for (const k of Object.keys(src.text)) if (over.has(`text.${k}`)) (want as Record<string, unknown>)[k] = (dst.text as unknown as Record<string, unknown>)[k];
    if (!same(want, dst.text)) props.text = want;
  }
  if (Object.keys(props).length) ops.push({ kind: "update", id: dst.id, props: props as NodeProps });

  // Enfants : appariés par sourceId, puis par nom (changement de variante) ; les manquants sont créés, les orphelins supprimés
  const srcKids = src.children.map((id) => doc.nodes[id]!);
  const dstKids = dst.children.map((id) => doc.nodes[id]!);
  const pairs = new Map<string, DesignNode>(); // id source → nœud de l'instance
  const used = new Set<string>();
  for (const k of dstKids) {
    if (k.sourceId && srcKids.some((s) => s.id === k.sourceId) && !pairs.has(k.sourceId)) {
      pairs.set(k.sourceId, k);
      used.add(k.id);
    }
  }
  for (const s of srcKids) {
    if (pairs.has(s.id)) continue;
    const k = dstKids.find((d) => !used.has(d.id) && d.name === s.name && d.type === s.type);
    if (k) {
      pairs.set(s.id, k);
      used.add(k.id);
      ops.push({ kind: "update", id: k.id, props: { sourceId: s.id } });
    }
  }
  for (const k of dstKids) if (!used.has(k.id)) ops.push({ kind: "delete", id: k.id });
  // Ordre : celui du composant (simulé pas à pas, comme les opérations seront appliquées)
  const order = dst.children.filter((id) => used.has(id));
  const later: Op[] = [];
  srcKids.forEach((s, index) => {
    const k = pairs.get(s.id);
    if (!k) {
      ops.push(...copyOps(doc, s, dst.id, index));
      order.splice(index, 0, "(nouveau)");
      return;
    }
    if (order[index] !== k.id) {
      order.splice(order.indexOf(k.id), 1);
      order.splice(index, 0, k.id);
      ops.push({ kind: "move", id: k.id, parentId: dst.id, index });
    }
    later.push(...syncNode(doc, s, k, false, src, dst));
  });
  return [...ops, ...later];
}

/** Copie d'un sous-arbre du composant dans une instance (nouveaux ids, sourceId = original). */
function copyOps(doc: DesignDocument, src: DesignNode, parentId: string, index?: number): Op[] {
  const node: DesignNode = {
    ...structuredClone(src),
    id: newId(),
    parentId,
    children: [],
    sourceId: src.id,
    overrides: null,
    isComponent: false,
    isComponentSet: false,
    variant: null,
  };
  const ops: Op[] = [{ kind: "create", node, index }];
  for (const c of src.children) ops.push(...copyOps(doc, doc.nodes[c]!, node.id));
  return ops;
}

// ---------- Surcharges ----------

/**
 * Ajoute aux opérations d'un humain ou d'une IA la mémorisation des surcharges : modifier un élément d'une instance
 * le détache de cette propriété du composant. (Les opérations de synchronisation, elles, ne passent pas par ici.)
 */
export function withOverrides(doc: DesignDocument, ops: Op[]): Op[] {
  const extra = new Map<string, Set<string>>();
  for (const op of ops) {
    if (op.kind !== "update") continue;
    const n = doc.nodes[op.id];
    if (!n || (!n.sourceId && !n.instanceOf)) continue;
    const isRoot = !!n.instanceOf && !n.sourceId;
    const keys = extra.get(n.id) ?? new Set(n.overrides ?? []);
    for (const [k, v] of Object.entries(op.props)) {
      if (k === "overrides" || k === "sourceId" || NEVER.has(k) || (isRoot && ROOT_OWN.has(k))) continue;
      if (k === "text" && v) for (const t of Object.keys(v)) keys.add(`text.${t}`);
      else keys.add(k);
    }
    extra.set(n.id, keys);
  }
  const marks: Op[] = [];
  for (const [id, keys] of extra) {
    const list = [...keys].sort();
    if (!same(list, [...(doc.nodes[id]!.overrides ?? [])].sort())) marks.push({ kind: "update", id, props: { overrides: list } });
  }
  return [...ops, ...marks];
}

// ---------- Actions ----------

/** Crée un composant : une frame seule devient composant ; sinon la sélection est englobée dans une frame-composant. */
export function createComponentOps(doc: DesignDocument, ids: string[]): { ops: Op[]; id: string } | null {
  const nodes = ids.map((id) => doc.nodes[id]).filter((n): n is DesignNode => !!n);
  if (!nodes.length) return null;
  if (nodes.length === 1 && nodes[0]!.type === "frame" && !nodes[0]!.instanceOf) {
    return { ops: [{ kind: "update", id: nodes[0]!.id, props: { isComponent: true } }], id: nodes[0]!.id };
  }
  if (nodes.some((n) => n.parentId !== nodes[0]!.parentId)) return null;
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  const w = Math.max(...nodes.map((n) => n.x + n.width)) - x;
  const h = Math.max(...nodes.map((n) => n.y + n.height)) - y;
  const parentId = nodes[0]!.parentId;
  const siblings = parentId ? doc.nodes[parentId]!.children : doc.roots;
  const index = Math.min(...nodes.map((n) => siblings.indexOf(n.id)));
  const frame = makeNode("frame", { name: nodes.length === 1 ? nodes[0]!.name : "Composant", x, y, width: w, height: h, fill: null, clip: false, isComponent: true });
  frame.parentId = parentId;
  const ordered = [...nodes].sort((a, b) => siblings.indexOf(a.id) - siblings.indexOf(b.id));
  const ops: Op[] = [{ kind: "create", node: frame, index }];
  for (const n of ordered) {
    ops.push({ kind: "move", id: n.id, parentId: frame.id });
    ops.push({ kind: "update", id: n.id, props: { x: n.x - x, y: n.y - y } });
  }
  return { ops, id: frame.id };
}

/** Insère une instance d'un composant. */
export function createInstanceOps(doc: DesignDocument, componentId: string, parentId: string | null, x: number, y: number): { ops: Op[]; id: string } | null {
  const main = doc.nodes[componentId];
  if (!main?.isComponent) return null;
  const root: DesignNode = {
    ...structuredClone(main),
    id: newId(),
    parentId,
    children: [],
    x,
    y,
    isComponent: false,
    isComponentSet: false,
    variant: null,
    instanceOf: main.id,
    sourceId: null,
    overrides: null,
    constraints: null,
    absolute: false,
    visible: true,
  };
  const ops: Op[] = [{ kind: "create", node: root }];
  for (const c of main.children) ops.push(...copyOps(doc, doc.nodes[c]!, root.id));
  return { ops, id: root.id };
}

/** Détache une instance : elle redevient une frame ordinaire (ses éléments gardent leur apparence). */
export function detachInstanceOps(doc: DesignDocument, id: string): Op[] {
  const ops: Op[] = [];
  const walk = (nid: string, root: boolean) => {
    const n = doc.nodes[nid]!;
    if (root || n.sourceId || n.overrides) ops.push({ kind: "update", id: nid, props: root ? { instanceOf: null, overrides: null } : { sourceId: null, overrides: null } });
    // Une instance imbriquée reste une instance (de son propre composant)
    if (!root && n.instanceOf) return;
    n.children.forEach((c) => walk(c, false));
  };
  walk(id, true);
  return ops;
}

/** Réinitialise les surcharges d'une instance (et de ses éléments) : elle redevient identique au composant. */
export function resetOverridesOps(doc: DesignDocument, id: string): Op[] {
  const ops: Op[] = [];
  const walk = (nid: string) => {
    const n = doc.nodes[nid]!;
    if (n.overrides?.length) ops.push({ kind: "update", id: nid, props: { overrides: null } });
    n.children.forEach(walk);
  };
  walk(id);
  return ops;
}

/** L'ensemble de variantes d'un composant (son parent), s'il en a un. */
export function componentSetOf(doc: DesignDocument, componentId: string): DesignNode | null {
  const c = doc.nodes[componentId];
  const p = c?.parentId ? doc.nodes[c.parentId] : undefined;
  return p?.isComponentSet ? p : null;
}

/** Propriétés de variantes d'un ensemble et leurs valeurs possibles, dans l'ordre d'apparition. */
export function variantProperties(doc: DesignDocument, setId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of doc.nodes[setId]?.children ?? []) {
    for (const [k, v] of Object.entries(doc.nodes[id]?.variant ?? {})) {
      const list = (out[k] ??= []);
      if (!list.includes(v)) list.push(v);
    }
  }
  return out;
}

/** Change la variante d'une instance : le composant de l'ensemble qui correspond le mieux à la nouvelle valeur. */
export function setVariantOps(doc: DesignDocument, instanceId: string, prop: string, value: string): Op[] {
  const inst = doc.nodes[instanceId];
  const main = inst?.instanceOf ? doc.nodes[inst.instanceOf] : undefined;
  const set = main ? componentSetOf(doc, main.id) : null;
  if (!inst || !main || !set) return [];
  const wanted = { ...(main.variant ?? {}), [prop]: value };
  const candidates = set.children.map((id) => doc.nodes[id]!).filter((c) => c.isComponent && c.variant?.[prop] === value);
  const score = (c: DesignNode) => Object.entries(wanted).filter(([k, v]) => c.variant?.[k] === v).length;
  const best = candidates.sort((a, b) => score(b) - score(a))[0];
  return best && best.id !== main.id ? [{ kind: "update", id: instanceId, props: { instanceOf: best.id } }] : [];
}

/** Réunit des composants frères en un ensemble de variantes (frame en auto-layout, comme dans Figma). */
export function combineAsVariantsOps(doc: DesignDocument, ids: string[], property = "Variante"): { ops: Op[]; id: string } | null {
  const comps = ids.map((id) => doc.nodes[id]).filter((n): n is DesignNode => !!n?.isComponent);
  if (comps.length < 1 || comps.some((c) => c.parentId !== comps[0]!.parentId)) return null;
  const pad = 20;
  const x = Math.min(...comps.map((n) => n.x)) - pad;
  const y = Math.min(...comps.map((n) => n.y)) - pad;
  const parentId = comps[0]!.parentId;
  const set = makeNode("frame", {
    name: comps[0]!.name,
    x,
    y,
    width: 10,
    height: 10,
    fill: null,
    clip: false,
    radius: 6,
    stroke: { color: "#9747FF", width: 1, dash: [4, 4] },
    isComponentSet: true,
    sizingH: "hug",
    sizingV: "hug",
    layout: { direction: "row", gap: 20, padding: [pad, pad, pad, pad], justify: "start", align: "start", wrap: false },
  });
  set.parentId = parentId;
  const ops: Op[] = [{ kind: "create", node: set }];
  comps.forEach((c, i) => {
    ops.push({ kind: "move", id: c.id, parentId: set.id });
    if (!c.variant || !Object.keys(c.variant).length) ops.push({ kind: "update", id: c.id, props: { variant: { [property]: c.name || `Variante ${i + 1}` } } });
  });
  return { ops, id: set.id };
}

/** Ajoute une variante à un composant : il est copié dans son ensemble (créé au besoin). */
export function addVariantOps(doc: DesignDocument, componentId: string): { ops: Op[]; id: string } | null {
  const c = doc.nodes[componentId];
  if (!c?.isComponent) return null;
  let ops: Op[] = [];
  let setId = componentSetOf(doc, c.id)?.id;
  let sim = doc;
  if (!setId) {
    const res = combineAsVariantsOps(doc, [c.id]);
    if (!res) return null;
    ops = res.ops;
    setId = res.id;
    sim = structuredClone(doc);
    // simulation légère pour connaître les variantes existantes
    sim.nodes[setId] = { ...makeNode("frame", {}, setId), isComponentSet: true, children: [c.id] };
    sim.nodes[c.id] = { ...structuredClone(c), parentId: setId, variant: c.variant && Object.keys(c.variant).length ? c.variant : { Variante: c.name } };
  }
  const props = variantProperties(sim, setId);
  const key = Object.keys(props)[0] ?? "Variante";
  const base = sim.nodes[c.id]!.variant ?? {};
  let n = (props[key]?.length ?? 1) + 1;
  while (props[key]?.includes(`Variante ${n}`)) n++;
  // Copie profonde du composant, avec de nouveaux ids
  const idMap = new Map<string, string>();
  const copy = (src: DesignNode, parentId: string | null): Op[] => {
    const id = newId();
    idMap.set(src.id, id);
    const node: DesignNode = { ...structuredClone(src), id, parentId, children: [] };
    const out: Op[] = [{ kind: "create", node }];
    for (const k of src.children) out.push(...copy(doc.nodes[k]!, id));
    return out;
  };
  const copyOpsList = copy(c, setId);
  const root = (copyOpsList[0] as { node: DesignNode }).node;
  root.variant = { ...base, [key]: `Variante ${n}` };
  root.name = c.name;
  ops.push(...copyOpsList);
  return { ops, id: root.id };
}
