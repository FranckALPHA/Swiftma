// Tests du moteur d'auto-layout : npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { type DesignDocument, type NodeProps, type NodeType, addAutoLayoutOps, applyOps, createDocument, inferLayout, makeNode, makeResponsiveOps, wrapInAutoLayoutOps } from "../src/index.ts";

function doc(): DesignDocument {
  return createDocument("test");
}
function add(d: DesignDocument, type: NodeType, props: NodeProps, parentId: string | null = null): string {
  const n = makeNode(type, props);
  n.parentId = parentId;
  applyOps(d, [{ kind: "create", node: n }]);
  return n.id;
}
const box = (d: DesignDocument, id: string) => {
  const n = d.nodes[id]!;
  return [n.x, n.y, n.width, n.height];
};

test("ligne : marges, espacement, alignement centré", () => {
  const d = doc();
  const f = add(d, "frame", { width: 300, height: 100, layout: { direction: "row", gap: 10, padding: [5, 5, 5, 5], justify: "start", align: "center" } });
  const a = add(d, "rect", { width: 40, height: 20 }, f);
  const b = add(d, "rect", { width: 60, height: 50 }, f);
  assert.deepEqual(box(d, a), [5, 40, 40, 20]);
  assert.deepEqual(box(d, b), [55, 25, 60, 50]);
});

test("remplir : l'espace libre est partagé, l'axe secondaire s'étire", () => {
  const d = doc();
  const f = add(d, "frame", { width: 300, height: 100, layout: { direction: "row", gap: 10, padding: [0, 0, 0, 0], justify: "start", align: "start" } });
  const a = add(d, "rect", { width: 100, height: 20 }, f);
  const b = add(d, "rect", { width: 10, height: 20, sizingH: "fill", sizingV: "fill" }, f);
  const c = add(d, "rect", { width: 10, height: 20, sizingH: "fill" }, f);
  assert.deepEqual(box(d, a), [0, 0, 100, 20]);
  assert.deepEqual(box(d, b), [110, 0, 90, 100]);
  assert.deepEqual(box(d, c), [210, 0, 90, 20]);
});

test("ajuster : la frame prend la taille de son contenu, imbriquée comprise", () => {
  const d = doc();
  const outer = add(d, "frame", { width: 10, height: 10, sizingH: "hug", sizingV: "hug", layout: { direction: "column", gap: 8, padding: [16, 16, 16, 16], justify: "start", align: "start" } });
  const inner = add(d, "frame", { width: 10, height: 10, sizingH: "hug", sizingV: "hug", layout: { direction: "row", gap: 4, padding: [2, 2, 2, 2], justify: "start", align: "start" } }, outer);
  add(d, "rect", { width: 20, height: 30 }, inner);
  add(d, "rect", { width: 20, height: 10 }, inner);
  add(d, "text", { width: 100, height: 20 }, outer);
  assert.deepEqual(box(d, inner), [16, 16, 48, 34]);
  assert.deepEqual(box(d, outer).slice(2), [132, 94]); // 16 + 34 + 8 + 20 + 16
});

test("répartition space-between, et retour à la ligne", () => {
  const d = doc();
  const f = add(d, "frame", { width: 100, height: 100, layout: { direction: "row", gap: 0, padding: [0, 0, 0, 0], justify: "space-between", align: "start" } });
  const a = add(d, "rect", { width: 20, height: 20 }, f);
  const b = add(d, "rect", { width: 20, height: 20 }, f);
  assert.equal(d.nodes[a]!.x, 0);
  assert.equal(d.nodes[b]!.x, 80);
  const g = add(d, "frame", { width: 100, height: 100, layout: { direction: "row", gap: 10, wrapGap: 5, wrap: true, padding: [0, 0, 0, 0], justify: "start", align: "start" } });
  const ids = [0, 1, 2].map(() => add(d, "rect", { width: 40, height: 20 }, g));
  assert.deepEqual(ids.map((id) => box(d, id)), [[0, 0, 40, 20], [50, 0, 40, 20], [0, 25, 40, 20]]);
});

test("annuler l'ajout d'un auto-layout remet les enfants à leur place", () => {
  const d = doc();
  const f = add(d, "frame", { width: 300, height: 100 });
  const a = add(d, "rect", { x: 50, y: 30, width: 40, height: 20 }, f);
  const inverse = applyOps(d, [{ kind: "update", id: f, props: { layout: { direction: "row", gap: 0, padding: [0, 0, 0, 0], justify: "start", align: "start" } } }]);
  assert.deepEqual(box(d, a), [0, 0, 40, 20]);
  applyOps(d, inverse);
  assert.deepEqual(box(d, a), [50, 30, 40, 20]);
  assert.equal(d.nodes[f]!.layout ?? null, null);
});

test("détection : une pile régulière devient un auto-layout exact", () => {
  const d = doc();
  const f = add(d, "frame", { width: 200, height: 130 });
  // Désordre volontaire dans l'ordre des calques
  const c = add(d, "rect", { x: 20, y: 90, width: 160, height: 20 }, f);
  const a = add(d, "rect", { x: 20, y: 20, width: 160, height: 30 }, f);
  const b = add(d, "text", { x: 20, y: 60, width: 80, height: 20 }, f);
  const inf = inferLayout(d, f)!;
  assert.equal(inf.layout.direction, "column");
  assert.equal(inf.layout.gap, 10);
  assert.deepEqual(inf.layout.padding, [20, 20, 20, 20]);
  assert.equal(inf.exact, true);
  assert.deepEqual(inf.order, [a, b, c]);
  const before = [a, b, c].map((id) => box(d, id));
  applyOps(d, addAutoLayoutOps(d, f));
  assert.deepEqual([a, b, c].map((id) => box(d, id)), before);
  assert.equal(d.nodes[a]!.sizingH, "fill");
  assert.equal(d.nodes[b]!.sizingH, undefined);
});

test("maquette responsive : seules les piles exactes sont converties", () => {
  const d = doc();
  const page = add(d, "frame", { width: 400, height: 300 });
  const header = add(d, "frame", { x: 0, y: 0, width: 400, height: 60 }, page);
  add(d, "rect", { x: 16, y: 20, width: 80, height: 20 }, header);
  add(d, "rect", { x: 112, y: 20, width: 80, height: 20 }, header);
  const messy = add(d, "frame", { x: 0, y: 60, width: 400, height: 240 }, page);
  add(d, "rect", { x: 10, y: 10, width: 100, height: 100 }, messy);
  add(d, "rect", { x: 50, y: 50, width: 100, height: 100 }, messy); // chevauche : non convertible exactement
  const snapshot = Object.fromEntries(Object.keys(d.nodes).map((id) => [id, box(d, id)]));
  const { ops, frames } = makeResponsiveOps(d, page);
  applyOps(d, ops);
  assert.equal(frames, 2); // l'en-tête et la page ; pas la zone en désordre
  assert.ok(d.nodes[header]!.layout);
  assert.equal(d.nodes[messy]!.layout ?? null, null);
  assert.equal(d.nodes[page]!.sizingH, "fill");
  for (const [id, b] of Object.entries(snapshot)) assert.deepEqual(box(d, id), b, d.nodes[id]!.name);
});

test("englober une sélection dans un auto-layout", () => {
  const d = doc();
  const a = add(d, "rect", { x: 100, y: 100, width: 40, height: 40 });
  const b = add(d, "rect", { x: 150, y: 100, width: 40, height: 40 });
  const res = wrapInAutoLayoutOps(d, [b, a])!;
  applyOps(d, res.ops);
  const f = d.nodes[res.frameId]!;
  assert.deepEqual([f.x, f.y, f.width, f.height], [100, 100, 90, 40]);
  assert.deepEqual(f.children, [a, b]);
  assert.equal(f.layout?.gap, 10);
  assert.deepEqual(box(d, b), [50, 0, 40, 40]);
});

test("maquette responsive : le rectangle de fond d'un export Figma redevient le fond de la frame", () => {
  const d = doc();
  const card = add(d, "frame", { width: 200, height: 100, fill: null, clip: false });
  const bg = add(d, "rect", { width: 200, height: 100, fill: "#FF0000", radius: 12 }, card);
  const t = add(d, "text", { x: 16, y: 16, width: 100, height: 20 }, card);
  const { ops, frames } = makeResponsiveOps(d, card);
  applyOps(d, ops);
  assert.equal(d.nodes[bg], undefined);
  assert.equal(d.nodes[card]!.fill, "#FF0000");
  assert.equal(d.nodes[card]!.radius, 12);
  assert.equal(frames, 1);
  assert.deepEqual(box(d, t), [16, 16, 100, 20]);
});
