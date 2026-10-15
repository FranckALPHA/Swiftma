// Textes qui s'ajustent à leur contenu (dimensionnement « Ajuster ») : l'éditeur les mesure avec le moteur de texte
// du canevas et met leur taille à jour. Le cœur ne sait pas mesurer ; le lot envoyé contient donc les tailles
// mesurées, comme le reste des effets dérivés.

import Konva from "konva";
import { type DesignDocument, type DesignNode, type Op, cssFontStack } from "@swiftma/core";

let probe: Konva.Text | null = null;

export function measureText(n: DesignNode): { width: number; height: number } {
  probe ??= new Konva.Text({});
  const t = n.text!;
  probe.setAttrs({
    text: t.content || " ",
    fontFamily: cssFontStack(t),
    fontSize: t.fontSize,
    fontStyle: `${t.italic ? "italic " : ""}${t.fontWeight}`,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing ?? 0,
    // Largeur ajustée : pas de retour à la ligne automatique ; sinon on mesure la hauteur à largeur fixe
    width: n.sizingH === "hug" ? undefined : n.width,
    wrap: n.sizingH === "hug" ? "none" : "word",
  });
  if (n.sizingH === "hug") probe.width(undefined as unknown as number);
  return { width: probe.width(), height: probe.height() };
}

const round = (v: number) => Math.ceil(v * 100) / 100;

/** Opérations qui donnent aux textes « ajustés » la taille de leur contenu. */
export function fitTextOps(doc: DesignDocument): Op[] {
  const ops: Op[] = [];
  for (const n of Object.values(doc.nodes)) {
    if (n.type !== "text" || !n.text || (n.sizingH !== "hug" && n.sizingV !== "hug")) continue;
    const m = measureText(n);
    const props: { width?: number; height?: number } = {};
    if (n.sizingH === "hug" && Math.abs(round(m.width) - n.width) > 0.5) props.width = round(m.width);
    if (n.sizingV === "hug" && Math.abs(round(m.height) - n.height) > 0.5) props.height = round(m.height);
    if (Object.keys(props).length) ops.push({ kind: "update", id: n.id, props });
  }
  return ops;
}
