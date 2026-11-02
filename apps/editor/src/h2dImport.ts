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
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
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
 * Importe directement un tampon .h2d en un lot d'opérations Swiftma (Op[]).
 */
export function h2dToOps(
  bytes: Uint8Array,
  at: { x: number; y: number } = { x: 0, y: 0 }
): HtmlImportResult {
  const data = decodeH2D(bytes);
  const snapshot = h2dToHtmlSnapshot(data);
  return htmlSnapshotToOps(snapshot, at);
}
