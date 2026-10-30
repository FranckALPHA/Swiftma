import assert from "node:assert/strict";
import test from "node:test";
import { applyOps, createDocument, findHoverVariant } from "@swiftma/core";
import { htmlSnapshotToOps } from "../src/htmlImport";

const snapshot = {
  format: "swiftma-html",
  version: 1,
  source: { title: "Accueil", url: "https://example.com/", capturedAt: "2026-10-30T00:00:00.000Z" },
  root: {
    type: "frame",
    name: "Accueil",
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
    fill: "#ffffff",
    radius: 0,
    opacity: 1,
    clip: true,
    children: [{
      type: "text",
      name: "Titre — texte",
      x: 24,
      y: 32,
      width: 300,
      height: 48,
      fill: null,
      radius: 0,
      opacity: 1,
      clip: false,
      text: {
        content: "Bonjour",
        fontFamily: "Arial",
        fontSize: 32,
        fontWeight: 700,
        color: "#112233",
        align: "left",
        lineHeight: 1.2,
      },
      children: [],
    }],
  },
};

test("imports a Swiftma HTML snapshot as nested editable nodes", () => {
  const result = htmlSnapshotToOps(snapshot, { x: 1400, y: 20 });
  const doc = createDocument();
  applyOps(doc, result.ops);
  const root = doc.nodes[result.rootId]!;
  const text = doc.nodes[root.children[0]!]!;
  assert.equal(result.stats.nodes, 2);
  assert.equal(root.x, 1400);
  assert.equal(root.width, 1200);
  assert.equal(text.parentId, root.id);
  assert.equal(text.x, 24);
  assert.equal(text.text?.content, "Bonjour");
});

test("imports CSS gradients with transparent stops", () => {
  const input = structuredClone(snapshot);
  input.root.children = [{
    type: "rect",
    name: "Arrière-plan dégradé",
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
    fill: null,
    radius: 12,
    opacity: 1,
    clip: false,
    gradient: {
      type: "radial",
      stops: [
        { color: "#e1287280", offset: 0 },
        { color: "#00000000", offset: 0.5 },
      ],
      start: [0.5, 0.5],
      end: [1, 1],
      radius: [0.5, 4],
    },
    children: [],
  }];

  const result = htmlSnapshotToOps(input, { x: 0, y: 0 });
  const doc = createDocument();
  applyOps(doc, result.ops);
  const root = doc.nodes[result.rootId]!;
  const gradient = doc.nodes[root.children[0]!]!;
  assert.deepEqual(gradient.gradient?.stops, [
    { color: "#e1287280", offset: 0 },
    { color: "#00000000", offset: 0.5 },
  ]);
  assert.deepEqual(gradient.gradient?.radius, [0.5, 4]);
});

test("imports CSS drop and inset shadows", () => {
  const input = structuredClone(snapshot);
  input.root.children = [{
    type: "rect",
    name: "Carte avec ombres",
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    fill: "#ffffff",
    radius: 12,
    opacity: 1,
    clip: false,
    shadows: [
      { type: "drop", x: 0, y: 8, blur: 20, spread: -4, color: "#00000026" },
      { type: "inner", x: 0, y: 1, blur: 2, spread: 0, color: "#0000001a" },
    ],
    children: [],
  }];

  const result = htmlSnapshotToOps(input, { x: 0, y: 0 });
  const doc = createDocument();
  applyOps(doc, result.ops);
  const root = doc.nodes[result.rootId]!;
  const card = doc.nodes[root.children[0]!]!;
  assert.deepEqual(card.shadows, input.root.children[0]!.shadows);
});

test("rejects unrecognized formats and unsafe image URLs", () => {
  assert.throws(() => htmlSnapshotToOps({ ...snapshot, format: "other" }, { x: 0, y: 0 }), /Format de fichier/);
  const invalid: Record<string, unknown> = structuredClone(snapshot);
  const invalidRoot = invalid.root as { children: unknown[] };
  invalidRoot.children = [{
    type: "image",
    name: "Image",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    fill: null,
    radius: 0,
    opacity: 1,
    clip: false,
    image: { src: "javascript:alert(1)" },
    children: [],
  }];
  assert.throws(() => htmlSnapshotToOps(invalid, { x: 0, y: 0 }), /URL d’image invalide/);
});

test("imports images with data URLs (SVG and PNG)", () => {
  const input = structuredClone(snapshot);
  const svgData = "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%3E%3Cpath%20d%3D%22M0%200h24v24H0z%22%2F%3E%3C%2Fsvg%3E";
  const pngData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  input.root.children = [
    {
      type: "image",
      name: "Logo SVG",
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      fill: null,
      radius: 4,
      opacity: 1,
      clip: false,
      image: { src: svgData },
      children: [],
    },
    {
      type: "image",
      name: "Pixel PNG",
      x: 60,
      y: 10,
      width: 100,
      height: 100,
      fill: null,
      radius: 0,
      opacity: 0.9,
      clip: false,
      image: { src: pngData, crop: { x: 0, y: 0, width: 1, height: 1 } },
      children: [],
    },
  ];

  const result = htmlSnapshotToOps(input, { x: 0, y: 0 });
  const doc = createDocument();
  applyOps(doc, result.ops);
  const root = doc.nodes[result.rootId]!;
  const [logoNode, pngNode] = root.children.map((id) => doc.nodes[id]!);

  assert.equal(logoNode?.type, "image");
  assert.equal(logoNode?.image?.src, svgData);
  assert.equal(pngNode?.type, "image");
  assert.equal(pngNode?.image?.src, pngData);
  assert.deepEqual(pngNode?.image?.crop, { x: 0, y: 0, width: 1, height: 1 });
});

test("imports a flex row as Swiftma auto-layout and preserves absolute children", () => {
  const input = JSON.parse(JSON.stringify(snapshot)) as {
    root: { layout?: unknown; children: Array<Record<string, unknown>> };
  };
  input.root.layout = {
    direction: "row",
    gap: 16,
    padding: [12, 12, 12, 12],
    justify: "start",
    align: "center",
  };
  input.root.children = [
    { ...input.root.children[0]!, x: 12, y: 26, width: 100, height: 24 },
    { ...input.root.children[0]!, name: "Lien — texte", x: 128, y: 26, width: 100, height: 24 },
    { ...input.root.children[0]!, name: "Badge — texte", x: 240, y: 4, absolute: true, width: 20, height: 20 },
  ];

  const result = htmlSnapshotToOps(input, { x: 0, y: 0 });
  const doc = createDocument();
  applyOps(doc, result.ops);
  const root = doc.nodes[result.rootId]!;
  const [first, second, badge] = root.children.map((id) => doc.nodes[id]!);

  assert.deepEqual(root.layout, input.root.layout);
  assert.equal(first!.x, 12);
  assert.equal(second!.x, 128);
  assert.equal(badge!.x, 240);
  assert.equal(badge!.absolute, true);
});

test("rejects invalid auto-layout data", () => {
  const input = JSON.parse(JSON.stringify(snapshot)) as {
    root: { layout?: unknown };
  };
  input.root.layout = {
    direction: "row",
    gap: -1,
    padding: [0, 0, 0, 0],
    justify: "start",
    align: "start",
  };
  assert.throws(() => htmlSnapshotToOps(input, { x: 0, y: 0 }), /Auto-layout invalide/);
});

test("imports an element with states as a component set and interactive instance", () => {
  const input = structuredClone(snapshot);
  input.root.children = [{
    type: "frame",
    name: "Bouton CTA",
    x: 40,
    y: 60,
    width: 140,
    height: 48,
    fill: "#2563eb",
    radius: 8,
    opacity: 1,
    clip: true,
    children: [{
      type: "text",
      name: "Bouton CTA — texte",
      x: 20,
      y: 14,
      width: 100,
      height: 20,
      fill: null,
      radius: 0,
      opacity: 1,
      clip: false,
      text: {
        content: "Commencer",
        fontFamily: "Arial",
        fontSize: 16,
        fontWeight: 600,
        color: "#ffffff",
        align: "left",
        lineHeight: 1.2,
      },
      children: [],
    }],
    states: {
      "Survol": {
        fill: "#1d4ed8",
        textColor: "#f8fafc",
      },
    },
  }];

  const result = htmlSnapshotToOps(input, { x: 0, y: 0 });
  const doc = createDocument();
  applyOps(doc, result.ops);

  const root = doc.nodes[result.rootId]!;
  const instId = root.children[0]!;
  const instNode = doc.nodes[instId]!;

  // Vérifier que l'instance est bien liée à un composant
  assert.ok(instNode.instanceOf);
  const baseComp = doc.nodes[instNode.instanceOf]!;
  assert.equal(baseComp.isComponent, true);
  assert.deepEqual(baseComp.variant, { "État": "Normal" });
  assert.equal(baseComp.fill, "#2563eb");

  // Vérifier la détection de la variante de survol via findHoverVariant
  const hoverComp = findHoverVariant(doc, instId);
  assert.ok(hoverComp);
  assert.deepEqual(hoverComp.node.variant, { "État": "Survol" });
  assert.equal(hoverComp.node.fill, "#1d4ed8");

  // Vérifier le component set parent
  const setId = baseComp.parentId!;
  const setNode = doc.nodes[setId]!;
  assert.equal(setNode.isComponentSet, true);
  assert.equal(setNode.children.length, 2);
  assert.ok(setNode.children.includes(baseComp.id));
  assert.ok(setNode.children.includes(hoverComp.node.id));
});

test("imports an accordion details element with open state variant", () => {
  const input = structuredClone(snapshot);
  input.root.children = [{
    type: "frame",
    name: "Foire aux questions",
    x: 40,
    y: 60,
    width: 600,
    height: 72,
    fill: "#ffffff",
    radius: 8,
    opacity: 1,
    clip: true,
    children: [{
      type: "text",
      name: "Question — texte",
      x: 16,
      y: 24,
      width: 500,
      height: 24,
      fill: null,
      radius: 0,
      opacity: 1,
      clip: false,
      text: {
        content: "Comment ça marche ?",
        fontFamily: "Arial",
        fontSize: 18,
        fontWeight: 600,
        color: "#111827",
        align: "left",
        lineHeight: 1.2,
      },
      children: [],
    }],
    states: {
      "Ouvert": {
        height: 216,
        children: [
          {
            type: "text",
            name: "Question — texte",
            x: 16,
            y: 24,
            width: 500,
            height: 24,
            fill: null,
            radius: 0,
            opacity: 1,
            clip: false,
            text: {
              content: "Comment ça marche ?",
              fontFamily: "Arial",
              fontSize: 18,
              fontWeight: 600,
              color: "#111827",
              align: "left",
              lineHeight: 1.2,
            },
            children: [],
          },
          {
            type: "text",
            name: "Réponse — texte",
            x: 16,
            y: 72,
            width: 500,
            height: 120,
            fill: null,
            radius: 0,
            opacity: 1,
            clip: false,
            text: {
              content: "Voici la réponse détaillée qui s'affiche à l'ouverture.",
              fontFamily: "Arial",
              fontSize: 15,
              fontWeight: 400,
              color: "#4b5563",
              align: "left",
              lineHeight: 1.4,
            },
            children: [],
          },
        ],
      },
    },
  }];

  const result = htmlSnapshotToOps(input, { x: 0, y: 0 });
  const doc = createDocument();
  applyOps(doc, result.ops);

  const root = doc.nodes[result.rootId]!;
  const instId = root.children[0]!;
  const instNode = doc.nodes[instId]!;

  assert.ok(instNode.instanceOf);
  const closedComp = doc.nodes[instNode.instanceOf]!;
  assert.equal(closedComp.isComponent, true);
  assert.deepEqual(closedComp.variant, { "État": "Fermé" });
  assert.equal(closedComp.height, 72);

  const setId = closedComp.parentId!;
  const setNode = doc.nodes[setId]!;
  assert.equal(setNode.isComponentSet, true);

  const openCompId = setNode.children.find((id) => id !== closedComp.id)!;
  const openComp = doc.nodes[openCompId]!;
  assert.deepEqual(openComp.variant, { "État": "Ouvert" });
  assert.equal(openComp.height, 216);
  assert.equal(openComp.children.length, 2);
});

test("imports a full site snapshot with multiple pages placed side by side", () => {
  const siteSnapshot = {
    format: "swiftma-html",
    version: 1,
    source: {
      title: "Mon Site (Site complet)",
      url: "https://monsite.fr",
      capturedAt: "2026-10-30T00:00:00.000Z",
      isSite: true,
      pageCount: 3,
    },
    pages: [
      {
        title: "Accueil",
        url: "https://monsite.fr",
        root: {
          type: "frame",
          name: "Accueil",
          x: 0,
          y: 0,
          width: 1440,
          height: 1800,
          fill: "#ffffff",
          radius: 0,
          opacity: 1,
          clip: true,
          children: [],
        },
      },
      {
        title: "Services",
        url: "https://monsite.fr/services",
        root: {
          type: "frame",
          name: "Services",
          x: 0,
          y: 0,
          width: 1440,
          height: 1200,
          fill: "#fafafa",
          radius: 0,
          opacity: 1,
          clip: true,
          children: [],
        },
      },
      {
        title: "Contact",
        url: "https://monsite.fr/contact",
        root: {
          type: "frame",
          name: "Contact",
          x: 0,
          y: 0,
          width: 1440,
          height: 900,
          fill: "#ffffff",
          radius: 0,
          opacity: 1,
          clip: true,
          children: [],
        },
      },
    ],
  };

  const result = htmlSnapshotToOps(siteSnapshot, { x: 100, y: 50 });
  const doc = createDocument();
  applyOps(doc, result.ops);

  assert.equal(result.stats.pages, 3);
  assert.equal(result.rootIds?.length, 3);
  assert.equal(doc.roots.length, 3);

  const page1 = doc.nodes[result.rootIds[0]!]!;
  const page2 = doc.nodes[result.rootIds[1]!]!;
  const page3 = doc.nodes[result.rootIds[2]!]!;

  assert.equal(page1.name, "Accueil");
  assert.equal(page1.x, 100);
  assert.equal(page1.y, 50);

  assert.equal(page2.name, "Services");
  assert.equal(page2.x, 1700);
  assert.equal(page2.y, 50);

  assert.equal(page3.name, "Contact");
  assert.equal(page3.x, 3300);
  assert.equal(page3.y, 50);
});

