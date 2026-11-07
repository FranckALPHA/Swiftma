// Parseur SVG vers calques éditables Swiftma (sans dépendance au DOM du navigateur).
// Convertit <svg>, <g>, <rect>, <circle>, <ellipse>, <path>, <text>, <image>, etc.
// en hiérarchie complète de nœuds Swiftma (Op[]).

import { makeNode, newId, type DesignNode, type Gradient, type NodeType, type Stroke } from "./model.js";
import type { Op } from "./ops.js";
import { parseCssColor } from "./h2dImport.js";
import { applyMatrix, type Matrix6 } from "./paint.js";

export interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  children: SvgElement[];
  text?: string;
}

export const IDENTITY_MATRIX: Matrix6 = [1, 0, 0, 1, 0, 0];

export function multiplyMatrix(m1: Matrix6, m2: Matrix6): Matrix6 {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function parseTransform(str?: string): Matrix6 {
  if (!str || !str.trim()) return IDENTITY_MATRIX;
  let current: Matrix6 = [...IDENTITY_MATRIX];

  const regex = /([a-zA-Z]+)\s*\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(str)) !== null) {
    const type = match[1]!.toLowerCase();
    const args = match[2]!.trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));

    let m: Matrix6 = [...IDENTITY_MATRIX];
    if (type === "translate" && args.length >= 1) {
      m = [1, 0, 0, 1, args[0]!, args[1] ?? 0];
    } else if (type === "scale" && args.length >= 1) {
      m = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
    } else if (type === "rotate" && args.length >= 1) {
      const rad = (args[0]! * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      if (args.length >= 3) {
        const cx = args[1]!;
        const cy = args[2]!;
        const t1: Matrix6 = [1, 0, 0, 1, cx, cy];
        const r: Matrix6 = [cos, sin, -sin, cos, 0, 0];
        const t2: Matrix6 = [1, 0, 0, 1, -cx, -cy];
        m = multiplyMatrix(multiplyMatrix(t1, r), t2);
      } else {
        m = [cos, sin, -sin, cos, 0, 0];
      }
    } else if (type === "matrix" && args.length === 6) {
      m = [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
    }

    current = multiplyMatrix(current, m);
  }

  return current;
}

export function parseStyleString(str?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!str) return result;
  const parts = str.split(";");
  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx > 0) {
      const key = part.slice(0, idx).trim().toLowerCase();
      const val = part.slice(idx + 1).trim();
      if (key && val) result[key] = val;
    }
  }
  return result;
}

export function unescapeXml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function parseSvgXml(xml: string): SvgElement | null {
  let clean = xml.replace(/<!--[\s\S]*?-->/g, "");
  clean = clean.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  clean = clean.replace(/<\?xml[\s\S]*?\?>/gi, "");

  const classStyles = new Map<string, Record<string, string>>();
  const styleBlocks = clean.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (styleBlocks) {
    for (const block of styleBlocks) {
      const content = block.replace(/<style[^>]*>|<\/style>/gi, "");
      const rules = content.match(/\.([a-zA-Z0-9_-]+)\s*\{([^}]+)\}/g);
      if (rules) {
        for (const rule of rules) {
          const m = /\.([a-zA-Z0-9_-]+)\s*\{([^}]+)\}/.exec(rule);
          if (m) {
            classStyles.set(m[1]!, parseStyleString(m[2]!));
          }
        }
      }
    }
  }

  const tagRegex = /<(\/?)([a-zA-Z0-9_:-]+)((?:\s+[^"'>=\s]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

  const stack: SvgElement[] = [];
  let root: SvgElement | null = null;

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(clean)) !== null) {
    const isClosing = match[1] === "/";
    const tagName = match[2] ? match[2].toLowerCase() : "";
    const rawAttrs = match[3] ?? "";
    const isSelfClosing = match[4] === "/";
    const textNode = match[5];

    if (textNode) {
      if (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const trimmed = textNode.trim();
        if (trimmed) {
          top.text = (top.text ? top.text + " " : "") + unescapeXml(trimmed);
        }
      }
      continue;
    }

    if (!tagName) continue;

    if (isClosing) {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }

    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
      const key = attrMatch[1]!.toLowerCase();
      const val = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
      attrs[key] = unescapeXml(val);
    }

    const inlineStyle = parseStyleString(attrs.style);
    let mergedStyle: Record<string, string> = { ...inlineStyle };

    if (attrs.class) {
      const classes = attrs.class.split(/\s+/);
      for (const cls of classes) {
        const cStyle = classStyles.get(cls);
        if (cStyle) mergedStyle = { ...cStyle, ...mergedStyle };
      }
    }

    const el: SvgElement = {
      tag: tagName,
      attrs,
      style: mergedStyle,
      children: [],
    };

    if (stack.length === 0) {
      root = el;
    } else {
      stack[stack.length - 1]!.children.push(el);
    }

    const nonContainers = ["rect", "circle", "ellipse", "path", "line", "polyline", "polygon", "image", "stop", "use"];
    if (!isSelfClosing && !nonContainers.includes(tagName)) {
      stack.push(el);
    }
  }

  return root;
}

export function parseGradientElement(el: SvgElement): Gradient | null {
  const stops: { offset: number; color: string }[] = [];
  for (const child of el.children) {
    if (child.tag === "stop") {
      let offset = 0;
      const offStr = child.attrs.offset ?? child.style.offset ?? "0";
      if (offStr.endsWith("%")) offset = parseFloat(offStr) / 100;
      else offset = parseFloat(offStr) || 0;

      const stopColorRaw = child.attrs["stop-color"] ?? child.style["stop-color"] ?? child.style.color ?? "#000000";
      const stopColor = parseCssColor(stopColorRaw) ?? "#000000";
      stops.push({ offset: Math.min(1, Math.max(0, offset)), color: stopColor });
    }
  }

  if (stops.length < 2) {
    if (stops.length === 1) stops.push({ offset: 1, color: stops[0]!.color });
    else stops.push({ offset: 0, color: "#FFFFFF" }, { offset: 1, color: "#000000" });
  }

  if (el.tag === "radialgradient") {
    return {
      type: "radial",
      stops,
      start: [0.5, 0.5],
      end: [1, 0.5],
      radius: [0.5, 0.5],
    };
  }

  return {
    type: "linear",
    stops,
    start: [0, 0],
    end: [1, 1],
  };
}

export function getPathBounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  let curX = 0;
  let curY = 0;

  const cmdRegex = /([a-df-z])|([+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/gi;
  let currentCmd = "M";
  const coords: number[] = [];

  let m: RegExpExecArray | null;
  while ((m = cmdRegex.exec(d)) !== null) {
    if (m[1]) {
      processCmd(currentCmd, coords);
      coords.length = 0;
      currentCmd = m[1];
    } else if (m[2]) {
      coords.push(parseFloat(m[2]));
    }
  }
  processCmd(currentCmd, coords);

  function updateBounds(x: number, y: number) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  function processCmd(cmd: string, nums: number[]) {
    const isRel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();

    if (c === "M" || c === "L" || c === "T") {
      for (let i = 0; i < nums.length - 1; i += 2) {
        curX = isRel ? curX + nums[i]! : nums[i]!;
        curY = isRel ? curY + nums[i + 1]! : nums[i + 1]!;
        updateBounds(curX, curY);
      }
    } else if (c === "H") {
      for (let i = 0; i < nums.length; i++) {
        curX = isRel ? curX + nums[i]! : nums[i]!;
        updateBounds(curX, curY);
      }
    } else if (c === "V") {
      for (let i = 0; i < nums.length; i++) {
        curY = isRel ? curY + nums[i]! : nums[i]!;
        updateBounds(curX, curY);
      }
    } else if (c === "C") {
      for (let i = 0; i < nums.length - 5; i += 6) {
        const x1 = isRel ? curX + nums[i]! : nums[i]!;
        const y1 = isRel ? curY + nums[i + 1]! : nums[i + 1]!;
        const x2 = isRel ? curX + nums[i + 2]! : nums[i + 2]!;
        const y2 = isRel ? curY + nums[i + 3]! : nums[i + 3]!;
        curX = isRel ? curX + nums[i + 4]! : nums[i + 4]!;
        curY = isRel ? curY + nums[i + 5]! : nums[i + 5]!;
        updateBounds(x1, y1);
        updateBounds(x2, y2);
        updateBounds(curX, curY);
      }
    } else if (c === "S" || c === "Q") {
      for (let i = 0; i < nums.length - 3; i += 4) {
        const x1 = isRel ? curX + nums[i]! : nums[i]!;
        const y1 = isRel ? curY + nums[i + 1]! : nums[i + 1]!;
        curX = isRel ? curX + nums[i + 2]! : nums[i + 2]!;
        curY = isRel ? curY + nums[i + 3]! : nums[i + 3]!;
        updateBounds(x1, y1);
        updateBounds(curX, curY);
      }
    } else if (c === "A") {
      for (let i = 0; i < nums.length - 6; i += 7) {
        curX = isRel ? curX + nums[i + 5]! : nums[i + 5]!;
        curY = isRel ? curY + nums[i + 6]! : nums[i + 6]!;
        updateBounds(curX, curY);
      }
    }
  }

  if (minX === Infinity) {
    return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  }

  return { minX, minY, maxX, maxY };
}

export function transformBox(m: Matrix6, minX: number, minY: number, maxX: number, maxY: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const p0 = applyMatrix(m, minX, minY);
  const p1 = applyMatrix(m, maxX, minY);
  const p2 = applyMatrix(m, maxX, maxY);
  const p3 = applyMatrix(m, minX, maxY);
  return {
    minX: Math.min(p0[0], p1[0], p2[0], p3[0]),
    minY: Math.min(p0[1], p1[1], p2[1], p3[1]),
    maxX: Math.max(p0[0], p1[0], p2[0], p3[0]),
    maxY: Math.max(p0[1], p1[1], p2[1], p3[1]),
  };
}

interface IntermediateNode {
  id: string;
  type: NodeType;
  name: string;
  globalMinX: number;
  globalMinY: number;
  globalMaxX: number;
  globalMaxY: number;
  radius?: number;
  fill?: string | null;
  stroke?: Stroke;
  gradient?: Gradient;
  opacity?: number;
  clip?: boolean;
  text?: any;
  path?: any;
  image?: any;
  clipPath?: any;
  children: IntermediateNode[];
}

/** Convertit un document SVG XML en arbre de nœuds Swiftma (Op[]). */
export function svgToOps(
  svgText: string,
  at: { x: number; y: number } = { x: 0, y: 0 },
  defaultName = "Maquette SVG",
): { ops: Op[]; rootId: string; stats: { nodes: number; width: number; height: number } } {
  const root = parseSvgXml(svgText);
  if (!root || root.tag !== "svg") {
    throw new Error("Contenu SVG invalide.");
  }

  // 1. Dimensions racine du canvas
  const vbMatch = (root.attrs.viewbox ?? "").trim().split(/[\s,]+/).map(Number);
  const vbWidth = vbMatch.length === 4 && vbMatch[2]! > 0 ? vbMatch[2]! : 0;
  const vbHeight = vbMatch.length === 4 && vbMatch[3]! > 0 ? vbMatch[3]! : 0;

  const rawWidth = parseFloat(root.attrs.width ?? root.style.width ?? "");
  const rawHeight = parseFloat(root.attrs.height ?? root.style.height ?? "");

  const width = Math.round(rawWidth || vbWidth || 1440);
  const height = Math.round(rawHeight || vbHeight || 900);

  // 2. Extraction des définitions (<defs>, gradients, images, patterns, clipPaths, masques)
  const defsGradients = new Map<string, Gradient>();
  const defsImages = new Map<string, { src: string; name?: string; width?: number; height?: number }>();
  const defsPatterns = new Map<string, { imageSrc: string; name?: string; width?: number; height?: number }>();
  const defsClipPaths = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; radius?: number }>();
  const defsElements = new Map<string, SvgElement>();

  function indexAllIds(el: SvgElement) {
    if (el.attrs.id) {
      defsElements.set(el.attrs.id, el);
    }
    for (const child of el.children) {
      indexAllIds(child);
    }
  }
  indexAllIds(root);

  function extractMaskOrClipBounds(
    containerEl: SvgElement,
    parentMatrix: Matrix6,
  ): { minX: number; minY: number; maxX: number; maxY: number; radius?: number } | undefined {
    const containerMatrix = multiplyMatrix(parentMatrix, parseTransform(containerEl.attrs.transform));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let detectedRadius: number | undefined;
    let shapeCount = 0;

    function visit(child: SvgElement, currentMatrix: Matrix6) {
      const m = multiplyMatrix(currentMatrix, parseTransform(child.attrs.transform));

      if (child.tag === "rect") {
        const x = parseFloat(child.attrs.x || child.style.x || "0") || 0;
        const y = parseFloat(child.attrs.y || child.style.y || "0") || 0;
        const w = parseFloat(child.attrs.width || child.style.width || "0") || 0;
        const h = parseFloat(child.attrs.height || child.style.height || "0") || 0;
        const rx = parseFloat(child.attrs.rx || child.style.rx || child.attrs.ry || child.style.ry || "0") || 0;
        if (w > 0 && h > 0) {
          const b = transformBox(m, x, y, x + w, y + h);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
          if (rx > 0 && detectedRadius === undefined) detectedRadius = rx;
          shapeCount++;
        }
      } else if (child.tag === "circle") {
        const cx = parseFloat(child.attrs.cx || child.style.cx || "0") || 0;
        const cy = parseFloat(child.attrs.cy || child.style.cy || "0") || 0;
        const r = parseFloat(child.attrs.r || child.style.r || "0") || 0;
        if (r > 0) {
          const b = transformBox(m, cx - r, cy - r, cx + r, cy + r);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
          if (detectedRadius === undefined) detectedRadius = r;
          shapeCount++;
        }
      } else if (child.tag === "ellipse") {
        const cx = parseFloat(child.attrs.cx || child.style.cx || "0") || 0;
        const cy = parseFloat(child.attrs.cy || child.style.cy || "0") || 0;
        const rx = parseFloat(child.attrs.rx || child.style.rx || "0") || 0;
        const ry = parseFloat(child.attrs.ry || child.style.ry || "0") || 0;
        if (rx > 0 && ry > 0) {
          const b = transformBox(m, cx - rx, cy - ry, cx + rx, cy + ry);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
          if (detectedRadius === undefined) detectedRadius = Math.min(rx, ry);
          shapeCount++;
        }
      } else if (child.tag === "path") {
        const d = child.attrs.d;
        if (d) {
          const pb = getPathBounds(d);
          if (pb.maxX > pb.minX && pb.maxY > pb.minY) {
            const b = transformBox(m, pb.minX, pb.minY, pb.maxX, pb.maxY);
            if (b.minX < minX) minX = b.minX;
            if (b.minY < minY) minY = b.minY;
            if (b.maxX > maxX) maxX = b.maxX;
            if (b.maxY > maxY) maxY = b.maxY;
            const w = b.maxX - b.minX;
            const h = b.maxY - b.minY;
            if (Math.abs(w - h) < 1 && detectedRadius === undefined) {
              detectedRadius = Math.round(w / 2);
            }
            shapeCount++;
          }
        }
      } else if (child.tag === "polygon" || child.tag === "polyline") {
        const pts = (child.attrs.points ?? "")
          .trim()
          .split(/[\s,]+/)
          .map(Number)
          .filter((n) => !isNaN(n));
        if (pts.length >= 4) {
          let px0 = pts[0]!, px1 = pts[0]!, py0 = pts[1]!, py1 = pts[1]!;
          for (let i = 0; i < pts.length - 1; i += 2) {
            if (pts[i]! < px0) px0 = pts[i]!;
            if (pts[i]! > px1) px1 = pts[i]!;
            if (pts[i + 1]! < py0) py0 = pts[i + 1]!;
            if (pts[i + 1]! > py1) py1 = pts[i + 1]!;
          }
          const b = transformBox(m, px0, py0, px1, py1);
          if (b.minX < minX) minX = b.minX;
          if (b.minY < minY) minY = b.minY;
          if (b.maxX > maxX) maxX = b.maxX;
          if (b.maxY > maxY) maxY = b.maxY;
          shapeCount++;
        }
      } else if (child.tag === "use") {
        const href = child.attrs.href ?? child.attrs["xlink:href"] ?? "";
        const targetId = href.startsWith("#") ? href.slice(1) : href;
        const target = defsElements.get(targetId);
        if (target) {
          visit(target, m);
        }
      } else if (child.tag === "g") {
        for (const grandChild of child.children) {
          visit(grandChild, m);
        }
      }
    }

    for (const child of containerEl.children) {
      visit(child, containerMatrix);
    }

    if (shapeCount === 0 || minX === Infinity) {
      const mx = parseFloat(containerEl.attrs.x || containerEl.style.x || "0") || 0;
      const my = parseFloat(containerEl.attrs.y || containerEl.style.y || "0") || 0;
      const mw = parseFloat(containerEl.attrs.width || containerEl.style.width || "0") || 0;
      const mh = parseFloat(containerEl.attrs.height || containerEl.style.height || "0") || 0;
      if (mw > 0 && mh > 0) {
        const b = transformBox(containerMatrix, mx, my, mx + mw, my + mh);
        return { ...b };
      }
      return undefined;
    }

    return { minX, minY, maxX, maxY, radius: detectedRadius };
  }

  function scanDefs(el: SvgElement) {
    if (el.tag === "lineargradient" || el.tag === "radialgradient") {
      const id = el.attrs.id;
      if (id) {
        const grad = parseGradientElement(el);
        if (grad) defsGradients.set(id, grad);
      }
    } else if (el.tag === "image") {
      const id = el.attrs.id;
      const src = el.attrs.href ?? el.attrs["xlink:href"];
      if (id && src) {
        const w = parseFloat(el.attrs.width || "0") || undefined;
        const h = parseFloat(el.attrs.height || "0") || undefined;
        defsImages.set(id, { src, name: el.attrs["data-name"] || id, width: w, height: h });
      }
    } else if (el.tag === "clippath" || el.tag === "mask") {
      const id = el.attrs.id;
      if (id) {
        const bounds = extractMaskOrClipBounds(el, IDENTITY_MATRIX);
        if (bounds) {
          defsClipPaths.set(id, bounds);
        }
      }
    }
    for (const child of el.children) {
      scanDefs(child);
    }
  }

  function scanPatterns(el: SvgElement) {
    if (el.tag === "pattern") {
      const id = el.attrs.id;
      if (id) {
        for (const child of el.children) {
          if (child.tag === "use") {
            const href = child.attrs.href ?? child.attrs["xlink:href"] ?? "";
            const targetId = href.startsWith("#") ? href.slice(1) : href;
            const img = defsImages.get(targetId);
            if (img) {
              defsPatterns.set(id, { imageSrc: img.src, name: img.name, width: img.width, height: img.height });
              break;
            }
          } else if (child.tag === "image") {
            const src = child.attrs.href ?? child.attrs["xlink:href"];
            if (src) {
              const w = parseFloat(child.attrs.width || "0") || undefined;
              const h = parseFloat(child.attrs.height || "0") || undefined;
              defsPatterns.set(id, { imageSrc: src, name: child.attrs["data-name"] || id, width: w, height: h });
              break;
            }
          }
        }
      }
    }
    for (const child of el.children) {
      scanPatterns(child);
    }
  }

  scanDefs(root);
  scanPatterns(root);

  // 3. Conversion récursive des éléments en nœuds intermédiaires
  function convertElement(el: SvgElement, parentMatrix: Matrix6): IntermediateNode | null {
    if (
      el.tag === "defs" ||
      el.tag === "style" ||
      el.tag === "clippath" ||
      el.tag === "mask" ||
      el.tag === "lineargradient" ||
      el.tag === "radialgradient" ||
      el.tag === "pattern" ||
      el.tag === "foreignobject"
    ) {
      return null;
    }

    const style = el.style;
    const attrs = el.attrs;
    const elMatrix = parseTransform(attrs.transform ?? style.transform);
    const absMatrix = multiplyMatrix(parentMatrix, elMatrix);

    const opacity = parseFloat(style.opacity ?? attrs.opacity ?? "1");
    const fillRaw = style.fill ?? attrs.fill;
    let fill: string | null = null;
    let gradient: Gradient | undefined;
    let patternImage: { imageSrc: string; name?: string } | undefined;

    if (fillRaw && fillRaw !== "none") {
      if (fillRaw.startsWith("url(#")) {
        const id = fillRaw.slice(5, -1);
        if (defsPatterns.has(id)) {
          patternImage = defsPatterns.get(id);
        } else if (defsGradients.has(id)) {
          gradient = defsGradients.get(id);
        }
      } else {
        fill = parseCssColor(fillRaw);
      }
    } else if (fillRaw === "none") {
      fill = null;
    } else if (el.tag !== "g" && el.tag !== "svg") {
      fill = "#000000";
    }

    let stroke: Stroke | undefined;
    const strokeRaw = style.stroke ?? attrs.stroke;
    if (strokeRaw && strokeRaw !== "none") {
      const strokeColor = parseCssColor(strokeRaw) ?? "#000000";
      const strokeWidth = parseFloat(style["stroke-width"] ?? attrs["stroke-width"] ?? "1") || 1;
      stroke = { color: strokeColor, width: strokeWidth };
    }

    const name = attrs.id || patternImage?.name || attrs["aria-label"] || el.tag;

    // Détection de clipPath ou mask explicite
    const clipRaw = attrs["clip-path"] ?? style["clip-path"] ?? attrs.mask ?? style.mask;
    let clipInfo: { minX: number; minY: number; maxX: number; maxY: number; radius?: number } | undefined;
    if (clipRaw) {
      const match = clipRaw.match(/url\(['"]?#([^'")]+)['"]?\)/);
      if (match && match[1]) {
        clipInfo = defsClipPaths.get(match[1]);
      }
    }

    if (el.tag === "g" || el.tag === "svg") {
      const childNodes: IntermediateNode[] = [];
      for (const child of el.children) {
        const c = convertElement(child, absMatrix);
        if (c) childNodes.push(c);
      }

      if (childNodes.length === 0 && !clipInfo) {
        return null;
      }

      let minX = clipInfo ? clipInfo.minX : Infinity;
      let minY = clipInfo ? clipInfo.minY : Infinity;
      let maxX = clipInfo ? clipInfo.maxX : -Infinity;
      let maxY = clipInfo ? clipInfo.maxY : -Infinity;

      if (!clipInfo) {
        for (const c of childNodes) {
          if (c.globalMinX < minX) minX = c.globalMinX;
          if (c.globalMinY < minY) minY = c.globalMinY;
          if (c.globalMaxX > maxX) maxX = c.globalMaxX;
          if (c.globalMaxY > maxY) maxY = c.globalMaxY;
        }
      }

      return {
        id: newId(),
        type: "frame",
        name: attrs.id || (el.tag === "g" ? "Groupe" : "Frame"),
        globalMinX: minX,
        globalMinY: minY,
        globalMaxX: maxX,
        globalMaxY: maxY,
        radius: clipInfo?.radius,
        fill: null,
        clip: clipInfo ? true : false,
        opacity: isNaN(opacity) ? 1 : opacity,
        children: childNodes,
      };
    }

    if (el.tag === "rect") {
      const x = parseFloat(attrs.x ?? style.x ?? "0") || 0;
      const y = parseFloat(attrs.y ?? style.y ?? "0") || 0;
      const w = parseFloat(attrs.width ?? style.width ?? "0") || 100;
      const h = parseFloat(attrs.height ?? style.height ?? "0") || 100;
      const rx = parseFloat(attrs.rx ?? style.rx ?? attrs.ry ?? style.ry ?? "0") || 0;

      const b = transformBox(absMatrix, x, y, x + w, y + h);

      if (patternImage) {
        return {
          id: newId(),
          type: "image",
          name,
          globalMinX: b.minX,
          globalMinY: b.minY,
          globalMaxX: b.maxX,
          globalMaxY: b.maxY,
          radius: Math.round(rx),
          image: { src: patternImage.imageSrc },
          opacity: isNaN(opacity) ? 1 : opacity,
          children: [],
        };
      }

      return {
        id: newId(),
        type: "rect",
        name,
        globalMinX: b.minX,
        globalMinY: b.minY,
        globalMaxX: b.maxX,
        globalMaxY: b.maxY,
        radius: Math.round(rx),
        fill,
        gradient,
        stroke,
        opacity: isNaN(opacity) ? 1 : opacity,
        children: [],
      };
    }

    if (el.tag === "circle") {
      const cx = parseFloat(attrs.cx ?? "0") || 0;
      const cy = parseFloat(attrs.cy ?? "0") || 0;
      const r = parseFloat(attrs.r ?? "0") || 10;
      const b = transformBox(absMatrix, cx - r, cy - r, cx + r, cy + r);

      if (patternImage) {
        return {
          id: newId(),
          type: "image",
          name,
          globalMinX: b.minX,
          globalMinY: b.minY,
          globalMaxX: b.maxX,
          globalMaxY: b.maxY,
          radius: Math.round((b.maxX - b.minX) / 2),
          image: { src: patternImage.imageSrc },
          opacity: isNaN(opacity) ? 1 : opacity,
          children: [],
        };
      }

      return {
        id: newId(),
        type: "ellipse",
        name,
        globalMinX: b.minX,
        globalMinY: b.minY,
        globalMaxX: b.maxX,
        globalMaxY: b.maxY,
        fill,
        gradient,
        stroke,
        opacity: isNaN(opacity) ? 1 : opacity,
        children: [],
      };
    }

    if (el.tag === "ellipse") {
      const cx = parseFloat(attrs.cx ?? "0") || 0;
      const cy = parseFloat(attrs.cy ?? "0") || 0;
      const rx = parseFloat(attrs.rx ?? "0") || 10;
      const ry = parseFloat(attrs.ry ?? "0") || 10;
      const b = transformBox(absMatrix, cx - rx, cy - ry, cx + rx, cy + ry);

      if (patternImage) {
        return {
          id: newId(),
          type: "image",
          name,
          globalMinX: b.minX,
          globalMinY: b.minY,
          globalMaxX: b.maxX,
          globalMaxY: b.maxY,
          radius: Math.round((b.maxX - b.minX) / 2),
          image: { src: patternImage.imageSrc },
          opacity: isNaN(opacity) ? 1 : opacity,
          children: [],
        };
      }

      return {
        id: newId(),
        type: "ellipse",
        name,
        globalMinX: b.minX,
        globalMinY: b.minY,
        globalMaxX: b.maxX,
        globalMaxY: b.maxY,
        fill,
        gradient,
        stroke,
        opacity: isNaN(opacity) ? 1 : opacity,
        children: [],
      };
    }

    if (el.tag === "path") {
      const d = attrs.d;
      if (!d) return null;
      const localBounds = getPathBounds(d);
      const b = transformBox(absMatrix, localBounds.minX, localBounds.minY, localBounds.maxX, localBounds.maxY);
      const pathMatrix = multiplyMatrix([1, 0, 0, 1, -b.minX, -b.minY], absMatrix);

      if (patternImage) {
        return {
          id: newId(),
          type: "image",
          name,
          globalMinX: b.minX,
          globalMinY: b.minY,
          globalMaxX: b.maxX,
          globalMaxY: b.maxY,
          image: { src: patternImage.imageSrc },
          clipPath: {
            d,
            fillRule: (attrs["fill-rule"] ?? style["fill-rule"]) === "evenodd" ? "evenodd" : "nonzero",
            matrix: pathMatrix,
          },
          opacity: isNaN(opacity) ? 1 : opacity,
          children: [],
        };
      }

      return {
        id: newId(),
        type: "path",
        name,
        globalMinX: b.minX,
        globalMinY: b.minY,
        globalMaxX: b.maxX,
        globalMaxY: b.maxY,
        path: {
          d,
          fillRule: (attrs["fill-rule"] ?? style["fill-rule"]) === "evenodd" ? "evenodd" : "nonzero",
          matrix: pathMatrix,
        },
        fill,
        gradient,
        stroke,
        opacity: isNaN(opacity) ? 1 : opacity,
        children: [],
      };
    }

    if (el.tag === "line") {
      const x1 = parseFloat(attrs.x1 ?? "0") || 0;
      const y1 = parseFloat(attrs.y1 ?? "0") || 0;
      const x2 = parseFloat(attrs.x2 ?? "0") || 0;
      const y2 = parseFloat(attrs.y2 ?? "0") || 0;
      const d = `M ${x1} ${y1} L ${x2} ${y2}`;

      const b = transformBox(absMatrix, Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
      const pathMatrix = multiplyMatrix([1, 0, 0, 1, -b.minX, -b.minY], absMatrix);

      return {
        id: newId(),
        type: "path",
        name,
        globalMinX: b.minX,
        globalMinY: b.minY,
        globalMaxX: b.maxX,
        globalMaxY: b.maxY,
        path: {
          d,
          fillRule: "nonzero",
          matrix: pathMatrix,
        },
        fill: null,
        stroke: stroke ?? { color: "#000000", width: 1 },
        opacity: isNaN(opacity) ? 1 : opacity,
        children: [],
      };
    }

    if (el.tag === "polygon" || el.tag === "polyline") {
      const points = (attrs.points ?? "").trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));
      if (points.length >= 4) {
        let d = `M ${points[0]} ${points[1]}`;
        for (let i = 2; i < points.length - 1; i += 2) {
          d += ` L ${points[i]} ${points[i + 1]}`;
        }
        if (el.tag === "polygon") d += " Z";

        const localBounds = getPathBounds(d);
        const b = transformBox(absMatrix, localBounds.minX, localBounds.minY, localBounds.maxX, localBounds.maxY);
        const pathMatrix = multiplyMatrix([1, 0, 0, 1, -b.minX, -b.minY], absMatrix);

        return {
          id: newId(),
          type: "path",
          name,
          globalMinX: b.minX,
          globalMinY: b.minY,
          globalMaxX: b.maxX,
          globalMaxY: b.maxY,
          path: {
            d,
            fillRule: "nonzero",
            matrix: pathMatrix,
          },
          fill,
          stroke,
          opacity: isNaN(opacity) ? 1 : opacity,
          children: [],
        };
      }
    }

    if (el.tag === "image") {
      const src = attrs.href ?? attrs["xlink:href"];
      if (!src) return null;
      const x = parseFloat(attrs.x ?? "0") || 0;
      const y = parseFloat(attrs.y ?? "0") || 0;
      const w = parseFloat(attrs.width ?? "100") || 100;
      const h = parseFloat(attrs.height ?? "100") || 100;
      const b = transformBox(absMatrix, x, y, x + w, y + h);

      const imgNode: IntermediateNode = {
        id: newId(),
        type: "image",
        name,
        globalMinX: b.minX,
        globalMinY: b.minY,
        globalMaxX: b.maxX,
        globalMaxY: b.maxY,
        radius: clipInfo?.radius,
        image: { src },
        opacity: isNaN(opacity) ? 1 : opacity,
        children: [],
      };

      if (clipInfo) {
        return {
          id: newId(),
          type: "frame",
          name: name ? `${name} (Masque)` : "Masque",
          globalMinX: clipInfo.minX,
          globalMinY: clipInfo.minY,
          globalMaxX: clipInfo.maxX,
          globalMaxY: clipInfo.maxY,
          radius: clipInfo.radius,
          fill: null,
          clip: true,
          opacity: 1,
          children: [imgNode],
        };
      }

      return imgNode;
    }

    if (el.tag === "text") {
      let content = el.text ?? "";
      for (const child of el.children) {
        if (child.text) content += (content ? " " : "") + child.text;
      }
      if (!content.trim()) return null;

      const x = parseFloat(attrs.x ?? style.x ?? "0") || 0;
      const y = parseFloat(attrs.y ?? style.y ?? "0") || 0;
      const fontSize = parseFloat(style["font-size"] ?? attrs["font-size"] ?? "16") || 16;
      const fontFamily = style["font-family"] ?? attrs["font-family"] ?? "Inter";
      const fontWeight = parseInt(style["font-weight"] ?? attrs["font-weight"] ?? "400") || 400;

      const textWidth = Math.round(content.length * fontSize * 0.6);
      const textHeight = Math.round(fontSize * 1.3);

      const b = transformBox(absMatrix, x, y - fontSize, x + textWidth, y - fontSize + textHeight);

      return {
        id: newId(),
        type: "text",
        name: name || content.slice(0, 20),
        globalMinX: b.minX,
        globalMinY: b.minY,
        globalMaxX: b.maxX,
        globalMaxY: b.maxY,
        text: {
          content,
          fontSize,
          fontWeight,
          fontFamily,
          color: fill ?? "#000000",
        },
        opacity: isNaN(opacity) ? 1 : opacity,
        children: [],
      };
    }

    return null;
  }

  // 4. Conversion des enfants directs de <svg>
  const rootChildren: IntermediateNode[] = [];
  for (const child of root.children) {
    const c = convertElement(child, IDENTITY_MATRIX);
    if (c) rootChildren.push(c);
  }

  // 5. Nœud racine
  const rootNode = makeNode(
    "frame",
    {
      name: root.attrs.id || defaultName,
      x: at.x,
      y: at.y,
      width,
      height,
      fill: null,
      clip: true,
    },
    newId(),
  );

  rootNode.children = rootChildren.map((c) => c.id);
  const ops: Op[] = [{ kind: "create", node: rootNode }];

  // 6. Aplatissement bottom-up avec coordonnées relatives au parent
  function flatten(node: IntermediateNode, parentGlobalX: number, parentGlobalY: number, parentId: string) {
    const relX = Math.round(node.globalMinX - parentGlobalX);
    const relY = Math.round(node.globalMinY - parentGlobalY);
    const nodeWidth = Math.max(1, Math.round(node.globalMaxX - node.globalMinX));
    const nodeHeight = Math.max(1, Math.round(node.globalMaxY - node.globalMinY));

    const designNode = makeNode(
      node.type,
      {
        name: node.name,
        x: relX,
        y: relY,
        width: nodeWidth,
        height: nodeHeight,
        radius: node.radius,
        fill: node.fill,
        stroke: node.stroke,
        gradient: node.gradient,
        opacity: node.opacity,
        clip: node.clip,
        text: node.text,
        path: node.path,
        image: node.image,
        clipPath: node.clipPath,
      },
      node.id,
    );

    designNode.parentId = parentId;
    designNode.children = node.children.map((c) => c.id);
    ops.push({ kind: "create", node: designNode });

    for (const child of node.children) {
      flatten(child, node.globalMinX, node.globalMinY, node.id);
    }
  }

  for (const child of rootChildren) {
    flatten(child, 0, 0, rootNode.id);
  }

  return {
    ops,
    rootId: rootNode.id,
    stats: { nodes: ops.length, width, height },
  };
}
