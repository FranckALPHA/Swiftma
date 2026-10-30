import { makeNode, newId, type AutoLayout, type DesignNode, type Gradient, type Op, type Shadow, type Sizing, type Stroke, type TextStyle } from "@swiftma/core";

const FORMAT = "swiftma-html";
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_NODES = 20_000;
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
  children: HtmlNode[];
  states?: Record<string, Partial<HtmlNode> & { textColor?: string; strokeColor?: string }>;
}

interface HtmlSnapshot {
  format: typeof FORMAT;
  version: 1;
  source: { title: string; url: string; capturedAt: string };
  root: HtmlNode;
}

export interface HtmlImportResult {
  ops: Op[];
  rootId: string;
  stats: { nodes: number };
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
      !finite(value.radius, 0, MAX_DIMENSION) ||
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
    radius: value.radius,
    opacity: value.opacity,
    clip: value.clip,
    children: value.children.map((child) => parseNode(child, depth + 1, count)),
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
  if (node.type === "text") node.text = parseText(value.text);
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
        if (isColor(stVal.fill)) patch.fill = stVal.fill;
        if (finite(stVal.opacity, 0, 1)) patch.opacity = stVal.opacity;
        if (finite(stVal.height, 0.1, MAX_DIMENSION)) patch.height = stVal.height;
        if (isColor(stVal.textColor)) patch.textColor = stVal.textColor;
        if (isColor(stVal.strokeColor)) patch.strokeColor = stVal.strokeColor;
        if (Array.isArray(stVal.children)) {
          patch.children = stVal.children.map((c) => parseNode(c, depth + 1, count));
        }
        node.states[stName] = patch;
      }
    }
  }
  return node;
}

function parseSnapshot(input: string | unknown): HtmlSnapshot {
  if (typeof input === "string" && input.length > MAX_FILE_SIZE) {
    throw new Error("Fichier Swiftma HTML trop volumineux (maximum 20 Mo).");
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
  return {
    format: FORMAT,
    version: 1,
    source: { title: value.source.title, url: value.source.url, capturedAt: value.source.capturedAt },
    root: parseNode(value.root, 0, count),
  };
}

export function htmlSnapshotToOps(
  input: string | unknown,
  at: { x: number; y: number },
): HtmlImportResult {
  const snapshot = parseSnapshot(input);
  const ops: Op[] = [];
  let rootId = "";
  const compChildrenMap = new Map<string, string[]>();
  let nextComponentSetY = at.y;
  const componentSetX = at.x + snapshot.root.width + 120;

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
      text: branchSpec.text ? { ...branchSpec.text } : null,
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

  const emit = (spec: HtmlNode, parentId: string | null): string => {
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
      nextComponentSetY += Math.max(spec.height, 80) + 60;

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

      const compChildIds = spec.children.map((c) => emit(c, compId));

      // 3. Variantes d'état
      for (const [stateName, statePatch] of Object.entries(spec.states)) {
        const stateCompId = newId();
        const patchFill = typeof statePatch.fill === "string" ? statePatch.fill : compNode.fill;
        const patchHeight = typeof statePatch.height === "number" ? statePatch.height : compNode.height;
        const patchOpacity = typeof statePatch.opacity === "number" ? statePatch.opacity : compNode.opacity;

        const stateNode: DesignNode = makeNode("frame", {
          name: `${spec.name} — ${stateName}`,
          x: 0,
          y: 0,
          width: compNode.width,
          height: patchHeight,
          fill: patchFill,
          radius: compNode.radius,
          opacity: patchOpacity,
          clip: compNode.clip,
          stroke: compNode.stroke ? { ...compNode.stroke } : null,
          shadows: compNode.shadows ? [...compNode.shadows] : null,
          layout: compNode.layout ? { ...compNode.layout } : null,
          isComponent: true,
          variant: { "État": stateName },
        }, stateCompId);
        stateNode.parentId = setId;
        ops.push({ kind: "create", node: stateNode });

        if (statePatch.children && statePatch.children.length > 0) {
          statePatch.children.forEach((c) => emit(c, stateCompId));
        } else {
          spec.children.forEach((c) => {
            const childClone = { ...c };
            if (statePatch.textColor && childClone.text) {
              childClone.text = { ...childClone.text, color: statePatch.textColor };
            }
            emit(childClone, stateCompId);
          });
        }
      }

      // 4. Instance posée dans la page à la place initiale avec instanciation récursive complète
      const instId = newId();
      const instNode: DesignNode = makeNode("frame", {
        name: spec.name,
        x: spec.x + (parentId ? 0 : at.x),
        y: spec.y + (parentId ? 0 : at.y),
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
        instanceOf: compId,
      }, instId);
      instNode.parentId = parentId;
      ops.push({ kind: "create", node: instNode });

      spec.children.forEach((c, i) => {
        const subCompId = compChildIds[i]!;
        emitInstanceBranch(c, subCompId, instId);
      });

      if (!rootId) rootId = instId;
      return instId;
    }

    const node: DesignNode = makeNode(spec.type, {
      name: spec.name,
      x: spec.x + (parentId ? 0 : at.x),
      y: spec.y + (parentId ? 0 : at.y),
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
    }, newId());
    node.parentId = parentId;
    ops.push({ kind: "create", node });
    if (parentId) {
      const sibs = compChildrenMap.get(parentId) || [];
      sibs.push(node.id);
      compChildrenMap.set(parentId, sibs);
    }
    if (!rootId) rootId = node.id;
    spec.children.forEach((child) => emit(child, node.id));
    return node.id;
  };
  emit(snapshot.root, null);
  return { ops, rootId, stats: { nodes: ops.length } };
}
