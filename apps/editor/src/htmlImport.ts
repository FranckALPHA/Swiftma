import { makeNode, newId, type AnimationType, type AutoLayout, type DesignNode, type Gradient, type NodeAnimation, type Op, type Shadow, type Sizing, type Stroke, type TextStyle } from "@swiftma/core";

const FORMAT = "swiftma-html";
const MAX_FILE_SIZE = 150 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 50;
const MAX_DIMENSION = 100_000;

interface HtmlNode {
  type: "frame" | "rect" | "text" | "image";
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null;
  radius: number;
  opacity: number;
  clip: boolean;
  stroke?: Stroke;
  shadows?: Shadow[];
  text?: TextStyle;
  image?: { src: string; crop?: { x: number; y: number; width: number; height: number } };
  gradient?: Gradient;
  layout?: AutoLayout;
  absolute?: boolean;
  sizingH?: Sizing;
  sizingV?: Sizing;
  animation?: NodeAnimation;
  children: HtmlNode[];
  states?: Record<string, Partial<HtmlNode> & { textColor?: string; strokeColor?: string }>;
}

export interface HtmlPage {
  title: string;
  url: string;
  root: HtmlNode;
}

export interface HtmlSnapshot {
  format: typeof FORMAT;
  version: 1;
  source: {
    title: string;
    url: string;
    capturedAt: string;
    isSite?: boolean;
    pageCount?: number;
  };
  root?: HtmlNode;
  pages?: HtmlPage[];
}

export interface HtmlImportResult {
  ops: Op[];
  rootId: string;
  rootIds?: string[];
  stats: { nodes: number; pages?: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value);
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

function parseText(value: unknown): TextStyle {
  if (!isRecord(value) || typeof value.content !== "string" || value.content.length > 10_000 ||
      typeof value.fontFamily !== "string" || value.fontFamily.length > 200 ||
      !finite(value.fontSize, 1, 512) || !finite(value.fontWeight, 100, 900) ||
      !isColor(value.color) || !["left", "center", "right"].includes(String(value.align)) ||
      !finite(value.lineHeight, 0.5, 4) ||
      (value.letterSpacing !== undefined && !finite(value.letterSpacing, -100, 100)) ||
      (value.italic !== undefined && typeof value.italic !== "boolean")) {
    throw new Error("Style de texte invalide dans le fichier Swiftma HTML.");
  }
  return {
    content: value.content,
    fontFamily: value.fontFamily,
    fontSize: value.fontSize,
    fontWeight: value.fontWeight,
    color: value.color,
    align: value.align as TextStyle["align"],
    lineHeight: value.lineHeight,
    ...(value.letterSpacing === undefined ? {} : { letterSpacing: value.letterSpacing }),
    ...(value.italic === undefined ? {} : { italic: value.italic }),
  };
}

function parseStroke(value: unknown): Stroke {
  if (!isRecord(value) || !isColor(value.color) || !finite(value.width, 0.1, 100)) {
    throw new Error("Contour invalide dans le fichier Swiftma HTML.");
  }
  return { color: value.color, width: value.width };
}

function parseShadows(value: unknown): Shadow[] {
  if (!Array.isArray(value) || value.length > 8 ||
      !value.every((shadow) => isRecord(shadow) &&
        ["drop", "inner"].includes(String(shadow.type)) &&
        finite(shadow.x, -MAX_DIMENSION, MAX_DIMENSION) &&
        finite(shadow.y, -MAX_DIMENSION, MAX_DIMENSION) &&
        finite(shadow.blur, 0, MAX_DIMENSION) &&
        finite(shadow.spread, -MAX_DIMENSION, MAX_DIMENSION) &&
        isColor(shadow.color))) {
    throw new Error("Ombres invalides dans le fichier Swiftma HTML.");
  }
  return value.map((shadow) => ({
    type: shadow.type as Shadow["type"],
    x: shadow.x as number,
    y: shadow.y as number,
    blur: shadow.blur as number,
    spread: shadow.spread as number,
    color: shadow.color as string,
  }));
}

function parseGradient(value: unknown): Gradient {
  const isPoint = (point: unknown): point is [number, number] =>
    Array.isArray(point) && point.length === 2 && point.every((n) => finite(n, -2, 2));
  const isRadius = (radius: unknown): radius is [number, number] =>
    Array.isArray(radius) && radius.length === 2 && radius.every((n) => finite(n, 0, MAX_DIMENSION));
  if (!isRecord(value) ||
      !["linear", "radial"].includes(String(value.type)) ||
      !Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 32 ||
      !value.stops.every((stop) => isRecord(stop) && finite(stop.offset, 0, 1) && isColor(stop.color)) ||
      !isPoint(value.start) || !isPoint(value.end) ||
      (value.radius !== undefined && !isRadius(value.radius)) ||
      (value.angle !== undefined && !finite(value.angle, -360, 360))) {
    throw new Error("Dégradé invalide dans le fichier Swiftma HTML.");
  }
  return {
    type: value.type as Gradient["type"],
    stops: value.stops.map((stop) => ({ offset: stop.offset as number, color: stop.color as string })),
    start: value.start,
    end: value.end,
    ...(value.radius === undefined ? {} : { radius: value.radius }),
    ...(value.angle === undefined ? {} : { angle: value.angle }),
  };
}

function parseLayout(value: unknown): AutoLayout {
  if (!isRecord(value) ||
      !["row", "column"].includes(String(value.direction)) ||
      !finite(value.gap, 0, MAX_DIMENSION) ||
      !Array.isArray(value.padding) || value.padding.length !== 4 ||
      !value.padding.every((n) => finite(n, 0, MAX_DIMENSION)) ||
      !["start", "center", "end", "space-between"].includes(String(value.justify)) ||
      !["start", "center", "end"].includes(String(value.align)) ||
      (value.wrap !== undefined && typeof value.wrap !== "boolean") ||
      (value.wrapGap !== undefined && !finite(value.wrapGap, 0, MAX_DIMENSION))) {
    throw new Error("Auto-layout invalide dans le fichier Swiftma HTML.");
  }
  return {
    direction: value.direction as AutoLayout["direction"],
    gap: value.gap,
    padding: value.padding as AutoLayout["padding"],
    justify: value.justify as AutoLayout["justify"],
    align: value.align as AutoLayout["align"],
    ...(value.wrap === undefined ? {} : { wrap: value.wrap }),
    ...(value.wrapGap === undefined ? {} : { wrapGap: value.wrapGap }),
  };
}

function sortLayerStack(children: HtmlNode[]): HtmlNode[] {
  if (children.length <= 1) return children;
  const isHeaderOrNav = (n: HtmlNode) =>
    /^header\b|\bheader\b|\bnav\b|\bnavbar\b/i.test(n.name) ||
    /\b(sticky|fixed)\b/i.test(n.name) ||
    n.absolute === true;

  const hasHeader = children.some(isHeaderOrNav);
  if (!hasHeader) return children;

  // Hisser les calques d'en-tête, navigation et éléments fixés/collants à la fin des frères
  // pour qu'ils soient rendus au premier plan dans Konva et en haut de la liste des calques.
  return children.slice().sort((a, b) => {
    const aNav = isHeaderOrNav(a) ? 1 : 0;
    const bNav = isHeaderOrNav(b) ? 1 : 0;
    return aNav - bNav;
  });
}

function parseNode(value: unknown, depth: number, count: { value: number }): HtmlNode {
  if (depth > MAX_DEPTH || ++count.value > MAX_NODES || !isRecord(value)) {
    throw new Error("La capture HTML est invalide ou trop volumineuse.");
  }
  if (!["frame", "rect", "text", "image"].includes(String(value.type)) ||
      typeof value.name !== "string" || value.name.length > 200 ||
      !finite(value.x, -MAX_DIMENSION, MAX_DIMENSION) ||
      !finite(value.y, -MAX_DIMENSION, MAX_DIMENSION) ||
      !finite(value.width, 0.1, MAX_DIMENSION) ||
      !finite(value.height, 0.1, MAX_DIMENSION) ||
      (value.fill !== null && !isColor(value.fill)) ||
      (typeof value.radius !== "number" || !Number.isFinite(value.radius) || value.radius < 0) ||
      !finite(value.opacity, 0, 1) ||
      typeof value.clip !== "boolean" ||
      (value.absolute !== undefined && typeof value.absolute !== "boolean") ||
      (value.sizingH !== undefined && !["fixed", "fill", "hug"].includes(String(value.sizingH))) ||
      (value.sizingV !== undefined && !["fixed", "fill", "hug"].includes(String(value.sizingV))) ||
      !Array.isArray(value.children)) {
    throw new Error("Un calque de la capture HTML est invalide.");
  }

  const node: HtmlNode = {
    type: value.type as HtmlNode["type"],
    name: value.name,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    fill: value.fill,
    radius: Math.min(value.radius, Math.max(value.width, value.height) / 2),
    opacity: value.opacity,
    clip: value.clip,
    children: sortLayerStack(value.children.map((child) => parseNode(child, depth + 1, count))),
  };
  if (value.stroke !== undefined) node.stroke = parseStroke(value.stroke);
  if (value.shadows !== undefined) node.shadows = parseShadows(value.shadows);
  if (value.gradient !== undefined) node.gradient = parseGradient(value.gradient);
  if (value.layout !== undefined) {
    if (node.type !== "frame") throw new Error("Seule une frame peut contenir un auto-layout.");
    node.layout = parseLayout(value.layout);
  }
  if (value.absolute === true) node.absolute = true;
  if (value.sizingH !== undefined) node.sizingH = value.sizingH as Sizing;
  if (value.sizingV !== undefined) node.sizingV = value.sizingV as Sizing;
  if (node.type === "text") {
    node.text = parseText(value.text);
    if (!node.sizingH) {
      const isSingleLine = !node.height || !node.text?.fontSize || node.height <= node.text.fontSize * (node.text.lineHeight || 1.2) * 1.5;
      if (isSingleLine) {
        node.sizingH = "hug";
        node.sizingV = "hug";
      }
    }
  }
  else if (node.type === "image") {
    if (!isRecord(value.image) || typeof value.image.src !== "string" || value.image.src.length > 30 * 1024 * 1024) {
      throw new Error("URL d’image invalide dans le fichier Swiftma HTML.");
    }
    const rawSrc = value.image.src.trim();
    if (rawSrc.startsWith("data:image/")) {
      if (!/^data:image\/[a-z0-9.+_-]+(?:;[^,]+)*,/i.test(rawSrc)) {
        throw new Error("URL d’image invalide dans le fichier Swiftma HTML.");
      }
      let finalDataSrc = rawSrc;
      if (rawSrc.startsWith("data:image/svg+xml")) {
        try {
          const comma = rawSrc.indexOf(",");
          if (comma !== -1) {
            const head = rawSrc.slice(0, comma);
            const body = rawSrc.slice(comma + 1);
            const isB64 = head.includes(";base64");
            let xml = isB64
              ? (typeof Buffer !== "undefined" ? Buffer.from(body, "base64").toString("utf8") : atob(body))
              : decodeURIComponent(body);
            if (xml.includes("var(")) {
              xml = xml.replace(/var\(--[^)]+\)/g, "#000000");
              finalDataSrc = isB64
                ? `${head},${typeof Buffer !== "undefined" ? Buffer.from(xml).toString("base64") : btoa(unescape(encodeURIComponent(xml)))}`
                : `${head},${encodeURIComponent(xml)}`;
            }
          }
        } catch {}
      }
      node.image = { src: finalDataSrc };
    } else {
      try {
        const url = new URL(rawSrc);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
        node.image = { src: url.href };
      } catch {
        throw new Error("URL d’image invalide dans le fichier Swiftma HTML.");
      }
    }
    if (isRecord(value.image.crop)) {
      const { x, y, width, height } = value.image.crop;
      if (finite(x, 0, 1) && finite(y, 0, 1) && finite(width, 0, 1) && finite(height, 0, 1)) {
        node.image.crop = { x, y, width, height };
      }
    }
  }
  if (isRecord(value.states)) {
    node.states = {};
    for (const [stName, stVal] of Object.entries(value.states)) {
      if (typeof stName === "string" && isRecord(stVal)) {
        const patch: Partial<HtmlNode> & { textColor?: string; strokeColor?: string } = {};
        if (stVal.fill === null || isColor(stVal.fill)) patch.fill = stVal.fill;
        if (finite(stVal.opacity, 0, 1)) patch.opacity = stVal.opacity;
        if (finite(stVal.width, 0.1, MAX_DIMENSION)) patch.width = stVal.width;
        if (finite(stVal.height, 0.1, MAX_DIMENSION)) patch.height = stVal.height;
        if (typeof stVal.radius === "number" && Number.isFinite(stVal.radius) && stVal.radius >= 0) {
          patch.radius = stVal.radius;
        }
        if (isColor(stVal.textColor)) patch.textColor = stVal.textColor;
        if (isColor(stVal.strokeColor)) patch.strokeColor = stVal.strokeColor;
        if (stVal.stroke !== undefined) {
          try { patch.stroke = parseStroke(stVal.stroke); } catch {}
        }
        if (stVal.shadows !== undefined) {
          try { patch.shadows = parseShadows(stVal.shadows); } catch {}
        }
        if (stVal.gradient !== undefined) {
          try { patch.gradient = parseGradient(stVal.gradient); } catch {}
        }
        if (Array.isArray(stVal.children)) {
          patch.children = stVal.children.map((c) => parseNode(c, depth + 1, count));
        }
        node.states[stName] = patch;
      }
    }
  }
  if (isRecord(value.animation) && ["carousel", "marquee", "spin", "pulse", "shimmer", "float", "fade-in", "reveal"].includes(String(value.animation.type))) {
    const anim: NodeAnimation = { type: value.animation.type as AnimationType };
    if (finite(value.animation.duration, 0, 300_000)) anim.duration = value.animation.duration;
    if (finite(value.animation.delay, 0, 60_000)) anim.delay = value.animation.delay;
    if (typeof value.animation.easing === "string" && value.animation.easing.length <= 120) anim.easing = value.animation.easing;
    if (typeof value.animation.infinite === "boolean") anim.infinite = value.animation.infinite;
    if (typeof value.animation.autoPlay === "boolean") anim.autoPlay = value.animation.autoPlay;
    if (finite(value.animation.stepPx, 1, MAX_DIMENSION)) anim.stepPx = value.animation.stepPx;
    node.animation = anim;
  }
  return node;
}

function parseSnapshot(input: string | unknown): HtmlSnapshot {
  if (typeof input === "string" && input.length > MAX_FILE_SIZE) {
    throw new Error("Fichier Swiftma HTML trop volumineux (maximum 150 Mo).");
  }
  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("Fichier Swiftma HTML invalide : JSON illisible.");
  }
  if (!isRecord(value) || value.format !== FORMAT || value.version !== 1 ||
      !isRecord(value.source) || typeof value.source.title !== "string" ||
      typeof value.source.url !== "string" || typeof value.source.capturedAt !== "string") {
    throw new Error("Format de fichier non reconnu. Utilise un fichier .swiftma.json créé par l’extension Swiftma.");
  }
  const count = { value: 0 };

  const parsedPages: HtmlPage[] = [];
  if (Array.isArray(value.pages) && value.pages.length > 0) {
    for (const p of value.pages) {
      if (isRecord(p) && typeof p.title === "string" && typeof p.url === "string" && isRecord(p.root)) {
        parsedPages.push({
          title: p.title,
          url: p.url,
          root: parseNode(p.root, 0, count),
        });
      }
    }
  }

  const parsedRoot = isRecord(value.root) ? parseNode(value.root, 0, count) : undefined;
  if (!parsedRoot && parsedPages.length === 0) {
    throw new Error("Aucun calque trouvé dans le fichier Swiftma HTML.");
  }

  return {
    format: FORMAT,
    version: 1,
    source: {
      title: value.source.title,
      url: value.source.url,
      capturedAt: value.source.capturedAt,
      isSite: typeof value.source.isSite === "boolean" ? value.source.isSite : undefined,
      pageCount: typeof value.source.pageCount === "number" ? value.source.pageCount : undefined,
    },
    root: parsedRoot,
    pages: parsedPages.length > 0 ? parsedPages : undefined,
  };
}

export function htmlSnapshotToOps(
  input: string | unknown,
  at: { x: number; y: number } = { x: 0, y: 0 },
): HtmlImportResult {
  const snapshot = parseSnapshot(input);
  const ops: Op[] = [];
  const rootIds: string[] = [];
  const compChildrenMap = new Map<string, string[]>();

  const pageList: HtmlPage[] = snapshot.pages && snapshot.pages.length > 0
    ? snapshot.pages
    : snapshot.root ? [{ title: snapshot.source.title, url: snapshot.source.url, root: snapshot.root }] : [];

  const pageGap = 160;
  const totalWidth = pageList.reduce((sum, p) => sum + (p.root.width || 1440) + pageGap, 0);
  const componentSetX = at.x + totalWidth;
  let nextComponentSetY = at.y;

  const emitInstanceBranch = (branchSpec: HtmlNode, compSourceId: string, instParentId: string): string => {
    const kidId = newId();
    const kn: DesignNode = makeNode(branchSpec.type, {
      name: branchSpec.name,
      x: branchSpec.x,
      y: branchSpec.y,
      width: branchSpec.width,
      height: branchSpec.height,
      fill: branchSpec.fill,
      radius: branchSpec.radius,
      opacity: branchSpec.opacity,
      clip: branchSpec.clip,
      stroke: branchSpec.stroke ?? null,
      shadows: branchSpec.shadows ?? null,
      text: branchSpec.text ? { ...branchSpec.text } : undefined,
      image: branchSpec.image ? { ...branchSpec.image } : null,
      gradient: branchSpec.gradient ? structuredClone(branchSpec.gradient) : null,
      layout: branchSpec.layout ? { ...branchSpec.layout } : null,
      absolute: branchSpec.absolute,
      sizingH: branchSpec.sizingH,
      sizingV: branchSpec.sizingV,
      sourceId: compSourceId,
    }, kidId);
    kn.parentId = instParentId;
    ops.push({ kind: "create", node: kn });

    if (branchSpec.children && branchSpec.children.length > 0) {
      const compChildIds = compChildrenMap.get(compSourceId) || [];
      branchSpec.children.forEach((subSpec, i) => {
        const subCompId = compChildIds[i] || compSourceId;
        emitInstanceBranch(subSpec, subCompId, kidId);
      });
    }
    return kidId;
  };

  const emit = (spec: HtmlNode, parentId: string | null, originX: number, originY: number): string => {
    if (spec.states && Object.keys(spec.states).length > 0 && spec.type === "frame") {
      const isAccordion = "Ouvert" in spec.states;
      const baseStateName = isAccordion ? "Fermé" : "Normal";

      // 1. Ensemble de variantes (Component Set) placé à droite de la maquette
      const setId = newId();
      const setNode: DesignNode = makeNode("frame", {
        name: spec.name,
        x: componentSetX,
        y: nextComponentSetY,
        width: 10,
        height: 10,
        fill: null,
        stroke: { color: "#9747FF", width: 1, dash: [4, 4] },
        radius: 6,
        isComponentSet: true,
        sizingH: "hug",
        sizingV: "hug",
        layout: { direction: "row", gap: 20, padding: [20, 20, 20, 20], justify: "start", align: "start", wrap: false },
      }, setId);
      setNode.parentId = null;
      ops.push({ kind: "create", node: setNode });
      nextComponentSetY += Math.max(spec.height, 80) + 120;

      // 2. Composant de base
      const compId = newId();
      const compNode: DesignNode = makeNode("frame", {
        name: spec.name,
        x: 0,
        y: 0,
        width: spec.width,
        height: spec.height,
        fill: spec.fill,
        radius: spec.radius,
        opacity: spec.opacity,
        clip: spec.clip,
        stroke: spec.stroke ?? null,
        shadows: spec.shadows ?? null,
        layout: spec.layout ?? null,
        isComponent: true,
        variant: { "État": baseStateName },
      }, compId);
      compNode.parentId = setId;
      ops.push({ kind: "create", node: compNode });

      const compChildIds = spec.children.map((c) => emit(c, compId, originX, originY));

      // 3. Variantes d'état
      const cloneWithTextColor = (child: HtmlNode, textColor?: string): HtmlNode => {
        const cloned: HtmlNode = { ...child };
        if (textColor && cloned.text) {
          cloned.text = { ...cloned.text, color: textColor };
        }
        if (cloned.children && cloned.children.length > 0) {
          cloned.children = cloned.children.map((sub) => cloneWithTextColor(sub, textColor));
        }
        return cloned;
      };

      for (const [stateName, statePatch] of Object.entries(spec.states)) {
        const stateCompId = newId();
        const patchFill = statePatch.fill !== undefined ? statePatch.fill : compNode.fill;
        const patchWidth = typeof statePatch.width === "number" ? statePatch.width : compNode.width;
        const patchHeight = typeof statePatch.height === "number" ? statePatch.height : compNode.height;
        const patchRadius = typeof statePatch.radius === "number" ? statePatch.radius : compNode.radius;
        const patchOpacity = typeof statePatch.opacity === "number" ? statePatch.opacity : compNode.opacity;
        const patchStroke = statePatch.stroke
          ? { ...statePatch.stroke }
          : statePatch.strokeColor
            ? { color: statePatch.strokeColor, width: compNode.stroke?.width ?? 1 }
            : compNode.stroke
              ? { ...compNode.stroke }
              : null;
        const patchShadows = statePatch.shadows
          ? [...statePatch.shadows]
          : compNode.shadows
            ? [...compNode.shadows]
            : null;
        const patchGradient = statePatch.gradient
          ? structuredClone(statePatch.gradient)
          : compNode.gradient
            ? structuredClone(compNode.gradient)
            : null;

        const stateNode: DesignNode = makeNode("frame", {
          name: `${spec.name} — ${stateName}`,
          x: 0,
          y: 0,
          width: patchWidth,
          height: patchHeight,
          fill: patchFill,
          radius: patchRadius,
          opacity: patchOpacity,
          clip: compNode.clip,
          stroke: patchStroke,
          shadows: patchShadows,
          gradient: patchGradient,
          layout: compNode.layout ? { ...compNode.layout } : null,
          isComponent: true,
          variant: { "État": stateName },
        }, stateCompId);
        stateNode.parentId = setId;
        ops.push({ kind: "create", node: stateNode });

        if (statePatch.children && statePatch.children.length > 0) {
          statePatch.children.forEach((c) => emit(c, stateCompId, originX, originY));
        } else {
          spec.children.forEach((c) => {
            emit(cloneWithTextColor(c, statePatch.textColor), stateCompId, originX, originY);
          });
        }
      }

      // 4. Instance posée dans la page à la place initiale avec instanciation récursive complète
      const instId = newId();
      const instNode: DesignNode = makeNode("frame", {
        name: spec.name,
        x: spec.x + (parentId ? 0 : originX),
        y: spec.y + (parentId ? 0 : originY),
        width: spec.width,
        height: spec.height,
        fill: spec.fill,
        radius: spec.radius,
        opacity: spec.opacity,
        clip: spec.clip,
        stroke: spec.stroke ?? null,
        shadows: spec.shadows ?? null,
        layout: spec.layout ?? null,
        absolute: spec.absolute,
        sizingH: spec.sizingH,
        sizingV: spec.sizingV,
        animation: spec.animation ? { ...spec.animation } : null,
        instanceOf: compId,
      }, instId);
      instNode.parentId = parentId;
      ops.push({ kind: "create", node: instNode });

      spec.children.forEach((c, i) => {
        const subCompId = compChildIds[i]!;
        emitInstanceBranch(c, subCompId, instId);
      });

      return instId;
    }

    const node: DesignNode = makeNode(spec.type, {
      name: spec.name,
      x: spec.x + (parentId ? 0 : originX),
      y: spec.y + (parentId ? 0 : originY),
      width: spec.width,
      height: spec.height,
      fill: spec.fill,
      radius: spec.radius,
      opacity: spec.opacity,
      clip: spec.clip,
      stroke: spec.stroke ?? null,
      shadows: spec.shadows ?? null,
      text: spec.text,
      image: spec.image ?? null,
      gradient: spec.gradient ?? null,
      layout: spec.layout ?? null,
      absolute: spec.absolute,
      sizingH: spec.sizingH,
      sizingV: spec.sizingV,
      animation: spec.animation ? { ...spec.animation } : null,
    }, newId());
    node.parentId = parentId;
    ops.push({ kind: "create", node });
    if (parentId) {
      const sibs = compChildrenMap.get(parentId) || [];
      sibs.push(node.id);
      compChildrenMap.set(parentId, sibs);
    }
    spec.children.forEach((child) => emit(child, node.id, originX, originY));
    return node.id;
  };

  let currentX = at.x;
  for (const page of pageList) {
    if (!page.root.name || page.root.name === "frame") {
      page.root.name = page.title;
    }
    if (page.root.fill === null || page.root.fill === undefined) {
      page.root.fill = "#FFFFFF";
    }
    const pageId = emit(page.root, null, currentX, at.y);
    rootIds.push(pageId);
    currentX += (page.root.width || 1440) + pageGap;
  }

  // Détection et chargement automatique des polices Google Fonts présentes sur le site
  const fonts = new Set<string>();
  const collectFonts = (n: HtmlNode) => {
    if (n.text?.fontFamily) fonts.add(n.text.fontFamily);
    n.children?.forEach(collectFonts);
  };
  pageList.forEach((p) => collectFonts(p.root));
  ensureWebFontsLoaded(fonts);

  return { ops, rootId: rootIds[0] || "", rootIds, stats: { nodes: ops.length, pages: pageList.length } };
}

export function ensureWebFontsLoaded(fontFamilies: Iterable<string>) {
  if (typeof document === "undefined") return;
  const popularFonts = new Set([
    "Montserrat", "Poppins", "Roboto", "Open Sans", "Lato", "Oswald", "Raleway",
    "Jost", "Plus Jakarta Sans", "Outfit", "Space Grotesk", "Inter", "Playfair Display",
    "Lora", "Merriweather", "Nunito", "Rubik", "Work Sans", "DM Sans", "Manrope",
    "Syne", "Urbanist", "Cinzel", "Cabin", "Quicksand", "Barlow"
  ]);
  const toLoad: string[] = [];
  for (const f of fontFamilies) {
    if (!f) continue;
    const clean = f.replace(/^["']|["']$/g, "").trim();
    if (popularFonts.has(clean) && !document.querySelector(`link[data-font="${clean}"]`)) {
      toLoad.push(clean);
    }
  }
  if (toLoad.length === 0) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?${toLoad.map((f) => `family=${encodeURIComponent(f)}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400`).join("&")}&display=swap`;
  toLoad.forEach((f) => link.setAttribute("data-font", f));
  document.head.appendChild(link);
}
