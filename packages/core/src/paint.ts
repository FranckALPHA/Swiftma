// Conversions partagées par le canevas et les exports : dégradés, ombres, couleurs, matrices.

import type { ClipPath, DesignNode, Gradient, Shadow } from "./model.js";

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
export function cssMask(clip: ClipPath, w: number, h: number): string {
  let defs = "";
  let fill = "#000";
  if (clip.fade) {
    // Fondu : la forme est remplie par le dégradé d'opacité, défini en pixels de la frame
    // puis ramené dans le repère du tracé par l'inverse de sa matrice.
    const inv = `matrix(${invertMatrix(clip.matrix).map((v) => Math.round(v * 1e6) / 1e6).join(" ")})`;
    const g = clip.fade;
    defs =
      g.type === "radial"
        ? svgRadialGradient("f", g, w, h, inv)
        : `<linearGradient id="f" gradientUnits="userSpaceOnUse" gradientTransform="${inv}" x1="${r2(g.start[0] * w)}" y1="${r2(g.start[1] * h)}" x2="${r2(g.end[0] * w)}" y2="${r2(g.end[1] * h)}">${svgStops(g)}</linearGradient>`;
    defs = `<defs>${defs}</defs>`;
    fill = "url(#f)";
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(w)}" height="${r2(h)}" viewBox="0 0 ${r2(w)} ${r2(h)}" preserveAspectRatio="none">${defs}` +
    [clip, ...(clip.parts ?? [])]
      .map((p) => `<path d="${p.d}" transform="matrix(${p.matrix.map((v) => Math.round(v * 1e6) / 1e6).join(" ")})" fill="${fill}"${p.fillRule === "evenodd" ? ' fill-rule="evenodd"' : ""}/>`)
      .join("") +
    `</svg>`;
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

/** Contour centré d'une boîte : une moitié dehors, une moitié dedans (box-shadow, suit les coins arrondis). */
export function cssStroke(st: { width: number; color: string }): string {
  const h = px(st.width / 2);
  return `0 0 0 ${h} ${st.color}, inset 0 0 0 ${h} ${st.color}`;
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

// ---------- Polices Google Fonts ----------

export interface FontVariant {
  family: string;
  weight: number;
  italic: boolean;
}

/** Polices réellement utilisées par un ensemble de nœuds (famille, graisse, italique). */
export function fontVariants(nodes: Iterable<Pick<DesignNode, "text">>): FontVariant[] {
  const seen = new Map<string, FontVariant>();
  for (const n of nodes) {
    if (!n.text) continue;
    for (const family of [n.text.fontFamily, ...(n.text.fallbackFonts ?? [])]) {
      if (GENERIC_FONTS.has(family.toLowerCase())) continue;
      const v = { family, weight: n.text.fontWeight, italic: !!n.text.italic };
      seen.set(`${v.family}|${v.weight}|${v.italic}`, v);
    }
  }
  return [...seen.values()];
}

export const GENERIC_FONTS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong"]);

/** Pile CSS : police principale, polices de secours, puis une police générique (sans guillemets pour les génériques). */
export function cssFontStack(t: { fontFamily: string; fallbackFonts?: string[] }): string {
  const q = (f: string) => (GENERIC_FONTS.has(f.toLowerCase()) ? f : `"${f.replace(/"/g, "")}"`);
  const list = [t.fontFamily, ...(t.fallbackFonts ?? [])];
  if (!list.some((f) => GENERIC_FONTS.has(f.toLowerCase()))) list.push("sans-serif");
  return list.map(q).join(", ");
}

/**
 * Une URL Google Fonts PAR famille, avec seulement les variantes utilisées.
 * (Une seule URL pour toutes les familles échoue entièrement dès qu'une variante n'existe pas.)
 */
export function googleFontUrls(variants: FontVariant[]): { family: string; url: string }[] {
  const byFamily = new Map<string, Set<string>>();
  for (const v of variants) {
    const set = byFamily.get(v.family) ?? new Set<string>();
    set.add(`${v.italic ? 1 : 0},${Math.round(v.weight)}`);
    byFamily.set(v.family, set);
  }
  return [...byFamily].map(([family, set]) => {
    // Google exige les tuples triés (italique puis graisse)
    const tuples = [...set].sort((a, b) => {
      const [ia, wa] = a.split(",").map(Number);
      const [ib, wb] = b.split(",").map(Number);
      return ia! - ib! || wa! - wb!;
    });
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    return { family, url: `https://fonts.googleapis.com/css2?family=${name}:ital,wght@${tuples.join(";")}&display=swap` };
  });
}

// ---------- Placement d'un élément en position libre (contraintes) ----------

type Placed = { x: number; y: number; width: number; height: number; rotation: number; constraints?: { h: string; v: string } | null };

/** L'élément s'étire-t-il avec son parent sur cet axe (ancré des deux côtés ou à l'échelle) ? Sa taille vient alors du placement. */
export function stretchesWithParent(n: Placed, axis: "h" | "v"): boolean {
  const c = n.constraints;
  if (!c) return false;
  return axis === "h" ? c.h === "left-right" || c.h === "scale" : c.v === "top-bottom" || c.v === "scale";
}

/** CSS de placement d'un enfant en position libre dans un parent de taille pw×ph, selon ses contraintes :
 *  à la taille de la maquette, le résultat est identique ; quand le parent change de taille, l'enfant suit. */
export function absolutePlacementCss(n: Placed, pw: number, ph: number): string[] {
  const c = n.constraints ?? { h: "left", v: "top" };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const pxv = (v: number) => `${r2(v)}px`;
  const pct = (v: number, of: number) => `${r2((v / (of || 1)) * 100 * 100) / 100}%`;
  const out = ["position: absolute"];
  const axis = (mode: string, pos: number, size: number, parent: number, start: string, end: string, dim: string) => {
    if (mode === "right" || mode === "bottom") out.push(`${end}: ${pxv(parent - pos - size)}`);
    else if (mode === "left-right" || mode === "top-bottom") out.push(`${start}: ${pxv(pos)}`, `${end}: ${pxv(parent - pos - size)}`);
    else if (mode === "center") out.push(`${start}: calc(50% + ${pxv(pos - parent / 2)})`);
    else if (mode === "scale") out.push(`${start}: ${pct(pos, parent)}`, `${dim}: ${pct(size, parent)}`);
    else out.push(`${start}: ${pxv(pos)}`);
  };
  axis(c.h, n.x, n.width, pw, "left", "right", "width");
  axis(c.v, n.y, n.height, ph, "top", "bottom", "height");
  if (n.rotation) out.push(`transform: rotate(${n.rotation}deg)`, "transform-origin: top left");
  return out;
}

/** Bornes de taille en CSS. */
export function sizeBoundsCss(n: { minWidth?: number | null; maxWidth?: number | null; minHeight?: number | null; maxHeight?: number | null }): string[] {
  const out: string[] = [];
  const pxv = (v: number) => `${Math.round(v * 100) / 100}px`;
  if (n.minWidth) out.push(`min-width: ${pxv(n.minWidth)}`);
  if (n.maxWidth) out.push(`max-width: ${pxv(n.maxWidth)}`);
  if (n.minHeight) out.push(`min-height: ${pxv(n.minHeight)}`);
  if (n.maxHeight) out.push(`max-height: ${pxv(n.maxHeight)}`);
  return out;
}
