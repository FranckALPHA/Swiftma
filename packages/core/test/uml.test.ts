// Diagrammes UML (fusion d'Easy Analyst) : JSON abstrait du skill analyse-uml → calques Swiftma.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { type DesignDocument, type Op, UmlError, applyOps, createDocument, exportHtml, exportReact, runTool, toTree, umlDiagramOps } from "../src/index.ts";

const example = (t: string) => JSON.parse(fs.readFileSync(new URL(`../../../examples/uml/${t}.json`, import.meta.url), "utf8"));

function finite(doc: DesignDocument) {
  for (const n of Object.values(doc.nodes))
    for (const k of ["x", "y", "width", "height"] as const) assert.ok(Number.isFinite(n[k]), `${n.name}.${k} = ${n[k]}`);
}

for (const t of ["usecase", "class", "sequence", "activity"]) {
  test(`exemple ${t} : une frame éditable, dans le document`, () => {
    const doc = createDocument("t");
    const r = umlDiagramOps(doc, example(t));
    assert.equal(r.type, t);
    applyOps(doc, r.ops);
    const frame = doc.nodes[r.id]!;
    assert.equal(frame.type, "frame");
    assert.ok(doc.roots.includes(r.id));
    assert.ok(frame.children.length > 10, `${frame.children.length} calques`);
    assert.ok(frame.width > 300 && frame.height > 300);
    finite(doc);
    // tout le contenu tient dans la frame
    for (const c of frame.children.map((id) => doc.nodes[id]!)) {
      assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= frame.width + 0.5 && c.y + c.height <= frame.height + 0.5, `${c.name} déborde`);
    }
    // exportable comme n'importe quelle maquette
    assert.ok(Object.keys(exportReact(doc, r.id)).length > 3);
    assert.match(exportHtml(toTree(doc, r.id)).html, /<svg/);
  });
}

test("cas d'utilisation : acteurs, cas, relations et libellés « include » / « extend »", () => {
  const doc = createDocument("t");
  const r = umlDiagramOps(doc, example("usecase"));
  applyOps(doc, r.ops);
  const names = Object.values(doc.nodes).map((n) => n.name);
  assert.ok(names.includes("Cas Acheter un billet"));
  assert.ok(names.includes("Acteur NotchPay"));
  const texts = Object.values(doc.nodes).flatMap((n) => (n.text ? [n.text.content] : []));
  assert.ok(texts.includes("«include»"));
  assert.ok(texts.includes("«extend»\n[code saisi]"));
  // un cas « à implémenter » est en pointillé orange
  const promo = Object.values(doc.nodes).find((n) => n.name === "Cas Appliquer un code promo")!;
  assert.deepEqual(promo.stroke?.dash, [5, 4]);
});

test("ancien format d'Easy Analyst (elements « uml:… »)", () => {
  const doc = createDocument("t");
  const r = umlDiagramOps(doc, {
    diagram_type: "use_case",
    title: "Démo",
    elements: [
      { id: "a1", type: "uml:actor", label: "Client" },
      { id: "u1", type: "uml:usecase", label: "Commander" },
      { id: "u2", type: "uml:aiUsecase", label: "Recommander" },
    ],
    relations: [
      { id: "r1", type: "uml:association", from_id: "a1", to: "u1" },
      { id: "r2", type: "uml:include", from: "u1", to: "u2" },
    ],
  });
  applyOps(doc, r.ops);
  assert.equal(r.type, "usecase");
  assert.ok(Object.values(doc.nodes).some((n) => n.name === "Cas Recommander"));
});

test("règles de fermeture : ids inconnus, extend sans condition, type inconnu", () => {
  const doc = createDocument("t");
  assert.throws(
    () => umlDiagramOps(doc, { type: "class", classes: [{ id: "a", label: "A" }], relations: [{ from: "a", to: "b", kind: "association" }] }),
    (e: Error) => e instanceof UmlError && /id introuvable\(s\) : b \(relations.to\)/.test(e.message),
  );
  assert.throws(
    () =>
      umlDiagramOps(doc, {
        type: "usecase",
        actors: [],
        useCases: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        relations: [{ from: "a", to: "b", kind: "extend" }],
      }),
    /sans « condition »/,
  );
  assert.throws(() => umlDiagramOps(doc, { type: "gantt" }), /Type de diagramme inconnu/);
  assert.throws(() => umlDiagramOps(doc, { type: "class", classes: [{ id: "a" }, { id: "a" }], relations: [] }), /id en double : a/);
});

test("placé à droite du contenu existant, sans rien déplacer", () => {
  const doc = createDocument("t");
  const first = umlDiagramOps(doc, example("class"));
  applyOps(doc, first.ops);
  const second = umlDiagramOps(doc, example("sequence"));
  applyOps(doc, second.ops);
  const a = doc.nodes[first.id]!;
  const b = doc.nodes[second.id]!;
  assert.equal(b.x, a.x + a.width + 120);
  const at = umlDiagramOps(doc, example("usecase"), { x: -500, y: 40 });
  assert.equal((at.ops[0] as Extract<Op, { kind: "create" }>).node.x, -500);
});

test("outil create_uml_diagram (MCP et agent)", () => {
  const doc = createDocument("t");
  const committed: Op[][] = [];
  const ctx = { doc, selection: [], commit: (ops: Op[]) => (applyOps(doc, ops), committed.push(ops)) };
  const ok = runTool(ctx, "create_uml_diagram", { diagram: example("activity") });
  assert.equal(ok.ok, true);
  assert.equal(committed.length, 1);
  const res = (ok as { result: { id: string; type: string } }).result;
  assert.equal(res.type, "activity");
  assert.ok(doc.nodes[res.id]);
  const bad = runTool(ctx, "create_uml_diagram", { diagram: { type: "sequence", participants: [{ id: "p" }], messages: [{ id: "m", from: "p", to: "q" }] } });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /q \(messages\[m\]\.to\)/);
});
