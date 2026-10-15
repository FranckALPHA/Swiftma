// Composants, instances, surcharges et variantes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type DesignDocument, type NodeProps, type NodeType, type Op, addVariantOps, applyOp, applyOps, applyOpsDetailed, combineAsVariantsOps,
  createComponentOps, createDocument, createInstanceOps, detachInstanceOps, makeNode, resetOverridesOps, setVariantOps, variantProperties, withOverrides,
} from "../src/index.ts";

function add(d: DesignDocument, type: NodeType, props: NodeProps, parentId: string | null = null, id?: string): string {
  const n = makeNode(type, props, id);
  n.parentId = parentId;
  applyOps(d, [{ kind: "create", node: n }]);
  return n.id;
}
/** Comme l'éditeur : les modifications d'un humain mémorisent les surcharges. */
const user = (d: DesignDocument, ops: Op[]) => applyOps(d, withOverrides(d, ops));

function button(d: DesignDocument) {
  const btn = add(d, "frame", { name: "Bouton", width: 120, height: 40, fill: "#0D99FF", radius: 8 }, null, "btn");
  add(d, "text", { name: "Libellé", x: 16, y: 10, width: 88, height: 20, text: { content: "Valider", color: "#FFFFFF" } }, btn, "lbl");
  applyOps(d, createComponentOps(d, [btn])!.ops);
  return btn;
}
const instance = (d: DesignDocument, comp: string, x = 0, y = 200) => {
  const res = createInstanceOps(d, comp, null, x, y)!;
  applyOps(d, res.ops);
  return res.id;
};
const label = (d: DesignDocument, inst: string) => d.nodes[d.nodes[inst]!.children[0]!]!;

test("une instance suit son composant, sauf ses surcharges", () => {
  const d = createDocument("t");
  const comp = button(d);
  const a = instance(d, comp);
  const b = instance(d, comp, 200);
  assert.equal(label(d, a).text!.content, "Valider");
  assert.equal(label(d, a).sourceId, "lbl");

  user(d, [{ kind: "update", id: label(d, b).id, props: { text: { content: "Annuler" } } }]);
  assert.deepEqual(label(d, b).overrides, ["text.content"]);

  user(d, [{ kind: "update", id: comp, props: { fill: "#FF0000", radius: 20 } }, { kind: "update", id: "lbl", props: { text: { content: "OK", fontWeight: 700 } } }]);
  assert.equal(d.nodes[a]!.fill, "#FF0000");
  assert.equal(d.nodes[b]!.radius, 20);
  assert.equal(label(d, a).text!.content, "OK");
  assert.equal(label(d, b).text!.content, "Annuler"); // surcharge gardée…
  assert.equal(label(d, b).text!.fontWeight, 700); // …mais le reste suit
  assert.equal(d.nodes[a]!.x, 0); // la place de l'instance lui appartient
  assert.equal(d.nodes[b]!.x, 200);

  applyOps(d, resetOverridesOps(d, b));
  assert.equal(label(d, b).text!.content, "OK");
});

test("ajouter ou supprimer un élément du composant se répercute sur les instances", () => {
  const d = createDocument("t");
  const comp = button(d);
  const a = instance(d, comp);
  const icon = add(d, "ellipse", { name: "Icône", x: 4, y: 12, width: 16, height: 16 }, comp);
  assert.equal(d.nodes[a]!.children.length, 2);
  assert.equal(d.nodes[d.nodes[a]!.children[1]!]!.sourceId, icon);
  applyOps(d, [{ kind: "delete", id: "lbl" }]);
  assert.deepEqual(d.nodes[a]!.children.map((id) => d.nodes[id]!.sourceId), [icon]);
});

test("une instance redimensionnée place ses éléments selon leurs contraintes", () => {
  const d = createDocument("t");
  const comp = button(d);
  applyOps(d, [{ kind: "update", id: "lbl", props: { constraints: { h: "left-right", v: "center" } } }]);
  const a = instance(d, comp);
  user(d, [{ kind: "update", id: a, props: { width: 220, height: 60 } }]);
  assert.deepEqual(d.nodes[a]!.overrides, ["height", "width"]);
  const l = label(d, a);
  assert.deepEqual([l.x, l.y, l.width, l.height], [16, 20, 188, 20]);
});

test("variantes : changer de variante garde les textes surchargés", () => {
  const d = createDocument("t");
  const comp = button(d);
  const set = combineAsVariantsOps(d, [comp], "État")!;
  applyOps(d, set.ops);
  const hover = addVariantOps(d, comp)!;
  applyOps(d, hover.ops);
  assert.deepEqual(variantProperties(d, set.id), { État: ["Bouton", "Variante 2"] });
  const hoverLbl = d.nodes[hover.id]!.children[0]!;
  applyOps(d, [{ kind: "update", id: hover.id, props: { fill: "#0B7FD4" } }, { kind: "update", id: hoverLbl, props: { text: { color: "#EEEEEE" } } }]);

  const a = instance(d, comp);
  user(d, [{ kind: "update", id: label(d, a).id, props: { text: { content: "Payer" } } }]);
  applyOps(d, setVariantOps(d, a, "État", "Variante 2"));
  assert.equal(d.nodes[a]!.instanceOf, hover.id);
  assert.equal(d.nodes[a]!.fill, "#0B7FD4");
  assert.equal(label(d, a).sourceId, hoverLbl);
  assert.equal(label(d, a).text!.content, "Payer");
  assert.equal(label(d, a).text!.color, "#EEEEEE");
});

test("instance imbriquée : une carte qui contient un bouton", () => {
  const d = createDocument("t");
  const btn = button(d);
  const card = add(d, "frame", { name: "Carte", width: 300, height: 200, x: 400 }, null, "card");
  const res = createInstanceOps(d, btn, card, 20, 140)!;
  applyOps(d, res.ops);
  applyOps(d, createComponentOps(d, [card])!.ops);
  const c = instance(d, card, 400, 400);
  const inner = d.nodes[d.nodes[c]!.children[0]!]!;
  assert.equal(inner.instanceOf, btn);
  assert.equal(d.nodes[inner.children[0]!]!.text!.content, "Valider");
  user(d, [{ kind: "update", id: "lbl", props: { text: { content: "Voir" } } }]);
  assert.equal(d.nodes[inner.children[0]!]!.text!.content, "Voir"); // le bouton principal change → partout
  applyOps(d, detachInstanceOps(d, c));
  assert.equal(d.nodes[c]!.instanceOf, null);
});

test("le lot résolu d'une modification de composant se rejoue tel quel chez le hub", () => {
  const d = createDocument("t");
  const comp = button(d);
  instance(d, comp);
  const hub: DesignDocument = structuredClone(d);
  const ops: Op[] = [{ kind: "update", id: comp, props: { fill: "#00AA00" } }, { kind: "create", node: { ...makeNode("rect", { name: "Point" }, "dot"), parentId: comp } }];
  const { derived } = applyOpsDetailed(d, ops);
  for (const op of [...ops, ...derived]) applyOp(hub, op);
  const clean = (x: DesignDocument) => JSON.parse(JSON.stringify(x, (_k, v) => (v === null ? undefined : v)));
  assert.deepEqual(clean(hub), clean(d));
  // Et rejouer le lot chez un autre éditeur ne produit plus rien à dériver
  const other: DesignDocument = structuredClone(hub);
  assert.equal(applyOpsDetailed(other, []).derived.length, 0);
});

test("export React : une instance devient <Bouton etat=… libelle=… />, le composant est défini une fois", async () => {
  const { exportReact } = await import("../src/index.ts");
  const d = createDocument("t");
  const comp = button(d);
  const set = combineAsVariantsOps(d, [comp], "État")!;
  applyOps(d, set.ops);
  applyOps(d, [{ kind: "update", id: comp, props: { variant: { État: "Normal" } } }]);
  const hover = addVariantOps(d, comp)!;
  applyOps(d, hover.ops);
  applyOps(d, [{ kind: "update", id: hover.id, props: { fill: "#0B7FD4", variant: { État: "Survol" } } }]);
  const page = add(d, "frame", { name: "Page", width: 400, height: 300, x: 600 }, null, "page");
  const a = createInstanceOps(d, comp, page, 20, 20)!;
  const b = createInstanceOps(d, comp, page, 20, 80)!;
  applyOps(d, [...a.ops, ...b.ops]);
  user(d, [{ kind: "update", id: d.nodes[b.id]!.children[0]!, props: { text: { content: "Payer" } } }]);
  applyOps(d, setVariantOps(d, b.id, "État", "Survol"));
  // Une instance avec une surcharge de couleur reste exportée telle quelle
  const c = createInstanceOps(d, comp, page, 20, 140)!;
  applyOps(d, c.ops);
  user(d, [{ kind: "update", id: c.id, props: { fill: "#000000" } }]);

  const files = exportReact(d, page);
  const pageJsx = files["src/components/Page/Page.jsx"] as string;
  assert.match(pageJsx, /import Bouton from "\.\.\/Bouton\/Bouton\.jsx";/);
  assert.match(pageJsx, /<Bouton className=\{styles\.slot\w+\} etat="Normal" \/>/);
  assert.match(pageJsx, /<Bouton className=\{styles\.slot\w+\} etat="Survol" libelle="Payer" \/>/);
  assert.equal((pageJsx.match(/import Bouton /g) ?? []).length, 1);
  const variants = files["src/components/Bouton/Bouton.jsx"] as string;
  assert.match(variants, /"Normal": BoutonNormal/);
  assert.match(variants, /"Survol": BoutonSurvol/);
  assert.match(variants, /export default function Bouton\(\{ etat = "Normal", \.\.\.props \}\)/);
  assert.match(files["src/components/BoutonNormal/BoutonNormal.jsx"] as string, /<BoutonTextes\.Provider value=\{textes\}>/);
  const lbl = Object.entries(files).find(([p, v]) => p.endsWith(".jsx") && typeof v === "string" && v.includes("textes.libelle"));
  assert.ok(lbl, "le texte du bouton lit la prop libelle");
  assert.match(files["STRUCTURE.md"] as string, /## Composants réutilisables/);
});
