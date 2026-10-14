// Import SVG → maquette Nyota éditable.
//
// On laisse le navigateur faire le travail difficile : le SVG est monté hors écran, puis pour chaque
// élément on lit sa boîte englobante (getBBox), sa matrice vers le repère racine (getScreenCTM) et
// ses styles résolus (getComputedStyle). Chaque élément devient un nœud :
//   <g>                 → frame sans fond (masque / clip-path → frame qui rogne)
//   <rect>              → rectangle (rx → radius), ou image si rempli par un motif d'image
//   <circle>, <ellipse> → ellipse
//   <path>, <polygon>…  → vecteur (le tracé d'origine + une matrice)
//   <image>             → image
//   <text>              → texte
// Les noms de calques (attribut id, comme dans les exports Figma) sont conservés.

import { type DesignNode, type NodeType, type Op, makeNode, newId } from "@nyota/core";

type Matrix = [number, number, number, number, number, number];

interface Spec {
  type: NodeType;
  name: string;
  x: number; // position absolue dans le repère du SVG
  y: number;
  width: number;
  height: number;
  props: Partial<DesignNode>;
  children: Spec[];
}

export interface SvgImportResult {
  ops: Op[];
  rootId: string;
  stats: { nodes: number; skipped: Record<string, number> };
}

const SKIP = new Set(["defs", "mask", "clipPath", "pattern", "linearGradient", "radialGradient", "symbol", "title", "desc", "style", "metadata", "script", "filter", "marker"]);

export async function importSvg(source: string, name: string, at: { x: number; y: number }): Promise<SvgImportResult> {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const err = parsed.querySelector("parsererror");
  if (err || parsed.documentElement.nodeName.toLowerCase() !== "svg") throw new Error("Fichier SVG invalide.");

  // Montage hors écran : nécessaire pour que le navigateur calcule géométrie et styles.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;"; // pas visibility:hidden : les enfants en hériteraient
  const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  host.appendChild(svg);
  document.body.appendChild(host);

  try {
    await loadFonts(svg);
    const vb = svg.viewBox.baseVal;
    const width = vb && vb.width ? vb.width : svg.width.baseVal.value || 800;
    const height = vb && vb.height ? vb.height : svg.height.baseVal.value || 600;
    const rootInv = svg.getScreenCTM()!.inverse();
    const ctx = new Ctx(svg, rootInv);

    const children = walkChildren(svg, ctx);
    const root: Spec = {
      type: "frame",
      name,
      x: 0,
      y: 0,
      width,
      height,
      props: { fill: null, clip: true },
      children,
    };

    // Spécifications → opérations (parents d'abord, positions relatives au parent)
    const ops: Op[] = [];
    let count = 0;
    const emit = (spec: Spec, parentId: string | null, px: number, py: number, offset = { x: 0, y: 0 }): string => {
      const node = makeNode(spec.type, {
        ...spec.props,
        name: spec.name,
        x: r(spec.x - px + offset.x),
        y: r(spec.y - py + offset.y),
        width: r(spec.width),
        height: r(spec.height),
      } as Parameters<typeof makeNode>[1], newId());
      node.parentId = parentId;
      ops.push({ kind: "create", node });
      count++;
      for (const c of spec.children) emit(c, node.id, spec.x, spec.y);
      return node.id;
    };
    const rootId = emit(root, null, 0, 0, at);
    return { ops, rootId, stats: { nodes: count, skipped: ctx.skipped } };
  } finally {
    host.remove();
  }
}

class Ctx {
  skipped: Record<string, number> = {};
  constructor(public svg: SVGSVGElement, public rootInv: DOMMatrix) {}
  skip(tag: string) {
    this.skipped[tag] = (this.skipped[tag] ?? 0) + 1;
  }
  /** Matrice élément → repère racine du SVG. */
  matrix(el: SVGGraphicsElement): DOMMatrix {
    const ctm = el.getScreenCTM();
    return ctm ? this.rootInv.multiply(ctm) : new DOMMatrix();
  }
  ref(value: string): Element | null {
    const m = /url\(\s*["']?#([^"')]+)["']?\s*\)/.exec(value);
    return m ? this.svg.ownerDocument.getElementById(m[1]!) : null;
  }
}

function walkChildren(parent: Element, ctx: Ctx): Spec[] {
  const out: Spec[] = [];
  for (const el of Array.from(parent.children)) {
    const spec = convert(el as SVGElement, ctx);
    if (spec) out.push(spec);
  }
  return out;
}

function convert(el: SVGElement, ctx: Ctx): Spec | null {
  const tag = el.localName;
  if (SKIP.has(tag)) return null;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const opacity = num(style.opacity, 1);
  const name = layerName(el, tag);

  if (tag === "g" || tag === "a" || tag === "svg" || tag === "switch") return group(el as SVGGraphicsElement, name, opacity, style, ctx);

  const g = el as SVGGraphicsElement;
  if (typeof g.getBBox !== "function") {
    ctx.skip(tag);
    return null;
  }
  const bb = g.getBBox();
  const m = ctx.matrix(g);
  const box = transformBox(bb, m);
  const axisAligned = Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6 && m.a > 0 && m.d > 0;
  const fill = paint(style.fill, num(style.fillOpacity, 1), ctx);
  const stroke = strokeOf(style, m);
  const base = { opacity, stroke };

  // Motif d'image (avatars, photos exportés par Figma) → nœud image
  if (fill.image && (tag === "rect" || tag === "circle" || tag === "ellipse" || tag === "path")) {
    const radius = tag === "circle" || tag === "ellipse" ? Math.min(box.width, box.height) / 2 : tag === "rect" ? rx(el) * m.a : 0;
    return spec("image", name, box, { ...base, image: { src: fill.image, ...(fill.crop ? { crop: fill.crop } : {}) }, radius: r(radius) });
  }

  switch (tag) {
    case "rect":
      if (axisAligned) return spec("rect", name, box, { ...base, fill: fill.color, radius: r(rx(el) * m.a) });
      break;
    case "circle":
    case "ellipse":
      if (axisAligned) return spec("ellipse", name, box, { ...base, fill: fill.color });
      break;
    case "image": {
      const src = el.getAttribute("href") ?? el.getAttribute("xlink:href");
      if (!src) return null;
      return spec("image", name, box, { opacity, image: { src } });
    }
    case "text":
      return text(el as SVGTextElement, name, style, fill.color, opacity, m);
    case "use": {
      const target = ctx.ref(`url(${el.getAttribute("href") ?? el.getAttribute("xlink:href")})`);
      const src = target?.localName === "image" ? (target.getAttribute("href") ?? target.getAttribute("xlink:href")) : null;
      if (src) return spec("image", name, box, { opacity, image: { src } });
      ctx.skip("use");
      return null;
    }
  }

  // Tout le reste (et les formes tournées) devient un vecteur
  const d = pathData(el, tag);
  if (!d) {
    ctx.skip(tag);
    return null;
  }
  if (box.width === 0 && box.height === 0) return null;
  // Matrice : repère du tracé → repère local du nœud (origine = coin de la boîte englobante)
  const local = new DOMMatrix().translate(-box.x, -box.y).multiply(m);
  return spec("path", name, box, {
    ...base,
    fill: fill.color,
    path: { d, fillRule: style.fillRule === "evenodd" ? "evenodd" : "nonzero", matrix: [local.a, local.b, local.c, local.d, local.e, local.f].map(r6) as Matrix },
  });
}

function group(el: SVGGraphicsElement, name: string, opacity: number, style: CSSStyleDeclaration, ctx: Ctx): Spec | null {
  const children = walkChildren(el, ctx);
  if (!children.length) return null;

  // Masque ou clip-path : la frame prend la forme du masque et rogne son contenu.
  const maskEl = ctx.ref(style.mask || el.getAttribute("mask") || "") ?? ctx.ref(style.clipPath || el.getAttribute("clip-path") || "");
  const shape = maskEl ? (Array.from(maskEl.children).find((c) => !SKIP.has(c.localName)) as SVGGraphicsElement | undefined) : undefined;
  if (shape && typeof shape.getBBox === "function") {
    const m = ctx.matrix(el);
    const box = transformBox(shape.getBBox(), m);
    const radius =
      shape.localName === "circle" || shape.localName === "ellipse" ? Math.min(box.width, box.height) / 2 : shape.localName === "rect" ? rx(shape) * m.a : 0;
    return { ...spec("frame", name, box, { fill: null, clip: true, opacity, radius: r(radius) }), children };
  }

  const x0 = Math.min(...children.map((c) => c.x));
  const y0 = Math.min(...children.map((c) => c.y));
  const x1 = Math.max(...children.map((c) => c.x + c.width));
  const y1 = Math.max(...children.map((c) => c.y + c.height));
  return { ...spec("frame", name, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, { fill: null, clip: false, opacity }), children };
}

/**
 * Texte SVG → nœud texte. Les <tspan> de même ordonnée forment une ligne ; l'interligne vient de l'écart
 * entre les lignes ; la position verticale est calculée avec les métriques de la police (modèle CSS :
 * la ligne fait lineHeight × taille, le texte y est centré, la ligne de base est à « ascent » du haut du texte).
 */
function text(el: SVGTextElement, name: string, style: CSSStyleDeclaration, color: string | null, opacity: number, m: DOMMatrix): Spec | null {
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  const fontSize = num(style.fontSize, 16) * scale;
  const family = (style.fontFamily || "Inter").split(",")[0]!.replace(/["']/g, "").trim();
  const weight = num(style.fontWeight, 400);

  const spans = Array.from(el.querySelectorAll("tspan"));
  const parts = (spans.length ? spans : [el]).map((t) => ({
    x: Number(t.getAttribute("x") ?? el.getAttribute("x") ?? 0),
    y: Number(t.getAttribute("y") ?? el.getAttribute("y") ?? 0),
    text: (t.textContent ?? "").replace(/\n+$/, ""), // Figma met le saut de ligne DANS le tspan
  }));
  const lines: { x: number; y: number; text: string }[] = [];
  for (const p of parts) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - p.y) < 0.5) last.text += p.text;
    else lines.push({ ...p });
  }
  if (!lines.length || !lines.some((l) => l.text.trim())) return null;

  const metrics = fontMetrics(family, weight, fontSize);
  const lineHeight = lines.length > 1
    ? ((lines[lines.length - 1]!.y - lines[0]!.y) / (lines.length - 1)) * scale / fontSize
    : (metrics.ascent + metrics.descent) / fontSize;
  const linePx = lineHeight * fontSize;
  const width = Math.max(...lines.map((l) => metrics.measure(l.text))) * 1.03 + 2; // marge : évite un retour à la ligne parasite

  const anchor = style.textAnchor;
  const first = new DOMPoint(Math.min(...lines.map((l) => l.x)), lines[0]!.y).matrixTransform(m);
  const x = anchor === "middle" ? first.x - width / 2 : anchor === "end" ? first.x - width : first.x;
  const top = first.y - (linePx - (metrics.ascent + metrics.descent)) / 2 - metrics.ascent;

  return spec("text", name, { x, y: top, width, height: linePx * lines.length }, {
    opacity,
    text: {
      content: lines.map((l) => l.text).join("\n"),
      fontFamily: family,
      fontSize: r(fontSize),
      fontWeight: weight,
      color: color ?? "#000000",
      align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
      lineHeight: Math.round(lineHeight * 10000) / 10000,
    },
  });
}

const measureCtx = document.createElement("canvas").getContext("2d")!;
function fontMetrics(family: string, weight: number, size: number) {
  measureCtx.font = `${weight} ${size}px "${family}", sans-serif`;
  const m = measureCtx.measureText("Hg");
  return {
    ascent: m.fontBoundingBoxAscent || size * 0.8,
    descent: m.fontBoundingBoxDescent || size * 0.2,
    measure: (t: string) => measureCtx.measureText(t).width,
  };
}

/** Charge les polices utilisées par le SVG avant de mesurer quoi que ce soit. */
async function loadFonts(svg: Element) {
  const fonts = new Set<string>();
  for (const t of Array.from(svg.querySelectorAll("text"))) {
    const st = getComputedStyle(t);
    fonts.add(`${st.fontWeight} 16px "${(st.fontFamily || "Inter").split(",")[0]!.replace(/["']/g, "").trim()}"`);
  }
  await Promise.all([...fonts].map((f) => document.fonts.load(f).catch(() => [])));
}

// ---------- Utilitaires ----------

interface Box { x: number; y: number; width: number; height: number }

function spec(type: NodeType, name: string, box: Box, props: Partial<DesignNode>): Spec {
  return { type, name, x: box.x, y: box.y, width: box.width, height: box.height, props, children: [] };
}

function transformBox(bb: DOMRect, m: DOMMatrix): Box {
  const pts = [
    new DOMPoint(bb.x, bb.y), new DOMPoint(bb.x + bb.width, bb.y),
    new DOMPoint(bb.x, bb.y + bb.height), new DOMPoint(bb.x + bb.width, bb.y + bb.height),
  ].map((p) => p.matrixTransform(m));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Nom du calque : l'id de l'export (Figma suffixe les doublons par _2, _3…). */
function layerName(el: Element, tag: string): string {
  const id = el.getAttribute("id") ?? el.getAttribute("data-name") ?? el.getAttribute("inkscape:label");
  if (id) return id.replace(/_\d+$/, "").replace(/_/g, " ").trim() || id;
  return { g: "Groupe", rect: "Rectangle", circle: "Ellipse", ellipse: "Ellipse", path: "Vecteur", text: "Texte", image: "Image" }[tag] ?? tag;
}

function pathData(el: Element, tag: string): string | null {
  const a = (n: string) => Number(el.getAttribute(n) ?? 0);
  switch (tag) {
    case "path":
      return el.getAttribute("d");
    case "line":
      return `M${a("x1")} ${a("y1")}L${a("x2")} ${a("y2")}`;
    case "polygon":
    case "polyline": {
      const pts = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return tag === "polygon" ? d + "Z" : d;
    }
    case "rect": {
      const x = a("x"), y = a("y"), w = a("width"), h = a("height"), k = Math.min(rx(el), w / 2, h / 2);
      if (!k) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + k} ${y}H${x + w - k}A${k} ${k} 0 0 1 ${x + w} ${y + k}V${y + h - k}A${k} ${k} 0 0 1 ${x + w - k} ${y + h}H${x + k}A${k} ${k} 0 0 1 ${x} ${y + h - k}V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`;
    }
    case "circle":
    case "ellipse": {
      const cx = a("cx"), cy = a("cy");
      const rx2 = tag === "circle" ? a("r") : a("rx");
      const ry2 = tag === "circle" ? a("r") : a("ry");
      return `M${cx - rx2} ${cy}A${rx2} ${ry2} 0 1 0 ${cx + rx2} ${cy}A${rx2} ${ry2} 0 1 0 ${cx - rx2} ${cy}Z`;
    }
  }
  return null;
}

function rx(el: Element): number {
  return Number(el.getAttribute("rx") ?? el.getAttribute("ry") ?? 0) || 0;
}

/** Peinture résolue : couleur hexadécimale, image (motif) ou dégradé (approximé par sa 1re couleur). */
type Crop = { x: number; y: number; width: number; height: number };

function paint(value: string, opacity: number, ctx: Ctx): { color: string | null; image?: string; crop?: Crop } {
  if (!value || value === "none") return { color: null };
  if (value.startsWith("url(")) {
    const ref = ctx.ref(value);
    if (ref?.localName === "pattern") {
      const use = ref.querySelector("use, image");
      const img = use?.localName === "image" ? use : ctx.ref(`url(${use?.getAttribute("href") ?? use?.getAttribute("xlink:href")})`);
      const src = img?.getAttribute("href") ?? img?.getAttribute("xlink:href");
      if (src) return { color: null, image: src, crop: patternCrop(ref, use, img!) };
    }
    if (ref?.localName === "linearGradient" || ref?.localName === "radialGradient") {
      const stop = ref.querySelector("stop");
      if (stop) {
        const s = getComputedStyle(stop);
        return { color: toHex(s.stopColor, num(s.stopOpacity, 1) * opacity) };
      }
    }
    return { color: "#CCCCCC" };
  }
  return { color: toHex(value, opacity) };
}

/**
 * Recadrage d'une image remplissant une forme via un motif (cas des exports Figma) :
 * le motif est en unités de la boîte de l'objet (0 à 1), et le <use> porte une matrice
 * qui place l'image (en pixels) dans ce carré unité. On inverse pour savoir quelle partie est visible.
 */
function patternCrop(pattern: Element, use: Element | null, img: Element): Crop | undefined {
  if (pattern.getAttribute("patternContentUnits") !== "objectBoundingBox" || !use) return undefined;
  const W = Number(img.getAttribute("width"));
  const H = Number(img.getAttribute("height"));
  if (!W || !H) return undefined;
  const list = (use as SVGGraphicsElement).transform?.baseVal;
  const m = list && list.numberOfItems ? list.consolidate()!.matrix : new DOMMatrix();
  if (Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9 || m.a <= 0 || m.d <= 0) return undefined;
  // pixel (px, py) → (a·px + e, d·py + f) ; zone visible = [0,1]²
  const crop = { x: -m.e / m.a / W, y: -m.f / m.d / H, width: 1 / m.a / W, height: 1 / m.d / H };
  const whole = Math.abs(crop.x) < 1e-4 && Math.abs(crop.y) < 1e-4 && Math.abs(crop.width - 1) < 1e-4 && Math.abs(crop.height - 1) < 1e-4;
  return whole ? { x: 0, y: 0, width: 1, height: 1 } : { x: r6(crop.x), y: r6(crop.y), width: r6(crop.width), height: r6(crop.height) };
}

function strokeOf(style: CSSStyleDeclaration, m: DOMMatrix): DesignNode["stroke"] {
  if (!style.stroke || style.stroke === "none") return null;
  const width = num(style.strokeWidth, 1) * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const color = toHex(style.stroke, num(style.strokeOpacity, 1));
  return color && width > 0 ? { color, width: r(width) } : null;
}

/** "rgb(12, 34, 56)" / "rgba(…)" → "#0C2238" ou "#0C2238CC". */
function toHex(css: string, extraAlpha = 1): string | null {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (!m) return /^#[0-9a-f]{6}$/i.test(css) ? css.toUpperCase() : null;
  const [rr, gg, bb, aa = "1"] = m[1]!.split(/[\s,/]+/).filter(Boolean);
  const alpha = Math.max(0, Math.min(1, Number(aa) * extraAlpha));
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0").toUpperCase();
  return "#" + h(Number(rr)) + h(Number(gg)) + h(Number(bb)) + (alpha >= 0.999 ? "" : h(alpha * 255));
}

const num = (v: string | null | undefined, fallback: number) => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : fallback;
};
const r = (v: number) => Math.round(v * 100) / 100;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
