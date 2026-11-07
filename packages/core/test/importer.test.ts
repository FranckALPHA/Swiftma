import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { importPayloadToOps, getImageDimensions, parseSvgDimensions } from "../src/importer.js";
import { deflateSync } from "fflate";

test("parseSvgDimensions extrait les dimensions viewBox et width/height", () => {
  const svg1 = `<svg width="400px" height="300" viewBox="0 0 800 600"></svg>`;
  const dims1 = parseSvgDimensions(svg1);
  assert.equal(dims1.width, 400);
  assert.equal(dims1.height, 300);

  const svg2 = `<svg viewBox="0 0 1440 900"></svg>`;
  const dims2 = parseSvgDimensions(svg2);
  assert.equal(dims2.width, 1440);
  assert.equal(dims2.height, 900);
});

test("getImageDimensions détecte les headers PNG", () => {
  const buf = new Uint8Array(32);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  const view = new DataView(buf.buffer);
  view.setUint32(16, 640, false);
  view.setUint32(20, 480, false);

  const info = getImageDimensions(buf);
  assert.ok(info);
  assert.equal(info.mimeType, "image/png");
  assert.equal(info.width, 640);
  assert.equal(info.height, 480);
});

test("importPayloadToOps importe un SVG en calques éditables", () => {
  const svg = `<svg viewBox="0 0 100 100"><circle id="Circle" cx="50" cy="50" r="40" fill="red"/></svg>`;
  const res = importPayloadToOps({ text: svg, fileName: "circle.svg" }, { at: { x: 50, y: 100 } });

  assert.equal(res.format, "svg");
  assert.equal(res.stats.width, 100);
  assert.equal(res.stats.height, 100);
  assert.equal(res.stats.nodes, 2); // 1 frame racine + 1 cercle
  const rootNode = (res.ops[0] as any).node;
  assert.equal(rootNode.type, "frame");
  assert.equal(rootNode.x, 50);
  assert.equal(rootNode.y, 100);

  const circleNode = (res.ops[1] as any).node;
  assert.equal(circleNode.type, "ellipse");
  assert.equal(circleNode.name, "Circle");
  assert.equal(circleNode.fill, "#FF0000");
  assert.equal(circleNode.parentId, rootNode.id);
});

test("importPayloadToOps importe une capture H2D synthétique", () => {
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
      ],
    },
    assets: {},
  };

  const rawBytes = new TextEncoder().encode(JSON.stringify(sampleData));
  const compressed = deflateSync(rawBytes);
  const xored = new Uint8Array(compressed.length);
  for (let i = 0; i < compressed.length; i++) xored[i] = compressed[i]! ^ 57;

  const res = importPayloadToOps({ bytes: xored, fileName: "test.h2d" }, { at: { x: 200, y: 0 } });
  assert.equal(res.format, "h2d");
  assert.ok(res.ops.length >= 2);
  assert.ok(res.rootId);
});

test("importPayloadToOps vectorise un SVG Figma complexe en calques réels", () => {
  const svgPath = path.resolve(process.cwd(), "examples/effets-figma.svg");
  if (fs.existsSync(svgPath)) {
    const content = fs.readFileSync(svgPath, "utf-8");
    const res = importPayloadToOps({ text: content, fileName: "effets-figma.svg" });
    assert.equal(res.format, "svg");
    assert.ok(res.stats.nodes >= 8, `Doit contenir plusieurs calques réels, obtenu: ${res.stats.nodes}`);
    assert.equal(res.stats.width, 800);
    assert.equal(res.stats.height, 500);
  }
});

test("importPayloadToOps résout les patterns d'image et calcule les frames avec coordonnées relatives", () => {
  const svg = `<svg viewBox="0 0 1000 800">
    <defs>
      <image id="photo1" data-name="avatar.png" width="200" height="200" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="/>
      <pattern id="pat1" width="1" height="1"><use xlink:href="#photo1"/></pattern>
    </defs>
    <rect id="Avatar" x="50" y="50" width="120" height="120" rx="60" fill="url(#pat1)"/>
    <g id="Card">
      <rect id="CardBg" x="200" y="100" width="300" height="200" fill="#FFFFFF"/>
      <circle id="Badge" cx="450" cy="150" r="20" fill="red"/>
    </g>
  </svg>`;

  const res = importPayloadToOps({ text: svg, fileName: "test.svg" });
  assert.equal(res.format, "svg");

  // Avatar résolu en image avec src et radius
  const avatarNode = res.ops.find((o: any) => o.kind === "create" && o.node.name === "Avatar") as any;
  assert.ok(avatarNode);
  assert.equal(avatarNode.node.type, "image");
  assert.ok(avatarNode.node.image?.src.startsWith("data:image/png;base64"));
  assert.equal(avatarNode.node.radius, 60);

  // Card calculée avec vraies dimensions non nulles
  const cardNode = res.ops.find((o: any) => o.kind === "create" && o.node.name === "Card") as any;
  assert.ok(cardNode);
  assert.equal(cardNode.node.type, "frame");
  assert.equal(cardNode.node.x, 200);
  assert.equal(cardNode.node.y, 100);
  assert.equal(cardNode.node.width, 300);
  assert.equal(cardNode.node.height, 200);

  // CardBg positionné relativement à Card
  const cardBgNode = res.ops.find((o: any) => o.kind === "create" && o.node.name === "CardBg") as any;
  assert.ok(cardBgNode);
  assert.equal(cardBgNode.node.x, 0); // 200 - 200
  assert.equal(cardBgNode.node.y, 0); // 100 - 100
  assert.equal(cardBgNode.node.parentId, cardNode.node.id);

  // Badge positionné relativement à Card (cx - r = 450 - 20 = 430 -> 430 - 200 = 230)
  const badgeNode = res.ops.find((o: any) => o.kind === "create" && o.node.name === "Badge") as any;
  assert.ok(badgeNode);
  assert.equal(badgeNode.node.x, 230);
  assert.equal(badgeNode.node.y, 30); // 150 - 20 - 100 = 30
  assert.equal(badgeNode.node.parentId, cardNode.node.id);
});

test("importPayloadToOps découpe correctement les masques Figma (<mask id='...'>) et limite la taille du groupe", () => {
  const svg = `<svg viewBox="0 0 400 400">
    <defs>
      <mask id="mask_avatar" maskUnits="userSpaceOnUse" x="10" y="20" width="60" height="60">
        <circle cx="40" cy="50" r="30" fill="white"/>
      </mask>
    </defs>
    <g id="ProfilePic" mask="url(#mask_avatar)">
      <image id="Photo" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" x="0" y="10" width="120" height="120"/>
    </g>
  </svg>`;

  const res = importPayloadToOps({ text: svg, fileName: "avatar-mask.svg" });
  assert.equal(res.format, "svg");

  const groupNode = res.ops.find((o: any) => o.kind === "create" && o.node.name === "ProfilePic") as any;
  assert.ok(groupNode);
  assert.equal(groupNode.node.type, "frame");
  // La boîte doit correspondre au masque (60x60, radius 30, clip: true) et non à l'image 120x120 non-rognée
  assert.equal(groupNode.node.width, 60);
  assert.equal(groupNode.node.height, 60);
  assert.equal(groupNode.node.x, 10);
  assert.equal(groupNode.node.y, 20);
  assert.equal(groupNode.node.clip, true);
  assert.equal(groupNode.node.radius, 30);

  const imgNode = res.ops.find((o: any) => o.kind === "create" && o.node.name === "Photo") as any;
  assert.ok(imgNode);
  assert.equal(imgNode.node.type, "image");
  assert.equal(imgNode.node.parentId, groupNode.node.id);
  // Position relative à la frame masquée : x=0 - 10 = -10, y=10 - 20 = -10
  assert.equal(imgNode.node.x, -10);
  assert.equal(imgNode.node.y, -10);
});
