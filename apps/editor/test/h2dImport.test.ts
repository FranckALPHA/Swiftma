import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import { deflateSync } from "fflate";
import { applyOps, createDocument } from "@swiftma/core";
import { decodeH2D, h2dToHtmlSnapshot, h2dToOps, isH2DBytes, isMakeArchive, parseCssColor } from "../src/h2dImport";
import { htmlSnapshotToOps } from "../src/htmlImport";

test("parseCssColor convertit fidèlement différents formats CSS", () => {
  // Hex
  assert.equal(parseCssColor("#ffffff"), "#FFFFFF");
  assert.equal(parseCssColor("#123"), "#112233");
  // Transparent
  assert.equal(parseCssColor("transparent"), null);
  assert.equal(parseCssColor("rgba(0, 0, 0, 0)"), null);
  // RGB / RGBA
  assert.equal(parseCssColor("rgb(255, 0, 128)"), "#FF0080");
  assert.equal(parseCssColor("rgba(255, 255, 255, 0.5)"), "#FFFFFF80");
  // OKLCH (utilisé par Bootstrap, Tailwind v4, DaisyUI)
  const purple = parseCssColor("oklch(0.56 0.26 288)");
  assert.ok(purple && purple.startsWith("#"), "OKLCH doit être converti en hex");
  // Lab
  const labColor = parseCssColor("lab(39.7424 51.5301 -79.019)");
  assert.ok(labColor && labColor.startsWith("#"), "Lab doit être converti en hex");
});

test("décode un payload H2D synthétique avec masquage XOR 57 et Deflate Raw", () => {
  const sampleData = {
    name: "https://mon-site.test/",
    doc: { title: "Mon Site Test", innerWidth: 1440, innerHeight: 900 },
    frame: {
      type: "FRAME",
      tag: "header",
      x: 0,
      y: 0,
      width: 1440,
      height: 80,
      styles: {
        backgroundColor: "rgb(24, 24, 27)",
        color: "rgb(255, 255, 255)",
      },
      children: [
        {
          type: "TEXT",
          value: "Logo MonSite",
          font: "Inter",
          x: 40,
          y: 25,
          width: 160,
          height: 30,
          styles: {
            fontSize: "20px",
            fontWeight: "700",
            color: "rgb(255, 255, 255)",
          },
        },
        {
          type: "SVG",
          x: 1360,
          y: 28,
          width: 24,
          height: 24,
          svg: '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
        },
      ],
    },
    assets: {},
  };

  // Compression Deflate
  const jsonBytes = new TextEncoder().encode(JSON.stringify(sampleData));
  const compressed = deflateSync(jsonBytes);
  // Masquage XOR 57
  const xored = new Uint8Array(compressed.length);
  for (let i = 0; i < compressed.length; i++) {
    xored[i] = compressed[i]! ^ 57;
  }

  assert.equal(isH2DBytes(xored), true);

  const decoded = decodeH2D(xored);
  assert.equal(decoded.name, "https://mon-site.test/");
  assert.equal(decoded.doc.title, "Mon Site Test");

  const snapshot = h2dToHtmlSnapshot(decoded);
  assert.equal(snapshot.format, "swiftma-html");
  assert.equal(snapshot.root?.type, "frame");
  assert.equal(snapshot.root?.width, 1440);
  assert.equal(snapshot.root?.fill, "#18181B");
  assert.equal(snapshot.root?.children.length, 2);

  const logoNode = snapshot.root?.children[0];
  assert.equal(logoNode?.type, "text");
  assert.equal(logoNode?.x, 40);
  assert.equal(logoNode?.y, 25);
  assert.equal(logoNode?.text?.content, "Logo MonSite");
  assert.equal(logoNode?.text?.fontSize, 20);
  assert.equal(logoNode?.text?.fontWeight, 700);

  const svgNode = snapshot.root?.children[1];
  assert.equal(svgNode?.type, "image");
  assert.equal(svgNode?.x, 1360);
  assert.ok(svgNode?.image?.src.startsWith("data:image/svg+xml"));

  // Application complète aux ops Swiftma
  const result = htmlSnapshotToOps(snapshot);
  const doc = createDocument();
  applyOps(doc, result.ops);

  assert.equal(doc.roots.length, 1);
  const root = doc.nodes[result.rootId]!;
  assert.equal(root.width, 1440);
  assert.equal(root.children.length, 2);
});

test("importe le fichier réel getbootstrap.h2d téléchargé s’il est présent", () => {
  const filePath = "/home/franck-alpha/Téléchargements/getbootstrap_com_1536w_default.h2d";
  if (!fs.existsSync(filePath)) return;

  const bytes = new Uint8Array(fs.readFileSync(filePath));
  const result = h2dToOps(bytes, { x: 100, y: 50 });

  assert.ok(result.ops.length > 50, "Le fichier Bootstrap doit générer de nombreux nœuds");
  assert.ok(result.stats.nodes > 50);

  const doc = createDocument();
  applyOps(doc, result.ops);

  const root = doc.nodes[result.rootId]!;
  assert.equal(root.x, 100);
  assert.equal(root.y, 50);
  assert.ok(root.width >= 1200);
  assert.ok(root.children.length > 0);

  // Vérifie la prise en compte du border-radius des boutons
  const allNodes = Object.values(doc.nodes);
  const roundedNodes = allNodes.filter((n) => n.radius > 0);
  assert.ok(roundedNodes.length >= 10, "Au moins 10 éléments doivent avoir un rayon d'angle (radius) non nul");
  const roundedButtons = allNodes.filter((n) => n.name.includes("btn") && n.radius > 0);
  assert.ok(roundedButtons.length > 0, "Les boutons avec classe .btn doivent avoir un radius > 0");
});

test("importe le fichier réel mobbin.h2d téléchargé s’il est présent", () => {
  const filePath = "/home/franck-alpha/Téléchargements/mobbin_com_discover_sites_latest_1536w_default.h2d";
  if (!fs.existsSync(filePath)) return;

  const bytes = new Uint8Array(fs.readFileSync(filePath));
  const result = h2dToOps(bytes);

  assert.ok(result.ops.length > 100, "Mobbin doit comporter plus de 100 calques");

  const doc = createDocument();
  applyOps(doc, result.ops);

  const root = doc.nodes[result.rootId]!;
  assert.ok(root.width >= 1200);
});

test("importe le fichier réel deezer.h2d téléchargé et n’ajoute aucun trait blanc parasite dans le footer", () => {
  const filePath = "/home/franck-alpha/Téléchargements/www_deezer_com_fr_1536w_default.h2d";
  if (!fs.existsSync(filePath)) return;

  const bytes = new Uint8Array(fs.readFileSync(filePath));
  const result = h2dToOps(bytes);

  const doc = createDocument();
  applyOps(doc, result.ops);

  const allNodes = Object.values(doc.nodes);
  // Aucun calque ne doit avoir de bordure blanche parasite #FDFCFE
  const whiteStrokes = allNodes.filter((n) => n.stroke?.color === "#FDFCFE");
  assert.equal(whiteStrokes.length, 0, "Aucun trait blanc #FDFCFE ne doit être généré sur les calques");

  // Les conteneurs du footer ne doivent pas avoir de contour de bordure
  const storeCells = allNodes.filter((n) => n.name.includes("cell-stores") || n.name.includes("cell-navigation"));
  assert.ok(storeCells.length > 0, "Doit contenir les cellules de footer Deezer");
  for (const cell of storeCells) {
    assert.equal(cell.stroke, null, `Le calque ${cell.name} ne doit avoir aucun contour`);
  }

  // Les boutons badges des stores (App Store / Google Play) doivent avoir un SVG valide encodé en base64
  const storeBadges = allNodes.filter((n) => n.name.includes("store-badge") && n.type === "image");
  assert.equal(storeBadges.length, 2, "Doit contenir les 2 badges App Store et Play Store");
  for (const badge of storeBadges) {
    assert.ok(badge.image?.src.startsWith("data:image/svg+xml;base64,PHN2"), "Le badge doit être encodé en base64 valide et non du XML brut malformé");
    assert.ok(!badge.image?.src.includes("<svg"), "La data URI base64 ne doit pas contenir de balises XML non encodées");
  }

  // Les logos Deezer (définis via backgroundImage dans le header et le footer) doivent être importés comme images
  const deezerLogos = allNodes.filter((n) => n.name.includes("logo-deezer"));
  assert.equal(deezerLogos.length, 2, "Doit contenir les 2 logos Deezer");
  for (const logo of deezerLogos) {
    assert.equal(logo.type, "image", "Le logo Deezer doit être un nœud image");
    assert.ok(logo.image?.src.startsWith("data:image/svg+xml;base64,"), "Le logo Deezer doit être encodé en base64 SVG");
  }
});

test("détecte une archive .make", () => {
  const zipHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  assert.equal(isMakeArchive(zipHeader), true);
  assert.equal(isMakeArchive(new Uint8Array([0x00, 0x00, 0x00, 0x00])), false);
});
