// Génère tests/fixtures/ops.json : cas d'opérations appliqués par le cœur TypeScript (référence).
// Le hub Rust applique les mêmes opérations de façon générique et doit obtenir exactement les mêmes documents
// et les mêmes inverses (cargo test). Relancer après un changement de sémantique : npx tsx packages/core/test/gen-op-fixtures.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DesignDocument, type Op, applyOps, makeNode } from "../src/index.ts";

const base = (): DesignDocument => {
  const doc: DesignDocument = { id: "doc1", name: "Test", background: "#F5F5F5", nodes: {}, roots: [] };
  const frame = { ...makeNode("frame", { name: "Écran", width: 375, height: 812 }, "f1") };
  const title = { ...makeNode("text", { name: "Titre", x: 16, y: 24, text: { content: "Bonjour" } }, "t1"), parentId: "f1" };
  const card = { ...makeNode("frame", { name: "Carte", x: 16, y: 80, width: 343, height: 120 }, "c1"), parentId: "f1" };
  const btn = { ...makeNode("rect", { name: "Bouton", x: 8, y: 8 }, "b1"), parentId: "c1" };
  applyOps(doc, [
    { kind: "create", node: frame },
    { kind: "create", node: title },
    { kind: "create", node: card },
    { kind: "create", node: btn },
  ]);
  return doc;
};

const cases: { name: string; ops: Op[] }[] = [
  { name: "créer à la racine", ops: [{ kind: "create", node: makeNode("ellipse", { name: "Rond" }, "e1") }] },
  { name: "créer un enfant à un index", ops: [{ kind: "create", node: { ...makeNode("rect", {}, "r9"), parentId: "f1" }, index: 1 }] },
  { name: "modifier des propriétés", ops: [{ kind: "update", id: "c1", props: { x: 20, fill: "#FF0000", radius: 12 } }] },
  { name: "ajouter une propriété absente", ops: [{ kind: "update", id: "c1", props: { sizingH: "fill", absolute: true } }] },
  { name: "fusion du texte", ops: [{ kind: "update", id: "t1", props: { text: { content: "Salut", fontSize: 20 } } }] },
  { name: "supprimer un sous-arbre", ops: [{ kind: "delete", id: "c1" }] },
  { name: "déplacer vers la racine", ops: [{ kind: "move", id: "c1", parentId: null }] },
  { name: "déplacer à un index", ops: [{ kind: "move", id: "c1", parentId: "f1", index: 0 }] },
  { name: "propriétés du document", ops: [{ kind: "set-doc", props: { name: "Renommé", background: "#000000" } }, { kind: "set-doc", props: { styles: { colors: { s1: { name: "Primaire", value: "#0D99FF" } } } } as never }] },
  { name: "lot de plusieurs opérations", ops: [
    { kind: "create", node: { ...makeNode("text", {}, "t2"), parentId: "c1" } },
    { kind: "update", id: "t2", props: { text: { content: "Prix" } } },
    { kind: "move", id: "b1", parentId: "f1", index: 0 },
    { kind: "delete", id: "t1" },
  ] },
  { name: "erreur : nœud déjà existant", ops: [{ kind: "create", node: makeNode("rect", {}, "f1") }] },
  { name: "erreur : parent introuvable", ops: [{ kind: "create", node: { ...makeNode("rect", {}, "zz"), parentId: "nope" } }] },
  { name: "erreur : déplacer dans soi-même", ops: [{ kind: "move", id: "f1", parentId: "b1" }] },
  { name: "erreur : texte sur un non-texte", ops: [{ kind: "update", id: "c1", props: { text: { content: "x" } } }] },
  { name: "erreur atomique : rien n'est gardé", ops: [{ kind: "update", id: "c1", props: { x: 99 } }, { kind: "delete", id: "inconnu" }] },
];

const out = cases.map(({ name, ops }) => {
  const before = base();
  const doc = structuredClone(before);
  try {
    const inverse = JSON.parse(JSON.stringify(applyOps(doc, ops)));
    const after = JSON.parse(JSON.stringify(doc));
    // L'inverse doit ramener au document de départ
    applyOps(doc, inverse);
    return { name, before, ops, after, inverse, error: false };
  } catch (e) {
    return { name, before, ops, after: null, inverse: null, error: true, message: (e as Error).message };
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, "../../../tests/fixtures/ops.json");
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`${out.length} cas → ${path.relative(process.cwd(), file)}`);
