// Tests de l'organisation des calques (ordre, groupes, retrait de l'auto-layout) : npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { type DesignDocument, type NodeProps, type NodeType, applyOps, createDocument, groupOps, makeNode, removeAutoLayoutOps, reorderOps, ungroupOps, wrapInAutoLayoutOps } from "../src/index.ts";

function add(d: DesignDocument, type: NodeType, props: NodeProps, parentId: string | null = null): string {
  const n = makeNode(type, props);
  n.parentId = parentId;
  applyOps(d, [{ kind: "create", node: n }]);
  return n.id;
}
const abs = (d: DesignDocument, id: string): [number, number] => {
  let x = 0, y = 0;
  for (let n = d.nodes[id]; n; n = n.parentId ? d.nodes[n.parentId] : undefined) (x += n.x), (y += n.y);
  return [x, y];
};

test("ordre : premier plan, arrière-plan, avancer, reculer", () => {
  const d = createDocument("t");
  const [a, b, c, e] = ["a", "b", "c", "e"].map((name, i) => add(d, "rect", { name, x: i * 10 }));
  applyOps(d, reorderOps(d, [a!], "front"));
  assert.deepEqual(d.roots, [b, c, e, a]);
  applyOps(d, reorderOps(d, [a!, c!], "back"));
  assert.deepEqual(d.roots, [c, a, b, e]);
  applyOps(d, reorderOps(d, [c!], "forward"));
  assert.deepEqual(d.roots, [a, c, b, e]);
  applyOps(d, reorderOps(d, [e!], "backward"));
  assert.deepEqual(d.roots, [a, c, e, b]);
  assert.deepEqual(reorderOps(d, [b!], "front"), []); // déjà devant : rien à faire
});

test("grouper puis dissocier : rien ne bouge à l'écran, l'empilement est conservé", () => {
  const d = createDocument("t");
  const f = add(d, "frame", { x: 100, y: 100, width: 400, height: 400 });
  const a = add(d, "rect", { x: 10, y: 20, width: 50, height: 50 }, f);
  const b = add(d, "rect", { x: 200, y: 50, width: 30, height: 30 }, f);
  const c = add(d, "rect", { x: 300, y: 300, width: 30, height: 30 }, f);
  const before = [a, b, c].map((id) => abs(d, id));
  const g = groupOps(d, [c, a])!;
  applyOps(d, g.ops);
  assert.deepEqual(d.nodes[f]!.children, [b, g.frameId]);
  assert.deepEqual(d.nodes[g.frameId]!.children, [a, c]);
  assert.deepEqual([d.nodes[g.frameId]!.x, d.nodes[g.frameId]!.y, d.nodes[g.frameId]!.width, d.nodes[g.frameId]!.height], [10, 20, 320, 310]);
  assert.deepEqual([a, b, c].map((id) => abs(d, id)), before);

  const u = ungroupOps(d, g.frameId)!;
  applyOps(d, u.ops);
  assert.equal(d.nodes[g.frameId], undefined);
  assert.deepEqual(d.nodes[f]!.children, [b, a, c]);
  assert.deepEqual([a, b, c].map((id) => abs(d, id)), before);
});

test("auto-layout : le retirer garde les positions, dissocier libère les enfants", () => {
  const d = createDocument("t");
  const a = add(d, "rect", { x: 0, y: 0, width: 100, height: 40 });
  const b = add(d, "rect", { x: 0, y: 60, width: 100, height: 40 });
  const w = wrapInAutoLayoutOps(d, [a, b])!;
  applyOps(d, w.ops);
  applyOps(d, [{ kind: "update", id: b, props: { sizingH: "fill" } }]);
  const before = [a, b].map((id) => abs(d, id));

  applyOps(d, removeAutoLayoutOps(d, w.frameId));
  assert.equal(d.nodes[w.frameId]!.layout, null);
  assert.equal(d.nodes[b]!.sizingH, "fixed");
  assert.deepEqual([a, b].map((id) => abs(d, id)), before);
  // Sans auto-layout, déplacer un enfant ne pousse plus l'autre
  applyOps(d, [{ kind: "update", id: a, props: { height: 80 } }]);
  assert.deepEqual(abs(d, b), before[1]);

  const u = ungroupOps(d, w.frameId)!;
  applyOps(d, u.ops);
  assert.deepEqual(d.roots, [a, b]);
  assert.deepEqual(abs(d, b), before[1]);
});

test("dissocier refuse les composants et les frames vides", () => {
  const d = createDocument("t");
  const empty = add(d, "frame", { width: 10, height: 10 });
  const comp = add(d, "frame", { width: 10, height: 10, isComponent: true });
  add(d, "rect", { width: 5, height: 5 }, comp);
  assert.equal(ungroupOps(d, empty), null);
  assert.equal(ungroupOps(d, comp), null);
});
