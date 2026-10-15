// Styles partagés (design tokens).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type DesignDocument, type NodeProps, type NodeType, applyOps, colorName, createDocument, createComponentOps, createInstanceOps,
  deleteStyleOps, exportReact, extractStylesOps, makeNode, upsertStyleOps, withOverrides, withStyleDetach,
} from "../src/index.ts";

function add(d: DesignDocument, type: NodeType, props: NodeProps, parentId: string | null = null, id?: string): string {
  const n = makeNode(type, props, id);
  n.parentId = parentId;
  applyOps(d, [{ kind: "create", node: n }]);
  return n.id;
}
const user = (d: DesignDocument, ops: Parameters<typeof applyOps>[1]) => applyOps(d, withStyleDetach(d, withOverrides(d, ops)));

test("changer un style change tous les éléments liés ; une modification directe détache", () => {
  const d = createDocument("t");
  const { ops, id: primary } = upsertStyleOps(d, "colors", { name: "Primaire", value: "#0D99FF" });
  applyOps(d, ops);
  const a = add(d, "rect", { fillStyle: primary });
  const b = add(d, "rect", { fillStyle: primary });
  const t = add(d, "text", { fillStyle: primary });
  assert.equal(d.nodes[a]!.fill, "#0D99FF");
  assert.equal(d.nodes[t]!.text!.color, "#0D99FF");
  applyOps(d, upsertStyleOps(d, "colors", { name: "Primaire", value: "#16A34A" }, primary).ops);
  assert.deepEqual([d.nodes[a]!.fill, d.nodes[b]!.fill, d.nodes[t]!.text!.color], ["#16A34A", "#16A34A", "#16A34A"]);
  user(d, [{ kind: "update", id: b, props: { fill: "#FF0000" } }]);
  assert.equal(d.nodes[b]!.fillStyle, null);
  applyOps(d, upsertStyleOps(d, "colors", { name: "Primaire", value: "#000000" }, primary).ops);
  assert.equal(d.nodes[b]!.fill, "#FF0000");
  assert.equal(d.nodes[a]!.fill, "#000000");
  applyOps(d, deleteStyleOps(d, "colors", primary));
  assert.equal(d.nodes[a]!.fillStyle, null);
  assert.equal(d.nodes[a]!.fill, "#000000");
});

test("styles de texte et d'ombre ; les instances suivent", () => {
  const d = createDocument("t");
  const h1 = upsertStyleOps(d, "texts", { name: "Titre", fontFamily: "Poppins", fontSize: 32, fontWeight: 700, lineHeight: 1.2 });
  applyOps(d, h1.ops);
  const card = add(d, "frame", { name: "Carte", width: 200, height: 100 }, null, "card");
  const title = add(d, "text", { textStyle: h1.id }, card);
  applyOps(d, createComponentOps(d, [card])!.ops);
  const inst = createInstanceOps(d, card, null, 300, 0)!;
  applyOps(d, inst.ops);
  assert.equal(d.nodes[title]!.text!.fontSize, 32);
  applyOps(d, upsertStyleOps(d, "texts", { name: "Titre", fontFamily: "Poppins", fontSize: 40, fontWeight: 800, lineHeight: 1.1 }, h1.id).ops);
  const copy = d.nodes[d.nodes[inst.id]!.children[0]!]!;
  assert.deepEqual([copy.text!.fontSize, copy.text!.fontWeight, copy.textStyle], [40, 800, h1.id]);
});

test("détection des styles d'une maquette, sans rien changer à l'écran", () => {
  const d = createDocument("t");
  const page = add(d, "frame", { width: 400, height: 400, fill: "#FFFFFF" }, null, "page");
  for (let i = 0; i < 3; i++) add(d, "rect", { fill: "#0D99FF", shadows: [{ type: "drop", x: 0, y: 2, blur: 8, spread: 0, color: "#00000022" }] }, page);
  for (let i = 0; i < 2; i++) add(d, "text", { text: { fontSize: 24, fontWeight: 700, color: "#111111" } }, page);
  add(d, "rect", { fill: "#123456" }, page);
  const before = JSON.stringify(Object.values(d.nodes).map((n) => [n.fill, n.text, n.shadows]));
  const { ops, counts } = extractStylesOps(d, page);
  applyOps(d, ops);
  assert.deepEqual(counts, { colors: 1, texts: 1, effects: 1 });
  assert.equal(Object.values(d.styles!.colors!)[0]!.name, "Bleu");
  assert.equal(Object.values(d.styles!.texts!)[0]!.name, "Inter 24 Bold");
  assert.equal(JSON.stringify(Object.values(d.nodes).map((n) => [n.fill, n.text, n.shadows])), before);
  assert.equal(Object.values(d.nodes).filter((n) => n.fillStyle).length, 3);
});

test("export : tokens.css et var(--…) dans les composants", () => {
  const d = createDocument("t");
  const c = upsertStyleOps(d, "colors", { name: "Bleu clair", value: "#BFE3FF" });
  applyOps(d, c.ops);
  const t = upsertStyleOps(d, "texts", { name: "Corps", fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 1.5 });
  applyOps(d, t.ops);
  const page = add(d, "frame", { name: "Page", width: 300, height: 200, fillStyle: c.id }, null, "page");
  add(d, "text", { name: "Para", textStyle: t.id, fillStyle: c.id }, page);
  const files = exportReact(d, page);
  assert.match(files["src/styles/tokens.css"] as string, /--color-bleu-clair: #BFE3FF;/);
  assert.match(files["src/styles/tokens.css"] as string, /--text-corps-size: 16px;/);
  assert.match(files["src/components/Page/Page.module.css"] as string, /background: var\(--color-bleu-clair\);/);
  const para = files["src/components/Para/Para.module.css"] as string;
  assert.match(para, /font-size: var\(--text-corps-size\);/);
  assert.match(para, /color: var\(--color-bleu-clair\);/);
  assert.match(files["src/main.jsx"] as string, /import "\.\/styles\/tokens\.css";/);
  assert.equal(colorName("#111111"), "Noir");
});
