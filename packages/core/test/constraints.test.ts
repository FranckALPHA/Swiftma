// Contraintes (ancrage des éléments en position libre) et bornes min/max.
import { test } from "node:test";
import assert from "node:assert/strict";
import { type DesignDocument, type NodeProps, type NodeType, applyOps, createDocument, exportReact, makeNode, resizeOps } from "../src/index.ts";

function add(d: DesignDocument, type: NodeType, props: NodeProps, parentId: string | null = null, id?: string): string {
  const n = makeNode(type, props, id);
  n.parentId = parentId;
  applyOps(d, [{ kind: "create", node: n }]);
  return n.id;
}
const box = (d: DesignDocument, id: string) => [d.nodes[id]!.x, d.nodes[id]!.y, d.nodes[id]!.width, d.nodes[id]!.height];

test("redimensionner une frame : chaque enfant suit son ancrage", () => {
  const d = createDocument("t");
  const f = add(d, "frame", { width: 400, height: 200 });
  const l = add(d, "rect", { x: 10, y: 10, width: 50, height: 20 }, f);
  const r = add(d, "rect", { x: 340, y: 10, width: 50, height: 20, constraints: { h: "right", v: "bottom" } }, f);
  const c = add(d, "rect", { x: 175, y: 90, width: 50, height: 20, constraints: { h: "center", v: "center" } }, f);
  const s = add(d, "rect", { x: 10, y: 50, width: 380, height: 20, constraints: { h: "left-right", v: "top" } }, f);
  const k = add(d, "rect", { x: 100, y: 100, width: 100, height: 50, constraints: { h: "scale", v: "scale" } }, f);
  applyOps(d, resizeOps(d, f, 200, 100));
  assert.deepEqual(box(d, l), [10, 10, 50, 20]);
  assert.deepEqual(box(d, r), [140, -90, 50, 20]);
  assert.deepEqual(box(d, c), [75, 40, 50, 20]);
  assert.deepEqual(box(d, s), [10, 50, 180, 20]);
  assert.deepEqual(box(d, k), [50, 50, 50, 25]);
});

test("une frame étirée par l'auto-layout applique les contraintes de ses enfants, bornes min/max comprises", () => {
  const d = createDocument("t");
  const col = add(d, "frame", { width: 300, height: 400, layout: { direction: "column", gap: 0, padding: [0, 0, 0, 0], justify: "start", align: "start" } });
  const bar = add(d, "frame", { width: 100, height: 50 }, col);
  const btn = add(d, "rect", { x: 70, y: 10, width: 20, height: 20, constraints: { h: "right", v: "top" } }, bar);
  applyOps(d, [{ kind: "update", id: bar, props: { sizingH: "fill" } }]);
  assert.equal(d.nodes[bar]!.width, 300);
  assert.equal(d.nodes[btn]!.x, 270); // reste à 10 px du bord droit
  applyOps(d, [{ kind: "update", id: bar, props: { maxWidth: 200 } }, { kind: "update", id: col, props: { width: 500 } }]);
  assert.equal(d.nodes[bar]!.width, 200);
  assert.equal(d.nodes[btn]!.x, 170);
});

test("export : les ancrages deviennent right / calc(50%…) / left+right, la taille vient du placement", () => {
  const d = createDocument("t");
  const f = add(d, "frame", { name: "Page", width: 400, height: 200 }, null, "p");
  add(d, "rect", { name: "Droite", x: 340, y: 10, width: 50, height: 20, constraints: { h: "right", v: "top" } }, f);
  add(d, "rect", { name: "Centre", x: 175, y: 10, width: 50, height: 20, constraints: { h: "center", v: "top" } }, f);
  add(d, "text", { name: "Etire", x: 10, y: 50, width: 380, height: 20, constraints: { h: "left-right", v: "top" }, maxWidth: 600 }, f);
  const files = exportReact(d, f);
  const css = files["src/components/Page/Page.module.css"] as string;
  assert.match(css, /\.slotDroite \{\n  position: absolute;\n  right: 10px;\n  top: 10px;/);
  assert.match(css, /\.slotCentre \{\n  position: absolute;\n  left: calc\(50% \+ -25px\);/);
  assert.match(css, /\.slotEtire \{\n  position: absolute;\n  left: 10px;\n  right: 10px;/);
  const etire = files["src/components/Etire/Etire.module.css"] as string;
  assert.doesNotMatch(etire.split("/* Par défaut")[0]!, /\bwidth: 380px/);
  assert.match(etire, /max-width: 600px/);
});
