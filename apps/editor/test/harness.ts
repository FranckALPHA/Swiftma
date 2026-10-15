// Banc d'essai de fidélité (outil de développement, hors application).
// Fait passer un SVG par le VRAI import de l'éditeur puis par l'export React, sans interface.

import { applyOps, createDocument, exportReact, makeResponsiveOps } from "@nyota/core";
import { importSvg } from "../src/svgImport";

export async function convert(svg: string, name = "Case", opts: { responsive?: boolean } = {}) {
  const doc = createDocument();
  const { ops, rootId, stats } = await importSvg(svg, name, { x: 0, y: 0 });
  applyOps(doc, ops);
  let frames = 0;
  if (opts.responsive) {
    // Conversion en auto-layout (flexbox) : le rendu doit rester identique
    const res = makeResponsiveOps(doc, rootId);
    applyOps(doc, res.ops);
    frames = res.frames;
  }
  const root = doc.nodes[rootId]!;
  return { files: exportReact(doc, rootId), stats, width: root.width, height: root.height, layers: Object.keys(doc.nodes).length, layoutFrames: frames };
}
