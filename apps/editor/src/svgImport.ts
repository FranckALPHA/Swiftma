// Import SVG → maquette Swiftma éditable.
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

import { ensureFonts } from "./fonts";
import { cssFontStack, GENERIC_FONTS, type DesignNode, type Gradient, type PathData, type NodeType, type Op, type Shadow, makeNode, newId } from "@swiftma/core";

type Matrix = [number, number, number, number, number, number];

interface Spec {
  gradientRoot?: RootGradient; // dégradé en coordonnées du SVG, converti une fois la boîte connue
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

const SKIP = new Set(["foreignObject", "defs", "mask", "clipPath", "pattern", "linearGradient", "radialGradient", "symbol", "title", "desc", "style", "metadata", "script", "filter", "marker"]);

// Éléments qui exécutent du code, chargent une page ou changent des attributs à la volée : jamais montés
const UNSAFE = new Set(["script", "foreignobject", "iframe", "embed", "object", "animate", "animatemotion", "animatetransform", "set", "handler", "listener"]);

/**
 * Le SVG est monté dans la page pour être mesuré : un SVG venu d'ailleurs (presse-papiers, fichier, plugin)
 * ne doit rien pouvoir y exécuter. On retire les scripts, les gestionnaires on…, et les liens javascript:.
 */
export function sanitizeSvg(root: Element) {
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (el !== root && UNSAFE.has(el.localName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if ((name === "href" || name.endsWith(":href") || name === "src") && /^(javascript|vbscript|data:text\/html)/.test(value)) el.removeAttribute(attr.name);
    }
  }
}

export async function importSvg(source: string, name: string, at: { x: number; y: number }): Promise<SvgImportResult> {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const err = parsed.querySelector("parsererror");
  if (err || parsed.documentElement.nodeName.toLowerCase() !== "svg") throw new Error("Fichier SVG invalide.");
  sanitizeSvg(parsed.documentElement);

  // Montage hors écran : nécessaire pour que le navigateur calcule géométrie et styles.
  const host = document.createElement("div");
  host.style.cssText = "all:initial;display:block;position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;"; // all:initial : rien hérité de l'interface (couleur pour currentColor, police) ; pas visibility:hidden : les enfants en hériteraient
  const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  fixRootSize(svg);
  host.appendChild(svg);
  document.body.appendChild(host);

  try {
    expandUses(svg);
    await loadFonts(svg);
    // On travaille en pixels d'AFFICHAGE du SVG (sa largeur/hauteur), pas dans les unités de son viewBox :
    // un drapeau de 900 px dont le viewBox fait 84 000 unités (ou commence à -50) donne une frame de 900 px.
    const box = svg.getBoundingClientRect();
    const width = r(box.width) || 800;
    const height = r(box.height) || 600;
    const rootInv = new DOMMatrix().translate(-box.left, -box.top);
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

    snapBoxes(root);

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

/**
 * Les navigateurs alignent chaque élément <svg> d'une page HTML sur la grille des pixels, alors que le SVG d'origine
 * dessine à des positions fractionnaires : un vecteur placé à 3,73 px serait décalé d'une fraction de pixel.
 * Les boîtes « invisibles » (vecteurs, groupes sans fond ni découpe) sont donc élargies aux pixels entiers ;
 * le dessin, lui, ne bouge pas (on compense dans la matrice du tracé).
 */
function snapBoxes(s: Spec) {
  s.children.forEach(snapBoxes);
  const invisibleBox =
    s.type === "path" ||
    (s.type === "frame" && !s.props.clip && !s.props.fill && !s.props.gradient && !s.props.backgroundBlur && !s.props.shadows?.some((sh) => sh.type === "inner"));
  if (!invisibleBox) return;
  const x0 = Math.floor(s.x + 1e-6), y0 = Math.floor(s.y + 1e-6);
  const x1 = Math.ceil(s.x + s.width - 1e-6), y1 = Math.ceil(s.y + s.height - 1e-6);
  if (s.props.path) {
    const [a, b, c, d, e, f] = s.props.path.matrix;
    s.props.path = { ...s.props.path, matrix: [a, b, c, d, r6(e + s.x - x0), r6(f + s.y - y0)] };
  }
  const g = s.props.gradient;
  if (g) {
    // Le dégradé est en fractions de la boîte : on le ré-exprime dans la nouvelle boîte
    const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0);
    const fx = (v: number) => r6((v * s.width + s.x - x0) / W);
    const fy = (v: number) => r6((v * s.height + s.y - y0) / H);
    s.props.gradient = {
      ...g,
      start: [fx(g.start[0]), fy(g.start[1])],
      end: [fx(g.end[0]), fy(g.end[1])],
      ...(g.radius ? { radius: [r6((g.radius[0] * s.width) / W), r6((g.radius[1] * s.height) / H)] as [number, number] } : {}),
    };
  }
  s.x = x0;
  s.y = y0;
  s.width = Math.max(1, x1 - x0);
  s.height = Math.max(1, y1 - y0);
}

/** Taille d'affichage absente ou en % (icônes) : on prend celle du viewBox, sinon 300×150 comme les navigateurs. */
function fixRootSize(svg: SVGSVGElement) {
  const vb = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const bad = (v: string | null) => !v || /%|auto/.test(v) || !(parseFloat(v) > 0);
  const w = svg.getAttribute("width"), h = svg.getAttribute("height");
  if (vb && vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) {
    // Une seule dimension donnée : l'autre suit les proportions du viewBox
    if (bad(w) && bad(h)) (svg.setAttribute("width", String(vb[2])), svg.setAttribute("height", String(vb[3])));
    else if (bad(w)) svg.setAttribute("width", String((parseFloat(h!) * vb[2]!) / vb[3]!));
    else if (bad(h)) svg.setAttribute("height", String((parseFloat(w!) * vb[3]!) / vb[2]!));
  } else {
    if (bad(w)) svg.setAttribute("width", "300");
    if (bad(h)) svg.setAttribute("height", "150");
  }
}

/**
 * <use> réutilise une forme ou un groupe ailleurs. Le navigateur cache ces copies dans un arbre fermé ;
 * on les rend donc réelles : chaque <use> devient un <g> (mêmes attributs, + décalage x/y) contenant une copie
 * de sa cible. Les <symbol> deviennent des groupes, mis à l'échelle de leur viewBox.
 * (Les <use> d'un motif d'image restent : le recadrage des images les lit.)
 */
function expandUses(svg: SVGSVGElement) {
  const NS = "http://www.w3.org/2000/svg";
  for (let pass = 0; pass < 8; pass++) {
    const uses = Array.from(svg.querySelectorAll("use")).filter((u) => !u.closest("pattern"));
    if (!uses.length) return;
    let changed = false;
    for (const u of uses) {
      const href = u.getAttribute("href") ?? u.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? u.getAttribute("xlink:href");
      const target = href?.startsWith("#") ? svg.ownerDocument.getElementById(href.slice(1)) : null;
      if (!target || target.contains(u) || u.contains(target)) continue;
      const g = svg.ownerDocument.createElementNS(NS, "g");
      for (const attr of Array.from(u.attributes)) {
        if (!/^(x|y|width|height|href|xlink:href)$/.test(attr.name)) g.setAttribute(attr.name, attr.value);
      }
      const x = parseFloat(u.getAttribute("x") ?? "0") || 0, y = parseFloat(u.getAttribute("y") ?? "0") || 0;
      if (x || y) g.setAttribute("transform", `${g.getAttribute("transform") ?? ""} translate(${x} ${y})`.trim());
      let clone: Element;
      if (target.localName === "symbol" || target.localName === "svg") {
        clone = svg.ownerDocument.createElementNS(NS, "g");
        for (const child of Array.from(target.childNodes)) clone.appendChild(child.cloneNode(true));
        for (const attr of Array.from(target.attributes)) {
          if (!/^(id|viewBox|x|y|width|height|preserveAspectRatio|refX|refY)$/i.test(attr.name)) clone.setAttribute(attr.name, attr.value);
        }
        const vb = target.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
        const W = parseFloat(u.getAttribute("width") ?? target.getAttribute("width") ?? "") || (vb ? vb[2]! : 0);
        const H = parseFloat(u.getAttribute("height") ?? target.getAttribute("height") ?? "") || (vb ? vb[3]! : 0);
        if (vb && vb.length === 4 && vb[2]! > 0 && vb[3]! > 0 && W && H) {
          // preserveAspectRatio par défaut : xMidYMid meet
          const k = Math.min(W / vb[2]!, H / vb[3]!);
          const tx = (W - vb[2]! * k) / 2 - vb[0]! * k, ty = (H - vb[3]! * k) / 2 - vb[1]! * k;
          clone.setAttribute("transform", `translate(${tx} ${ty}) scale(${k})`);
        }
      } else {
        clone = target.cloneNode(true) as Element;
      }
      g.setAttribute("data-swiftma-use", target.localName); // retenu : un <clipPath> n'accepte que des formes
      g.appendChild(clone);
      u.replaceWith(g);
      changed = true;
    }
    if (!changed) return;
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
    // On convertit en DOMMatrix : l'ancien SVGMatrix refuse de se multiplier avec un DOMMatrix
    return ctm ? DOMMatrix.fromMatrix(this.rootInv.multiply(ctm)) : new DOMMatrix();
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

/** Convertit un élément, puis lui rattache son dégradé et ses ombres (filtres SVG). */
function convert(el: SVGElement, ctx: Ctx): Spec | null {
  const spec = convertElement(el, ctx);
  if (!spec) return null;
  if (spec.gradientRoot) {
    spec.props.gradient = localGradient(spec.gradientRoot, spec);
    delete spec.gradientRoot;
  }
  const m = typeof (el as SVGGraphicsElement).getScreenCTM === "function" ? ctx.matrix(el as SVGGraphicsElement) : new DOMMatrix();
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  // Flou d'arrière-plan : Figma l'écrit dans un attribut (et un <foreignObject> que l'on ignore)
  const bgBlur = parseFloat(el.getAttribute("data-figma-bg-blur-radius") ?? "");
  if (bgBlur > 0) spec.props.backgroundBlur = r(bgBlur * scale);
  const filter = ctx.ref(getComputedStyle(el).filter || el.getAttribute("filter") || "");
  if (filter?.localName === "filter" && spec.type === "frame" && spec.props.clip) {
    // En SVG, le filtre s'applique AVANT la découpe : l'effet va sur une frame intérieure, la découpe reste dehors
    const inner: Spec = { ...spec, name: spec.name + " (effets)", props: { fill: null, clip: false }, children: spec.children };
    spec.children = [inner];
    applyFilter(inner, filter, scale);
  } else if (filter?.localName === "filter") applyFilter(spec, filter, scale);
  // Masque posé directement sur une forme (Figma s'en sert pour les contours intérieurs) : on l'enveloppe
  // dans une frame qui rogne selon la forme exacte du masque.
  if (spec.type !== "frame" || !isGroupTag(el.localName)) {
    const st = getComputedStyle(el);
    if ((st.mask && st.mask !== "none") || (st.clipPath && st.clipPath !== "none") || el.hasAttribute("mask") || el.hasAttribute("clip-path")) {
      const wrapped = maskFrame(el as SVGGraphicsElement, spec.name, 1, st, [spec], ctx);
      if (wrapped) return wrapped;
    }
  }
  return spec;
}

const isGroupTag = (t: string) => t === "g" || t === "a" || t === "svg" || t === "switch";


/** Ombres et flou de calque d'un filtre SVG, posés sur la spécification. */
function applyFilter(spec: Spec, filter: Element, scale: number) {
  const { shadows, layerBlur } = parseEffects(filter, scale);

  if (layerBlur) spec.props.layerBlur = layerBlur;
  if (shadows.length) {
    // Figma pose l'ombre sur le groupe du bouton ; on la donne à la forme de fond quand elle couvre le groupe,
    // pour qu'elle suive ses coins arrondis.
    const bg = spec.type === "frame" ? spec.children[0] : undefined;
    const covers = bg && Math.abs(bg.x - spec.x) < 1 && Math.abs(bg.y - spec.y) < 1 && Math.abs(bg.width - spec.width) < 1 && Math.abs(bg.height - spec.height) < 1;
    const target = covers && bg.type !== "text" && !spec.props.clip ? bg : spec;
    target.props.shadows = [...(target.props.shadows ?? []), ...shadows];
  }
}

function convertElement(el: SVGElement, ctx: Ctx): Spec | null {
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
  const fill = paint(style.fill, num(style.fillOpacity, 1), ctx, g);
  const stroke = strokeOf(style, m);
  const base = { opacity, stroke };

  // Motif d'image (avatars, photos exportés par Figma) → nœud image
  if (fill.image && (tag === "rect" || tag === "circle" || tag === "ellipse" || tag === "path")) {
    const radius = tag === "circle" || tag === "ellipse" ? Math.min(box.width, box.height) / 2 : tag === "rect" ? rx(el) * m.a : 0;
    return spec("image", name, box, { ...base, image: { src: fill.image, ...(fill.crop ? { crop: fill.crop } : {}) }, radius: r(radius) });
  }

  switch (tag) {
    case "rect":
      // (pointillés : on passe par un vecteur, plus fidèle qu'un « outline » CSS)
      if (axisAligned && !stroke?.dash) return withGradient(spec("rect", name, box, { ...base, fill: fill.color, radius: r(rx(el) * m.a) }), fill.gradient);
      break;
    case "circle":
    case "ellipse":
      if (axisAligned && !stroke?.dash) return withGradient(spec("ellipse", name, box, { ...base, fill: fill.color }), fill.gradient);
      break;
    case "image": {
      const src = el.getAttribute("href") ?? el.getAttribute("xlink:href");
      if (!src) return null;
      return spec("image", name, box, { opacity, image: { src } });
    }
    case "text":
      return withGradient(text(el as SVGTextElement, name, style, fill.color, opacity, m), fill.gradient);
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
  // La boîte inclut l'épaisseur du contour (comme dans Figma) : un trait parfaitement droit garde une taille
  const pad = stroke ? stroke.width / 2 : 0;
  if (box.width + 2 * pad === 0 || box.height + 2 * pad === 0) return null;
  const vbox = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
  // Matrice : repère du tracé → repère local du nœud (origine = coin de la boîte englobante)
  const local = new DOMMatrix().translate(-vbox.x, -vbox.y).multiply(m);
  return withGradient(spec("path", name, vbox, {
    ...base,
    fill: fill.color,
    path: { d, fillRule: style.fillRule === "evenodd" ? "evenodd" : "nonzero", matrix: [local.a, local.b, local.c, local.d, local.e, local.f].map(r6) as Matrix },
  }), fill.gradient);
}

/** Masque ou clip-path : une frame qui prend la forme du masque et rogne son contenu (ou null s'il n'y en a pas). */
function maskFrame(el: SVGGraphicsElement, name: string, opacity: number, style: CSSStyleDeclaration, children: Spec[], ctx: Ctx): Spec | null {
  const maskEl = ctx.ref(style.mask || el.getAttribute("mask") || "") ?? ctx.ref(style.clipPath || el.getAttribute("clip-path") || "");
  if (!maskEl || (maskEl.localName !== "mask" && maskEl.localName !== "clipPath")) return null;
  const own = (e: Element) => {
    const list = (e as SVGGraphicsElement).transform?.baseVal;
    return list && list.numberOfItems ? DOMMatrix.fromMatrix(list.consolidate()!.matrix) : new DOMMatrix();
  };
  // Repère du contenu du masque : celui de l'élément masqué, × transformation du masque,
  // × (en unités « objectBoundingBox ») la boîte de l'élément.
  let base = ctx.matrix(el).multiply(own(maskEl));
  const units = maskEl.getAttribute(maskEl.localName === "clipPath" ? "clipPathUnits" : "maskContentUnits");
  if (units === "objectBoundingBox") {
    const bb = el.getBBox();
    base = base.translate(bb.x, bb.y).scale(bb.width || 1e-6, bb.height || 1e-6);
  }
  // Toutes les formes du masque (union), en descendant dans les groupes (un <use> déplié en crée)
  const shapes: { shape: SVGGraphicsElement; m: DOMMatrix }[] = [];
  const collect = (parent: Element, m: DOMMatrix) => {
    for (const c of Array.from(parent.children)) {
      if (SKIP.has(c.localName)) continue;
      const st = getComputedStyle(c);
      if (st.display === "none" || st.visibility === "hidden") continue;
      if (isGroupTag(c.localName)) {
        // Dans un <clipPath>, seuls les formes, textes et <use> vers une forme sont valides (pas de <g>)
        const via = c.getAttribute("data-swiftma-use");
        if (maskEl.localName === "clipPath" && (!via || isGroupTag(via) || via === "symbol")) continue;
        collect(c, m.multiply(own(c)));
      }
      else if (typeof (c as SVGGraphicsElement).getBBox === "function") shapes.push({ shape: c as SVGGraphicsElement, m: m.multiply(own(c)) });
    }
  };
  collect(maskEl, base);
  const rule = (e: Element) =>
    getComputedStyle(e).getPropertyValue(maskEl.localName === "clipPath" ? "clip-rule" : "fill-rule") === "evenodd" ? "evenodd" : "nonzero";
  const parts = shapes
    .map(({ shape, m }) => ({ shape, m, d: pathData(shape, shape.localName), box: transformBox(shape.getBBox(), m) }))
    .filter((p) => p.d && p.box.width > 0 && p.box.height > 0);

  if (!parts.length) {
    // Masque sans forme valide : rien n'est visible (comportement SVG)
    const box = { x: 0, y: 0, width: 1, height: 1 };
    return { ...spec("frame", name, box, { fill: null, clip: true, opacity, clipPath: { d: "M0 0Z", fillRule: "nonzero", matrix: [1, 0, 0, 1, 0, 0] } }), children };
  }

  const x0 = Math.min(...parts.map((p) => p.box.x)), y0 = Math.min(...parts.map((p) => p.box.y));
  const x1 = Math.max(...parts.map((p) => p.box.x + p.box.width)), y1 = Math.max(...parts.map((p) => p.box.y + p.box.height));
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const first = parts[0]!;
  const fade = parts.length === 1 ? maskFade(maskEl, first.shape, first.m, box, ctx) : undefined;
  const simple = Math.abs(first.m.b) < 1e-6 && Math.abs(first.m.c) < 1e-6;
  const tag = first.shape.localName;
  // Une seule forme, rectangle ou cercle droit : un simple rayon suffit
  if (parts.length === 1 && !fade && simple && (tag === "rect" || tag === "circle" || (tag === "ellipse" && Math.abs(box.width - box.height) < 0.5))) {
    const radius = tag === "rect" ? rx(first.shape) * first.m.a : Math.min(box.width, box.height) / 2;
    return { ...spec("frame", name, box, { fill: null, clip: true, opacity, radius: r(radius) }), children };
  }
  const toPart = (p: (typeof parts)[number]): PathData => {
    const local = new DOMMatrix().translate(-box.x, -box.y).multiply(p.m);
    return { d: p.d!, fillRule: rule(p.shape), matrix: [local.a, local.b, local.c, local.d, local.e, local.f].map(r6) as Matrix };
  };
  return {
    ...spec("frame", name, box, {
      fill: null,
      clip: true,
      opacity,
      clipPath: { ...toPart(first), ...(parts.length > 1 ? { parts: parts.slice(1).map(toPart) } : {}), ...(fade ? { fade } : {}) },
    }),
    children,
  };
}

/**
 * Masque rempli par un dégradé = fondu. En mode « alpha » on garde l'opacité des couleurs ;
 * en mode « luminance » (défaut SVG), l'opacité suit la luminosité × l'opacité de chaque couleur.
 */
function maskFade(maskEl: Element, shape: SVGGraphicsElement, m: DOMMatrix, box: Box, ctx: Ctx): Gradient | undefined {
  if (maskEl.localName !== "mask") return undefined;
  const ref = ctx.ref(getComputedStyle(shape).fill || shape.getAttribute("fill") || "");
  if (ref?.localName !== "linearGradient" && ref?.localName !== "radialGradient") return undefined;
  const root = gradientOf(ref as SVGGradientElement, 1, shape, ctx, m);
  if (!root) return undefined;
  const alphaMode = getComputedStyle(maskEl).getPropertyValue("mask-type") === "alpha";
  const toAlpha = (hex: string) => {
    const h = hex.replace("#", "");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    const a = h.length >= 8 ? n(6) : 1;
    const v = alphaMode ? a : (0.2126 * n(0) + 0.7152 * n(2) + 0.0722 * n(4)) * a;
    return "#FFFFFF" + Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
  };
  const g = localGradient(root, { ...box } as Spec);
  return { ...g, stops: g.stops.map((st) => ({ ...st, color: toAlpha(st.color) })) };
}

function group(el: SVGGraphicsElement, name: string, opacity: number, style: CSSStyleDeclaration, ctx: Ctx): Spec | null {
  const children = walkChildren(el, ctx);
  if (!children.length) return null;

  const masked = maskFrame(el, name, opacity, style, children, ctx);
  if (masked) return masked;

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
/**
 * Texte SVG → nœuds texte. On demande au navigateur la position exacte de CHAQUE caractère (x/y/dx/dy, ancrage,
 * espacement, tspan… tout est déjà résolu), puis on regroupe : caractères qui se suivent avec le même style = un
 * morceau ; morceaux alignés les uns sous les autres = un paragraphe multi-ligne, éditable.
 */
function text(el: SVGTextElement, name: string, style: CSSStyleDeclaration, color: string | null, opacity: number, m: DOMMatrix): Spec | null {
  let n = 0;
  try {
    n = el.getNumberOfChars();
  } catch {
    return textBySpans(el, name, style, color, opacity, m);
  }
  if (!n) return null;
  const chars = processedChars(el);
  if (chars.length !== n) return textBySpans(el, name, style, color, opacity, m);

  interface Run { owner: Element; key: string; x: number; y: number; end: number; text: string; rot: number }
  const runs: Run[] = [];
  const keys = new Map<Element, string>();
  const keyOf = (e: Element) => {
    let k = keys.get(e);
    if (!k) {
      const st = getComputedStyle(e);
      k = [st.fontFamily, st.fontWeight, st.fontStyle, st.fontSize, st.fill, st.fillOpacity, st.stroke, st.strokeWidth, st.letterSpacing, decorationOf(e, el)].join("|");
      keys.set(e, k);
    }
    return k;
  };
  try {
    for (let i = 0; i < n; i++) {
      const c = chars[i]!;
      if (c.br) {
        runs.push({ owner: c.owner, key: "\u0000br", x: 0, y: 0, end: 0, text: "", rot: 0 }); // fin de morceau
        continue;
      }
      const start = el.getStartPositionOfChar(i);
      const end = el.getEndPositionOfChar(i);
      const rot = el.getRotationOfChar(i) || 0;
      const key = keyOf(c.owner);
      const last = runs[runs.length - 1];
      if (last && last.key === key && !rot && !last.rot && Math.abs(start.x - last.end) < 0.5 && Math.abs(start.y - last.y) < 0.5) {
        last.text += c.ch;
        last.end = end.x;
      } else runs.push({ owner: c.owner, key, x: start.x, y: start.y, end: end.x, text: c.ch, rot });
    }
  } catch {
    return textBySpans(el, name, style, color, opacity, m);
  }
  const kept = runs.filter((r1) => r1.text.trim());
  if (!kept.length) return null;

  const baseFor = (owner: Element, rot = 0): TextBase => {
    const st = getComputedStyle(owner);
    const [family = "Inter", ...fallbacks] = fontList(st.fontFamily);
    const weight = num(st.fontWeight, 400);
    const italic = st.fontStyle === "italic" || st.fontStyle === "oblique";
    const rawSize = num(st.fontSize, 16);
    const fill = owner === el ? color : toHex(st.fill, num(st.fillOpacity, 1));
    const ls = num(st.letterSpacing, 0);
    return {
      family, weight, italic, rawSize, color: fill, opacity, m, scale: Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1,
      local: fontMetrics(family, weight, rawSize, italic, fallbacks), letterSpacing: ls || undefined, decoration: decorationOf(owner, el), rotation: rot,
      fallbacks, stroke: strokeOf(st, m),
    };
  };
  const rowOf = (r1: Run) => ({ y: r1.y, left: r1.x, text: r1.text, w: r1.end - r1.x });

  // Paragraphe : même style partout, un morceau par ligne, lignes alignées (gauche, centre ou droite)
  const sameKey = kept.every((r1) => r1.key === kept[0]!.key && !r1.rot);
  const ys = kept.map((r1) => r1.y);
  if (sameKey && new Set(ys.map((y) => Math.round(y * 2))).size === kept.length) {
    const rows = kept.map(rowOf).sort((a1, b1) => a1.y - b1.y);
    const same = (f: (r1: (typeof rows)[number]) => number) => rows.every((r1) => Math.abs(f(r1) - f(rows[0]!)) < 1);
    const align = rows.length === 1 || same((r1) => r1.left) ? "left" : same((r1) => r1.left + r1.w / 2) ? "center" : same((r1) => r1.left + r1.w) ? "right" : null;
    if (align) return textNode(name, rows, align, baseFor(kept[0]!.owner));
  }
  // Sinon : un texte par morceau, regroupés dans une frame (positions exactes)
  const children = kept.map((r1) => textNode(r1.text.trim().slice(0, 40) || name, [rowOf(r1)], "left", baseFor(r1.owner, r1.rot)));
  if (children.length === 1) return { ...children[0]!, name };
  const x0 = Math.min(...children.map((c) => c.x)), y0 = Math.min(...children.map((c) => c.y));
  const x1 = Math.max(...children.map((c) => c.x + c.width)), y1 = Math.max(...children.map((c) => c.y + c.height));
  return { ...spec("frame", name, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, { fill: null, clip: false }), children };
}

/**
 * Caractères « adressables » du texte, dans l'ordre, avec l'élément qui les porte, après traitement des espaces
 * comme le fait SVG (xml:space / white-space). Les sauts de ligne en mode « pre » sont marqués (br).
 */
function processedChars(textEl: Element): { ch: string; owner: Element; br?: boolean }[] {
  const pre = /^pre/.test(getComputedStyle(textEl).whiteSpace) || textEl.getAttribute("xml:space") === "preserve" || textEl.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space") === "preserve";
  const raw: { ch: string; owner: Element; br?: boolean }[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data;
        for (let i = 0; i < data.length; i++) raw.push({ ch: data[i]!, owner: child.parentElement! });
      } else if (child.nodeType === Node.ELEMENT_NODE && !["title", "desc", "metadata"].includes((child as Element).localName)) {
        if (getComputedStyle(child as Element).display === "none") continue;
        walk(child);
      }
    }
  };
  walk(textEl);
  if (pre) return raw.map((c) => (c.ch === "\n" || c.ch === "\r" ? { ...c, ch: " ", br: true } : c.ch === "\t" ? { ...c, ch: " " } : c));
  const out: typeof raw = [];
  for (const c of raw) {
    if (c.ch === "\n" || c.ch === "\r") continue;
    const ch = c.ch === "\t" ? " " : c.ch;
    if (ch === " " && (out.length === 0 || out[out.length - 1]!.ch === " ")) continue;
    out.push({ ...c, ch });
  }
  while (out.length && out[out.length - 1]!.ch === " ") out.pop();
  return out;
}

/** Soulignement / barré : la décoration se propage depuis les ancêtres jusqu'au <text>. */
function decorationOf(e: Element, textEl: Element): string | null {
  const lines = new Set<string>();
  for (let cur: Element | null = e; cur; cur = cur === textEl ? null : cur.parentElement) {
    for (const l of (getComputedStyle(cur).textDecorationLine || "").split(/\s+/)) if (["underline", "overline", "line-through"].includes(l)) lines.add(l);
  }
  return lines.size ? [...lines].join(" ") : null;
}

/** Liste des polices CSS → [principale, …secours]. */
function fontList(css: string): string[] {
  return (css || "Inter").split(",").map((f) => f.replace(/["']/g, "").trim()).filter(Boolean);
}

function textBySpans(el: SVGTextElement, name: string, style: CSSStyleDeclaration, color: string | null, opacity: number, m: DOMMatrix): Spec | null {
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  const rawSize = num(style.fontSize, 16);
  const family = (style.fontFamily || "Inter").split(",")[0]!.replace(/["']/g, "").trim();
  const weight = num(style.fontWeight, 400);
  const italic = style.fontStyle === "italic" || style.fontStyle === "oblique";
  const local = fontMetrics(family, weight, rawSize, italic); // mesures dans le repère du SVG
  const anchor = style.textAnchor;
  // Bord gauche d'un morceau de texte : x désigne le début, le milieu ou la fin selon text-anchor
  const leftOf = (x: number, t: string) => (anchor === "middle" ? x - local.measure(t) / 2 : anchor === "end" ? x - local.measure(t) : x);

  const spans = Array.from(el.querySelectorAll("tspan"));
  const parts = (spans.length ? spans : [el]).map((t) => {
    const raw = (t.textContent ?? "").replace(/\n+$/, ""); // Figma met le saut de ligne DANS le tspan
    const x = Number(t.getAttribute("x") ?? el.getAttribute("x") ?? 0);
    return { left: leftOf(x, raw), y: Number(t.getAttribute("y") ?? el.getAttribute("y") ?? 0), text: raw };
  });

  // Lignes (même ordonnée), et dans chaque ligne des morceaux : contigus = fusionnés, espacés = séparés.
  // Figma coupe une ligne en plusieurs <tspan> quand un autre texte s'intercale (ex. « Made with ♥ and… »).
  const lines: { y: number; runs: { left: number; text: string }[] }[] = [];
  for (const p of parts) {
    let line = lines.find((l) => Math.abs(l.y - p.y) < 0.5);
    if (!line) lines.push((line = { y: p.y, runs: [] }));
    const last = line.runs[line.runs.length - 1];
    if (last && Math.abs(last.left + local.measure(last.text) - p.left) < 1.5) last.text += p.text;
    else line.runs.push({ left: p.left, text: p.text });
  }
  for (const l of lines) l.runs = l.runs.filter((r1) => r1.text.length > 0);
  const kept = lines.filter((l) => l.runs.length && l.runs.some((r1) => r1.text.trim()));
  if (!kept.length) return null;

  const base = { family, weight, italic, rawSize, color, opacity, m, scale, local };
  // Un seul morceau par ligne et alignement commun (gauche, centre ou droite) → un seul texte multi-ligne, éditable
  if (kept.every((l) => l.runs.length === 1)) {
    const rows = kept.map((l) => ({ y: l.y, left: l.runs[0]!.left, text: l.runs[0]!.text, w: local.measure(l.runs[0]!.text) }));
    const same = (f: (r1: (typeof rows)[number]) => number) => rows.every((r1) => Math.abs(f(r1) - f(rows[0]!)) < 1);
    const align = rows.length === 1 || same((r1) => r1.left) ? "left" : same((r1) => r1.left + r1.w / 2) ? "center" : same((r1) => r1.left + r1.w) ? "right" : null;
    if (align) return textNode(name, rows, align, base);
  }
  // Sinon : un texte par morceau, regroupés dans une frame (positions exactes)
  const children = kept.flatMap((l) => l.runs.map((r1) => textNode(r1.text.trim().slice(0, 40) || name, [{ y: l.y, left: r1.left, text: r1.text, w: local.measure(r1.text) }], "left", base)));
  const x0 = Math.min(...children.map((c) => c.x)), y0 = Math.min(...children.map((c) => c.y));
  const x1 = Math.max(...children.map((c) => c.x + c.width)), y1 = Math.max(...children.map((c) => c.y + c.height));
  return { ...spec("frame", name, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, { fill: null, clip: false }), children };
}

interface TextBase {
  family: string; weight: number; italic: boolean; rawSize: number; color: string | null; opacity: number;
  m: DOMMatrix; scale: number; local: ReturnType<typeof fontMetrics>;
  letterSpacing?: number; decoration?: string | null; rotation?: number; fallbacks?: string[]; stroke?: DesignNode["stroke"];
}

/** Nœud texte pour des lignes déjà alignées. Position verticale selon le modèle CSS (demi-interlignage + ascent). */
function textNode(name: string, rows: { y: number; left: number; text: string; w: number }[], align: "left" | "center" | "right", b: TextBase): Spec {
  const fontSize = b.rawSize * b.scale;
  const asc = b.local.ascent * b.scale, desc = b.local.descent * b.scale;
  const lineHeight = rows.length > 1 ? ((rows[rows.length - 1]!.y - rows[0]!.y) / (rows.length - 1)) * b.scale / fontSize : (asc + desc) / fontSize;
  const linePx = lineHeight * fontSize;
  const maxW = Math.max(...rows.map((r1) => r1.w)) * b.scale;
  const width = maxW * 1.03 + 2; // marge : évite un retour à la ligne parasite
  const ref = align === "left" ? Math.min(...rows.map((r1) => r1.left)) : align === "center" ? rows[0]!.left + rows[0]!.w / 2 : rows[0]!.left + rows[0]!.w;
  const p = new DOMPoint(ref, rows[0]!.y).matrixTransform(b.m);
  // Coin haut-gauche de la boîte = point de base, décalé selon l'alignement et la hauteur de ligne,
  // dans le repère tourné du texte (rotation de la matrice + rotation propre du caractère)
  const angle = (Math.atan2(b.m.b, b.m.a) * 180) / Math.PI + (b.rotation ?? 0);
  const ox = align === "left" ? 0 : align === "center" ? -width / 2 : -width;
  const oy = -(linePx - (asc + desc)) / 2 - asc;
  const rad = (angle * Math.PI) / 180;
  const x = p.x + ox * Math.cos(rad) - oy * Math.sin(rad);
  const top = p.y + ox * Math.sin(rad) + oy * Math.cos(rad);
  return spec("text", name, { x, y: top, width, height: linePx * rows.length }, {
    opacity: b.opacity,
    ...(b.stroke ? { stroke: b.stroke } : {}),
    ...(Math.abs(angle) > 0.01 ? { rotation: r(angle) } : {}),
    text: {
      content: rows.map((r1) => r1.text).join("\n"),
      fontFamily: b.family,
      fontSize: r(fontSize),
      fontWeight: b.weight,
      color: b.color ?? "#000000",
      align,
      lineHeight: Math.round(lineHeight * 10000) / 10000,
      ...(b.italic ? { italic: true } : {}),
      ...(b.letterSpacing ? { letterSpacing: r(b.letterSpacing * b.scale) } : {}),
      ...(b.decoration ? { decoration: b.decoration } : {}),
      ...(b.fallbacks?.length ? { fallbackFonts: b.fallbacks } : {}),
    },
  });
}

const measureCtx = document.createElement("canvas").getContext("2d")!;
function fontMetrics(family: string, weight: number, size: number, italic = false, fallbacks: string[] = []) {
  const font = `${italic ? "italic " : ""}${weight} ${size}px ${cssFontStack({ fontFamily: family, fallbackFonts: fallbacks })}`;
  measureCtx.font = font;
  const m = measureCtx.measureText("Hg");
  return {
    ascent: m.fontBoundingBoxAscent || size * 0.8,
    descent: m.fontBoundingBoxDescent || size * 0.2,
    measure: (t: string) => ((measureCtx.font = font), measureCtx.measureText(t).width),
  };
}

/** Charge (depuis Google Fonts) les polices utilisées par le SVG avant de mesurer quoi que ce soit. */
async function loadFonts(svg: Element) {
  const variants = Array.from(svg.querySelectorAll("text, tspan")).map((t) => {
    const st = getComputedStyle(t);
    return fontList(st.fontFamily)
      .filter((family) => !GENERIC_FONTS.has(family.toLowerCase()))
      .map((family) => ({ family, weight: num(st.fontWeight, 400), italic: st.fontStyle === "italic" || st.fontStyle === "oblique" }));
  }).flat();
  await ensureFonts(variants);
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

function paint(value: string, opacity: number, ctx: Ctx, el?: SVGGraphicsElement): { color: string | null; image?: string; crop?: Crop; gradient?: RootGradient } {
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
      const gradient = el ? gradientOf(ref as SVGGradientElement, opacity, el, ctx) : null;
      if (gradient) return { color: gradient.stops[0]!.color, gradient };
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

// ---------- Dégradés ----------

interface RootGradient {
  type: "linear" | "radial";
  stops: { offset: number; color: string }[];
  p1: [number, number]; // linéaire : départ ; radial : centre (coordonnées du SVG)
  p2: [number, number]; // linéaire : arrivée
  rx: number; // radial : rayons
  ry: number;
  angle?: number; // radial : rotation en degrés
}

function withGradient(s: Spec | null, g: RootGradient | undefined): Spec | null {
  if (s && g) s.gradientRoot = g;
  return s;
}

/** Lit un <linearGradient>/<radialGradient> et ramène ses points dans le repère racine du SVG. */
function gradientOf(ref: SVGGradientElement, opacity: number, el: SVGGraphicsElement, ctx: Ctx, matrix?: DOMMatrix): RootGradient | null {
  // Un dégradé peut hériter de ses arrêts et de ses attributs d'un autre (href) : Inkscape le fait systématiquement
  const chain: Element[] = [];
  for (let cur: Element | null = ref; cur && chain.length < 12 && !chain.includes(cur); ) {
    chain.push(cur);
    const h: string | null = cur.getAttribute("href") ?? cur.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? cur.getAttribute("xlink:href");
    cur = h?.startsWith("#") ? ref.ownerDocument.getElementById(h.slice(1)) : null;
  }
  const stopHost = chain.find((e) => e.querySelector("stop")) ?? ref;
  const owner = (n: string) => chain.find((e) => e.hasAttribute(n));
  const stops = Array.from(stopHost.querySelectorAll("stop")).map((stop) => {
    const st = getComputedStyle(stop);
    const raw = stop.getAttribute("offset") ?? "0";
    const offset = raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw) || 0;
    return { offset: Math.max(0, Math.min(1, offset)), color: toHex(st.stopColor, num(st.stopOpacity, 1) * opacity) ?? "#000000" };
  });
  if (stops.length === 0) return null;
  if (stops.length === 1) stops.push({ ...stops[0]!, offset: 1 });

  const m = matrix ?? ctx.matrix(el);
  const list = (owner("gradientTransform") as SVGGradientElement | undefined)?.gradientTransform?.baseVal;
  const gt = list && list.numberOfItems ? list.consolidate()!.matrix : new DOMMatrix();
  const bbox = (owner("gradientUnits")?.getAttribute("gradientUnits") ?? "objectBoundingBox") === "objectBoundingBox" ? el.getBBox() : null;
  const at = (x: number, y: number): [number, number] => {
    let p = new DOMPoint(x, y).matrixTransform(gt);
    if (bbox) p = new DOMPoint(bbox.x + p.x * bbox.width, bbox.y + p.y * bbox.height);
    p = p.matrixTransform(m);
    return [p.x, p.y];
  };
  const attr = (n: string, def: number) => {
    const v = owner(n)?.getAttribute(n) ?? null;
    if (v === null) return def;
    return v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
  };

  if (ref.localName === "radialGradient") {
    const cx = attr("cx", 0.5), cy = attr("cy", 0.5), rr = attr("r", 0.5);
    const c = at(cx, cy), ex = at(cx + rr, cy), ey = at(cx, cy + rr);
    const angle = (Math.atan2(ex[1] - c[1], ex[0] - c[0]) * 180) / Math.PI; // rotation de l'ellipse
    return { type: "radial", stops, p1: c, p2: c, rx: Math.hypot(ex[0] - c[0], ex[1] - c[1]), ry: Math.hypot(ey[0] - c[0], ey[1] - c[1]), angle };
  }
  return { type: "linear", stops, p1: at(attr("x1", 0), attr("y1", 0)), p2: at(attr("x2", 1), attr("y2", 0)), rx: 0, ry: 0 };
}

/** Dégradé en coordonnées du SVG → fractions de la boîte du nœud. */
function localGradient(g: RootGradient, s: Spec): Gradient {
  const fx = (x: number) => r6((x - s.x) / (s.width || 1));
  const fy = (y: number) => r6((y - s.y) / (s.height || 1));
  return {
    type: g.type,
    stops: g.stops.map((st) => ({ offset: r6(st.offset), color: st.color })),
    start: [fx(g.p1[0]), fy(g.p1[1])],
    end: [fx(g.p2[0]), fy(g.p2[1])],
    ...(g.type === "radial"
      ? { radius: [r6(g.rx / (s.width || 1)), r6(g.ry / (s.height || 1))] as [number, number], ...(Math.abs(g.angle ?? 0) > 0.01 ? { angle: r(g.angle!) } : {}) }
      : {}),
  };
}

// ---------- Ombres (filtres SVG façon Figma) ----------

/**
 * Figma décrit chaque ombre par une suite de primitives :
 *   feColorMatrix in=SourceAlpha → [feMorphology (étendue)] → feOffset → feGaussianBlur
 *   → [feComposite arithmetic = ombre interne] → feColorMatrix (couleur) → feBlend result=effect…
 */
function parseEffects(filter: Element, scale: number): { shadows: Shadow[]; layerBlur: number } {
  const out: Shadow[] = [];
  let layerBlur = 0;
  let cur: (Omit<Shadow, "color"> & { color?: string }) | null = null;
  const n = (fe: Element, a: string) => parseFloat((fe.getAttribute(a) ?? "0").split(/[\s,]+/)[0]!) || 0;
  for (const fe of Array.from(filter.children)) {
    switch (fe.localName) {
      case "feColorMatrix":
        if (fe.getAttribute("in") === "SourceAlpha") cur = { type: "drop", x: 0, y: 0, blur: 0, spread: 0 };
        else if (cur) {
          const v = (fe.getAttribute("values") ?? "").trim().split(/[\s,]+/).map(Number);
          if (v.length >= 19) cur.color = rgbaHex(v[4]!, v[9]!, v[14]!, v[18]!);
        }
        break;
      case "feMorphology":
        if (cur) cur.spread = fe.getAttribute("operator") === "erode" && cur.type === "drop" ? -n(fe, "radius") : n(fe, "radius");
        break;
      case "feOffset":
        if (cur) (cur.x = n(fe, "dx")), (cur.y = n(fe, "dy"));
        break;
      case "feGaussianBlur":
        // Hors d'une séquence d'ombre (ou appliqué à SourceGraphic), c'est le flou de calque de Figma
        if (!cur || fe.getAttribute("in") === "SourceGraphic") layerBlur = r(2 * n(fe, "stdDeviation") * scale);
        else cur.blur = 2 * n(fe, "stdDeviation");
        break;
      case "feComposite":
        if (cur && fe.getAttribute("operator") === "arithmetic") cur.type = "inner";
        break;
      case "feBlend":
        if (cur?.color && (fe.getAttribute("result") ?? "").startsWith("effect")) {
          out.push({ type: cur.type, x: r(cur.x * scale), y: r(cur.y * scale), blur: r(cur.blur * scale), spread: r(cur.spread * scale), color: cur.color });
          cur = null;
        }
        break;
    }
  }
  return { shadows: out, layerBlur };
}

function rgbaHex(r1: number, g1: number, b1: number, a1: number): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0").toUpperCase();
  return "#" + h(r1) + h(g1) + h(b1) + (a1 >= 0.999 ? "" : h(a1));
}

function strokeOf(style: CSSStyleDeclaration, m: DOMMatrix): DesignNode["stroke"] {
  if (!style.stroke || style.stroke === "none") return null;
  const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const width = num(style.strokeWidth, 1) * k;
  const color = toHex(style.stroke, num(style.strokeOpacity, 1));
  if (!color || width <= 0) return null;
  const dash = style.strokeDasharray && style.strokeDasharray !== "none"
    ? style.strokeDasharray.split(/[\s,]+/).map((v) => parseFloat(v) * k).filter((v) => Number.isFinite(v))
    : [];
  const cap = style.strokeLinecap as "butt" | "round" | "square";
  const join = style.strokeLinejoin as string;
  const miter = num(style.strokeMiterlimit, 4);
  return {
    color,
    width: r(width),
    ...(cap && cap !== "butt" ? { cap } : {}),
    ...(join === "round" || join === "bevel" ? { join } : {}),
    ...(dash.length && dash.some((v) => v > 0) ? { dash: dash.map(r) } : {}),
    ...(miter !== 4 ? { miterLimit: miter } : {}),
  };
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
