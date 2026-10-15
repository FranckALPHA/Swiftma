// Le hub (Rust) applique les opérations sans connaître les règles du design. Ces tests vérifient qu'un lot
// « résolu » (ops + dérivées) appliqué de façon générique donne exactement le document des clients.
import { test } from "node:test";
import assert from "node:assert/strict";
import { type DesignDocument, type Op, applyOp, applyOpsDetailed, createDocument, makeNode } from "../src/index.ts";

/** Application générique, comme le hub : opération par opération, sans dérivation, inverse aplati à l'envers. */
function genericApply(doc: DesignDocument, ops: Op[]): Op[] {
  const inv: Op[][] = [];
  for (const op of ops) inv.push(applyOp(doc, op));
  return inv.reverse().flat();
}
const clean = (d: DesignDocument) => JSON.parse(JSON.stringify(d, (_k, v) => (v === null ? undefined : v)));

test("un lot résolu rejoué de façon générique donne le même document, et s'annule entièrement", () => {
  const client = createDocument("t");
  const frame = makeNode("frame", { width: 300, height: 100 }, "f");
  const a = { ...makeNode("rect", { x: 50, y: 30, width: 40, height: 20 }, "a"), parentId: "f" };
  const b = { ...makeNode("rect", { x: 200, y: 10, width: 60, height: 20 }, "b"), parentId: "f" };
  const setup: Op[] = [{ kind: "create", node: frame }, { kind: "create", node: a }, { kind: "create", node: b }];
  applyOpsDetailed(client, setup);
  const hub: DesignDocument = structuredClone(client);
  const before = clean(hub);

  // Ajouter un auto-layout déplace a et b : ces déplacements font partie du lot résolu
  const ops: Op[] = [{ kind: "update", id: "f", props: { layout: { direction: "row", gap: 10, padding: [5, 5, 5, 5], justify: "start", align: "start" } } }];
  const { derived } = applyOpsDetailed(client, ops);
  assert.ok(derived.length >= 2);
  const inverse = genericApply(hub, [...ops, ...derived]);
  assert.deepEqual(clean(hub), clean(client));
  assert.deepEqual([hub.nodes.a!.x, hub.nodes.b!.x], [5, 55]);

  // L'inverse générique remet aussi les positions d'origine
  genericApply(hub, inverse);
  assert.deepEqual(clean(hub), before);
});
