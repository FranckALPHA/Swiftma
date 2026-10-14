// Conversions partagées par le canevas et les exports : dégradés, ombres, couleurs, matrices.

import type { DesignNode, Gradient, PathData, Shadow } from "./model.js";

export type Matrix6 = [number, number, number, number, number, number];

/** "#RRGGBB" ou "#RRGGBBAA" → "rgba(r, g, b, a)". */
export function toRgba(hex: string): string {
  const h = hex.replace("#", "");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  const a = h.length >= 8 ? n(6) / 255 : 1;
  return `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${Math.round(a * 1000) / 1000})`;
}

/**
 * Dégradé → CSS exact pour une boîte w×h.
 * Un dégradé linéaire CSS passe par le centre de la boîte, avec un angle et une longueur imposés ;
 * on projette chaque arrêt du dégradé d'origine sur cette ligne pour garder les couleurs au même endroit.
 */
export function cssGradient(g: Gradient, w: number, h: number): string {
  if (g.type === "radial" && isRotated(g)) {
    // CSS ne sait pas tourner un dégradé radial : on passe par une image SVG, exacte.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 ${r2(w)} ${r2(h)}" preserveAspectRatio="none">` +
      `<defs>${svgRadialGradient("g", g, w, h)}</defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}") 0 0 / 100% 100% no-repeat`;
  }
  if (g.type === "radial") {
    const [cx, cy] = g.start;
    const [rx, ry] = g.radius ?? [0.5, 0.5];
    const stops = g.stops.map((s) => `${s.color} ${pct(s.offset)}`).join(", ");
    return `radial-gradient(${px(rx * w)} ${px(ry * h)} at ${pct(cx)} ${pct(cy)}, ${stops})`;
  }
  const x1 = g.start[0] * w, y1 = g.start[1] * h;
  const x2 = g.end[0] * w, y2 = g.end[1] * h;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const angle = (Math.atan2(ux, -uy) * 180) / Math.PI; // CSS : 0deg = vers le haut, sens horaire
  const L = Math.abs(w * ux) + Math.abs(h * uy); // longueur de la ligne de dégradé CSS
  const sx = w / 2 - (L / 2) * ux, sy = h / 2 - (L / 2) * uy; // départ de la ligne CSS
  const stops = g.stops
    .map((s) => {
      const t = ((x1 + s.offset * dx - sx) * ux + (y1 + s.offset * dy - sy) * uy) / (L || 1);
      return `${s.color} ${pct(t)}`;
    })
    .join(", ");
  return `linear-gradient(${Math.round(angle * 100) / 100}deg, ${stops})`;
}

const isRotated = (g: Gradient) => !!g.angle && Math.abs(g.angle % 180) > 0.01;

/** <radialGradient> SVG (coordonnées en pixels de la boîte w×h), avec rotation et ellipse exactes. */
export function svgRadialGradient(id: string, g: Gradient, w: number, h: number, extraTransform = "", camel = false): string {
  const [rx, ry] = g.radius ?? [0.5, 0.5];
  const t = `${extraTransform} translate(${r2(g.start[0] * w)} ${r2(g.start[1] * h)}) rotate(${r2(g.angle ?? 0)}) scale(${r2(rx * w) || 0.01} ${r2(ry * h) || 0.01})`.trim();
  return `<radialGradient id="${id}" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="${t}">${svgStops(g, camel)}</radialGradient>`;
}

export function svgStops(g: Gradient, camel = false): string {
  const sc = camel ? "stopColor" : "stop-color";
  const so = camel ? "stopOpacity" : "stop-opacity";
  return g.stops
    .map((s) => `<stop offset="${r2(s.offset)}" ${sc}="${s.color.slice(0, 7)}"${s.color.length > 7 ? ` ${so}="${r2(parseInt(s.color.slice(7), 16) / 255)}"` : ""}/>`)
    .join("");
}

/** Masque de forme libre → CSS mask avec une image SVG intégrée (exact, transformations et règle de remplissage comprises). */
export function cssMask(clip: PathData, w: number, h: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 ${r2(w)} ${r2(h)}" preserveAspectRatio="none">` +
    `<path d="${clip.d}" transform="matrix(${clip.matrix.map((v) => Math.round(v * 1e6) / 1e6).join(" ")})" fill="#000"${clip.fillRule === "evenodd" ? ' fill-rule="evenodd"' : ""}/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}") 0 0 / 100% 100% no-repeat`;
}

/** Tous les effets d'un nœud → CSS : ombres, flou de calque, flou d'arrière-plan. */
export function cssEffects(n: Pick<DesignNode, "type" | "fill" | "gradient" | "shadows" | "layerBlur" | "backgroundBlur">): {
  boxShadow?: string;
  filter?: string;
  backdropFilter?: string;
} {
  const out: { boxShadow?: string; filter?: string; backdropFilter?: string } = cssShadows(n, n.shadows ?? []);
  if (n.layerBlur) out.filter = [out.filter, `blur(${px(n.layerBlur / 2)})`].filter(Boolean).join(" ");
  if (n.backgroundBlur) out.backdropFilter = `blur(${px(n.backgroundBlur / 2)})`;
  return out;
}

/** Ombres → CSS. Les boîtes pleines utilisent box-shadow (étendue et ombres internes comprises) ;
 *  les formes libres (vecteurs, textes, frames sans fond) utilisent filter: drop-shadow, qui suit leur contour. */
export function cssShadows(node: Pick<DesignNode, "type" | "fill" | "gradient">, shadows: Shadow[]): { boxShadow?: string; filter?: string } {
  if (!shadows.length) return {};
  const boxy = node.type === "rect" || node.type === "ellipse" || node.type === "image" || (node.type === "frame" && (!!node.fill || !!node.gradient));
  if (boxy) {
    return {
      boxShadow: shadows
        .map((s) => `${s.type === "inner" ? "inset " : ""}${px(s.x)} ${px(s.y)} ${px(s.blur)} ${px(s.spread)} ${s.color}`)
        .join(", "),
    };
  }
  const drops = shadows.filter((s) => s.type === "drop");
  return drops.length ? { filter: drops.map((s) => `drop-shadow(${px(s.x)} ${px(s.y)} ${px(s.blur)} ${s.color})`).join(" ") } : {};
}

export function invertMatrix([a, b, c, d, e, f]: Matrix6): Matrix6 {
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function applyMatrix([a, b, c, d, e, f]: Matrix6, x: number, y: number): [number, number] {
  return [a * x + c * y + e, b * x + d * y + f];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const px = (v: number) => `${r2(v)}px`;
const pct = (v: number) => `${r2(v * 100)}%`;
