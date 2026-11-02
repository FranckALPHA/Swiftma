import { inflateSync, strFromU8, unzipSync } from "fflate";
import type { Shadow } from "@swiftma/core";
import { htmlSnapshotToOps, type HtmlImportResult, type HtmlNode, type HtmlSnapshot } from "./htmlImport";

/**
 * Décode un tampon d'octets .h2d (provenant de html.to.design / divRIOTS).
 * Le format .h2d est composé d'un JSON compressé en Deflate Raw
 * et obfusqué avec un masque XOR 57 (1337 & 0xFF).
 */
export function decodeH2D(bytes: Uint8Array): any {
  // 1. Dé-masquage XOR
  const unxored = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    unxored[i] = bytes[i]! ^ 57;
  }

  // 2. Décompression Deflate Raw
  const decompressed = inflateSync(unxored);

  // 3. Parser JSON
  const jsonStr = strFromU8(decompressed);
  return JSON.parse(jsonStr);
}

/**
 * Vérifie si un tampon commence par la signature .h2d ou est un fichier .h2d.
 */
export function isH2DBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  try {
    const unxored = new Uint8Array(Math.min(bytes.length, 256));
    for (let i = 0; i < unxored.length; i++) {
      unxored[i] = bytes[i]! ^ 57;
    }
    // Teste si les premiers octets se décompressent
    inflateSync(unxored);
    return true;
  } catch {
    // Si la décompression des premiers octets n'a pas suffi, teste le fichier entier si petit
    if (bytes.length <= 1024 * 1024) {
      try {
        decodeH2D(bytes);
        return true;
      } catch {}
    }
    return false;
  }
}

/**
 * Vérifie si un tampon est une archive .make (archive ZIP contenant meta.json ou canvas.fig).
 */
export function isMakeArchive(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  // Signature ZIP : PK\x03\x04
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return false;
  // Pour les petits tampons de test ou signatures tronquées
  if (bytes.length < 64) return true;
  // Détecte la présence de meta.json ou canvas.fig dans l'en-tête de l'archive
  const headerSlice = strFromU8(bytes.subarray(0, Math.min(bytes.length, 2048)));
  if (headerSlice.includes("meta.json") || headerSlice.includes("canvas.fig")) {
    return true;
  }
  // Si le tampon est complet, tente un unzip
  try {
    const unzipped = unzipSync(bytes);
    return Boolean(unzipped["canvas.fig"] || unzipped["meta.json"]);
  } catch {
    return false;
  }
}

/**
 * Décode une archive .make (Figma Make de html.to.design).
 */
export function decodeMakeArchive(bytes: Uint8Array): { meta?: any; thumbnail?: Uint8Array; fig?: Uint8Array } {
  const unzipped = unzipSync(bytes);
  let meta: any = undefined;
  if (unzipped["meta.json"]) {
    try {
      meta = JSON.parse(strFromU8(unzipped["meta.json"]!));
    } catch {}
  }
  return {
    meta,
    thumbnail: unzipped["thumbnail.png"],
    fig: unzipped["canvas.fig"],
  };
}

/**
 * Extrait le composant React JSX et les métadonnées d'une archive .make.
 */
export function extractMakeComponent(bytes: Uint8Array): { meta: any; jsx: string } {
  const unzipped = unzipSync(bytes);
  let meta: any = {};
  if (unzipped["meta.json"]) {
    try {
      meta = JSON.parse(strFromU8(unzipped["meta.json"]!));
    } catch {}
  }

  const figBytes = unzipped["canvas.fig"];
  if (!figBytes || figBytes.length < 16) {
    throw new Error("Fichier canvas.fig manquant ou corrompu dans l'archive .make.");
  }

  const view = new DataView(figBytes.buffer, figBytes.byteOffset, figBytes.byteLength);
  const schemaLen = view.getUint32(12, true);
  const dataOffset = 16 + schemaLen;
  if (dataOffset + 4 > figBytes.length) {
    throw new Error("Flux de données invalide dans canvas.fig.");
  }

  const dataLen = view.getUint32(dataOffset, true);
  const dataBytes = figBytes.subarray(dataOffset + 4, dataOffset + 4 + dataLen);
  const decompressedData = inflateSync(dataBytes);
  const text = strFromU8(decompressedData);

  const returnIdx = text.indexOf("return (");
  if (returnIdx === -1) {
    throw new Error("Instruction return JSX introuvable dans le composant .make.");
  }

  let depth = 0;
  let endIdx = -1;
  for (let i = returnIdx + 6; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) {
    throw new Error("Fin de bloc JSX introuvable dans le composant .make.");
  }

  const jsx = text.slice(returnIdx + 8, endIdx).trim();
  return { meta, jsx };
}

const TAILWIND_COLORS: Record<string, string> = {
  white: "#FFFFFF",
  black: "#000000",
  transparent: "transparent",
  "slate-50": "#F8FAFC", "slate-100": "#F1F5F9", "slate-200": "#E2E8F0", "slate-300": "#CBD5E1",
  "slate-400": "#94A3B8", "slate-500": "#64748B", "slate-600": "#475569", "slate-700": "#334155",
  "slate-800": "#1E293B", "slate-900": "#0F172A", "slate-950": "#020617",
  "gray-50": "#F9FAFB", "gray-100": "#F3F4F6", "gray-200": "#E5E7EB", "gray-300": "#D1D5DB",
  "gray-400": "#9CA3AF", "gray-500": "#6B7280", "gray-600": "#4B5563", "gray-700": "#374151",
  "gray-800": "#1F2937", "gray-900": "#111827", "gray-950": "#030712",
  "zinc-50": "#FAFAFA", "zinc-100": "#F4F4F5", "zinc-200": "#E4E4E7", "zinc-300": "#D4D4D8",
  "zinc-400": "#A1A1AA", "zinc-500": "#71717A", "zinc-600": "#52525B", "zinc-700": "#3F3F46",
  "zinc-800": "#27272A", "zinc-900": "#18181B", "zinc-950": "#09090B",
  "neutral-50": "#FAFAFA", "neutral-100": "#F5F5F5", "neutral-200": "#E5E5E5", "neutral-300": "#D4D4D4",
  "neutral-400": "#A3A3A3", "neutral-500": "#737373", "neutral-600": "#525252", "neutral-700": "#404040",
  "neutral-800": "#262626", "neutral-900": "#171717", "neutral-950": "#0A0A0A",
  "blue-500": "#3B82F6", "blue-600": "#2563EB", "blue-700": "#1D4ED8",
  "indigo-500": "#6366F1", "indigo-600": "#4F46E5",
  "purple-500": "#A855F7", "purple-600": "#9333EA",
};

function parseTailwindArbitraryColor(str: string): string | null {
  const cleaned = str.replace(/_/g, " ").trim();
  if (/^#([0-9a-fA-F]{3,8})$/.test(cleaned)) {
    return cleaned.toUpperCase();
  }
  const rgbMatch = /rgba?\(([^)]+)\)/i.exec(cleaned);
  if (rgbMatch && rgbMatch[1]) {
    const parts = rgbMatch[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
      const r = Math.max(0, Math.min(255, parseInt(parts[0], 10)));
      const g = Math.max(0, Math.min(255, parseInt(parts[1], 10)));
      const b = Math.max(0, Math.min(255, parseInt(parts[2], 10)));
      const toHex = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();
      let hex = "#" + toHex(r) + toHex(g) + toHex(b);
      if (parts[3] !== undefined) {
        const a = parseFloat(parts[3]);
        if (!isNaN(a) && a < 0.999) {
          hex += toHex(Math.round(Math.max(0, Math.min(1, a)) * 255));
        }
      }
      return hex;
    }
  }
  return null;
}

function parseTailwindColor(cls: string, style: any, prop: "bg" | "text" | "border"): string | null {
  if (prop === "bg" && style?.backgroundColor && /^#([0-9a-fA-F]{3,8})$/.test(style.backgroundColor)) {
    return style.backgroundColor;
  }
  if (prop === "text" && style?.color && /^#([0-9a-fA-F]{3,8})$/.test(style.color)) {
    return style.color;
  }
  if (!cls) return null;

  const arbRegex = new RegExp(`(?:^|\\s)${prop}-\\[([^\\]]+)\\]`, "i");
  const arb = arbRegex.exec(cls);
  if (arb && arb[1]) {
    const c = parseTailwindArbitraryColor(arb[1]);
    if (c) return c;
  }

  const slashRegex = new RegExp(`(?:^|\\s)${prop}-([a-zA-Z0-9_-]+)/([0-9.]+)`, "i");
  const slash = slashRegex.exec(cls);
  if (slash && slash[1] && slash[2]) {
    const baseColor = TAILWIND_COLORS[slash[1]];
    if (baseColor && baseColor.startsWith("#")) {
      const pct = parseFloat(slash[2]);
      if (!isNaN(pct)) {
        const alpha = Math.max(0, Math.min(255, Math.round((pct / 100) * 255)));
        return baseColor.slice(0, 7) + alpha.toString(16).padStart(2, "0").toUpperCase();
      }
    }
  }

  const namedRegex = new RegExp(`(?:^|\\s)${prop}-([a-zA-Z0-9_-]+)(?:\\s|$)`, "i");
  const named = namedRegex.exec(cls);
  if (named && named[1]) {
    const c = TAILWIND_COLORS[named[1]];
    if (c === "transparent") return null;
    if (c) return c;
  }

  return null;
}

function parseSpacing(cls: string, prefix: string): number {
  const re = new RegExp(`(?:^|\\s)${prefix}-\\[(?:normal_)?([0-9.]+)px\\]`, "i");
  const m = re.exec(cls);
  if (m && m[1]) return parseFloat(m[1]);
  const num = new RegExp(`(?:^|\\s)${prefix}-([0-9.]+)(?:\\s|$)`, "i").exec(cls);
  if (num && num[1]) return parseFloat(num[1]) * 4;
  return 0;
}

function parseRadius(cls: string, style: any): number {
  if (style?.borderRadius) {
    const n = parseFloat(style.borderRadius);
    if (!isNaN(n) && n >= 0) return n;
  }
  const m = /(?:^|\s)rounded-\[([0-9.]+)px\]/i.exec(cls);
  if (m && m[1]) return parseFloat(m[1]);
  if (cls.includes("rounded-full")) return 9999;
  if (cls.includes("rounded-3xl")) return 24;
  if (cls.includes("rounded-2xl")) return 16;
  if (cls.includes("rounded-xl")) return 12;
  if (cls.includes("rounded-lg")) return 8;
  if (cls.includes("rounded-md")) return 6;
  if (cls.includes("rounded-sm")) return 2;
  if (cls.includes("rounded")) return 4;
  return 0;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
}

function parseJsxToTree(jsxStr: string): any {
  let idx = 0;
  function skip() {
    while (idx < jsxStr.length && /\s/.test(jsxStr[idx]!)) idx++;
  }

  function parseNode(): any {
    skip();
    if (idx >= jsxStr.length) return null;

    if (jsxStr.startsWith("<!--", idx)) {
      const end = jsxStr.indexOf("-->", idx);
      idx = end === -1 ? jsxStr.length : end + 3;
      return null;
    }
    if (jsxStr.startsWith("{/*", idx)) {
      const end = jsxStr.indexOf("*/}", idx);
      idx = end === -1 ? jsxStr.length : end + 3;
      return null;
    }
    if (jsxStr.startsWith("{\" \"}", idx) || jsxStr.startsWith("{' '}", idx)) {
      idx += 5;
      return { type: "text", text: " " };
    }

    if (jsxStr[idx] !== "<") {
      const s = idx;
      while (idx < jsxStr.length && jsxStr[idx] !== "<") idx++;
      const t = decodeHtmlEntities(jsxStr.slice(s, idx)).trim();
      return t ? { type: "text", text: t } : null;
    }

    if (jsxStr[idx + 1] === "/") return null;
    idx++;

    let tag = "";
    while (idx < jsxStr.length && /[a-zA-Z0-9_:-]/.test(jsxStr[idx]!)) {
      tag += jsxStr[idx++]!;
    }

    const attrs: Record<string, any> = {};
    let className = "";
    let style: any = {};

    while (idx < jsxStr.length && jsxStr[idx] !== ">" && !(jsxStr[idx] === "/" && jsxStr[idx + 1] === ">")) {
      skip();
      if (jsxStr[idx] === ">" || (jsxStr[idx] === "/" && jsxStr[idx + 1] === ">")) break;

      let attrName = "";
      while (idx < jsxStr.length && /[a-zA-Z0-9_:-]/.test(jsxStr[idx]!)) {
        attrName += jsxStr[idx++]!;
      }

      skip();
      if (jsxStr[idx] === "=") {
        idx++;
        skip();
        if (jsxStr[idx] === "\"") {
          idx++;
          const s = idx;
          while (idx < jsxStr.length && jsxStr[idx] !== "\"") {
            if (jsxStr[idx] === "\\") idx++;
            idx++;
          }
          const val = decodeHtmlEntities(jsxStr.slice(s, idx));
          if (jsxStr[idx] === "\"") idx++;
          attrs[attrName] = val;
          if (attrName === "className" || attrName === "class") className = val;
        } else if (jsxStr[idx] === "'") {
          idx++;
          const s = idx;
          while (idx < jsxStr.length && jsxStr[idx] !== "'") {
            if (jsxStr[idx] === "\\") idx++;
            idx++;
          }
          const val = decodeHtmlEntities(jsxStr.slice(s, idx));
          if (jsxStr[idx] === "'") idx++;
          attrs[attrName] = val;
          if (attrName === "className" || attrName === "class") className = val;
        } else if (jsxStr.startsWith("{{", idx)) {
          idx += 2;
          let d = 1;
          const s = idx;
          while (idx < jsxStr.length && d > 0) {
            if (jsxStr.startsWith("}}", idx)) {
              d--;
              if (d === 0) break;
            } else if (jsxStr.startsWith("{{", idx)) {
              d++;
            }
            idx++;
          }
          const jText = "{" + jsxStr.slice(s, idx) + "}";
          idx += 2;
          try {
            style = JSON.parse(jText);
          } catch {}
          attrs[attrName] = style;
        } else if (jsxStr[idx] === "{") {
          idx++;
          let d = 1;
          const s = idx;
          while (idx < jsxStr.length && d > 0) {
            if (jsxStr[idx] === "}") {
              d--;
              if (d === 0) break;
            } else if (jsxStr[idx] === "{") {
              d++;
            }
            idx++;
          }
          const expr = jsxStr.slice(s, idx).trim();
          idx++;
          attrs[attrName] = expr.replace(/^["']|["']$/g, "");
          if (attrName === "className" || attrName === "class") className = attrs[attrName];
        }
      } else {
        attrs[attrName] = true;
      }
    }

    const self = jsxStr[idx] === "/" && jsxStr[idx + 1] === ">";
    if (self) idx += 2;
    else if (jsxStr[idx] === ">") idx++;

    const children: any[] = [];
    if (!self && !["img", "input", "br", "hr"].includes(tag.toLowerCase())) {
      const closeTag = "</" + tag + ">";
      while (idx < jsxStr.length) {
        skip();
        if (jsxStr.startsWith(closeTag, idx)) {
          idx += closeTag.length;
          break;
        }
        if (jsxStr.startsWith("</", idx)) break;
        const ch = parseNode();
        if (ch) children.push(ch);
      }
    }
    return { type: "element", tag, className, attrs, style, children };
  }

  return parseNode();
}

function astToHtmlNode(
  ast: any,
  inherited: { color: string; font: string; size: number; weight: number; align: "left" | "center" | "right" } = {
    color: "#FFFFFF",
    font: "Inter",
    size: 16,
    weight: 400,
    align: "left",
  }
): HtmlNode | null {
  if (!ast) return null;

  if (ast.type === "text") {
    const text = String(ast.text || "").trim();
    if (!text) return null;
    const fontSize = inherited.size;
    return {
      type: "text",
      name: `[texte]${text.slice(0, 30)}`,
      x: 0,
      y: 0,
      width: Math.max(12, Math.round(text.length * (fontSize * 0.55))),
      height: Math.max(16, Math.round(fontSize * 1.4)),
      fill: null,
      radius: 0,
      opacity: 1,
      clip: false,
      text: {
        content: text,
        color: inherited.color,
        fontSize,
        fontFamily: inherited.font,
        fontWeight: inherited.weight,
        align: inherited.align || "left",
        lineHeight: 1.4,
      },
      children: [],
    };
  }

  const { tag, className: cls = "", style = {}, attrs = {} } = ast;
  const textColor = parseTailwindColor(cls, style, "text") || inherited.color;
  const fontSizeMatch = /(?:^|\s)text-\[([0-9.]+)px\]/i.exec(cls);
  const fontSize = fontSizeMatch && fontSizeMatch[1] ? parseFloat(fontSizeMatch[1]) : inherited.size || 16;
  const fontWeight = cls.includes("font-bold")
    ? 700
    : cls.includes("font-semibold")
    ? 600
    : cls.includes("font-medium")
    ? 500
    : inherited.weight || 400;
  const fontFamily = style?.fontFamily
    ? (String(style.fontFamily).split(",")[0] || "").replace(/["']/g, "").trim() || inherited.font
    : inherited.font;
  const align = cls.includes("text-center") ? "center" : cls.includes("text-right") ? "right" : inherited.align || "left";

  const nextInherited = {
    color: textColor,
    size: fontSize,
    weight: fontWeight,
    font: fontFamily,
    align,
  };

  let width = 0;
  let height = 0;
  if (style.width && !String(style.width).includes("%")) width = parseFloat(style.width) || 0;
  if (style.height && !String(style.height).includes("%")) height = parseFloat(style.height) || 0;
  const wMatch = /(?:^|\s)w-\[([0-9.]+)px\]/i.exec(cls);
  if (wMatch && wMatch[1]) width = parseFloat(wMatch[1]);
  const hMatch = /(?:^|\s)h-\[([0-9.]+)px\]/i.exec(cls);
  if (hMatch && hMatch[1]) height = parseFloat(hMatch[1]);
  const sizeMatch = /(?:^|\s)size-\[([0-9.]+)px\]/i.exec(cls);
  if (sizeMatch && sizeMatch[1]) {
    width = parseFloat(sizeMatch[1]);
    height = parseFloat(sizeMatch[1]);
  }

  const radius = parseRadius(cls, style);

  let prefix = "";
  if (tag === "button" || attrs.role === "button") prefix = "[bouton]";
  else if (tag === "a" || attrs.href) prefix = "[lien]";
  else if (/^h[1-6]$/.test(tag)) prefix = "[titre]";
  else if (tag === "header") prefix = "[header]";
  else if (tag === "nav") prefix = "[nav]";
  else if (tag === "footer") prefix = "[footer]";
  else if (tag === "main") prefix = "[main]";
  else if (tag === "section") prefix = "[section]";
  else if (tag === "pseudo") prefix = "[effet]";

  const firstClass = cls
    .split(/\s+/)
    .filter((c: string) => !c.includes("[") && !c.includes("/") && c.length < 25)
    .slice(0, 2)
    .join(".");
  const name = `${prefix}${tag}${firstClass ? "." + firstClass : ""}`;

  if (tag === "img") {
    const src = attrs.src || attrs.srcSet?.split(/[\s,]+/)[0] || "";
    return {
      type: "image",
      name: `[image]${name}`,
      x: 0,
      y: 0,
      width: Math.max(16, width || 48),
      height: Math.max(16, height || 48),
      fill: null,
      radius,
      opacity: 1,
      clip: true,
      image: { src: src || "data:image/svg+xml;utf8,<svg/>" },
      children: [],
    };
  }

  const fill = parseTailwindColor(cls, style, "bg");
  const strokeColor = parseTailwindColor(cls, style, "border");
  let stroke: any = undefined;
  if (strokeColor) {
    const strokeWidth = parseSpacing(cls, "border") || (cls.includes("border-2") ? 2 : cls.includes("border-4") ? 4 : 1);
    stroke = { color: strokeColor, width: strokeWidth };
  }

  const convertedChildren = (ast.children || [])
    .map((ch: any) => astToHtmlNode(ch, nextInherited))
    .filter(Boolean) as HtmlNode[];

  let layout: any = undefined;
  if (cls.includes("flex")) {
    const isCol = cls.includes("flex-col");
    const gap = Math.max(0, parseSpacing(cls, "gap"));
    const pt = Math.max(0, parseSpacing(cls, "pt") || parseSpacing(cls, "py") || parseSpacing(cls, "p"));
    const pr = Math.max(0, parseSpacing(cls, "pr") || parseSpacing(cls, "px") || parseSpacing(cls, "p"));
    const pb = Math.max(0, parseSpacing(cls, "pb") || parseSpacing(cls, "py") || parseSpacing(cls, "p"));
    const pl = Math.max(0, parseSpacing(cls, "pl") || parseSpacing(cls, "px") || parseSpacing(cls, "p"));

    layout = {
      direction: isCol ? "column" : "row",
      gap,
      padding: [pt, pr, pb, pl],
      align: cls.includes("items-center") ? "center" : cls.includes("items-end") ? "end" : "start",
      justify: cls.includes("justify-center") ? "center" : cls.includes("justify-between") ? "space-between" : "start",
    };
  }

  return {
    type: "frame",
    name,
    x: 0,
    y: 0,
    width: Math.max(10, width || 100),
    height: Math.max(10, height || 100),
    fill,
    radius,
    opacity: 1,
    clip: cls.includes("overflow-hidden"),
    ...(stroke ? { stroke } : {}),
    ...(layout ? { layout } : {}),
    children: convertedChildren,
  };
}

/**
 * Convertit une archive .make en HtmlSnapshot Swiftma.
 */
export function makeToHtmlSnapshot(bytes: Uint8Array): HtmlSnapshot {
  const { meta, jsx } = extractMakeComponent(bytes);
  const ast = parseJsxToTree(jsx);
  if (!ast) {
    throw new Error("Impossible d'analyser l'arborescence JSX du fichier .make");
  }

  let rootBg: string | null = null;
  if (meta.client_meta?.background_color) {
    const bg = meta.client_meta.background_color;
    const r = Math.round(Math.max(0, Math.min(1, bg.r ?? 0)) * 255).toString(16).padStart(2, "0").toUpperCase();
    const g = Math.round(Math.max(0, Math.min(1, bg.g ?? 0)) * 255).toString(16).padStart(2, "0").toUpperCase();
    const b = Math.round(Math.max(0, Math.min(1, bg.b ?? 0)) * 255).toString(16).padStart(2, "0").toUpperCase();
    rootBg = `#${r}${g}${b}`;
  }

  const defaultWidth = meta.client_meta?.render_coordinates?.width || 1536;
  const defaultHeight = meta.client_meta?.render_coordinates?.height || 900;

  const rootNode = astToHtmlNode(ast, {
    color: "#FFFFFF",
    font: "Inter",
    size: 16,
    weight: 400,
    align: "left",
  }) || {
    type: "frame",
    name: "Page",
    x: 0,
    y: 0,
    width: defaultWidth,
    height: defaultHeight,
    fill: rootBg || "#0F0D13",
    radius: 0,
    opacity: 1,
    clip: true,
    children: [],
  };

  if (rootNode.type === "frame") {
    rootNode.name = meta.file_name || rootNode.name || "Page";
    rootNode.x = 0;
    rootNode.y = 0;
    if (rootNode.width < defaultWidth) rootNode.width = defaultWidth;
    if (rootNode.height < defaultHeight) rootNode.height = defaultHeight;
    if (!rootNode.fill && rootBg) rootNode.fill = rootBg;
  }

  return {
    format: "swiftma-html",
    version: 1,
    source: {
      title: meta.file_name || "Capture Figma Make",
      url: meta.file_name || "https://example.com",
      capturedAt: new Date().toISOString(),
    },
    root: rootNode,
  };
}

/**
 * Convertit un espace de couleur OKLCH vers sRGB au format hexadécimal #RRGGBB(AA).
 */
function oklchToHex(l: number, c: number, h: number, alpha = 1): string {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;
  const r = +4.0767434057 * L - 3.3077115913 * M + 0.2309699291 * S;
  const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const bl = -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S;
  const toSRGB = (x: number) => {
    const clamped = Math.max(0, Math.min(1, x));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };
  const toHex = (v: number) => Math.round(v).toString(16).padStart(2, "0").toUpperCase();
  const hex = "#" + toHex(toSRGB(r) * 255) + toHex(toSRGB(g) * 255) + toHex(toSRGB(bl) * 255);
  return alpha >= 0.999 ? hex : hex + toHex(Math.round(alpha * 255));
}

/**
 * Convertit un espace Lab vers sRGB au format hexadécimal #RRGGBB(AA).
 */
function labToHex(L: number, a: number, b: number, alpha = 1): string {
  const y = (L + 16) / 116;
  const x = a / 500 + y;
  const z = y - b / 200;
  const fn = (t: number) => (t > 0.2068965517 ? t * t * t : (t - 16 / 116) / 7.787037);
  const X = 0.95047 * fn(x);
  const Y = 1.0 * fn(y);
  const Z = 1.08883 * fn(z);
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const bl = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const toSRGB = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  };
  const toHex = (v: number) => Math.round(v).toString(16).padStart(2, "0").toUpperCase();
  const hex = "#" + toHex(toSRGB(r) * 255) + toHex(toSRGB(g) * 255) + toHex(toSRGB(bl) * 255);
  return alpha >= 0.999 ? hex : hex + toHex(Math.round(alpha * 255));
}

/**
 * Analyse n'importe quelle chaîne de couleur CSS (hex, rgb, rgba, oklch, lab) et retourne #RRGGBB ou #RRGGBBAA,
 * ou null pour transparent / none.
 */
export function parseCssColor(css?: string | null): string | null {
  if (!css || typeof css !== "string") return null;
  const str = css.trim().toLowerCase();
  if (str === "transparent" || str === "none" || str === "rgba(0, 0, 0, 0)" || str === "rgba(0,0,0,0)") return null;

  // Hex 6 ou 8 chiffres
  if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(str)) return str.toUpperCase();
  // Hex 3 chiffres
  if (/^#[\da-f]{3}$/i.test(str)) {
    return ("#" + str[1] + str[1] + str[2] + str[2] + str[3] + str[3]).toUpperCase();
  }

  // rgb(...) ou rgba(...)
  const rgbMatch = /^rgba?\s*\(([^)]+)\)$/i.exec(str);
  if (rgbMatch) {
    const parts = rgbMatch[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const parseVal = (v: string) => (v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v));
      const r = Math.max(0, Math.min(255, Math.round(parseVal(parts[0]!))));
      const g = Math.max(0, Math.min(255, Math.round(parseVal(parts[1]!))));
      const b = Math.max(0, Math.min(255, Math.round(parseVal(parts[2]!))));
      let a = 1;
      if (parts.length >= 4) {
        a = parts[3]!.endsWith("%") ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!);
      }
      if (a <= 0.001) return null;
      const toHex = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();
      const hex = "#" + toHex(r) + toHex(g) + toHex(b);
      return a >= 0.999 ? hex : hex + toHex(Math.round(a * 255));
    }
  }

  // oklch(...)
  const oklchMatch = /^oklch\s*\(([^)]+)\)$/i.exec(str);
  if (oklchMatch) {
    const parts = oklchMatch[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const l = parts[0]!.endsWith("%") ? parseFloat(parts[0]!) / 100 : parseFloat(parts[0]!);
      const c = parts[1]!.endsWith("%") ? (parseFloat(parts[1]!) / 100) * 0.4 : parseFloat(parts[1]!);
      const h = parseFloat(parts[2]!) || 0;
      let a = 1;
      if (parts.length >= 4) {
        a = parts[3]!.endsWith("%") ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!);
      }
      if (a <= 0.001) return null;
      return oklchToHex(l, c, h, a);
    }
  }

  // lab(...)
  const labMatch = /^lab\s*\(([^)]+)\)$/i.exec(str);
  if (labMatch) {
    const parts = labMatch[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const L = parts[0]!.endsWith("%") ? parseFloat(parts[0]!) : parseFloat(parts[0]!);
      const a = parseFloat(parts[1]!) || 0;
      const b = parseFloat(parts[2]!) || 0;
      let alpha = 1;
      if (parts.length >= 4) {
        alpha = parts[3]!.endsWith("%") ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!);
      }
      if (alpha <= 0.001) return null;
      return labToHex(L, a, b, alpha);
    }
  }

  return null;
}

/**
 * Extrait le border-radius en prenant en compte les propriétés calculées
 * par coin (borderTopLeftRadius, borderTopRightRadius, etc.) générées par le navigateur.
 */
export function extractRadius(styles: any, width: number, height: number): number {
  if (!styles) return 0;
  const raw =
    styles.borderTopLeftRadius ||
    styles.borderTopRightRadius ||
    styles.borderBottomLeftRadius ||
    styles.borderBottomRightRadius ||
    styles.borderRadius;
  if (!raw || typeof raw !== "string") return 0;
  const val = raw.trim();
  if (val.endsWith("%")) {
    const pct = parseFloat(val) / 100;
    return Math.max(0, Math.round(Math.min(width, height) * pct));
  }
  const px = parseFloat(val);
  if (!isNaN(px) && px > 0) {
    const maxHalf = Math.max(0.1, Math.min(width, height) / 2);
    return Math.min(px, maxHalf);
  }
  return 0;
}

/**
 * Analyse la propriété CSS box-shadow (ombres portées et intérieures).
 */
export function parseBoxShadow(raw?: string | null): Shadow[] | undefined {
  if (!raw || typeof raw !== "string" || raw === "none") return undefined;
  const shadows: Shadow[] = [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());

  for (const part of parts) {
    const isInset = /\binset\b/i.test(part);
    const cleaned = part.replace(/\binset\b/gi, "").trim();
    let color = "#00000033";
    let numbersStr = cleaned;
    const colorMatch = /(?:rgba?|oklch|lab)\([^)]+\)|#[0-9a-f]{3,8}\b/i.exec(cleaned);
    if (colorMatch) {
      const parsed = parseCssColor(colorMatch[0]);
      if (parsed) color = parsed;
      numbersStr = (cleaned.slice(0, colorMatch.index) + " " + cleaned.slice(colorMatch.index + colorMatch[0].length)).trim();
    }
    const nums = numbersStr.split(/\s+/).map((v) => parseFloat(v)).filter((v) => !isNaN(v));
    const x = nums[0] ?? 0;
    const y = nums[1] ?? 0;
    const blur = Math.max(0, nums[2] ?? 0);
    const spread = nums[3] ?? 0;
    shadows.push({
      type: isInset ? "inner" : "drop",
      x,
      y,
      blur,
      spread,
      color,
    });
  }
  return shadows.length > 0 ? shadows : undefined;
}

function splitCssShorthand(val?: string | null): string[] {
  if (!val || typeof val !== "string") return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < val.length; i++) {
    const c = val[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === " " && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function expandSides<T>(parts: T[]): [T, T, T, T] | null {
  if (parts.length === 1) return [parts[0]!, parts[0]!, parts[0]!, parts[0]!];
  if (parts.length === 2) return [parts[0]!, parts[1]!, parts[0]!, parts[1]!];
  if (parts.length === 3) return [parts[0]!, parts[1]!, parts[2]!, parts[1]!];
  if (parts.length >= 4) return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
  return null;
}

/**
 * Extrait le contour (stroke) à partir des styles de bordure.
 */
export function extractStroke(styles: any): { color: string; width: number } | undefined {
  if (!styles) return undefined;

  const styleSides = expandSides(splitCssShorthand(styles.borderStyle));
  const widthSides = expandSides(splitCssShorthand(styles.borderWidth));
  const colorSides = expandSides(splitCssShorthand(styles.borderColor));

  const visibleStyles = ["solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"];

  const sides = [
    { side: "top", style: styles.borderTopStyle || styleSides?.[0], width: styles.borderTopWidth || widthSides?.[0], color: styles.borderTopColor || colorSides?.[0] },
    { side: "right", style: styles.borderRightStyle || styleSides?.[1], width: styles.borderRightWidth || widthSides?.[1], color: styles.borderRightColor || colorSides?.[1] },
    { side: "bottom", style: styles.borderBottomStyle || styleSides?.[2], width: styles.borderBottomWidth || widthSides?.[2], color: styles.borderBottomColor || colorSides?.[2] },
    { side: "left", style: styles.borderLeftStyle || styleSides?.[3], width: styles.borderLeftWidth || widthSides?.[3], color: styles.borderLeftColor || colorSides?.[3] },
  ];

  const visible = sides.filter((s) => {
    // Style check: si défini, doit être un style visible et PAS none/hidden
    if (s.style) {
      const st = s.style.toLowerCase();
      if (st === "none" || st === "hidden" || !visibleStyles.includes(st)) return false;
    }
    // Width check: doit être une largeur numérique positive
    if (!s.width || typeof s.width !== "string") return false;
    const w = parseFloat(s.width);
    if (isNaN(w) || w <= 0.05) return false;
    // Color check: doit être une couleur non transparente
    const c = parseCssColor(s.color);
    if (!c) return false;
    return true;
  });

  if (visible.length === 0) return undefined;

  // Sélectionner la bordure visible ayant la largeur maximale
  visible.sort((a, b) => parseFloat(b.width!) - parseFloat(a.width!));
  const best = visible[0]!;
  const w = parseFloat(best.width!);
  const c = parseCssColor(best.color)!;

  return {
    color: c,
    width: Math.min(100, Math.max(0.5, Math.round(w * 10) / 10)),
  };
}

/**
 * Transforme les données d'un document .h2d en un snapshot HtmlSnapshot conforme pour Swiftma.
 */
export function h2dToHtmlSnapshot(data: any): HtmlSnapshot {
  const assets: Record<string, { base64Encoded?: boolean; content?: string; mimeType?: string }> = data.assets || {};

  function resolveAssetSrc(url?: string | null): string | null {
    if (!url) return null;
    if (url.startsWith("data:")) {
      if (url.startsWith("data:image/svg+xml;base64,<")) {
        const rawXml = url.slice("data:image/svg+xml;base64,".length);
        const b64 = typeof Buffer !== "undefined"
          ? Buffer.from(rawXml).toString("base64")
          : btoa(unescape(encodeURIComponent(rawXml)));
        return `data:image/svg+xml;base64,${b64}`;
      }
      return url;
    }
    const asset = assets[url];
    if (asset && asset.content) {
      const mime = asset.mimeType || "image/png";
      if (asset.base64Encoded) {
        return `data:${mime};base64,${asset.content}`;
      }
      // Contenu texte brut (ex: SVG) : s'assurer du namespace xmlns et encoder en base64 valide
      if (mime.includes("svg") || asset.content.trim().startsWith("<")) {
        const svgContent = asset.content.trim();
        const normalizedSvg = svgContent.includes("xmlns=")
          ? svgContent
          : svgContent.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
        const b64 = typeof Buffer !== "undefined"
          ? Buffer.from(normalizedSvg).toString("base64")
          : btoa(unescape(encodeURIComponent(normalizedSvg)));
        return `data:image/svg+xml;base64,${b64}`;
      }
      const b64 = typeof Buffer !== "undefined"
        ? Buffer.from(asset.content).toString("base64")
        : btoa(unescape(encodeURIComponent(asset.content)));
      return `data:${mime};base64,${b64}`;
    }
    return url;
  }

  function convertNode(n: any, parentAbsX: number, parentAbsY: number, inheritedStyles: any = {}): HtmlNode | null {
    if (!n) return null;
    const styles = { ...inheritedStyles, ...(n.styles || {}) };

    // Coordonnées locales exactes par rapport au parent
    const x = Math.round((n.x - parentAbsX) * 100) / 100;
    const y = Math.round((n.y - parentAbsY) * 100) / 100;
    const width = Math.max(0.1, Math.round(n.width * 100) / 100);
    const height = Math.max(0.1, Math.round(n.height * 100) / 100);

    const tag = (n.tag || "div").toLowerCase();
    let name = tag;
    if (Array.isArray(n.classList) && n.classList.length > 0) {
      name += "." + n.classList.slice(0, 2).join(".");
    }
    // Tag sémantique Swiftma [tag]Nom
    if (tag === "button" || (n.attr && n.attr.role === "button")) name = `[bouton]${name}`;
    else if (tag === "a" || (n.attr && n.attr.href)) name = `[lien]${name}`;
    else if (tag === "header") name = `[header]${name}`;
    else if (tag === "nav") name = `[nav]${name}`;
    else if (tag === "footer") name = `[footer]${name}`;
    else if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") name = `[titre]${name}`;

    // 1. Nœud SVG vectoriel
    if (n.type === "SVG" && n.svg) {
      let svgStr = String(n.svg).trim();
      if (!svgStr.includes("xmlns=")) {
        svgStr = svgStr.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      const b64 = typeof Buffer !== "undefined"
        ? Buffer.from(svgStr).toString("base64")
        : btoa(unescape(encodeURIComponent(svgStr)));
      const dataUri = `data:image/svg+xml;base64,${b64}`;
      return {
        type: "image",
        name: `[svg]${name}`,
        x,
        y,
        width,
        height,
        fill: null,
        radius: 0,
        opacity: 1,
        clip: false,
        image: { src: dataUri },
        children: [],
      };
    }

    // 2. Nœud de Texte
    if (n.type === "TEXT") {
      const rawFontSize = parseFloat(styles.fontSize);
      const fontSize = !isNaN(rawFontSize) && rawFontSize >= 1 && rawFontSize <= 512 ? rawFontSize : 16;

      let fontWeight = 400;
      if (styles.fontWeight) {
        const fw = parseInt(styles.fontWeight, 10);
        if (!isNaN(fw) && fw >= 100 && fw <= 900) fontWeight = fw;
        else if (styles.fontWeight === "bold") fontWeight = 700;
      }

      const color = parseCssColor(styles.color) || "#000000";
      const rawFamily = n.font || (styles.fontFamily ? styles.fontFamily.split(",")[0] : "Inter");
      const fontFamily = (rawFamily || "Inter").replace(/['"]/g, "").trim();
      const align = ["center", "right"].includes(styles.textAlign) ? styles.textAlign : "left";

      let lineHeight = 1.2;
      if (styles.lineHeight) {
        const lhPx = parseFloat(styles.lineHeight);
        if (!isNaN(lhPx) && lhPx > 0) {
          lineHeight = Math.max(0.5, Math.min(4, Math.round((lhPx / fontSize) * 100) / 100));
        }
      }

      const textNode: HtmlNode = {
        type: "text",
        name: `[texte]${(n.value || "").slice(0, 30)}`,
        x,
        y,
        width,
        height,
        fill: null,
        radius: 0,
        opacity: typeof styles.opacity === "number" ? Math.max(0, Math.min(1, styles.opacity)) : 1,
        clip: false,
        text: {
          content: n.value || "",
          fontFamily,
          fontSize,
          fontWeight,
          color,
          align,
          lineHeight,
          ...(styles.fontStyle === "italic" || styles.fontStyle === "oblique" ? { italic: true } : {}),
        },
        children: [],
      };
      return textNode;
    }

    // 3. Image (balise <img>, ressource d'image $url ou image d'arrière-plan backgroundImage)
    const bgMatch = typeof styles.backgroundImage === "string" ? /url\(["']?([^"')]+)["']?\)/i.exec(styles.backgroundImage) : null;
    const bgUrl = bgMatch ? bgMatch[1] : null;
    const imageUrl = n.$url || (n.attr && n.attr.src) || (bgUrl && (!n.children || n.children.length === 0) ? bgUrl : null);
    if ((tag === "img" || n.$url || imageUrl) && imageUrl) {
      const src = resolveAssetSrc(imageUrl);
      if (src) {
        const radius = extractRadius(styles, width, height);
        return {
          type: "image",
          name: `[image]${name}`,
          x,
          y,
          width,
          height,
          fill: null,
          radius,
          opacity: typeof styles.opacity === "number" ? Math.max(0, Math.min(1, styles.opacity)) : 1,
          clip: true,
          image: { src },
          children: [],
        };
      }
    }

    // 4. Cadre / Frame conteneur
    const fill = parseCssColor(styles.backgroundColor);
    const radius = extractRadius(styles, width, height);
    const opacity = typeof styles.opacity === "number" ? Math.max(0, Math.min(1, styles.opacity)) : 1;
    const clip = styles.overflow === "hidden" || styles.overflow === "clip" || styles.overflowX === "hidden";

    // Contour / Bordure
    const stroke = extractStroke(styles);
    // Ombres
    const shadows = parseBoxShadow(styles.boxShadow);

    // Enfants récursifs (en CSS, seules les propriétés typographiques se transmettent aux descendants)
    const childInheritedStyles: any = {
      color: styles.color,
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize,
      fontWeight: styles.fontWeight,
      fontStyle: styles.fontStyle,
      lineHeight: styles.lineHeight,
      letterSpacing: styles.letterSpacing,
      textAlign: styles.textAlign,
      textTransform: styles.textTransform,
      visibility: styles.visibility,
    };

    const convertedChildren: HtmlNode[] = [];
    if (Array.isArray(n.children) && n.children.length > 0) {
      for (const c of n.children) {
        const childNode = convertNode(c, n.x, n.y, childInheritedStyles);
        if (childNode) convertedChildren.push(childNode);
      }
    }

    // Si le conteneur a une image d'arrière-plan backgroundImage ET des enfants, on insère le calque d'image en premier enfant
    if (bgUrl && convertedChildren.length > 0) {
      const bgSrc = resolveAssetSrc(bgUrl);
      if (bgSrc) {
        convertedChildren.unshift({
          type: "image",
          name: `[bg-image]${name}`,
          x: 0,
          y: 0,
          width,
          height,
          fill: null,
          radius,
          opacity: 1,
          clip: true,
          image: { src: bgSrc },
          children: [],
        });
      }
    }

    const frameNode: HtmlNode = {
      type: "frame",
      name,
      x,
      y,
      width,
      height,
      fill,
      radius,
      opacity,
      clip,
      ...(stroke ? { stroke } : {}),
      ...(shadows ? { shadows } : {}),
      children: convertedChildren,
    };

    // Gestion de l'état interactif au survol (hover) si présent
    if (n.hover && typeof n.hover === "object") {
      const hoverFill = parseCssColor(n.hover.styles?.backgroundColor);
      const hoverTextColor = parseCssColor(n.hover.styles?.color);
      const hoverBorderColor = parseCssColor(n.hover.styles?.borderColor);
      const statePatch: any = {};
      if (hoverFill !== null) statePatch.fill = hoverFill;
      if (hoverTextColor) statePatch.textColor = hoverTextColor;
      if (hoverBorderColor && stroke) statePatch.strokeColor = hoverBorderColor;
      if (Object.keys(statePatch).length > 0) {
        frameNode.states = {
          Survol: statePatch,
        };
      }
    }

    return frameNode;
  }

  const rootAbsX = data.frame?.x ?? 0;
  const rootAbsY = data.frame?.y ?? 0;
  const rootNode = convertNode(data.frame, rootAbsX, rootAbsY, {}) || {
    type: "frame",
    name: "Page",
    x: 0,
    y: 0,
    width: data.doc?.innerWidth || 1536,
    height: data.doc?.innerHeight || 900,
    fill: "#FFFFFF",
    radius: 0,
    opacity: 1,
    clip: true,
    children: [],
  };

  rootNode.x = 0;
  rootNode.y = 0;

  return {
    format: "swiftma-html",
    version: 1,
    source: {
      title: data.doc?.title || data.name || "Capture html.to.design",
      url: data.name || data.url || "https://example.com",
      capturedAt: new Date().toISOString(),
    },
    root: rootNode,
  };
}

/**
 * Importe directement un tampon .h2d ou une archive .make en un lot d'opérations Swiftma (Op[]).
 */
export function h2dToOps(
  bytes: Uint8Array,
  at: { x: number; y: number } = { x: 0, y: 0 }
): HtmlImportResult {
  if (isMakeArchive(bytes)) {
    const snapshot = makeToHtmlSnapshot(bytes);
    return htmlSnapshotToOps(snapshot, at);
  }
  const data = decodeH2D(bytes);
  const snapshot = h2dToHtmlSnapshot(data);
  return htmlSnapshotToOps(snapshot, at);
}
