// Parseur SVG vers calques éditables Swiftma (sans dépendance au DOM du navigateur).
// Convertit <svg>, <g>, <rect>, <circle>, <ellipse>, <path>, <text>, <image>, etc.
// en hiérarchie complète de nœuds Swiftma (Op[]).

import { makeNode, newId, type DesignNode, type Gradient, type Stroke } from "./model.js";
import type { Op } from "./ops.js";
import { parseCssColor } from "./h2dImport.js";

type Matrix6 = [number, number, number, number, number, number];

interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  children: SvgElement[];
  text?: string;
}

const IDENTITY_MATRIX: Matrix6 = [1, 0, 0, 1, 0, 0];

function multiplyMatrix(m1: Matrix6, m2: Matrix6): Matrix6 {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function parseTransform(str?: string): Matrix6 {
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
        // translate(cx, cy) * rotate(angle) * translate(-cx, -cy)
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

function parseStyleString(str?: string): Record<string, string> {
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

function unescapeXml(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Parse un document SVG XML en arbre AST léger. */
function parseSvgXml(xml: string): { root: SvgElement | null; defsGradients: Map<string, Gradient> } {
  // Nettoyage préliminaire
  let clean = xml.replace(/<!--[\s\S]*?-->/g, "");
  clean = clean.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  clean = clean.replace(/<\?xml[\s\S]*?\?>/gi, "");

  // Extraction des règles CSS <style>
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

  // Tokeniseur XML
  const tagRegex = /<(\/?)([a-zA-Z0-9_:-]+)((?:\s+[^"'>=\s]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

  const stack: SvgElement[] = [];
  let root: SvgElement | null = null;
  const defsGradients = new Map<string, Gradient>();

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

    // Fermeture de balise
    if (isClosing) {
      if (stack.length > 0) {
        const closed = stack.pop()!;
        // Détection gradient dans defs
        if (closed.tag === "lineargradient" || closed.tag === "radialgradient") {
          const id = closed.attrs.id;
          if (id) {
            const grad = parseGradientElement(closed);
            if (grad) defsGradients.set(id, grad);
          }
        }
      }
      continue;
    }

    // Ouverture de balise
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

    if (!isSelfClosing && tagName !== "rect" && tagName !== "circle" && tagName !== "ellipse" && tagName !== "path" && tagName !== "line" && tagName !== "polyline" && tagName !== "polygon" && tagName !== "image" && tagName !== "stop") {
      stack.push(el);
    } else if (tagName === "lineargradient" || tagName === "radialgradient") {
      stack.push(el);
    }
  }

  return { root, defsGradients };
}

function parseGradientElement(el: SvgElement): Gradient | null {
  const stops: { offset: number; color: string }[] = [];
  for (const child of el.children) {
    if (child.tag === "stop") {
      let offset = 0;
      const offStr = child.attrs.offset ?? child.style.offset ?? "0";
      if (offStr.endsWith("%")) offset = parseFloat(offStr) / 100;
      else offset = parseFloat(offStr) || 0;

      const stopColorRaw = child.attrs["stop-color"] ?? child.style["stop-color"] ?? child.style.color ?? "#000000";
      const stopColor = parseCssColor(stopColorRaw) ?? "#000000";
      const stopOpacity = parseFloat(child.attrs["stop-opacity"] ?? child.style["stop-opacity"] ?? "1");

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

/** Calcule la boîte englobante d'un chemin SVG (minX, minY, maxX, maxY). */
function getPathBounds(d: string): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  let curX = 0;
  let curY = 0;

  // Extraction de toutes les commandes et nombres
  const cmdRegex = /([a-df-z])|([+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/gi;
  let currentCmd = "M";
  const coords: number[] = [];

  let m: RegExpExecArray | null;
  while ((m = cmdRegex.exec(d)) !== null) {
    if (m[1]) {
      // Exécute la commande précédente avec ses coordonnées accumulées
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

interface ConvertedNode {
  node: DesignNode;
  children: ConvertedNode[];
}

/** Convertit récursivement les éléments SVG en arbre de nœuds Swiftma. */
export function svgToOps(
  svgText: string,
  at: { x: number; y: number } = { x: 0, y: 0 },
  defaultName = "Maquette SVG",
): { ops: Op[]; rootId: string; stats: { nodes: number; width: number; height: number } } {
  const { root, defsGradients } = parseSvgXml(svgText);
  if (!root || root.tag !== "svg") {
    throw new Error("Contenu SVG invalide.");
  }

  // 1. Dimensions racine
  const vbMatch = (root.attrs.viewbox ?? "").trim().split(/[\s,]+/).map(Number);
  const vbWidth = vbMatch.length === 4 && vbMatch[2]! > 0 ? vbMatch[2]! : 0;
  const vbHeight = vbMatch.length === 4 && vbMatch[3]! > 0 ? vbMatch[3]! : 0;

  const rawWidth = parseFloat(root.attrs.width ?? root.style.width ?? "");
  const rawHeight = parseFloat(root.attrs.height ?? root.style.height ?? "");

  const width = Math.round(rawWidth || vbWidth || 1440);
  const height = Math.round(rawHeight || vbHeight || 900);

  // 2. Nœud racine de la page
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

  const ops: Op[] = [{ kind: "create", node: rootNode }];
  let totalNodes = 1;

  // 3. Parcours récursif des enfants
  function processChildren(elements: SvgElement[], parentId: string, parentMatrix: Matrix6, parentX: number, parentY: number) {
    for (const el of elements) {
      if (el.tag === "defs" || el.tag === "style" || el.tag === "clippath" || el.tag === "mask" || el.tag === "lineargradient" || el.tag === "radialgradient") {
        continue;
      }

      const style = el.style;
      const attrs = el.attrs;

      // Calcul transform
      const elMatrix = parseTransform(attrs.transform ?? style.transform);
      const absMatrix = multiplyMatrix(parentMatrix, elMatrix);

      // Styles communs
      const opacity = parseFloat(style.opacity ?? attrs.opacity ?? "1");
      const fillRaw = style.fill ?? attrs.fill;
      let fill: string | null = null;
      let gradient: Gradient | undefined;

      if (fillRaw && fillRaw !== "none") {
        if (fillRaw.startsWith("url(#")) {
          const id = fillRaw.slice(5, -1);
          gradient = defsGradients.get(id);
        } else {
          fill = parseCssColor(fillRaw);
        }
      } else if (fillRaw === "none") {
        fill = null;
      } else if (el.tag !== "g" && el.tag !== "svg") {
        fill = "#000000"; // Défaut SVG
      }

      // Stroke
      let stroke: Stroke | undefined;
      const strokeRaw = style.stroke ?? attrs.stroke;
      if (strokeRaw && strokeRaw !== "none") {
        const strokeColor = parseCssColor(strokeRaw) ?? "#000000";
        const strokeWidth = parseFloat(style["stroke-width"] ?? attrs["stroke-width"] ?? "1") || 1;
        stroke = { color: strokeColor, width: strokeWidth };
      }

      const name = attrs.id || attrs["aria-label"] || el.tag;

      // Type de nœud
      if (el.tag === "g" || el.tag === "svg") {
        // Groupe → Frame transparente
        const groupNode = makeNode(
          "frame",
          {
            name: attrs.id || (el.tag === "g" ? "Groupe" : "Frame"),
            x: Math.round(absMatrix[4] - parentX),
            y: Math.round(absMatrix[5] - parentY),
            width: 0,
            height: 0,
            fill: null,
            clip: false,
            opacity: isNaN(opacity) ? 1 : opacity,
          },
          newId(),
        );
        groupNode.parentId = parentId;
        ops.push({ kind: "create", node: groupNode });
        totalNodes++;

        // Les enfants du groupe sont dans le repère du groupe
        processChildren(el.children, groupNode.id, IDENTITY_MATRIX, 0, 0);
        continue;
      }

      if (el.tag === "rect") {
        const x = parseFloat(attrs.x ?? style.x ?? "0") || 0;
        const y = parseFloat(attrs.y ?? style.y ?? "0") || 0;
        const w = parseFloat(attrs.width ?? style.width ?? "0") || 100;
        const h = parseFloat(attrs.height ?? style.height ?? "0") || 100;
        const rx = parseFloat(attrs.rx ?? style.rx ?? attrs.ry ?? style.ry ?? "0") || 0;

        const rectNode = makeNode(
          "rect",
          {
            name,
            x: Math.round(x + absMatrix[4] - parentX),
            y: Math.round(y + absMatrix[5] - parentY),
            width: Math.round(w),
            height: Math.round(h),
            radius: Math.round(rx),
            fill,
            gradient,
            stroke,
            opacity: isNaN(opacity) ? 1 : opacity,
          },
          newId(),
        );
        rectNode.parentId = parentId;
        ops.push({ kind: "create", node: rectNode });
        totalNodes++;
        continue;
      }

      if (el.tag === "circle") {
        const cx = parseFloat(attrs.cx ?? "0") || 0;
        const cy = parseFloat(attrs.cy ?? "0") || 0;
        const r = parseFloat(attrs.r ?? "0") || 10;

        const circleNode = makeNode(
          "ellipse",
          {
            name,
            x: Math.round(cx - r + absMatrix[4] - parentX),
            y: Math.round(cy - r + absMatrix[5] - parentY),
            width: Math.round(2 * r),
            height: Math.round(2 * r),
            fill,
            gradient,
            stroke,
            opacity: isNaN(opacity) ? 1 : opacity,
          },
          newId(),
        );
        circleNode.parentId = parentId;
        ops.push({ kind: "create", node: circleNode });
        totalNodes++;
        continue;
      }

      if (el.tag === "ellipse") {
        const cx = parseFloat(attrs.cx ?? "0") || 0;
        const cy = parseFloat(attrs.cy ?? "0") || 0;
        const rx = parseFloat(attrs.rx ?? "0") || 10;
        const ry = parseFloat(attrs.ry ?? "0") || 10;

        const ellipseNode = makeNode(
          "ellipse",
          {
            name,
            x: Math.round(cx - rx + absMatrix[4] - parentX),
            y: Math.round(cy - ry + absMatrix[5] - parentY),
            width: Math.round(2 * rx),
            height: Math.round(2 * ry),
            fill,
            gradient,
            stroke,
            opacity: isNaN(opacity) ? 1 : opacity,
          },
          newId(),
        );
        ellipseNode.parentId = parentId;
        ops.push({ kind: "create", node: ellipseNode });
        totalNodes++;
        continue;
      }

      if (el.tag === "path") {
        const d = attrs.d;
        if (!d) continue;

        const bounds = getPathBounds(d);
        const w = Math.max(1, Math.round(bounds.maxX - bounds.minX));
        const h = Math.max(1, Math.round(bounds.maxY - bounds.minY));

        const nodeX = Math.round(bounds.minX + absMatrix[4] - parentX);
        const nodeY = Math.round(bounds.minY + absMatrix[5] - parentY);

        const pathNode = makeNode(
          "path",
          {
            name,
            x: nodeX,
            y: nodeY,
            width: w,
            height: h,
            path: {
              d,
              fillRule: (attrs["fill-rule"] ?? style["fill-rule"]) === "evenodd" ? "evenodd" : "nonzero",
              matrix: [1, 0, 0, 1, -bounds.minX, -bounds.minY],
            },
            fill,
            gradient,
            stroke,
            opacity: isNaN(opacity) ? 1 : opacity,
          },
          newId(),
        );
        pathNode.parentId = parentId;
        ops.push({ kind: "create", node: pathNode });
        totalNodes++;
        continue;
      }

      if (el.tag === "line") {
        const x1 = parseFloat(attrs.x1 ?? "0") || 0;
        const y1 = parseFloat(attrs.y1 ?? "0") || 0;
        const x2 = parseFloat(attrs.x2 ?? "0") || 0;
        const y2 = parseFloat(attrs.y2 ?? "0") || 0;
        const d = `M ${x1} ${y1} L ${x2} ${y2}`;

        const minX = Math.min(x1, x2);
        const minY = Math.min(y1, y2);
        const w = Math.max(1, Math.round(Math.abs(x2 - x1)));
        const h = Math.max(1, Math.round(Math.abs(y2 - y1)));

        const lineNode = makeNode(
          "path",
          {
            name,
            x: Math.round(minX + absMatrix[4] - parentX),
            y: Math.round(minY + absMatrix[5] - parentY),
            width: w,
            height: h,
            path: {
              d,
              fillRule: "nonzero",
              matrix: [1, 0, 0, 1, -minX, -minY],
            },
            fill: null,
            stroke: stroke ?? { color: "#000000", width: 1 },
            opacity: isNaN(opacity) ? 1 : opacity,
          },
          newId(),
        );
        lineNode.parentId = parentId;
        ops.push({ kind: "create", node: lineNode });
        totalNodes++;
        continue;
      }

      if (el.tag === "polygon" || el.tag === "polyline") {
        const points = (attrs.points ?? "").trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));
        if (points.length >= 4) {
          let d = `M ${points[0]} ${points[1]}`;
          for (let i = 2; i < points.length - 1; i += 2) {
            d += ` L ${points[i]} ${points[i + 1]}`;
          }
          if (el.tag === "polygon") d += " Z";

          const bounds = getPathBounds(d);
          const w = Math.max(1, Math.round(bounds.maxX - bounds.minX));
          const h = Math.max(1, Math.round(bounds.maxY - bounds.minY));

          const polyNode = makeNode(
            "path",
            {
              name,
              x: Math.round(bounds.minX + absMatrix[4] - parentX),
              y: Math.round(bounds.minY + absMatrix[5] - parentY),
              width: w,
              height: h,
              path: {
                d,
                fillRule: "nonzero",
                matrix: [1, 0, 0, 1, -bounds.minX, -bounds.minY],
              },
              fill,
              stroke,
              opacity: isNaN(opacity) ? 1 : opacity,
            },
            newId(),
          );
          polyNode.parentId = parentId;
          ops.push({ kind: "create", node: polyNode });
          totalNodes++;
          continue;
        }
      }

      if (el.tag === "text") {
        let content = el.text ?? "";
        for (const child of el.children) {
          if (child.text) content += (content ? " " : "") + child.text;
        }
        if (!content.trim()) continue;

        const x = parseFloat(attrs.x ?? style.x ?? "0") || 0;
        const y = parseFloat(attrs.y ?? style.y ?? "0") || 0;
        const fontSize = parseFloat(style["font-size"] ?? attrs["font-size"] ?? "16") || 16;
        const fontFamily = style["font-family"] ?? attrs["font-family"] ?? "Inter";
        const fontWeight = parseInt(style["font-weight"] ?? attrs["font-weight"] ?? "400") || 400;

        const textWidth = Math.round(content.length * fontSize * 0.6);
        const textHeight = Math.round(fontSize * 1.3);

        const textNode = makeNode(
          "text",
          {
            name: name || content.slice(0, 20),
            x: Math.round(x + absMatrix[4] - parentX),
            y: Math.round(y - fontSize + absMatrix[5] - parentY),
            width: textWidth,
            height: textHeight,
            text: {
              content,
              fontSize,
              fontWeight,
              fontFamily,
              color: fill ?? "#000000",
            },
            opacity: isNaN(opacity) ? 1 : opacity,
          },
          newId(),
        );
        textNode.parentId = parentId;
        ops.push({ kind: "create", node: textNode });
        totalNodes++;
        continue;
      }

      if (el.tag === "image") {
        const src = attrs.href ?? attrs["xlink:href"];
        if (!src) continue;

        const x = parseFloat(attrs.x ?? "0") || 0;
        const y = parseFloat(attrs.y ?? "0") || 0;
        const w = parseFloat(attrs.width ?? "100") || 100;
        const h = parseFloat(attrs.height ?? "100") || 100;

        const imgNode = makeNode(
          "image",
          {
            name,
            x: Math.round(x + absMatrix[4] - parentX),
            y: Math.round(y + absMatrix[5] - parentY),
            width: Math.round(w),
            height: Math.round(h),
            image: { src },
            opacity: isNaN(opacity) ? 1 : opacity,
          },
          newId(),
        );
        imgNode.parentId = parentId;
        ops.push({ kind: "create", node: imgNode });
        totalNodes++;
        continue;
      }
    }
  }

  processChildren(root.children, rootNode.id, IDENTITY_MATRIX, 0, 0);

  return {
    ops,
    rootId: rootNode.id,
    stats: { nodes: totalNodes, width, height },
  };
}
