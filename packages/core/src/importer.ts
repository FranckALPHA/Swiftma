// Moteur d'import universel Swiftma : .h2d, .make, .swiftma.json, .svg, et images (.png, .jpg, .webp, .gif)
// Isomorphique (fonctionne à l'identique dans le navigateur, Node.js et les outils MCP).

import { decodeH2D, h2dToHtmlSnapshot, h2dToOps, isH2DBytes, isMakeArchive, makeToHtmlSnapshot } from "./h2dImport.js";
import { htmlSnapshotToOps, type HtmlSnapshot } from "./htmlImport.js";
import { svgToOps } from "./svgParser.js";
import { makeNode, newId, type DesignDocument, type DesignNode, type Op } from "./index.js";

export interface ImportOptions {
  /** Nom du fichier ou du calque importé */
  name?: string;
  /** Coordonnées de placement sur le canevas (défaut : à droite des calques existants) */
  at?: { x: number; y: number };
}

export interface ImportResult {
  ops: Op[];
  rootId: string;
  rootIds?: string[];
  format: "h2d" | "make" | "swiftma-html" | "svg" | "image" | "ops";
  stats: {
    nodes: number;
    pages?: number;
    width: number;
    height: number;
  };
}

/** Calcule le point d'insertion par défaut (à droite des racines existantes, ou 0,0 si vide). */
export function defaultInsertPosition(doc: DesignDocument): { x: number; y: number } {
  const roots = (doc.roots ?? []).map((id) => doc.nodes[id]).filter((n): n is DesignNode => !!n);
  if (!roots.length) return { x: 0, y: 0 };
  const maxX = roots.reduce((m, n) => Math.max(m, (n.x ?? 0) + (n.width ?? 0)), 0);
  return { x: Math.round(maxX + 100), y: 0 };
}

/** Détection des dimensions et du type MIME d'une image matricielle (PNG, JPEG, GIF, WebP). */
export function getImageDimensions(bytes: Uint8Array): { width: number; height: number; mimeType: string } | null {
  if (bytes.length < 8) return null;

  // PNG : 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return { width, height, mimeType: "image/png" };
  }

  // GIF : GIF87a ou GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes.length >= 10) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    return { width, height, mimeType: "image/gif" };
  }

  // JPEG : FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.length >= 4) {
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset < bytes.length - 8) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3 && marker !== 0xc4) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        return { width, height, mimeType: "image/jpeg" };
      }
      if (offset + 4 > bytes.length) break;
      const length = view.getUint16(offset + 2, false);
      offset += 2 + length;
    }
    return { width: 800, height: 600, mimeType: "image/jpeg" };
  }

  // WebP : RIFF ... WEBP
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      return { width, height, mimeType: "image/webp" };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c) {
      const b0 = bytes[21]!, b1 = bytes[22]!, b2 = bytes[23]!, b3 = bytes[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height, mimeType: "image/webp" };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { width, height, mimeType: "image/webp" };
    }
    return { width: 800, height: 600, mimeType: "image/webp" };
  }

  return null;
}

/** Extrait la géométrie d'un document SVG (largeur, hauteur). */
export function parseSvgDimensions(svgText: string): { width: number; height: number } {
  const vbMatch = svgText.match(/viewBox\s*=\s*["']\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*["']/i);
  const vbWidth = vbMatch && vbMatch[3] ? parseFloat(vbMatch[3]) : 0;
  const vbHeight = vbMatch && vbMatch[4] ? parseFloat(vbMatch[4]) : 0;

  const wMatch = svgText.match(/(?:<svg[^>]*\s)width\s*=\s*["']\s*([0-9.-]+)(?:px)?\s*["']/i);
  const hMatch = svgText.match(/(?:<svg[^>]*\s)height\s*=\s*["']\s*([0-9.-]+)(?:px)?\s*["']/i);

  const w = wMatch && wMatch[1] ? parseFloat(wMatch[1]) : (vbWidth || 800);
  const h = hMatch && hMatch[1] ? parseFloat(hMatch[1]) : (vbHeight || 600);

  return {
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
  };
}

/** Convertit des octets en base64 de façon isomorphique. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Importe n'importe quelle charge utile supportée par Swiftma en une liste d'opérations `Op[]`.
 * Formats pris en charge :
 * - .h2d : capture compressée html.to.design
 * - .make : archive ZIP html.to.design / Figma Make
 * - .swiftma.json / JSON : snapshot HTML / DOM de l'extension Swiftma
 * - SVG (.svg) : vecteur ou image SVG
 * - Images raster (.png, .jpg, .jpeg, .webp, .gif)
 * - Swiftma Ops JSON : suite d'opérations d'exportation directe
 */
export function importPayloadToOps(
  input: {
    bytes?: Uint8Array;
    text?: string;
    dataUrl?: string;
    fileName?: string;
    mimeType?: string;
  },
  opts: ImportOptions = {},
): ImportResult {
  const at = opts.at ?? { x: 0, y: 0 };
  const fileName = opts.name ?? input.fileName ?? "Import";
  const baseName = fileName.replace(/\.[a-zA-Z0-9]+$/i, "");
  const lowerName = fileName.toLowerCase();

  // 1. Récupération des octets et/ou du texte
  let bytes = input.bytes;
  let text = input.text;

  if (!bytes && input.dataUrl) {
    const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/.exec(input.dataUrl);
    if (match) {
      const mime = match[1] ?? "";
      const isBase64 = input.dataUrl.includes(";base64,");
      if (isBase64) {
        if (typeof Buffer !== "undefined") {
          bytes = new Uint8Array(Buffer.from(match[2]!, "base64"));
        } else {
          const bin = atob(match[2]!);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        }
      } else {
        text = decodeURIComponent(match[2]!);
      }
    }
  }

  if (bytes && !text) {
    try {
      // Tente de décoder en texte si ce n'est pas un binaire pur
      if (lowerName.endsWith(".json") || lowerName.endsWith(".svg") || (!isH2DBytes(bytes) && !isMakeArchive(bytes))) {
        text = new TextDecoder("utf-8").decode(bytes);
      }
    } catch {}
  }

  if (!bytes && text) {
    bytes = new TextEncoder().encode(text);
  }

  // 2. Détection .h2d ou .make
  if (bytes) {
    if (lowerName.endsWith(".h2d") || isH2DBytes(bytes)) {
      const res = h2dToOps(bytes, at);
      const rootNode = res.ops.find((op) => op.kind === "create" && op.node.id === res.rootId);
      const w = (rootNode && rootNode.kind === "create" ? rootNode.node.width : 1200) ?? 1200;
      const h = (rootNode && rootNode.kind === "create" ? rootNode.node.height : 800) ?? 800;
      return {
        ops: res.ops,
        rootId: res.rootId,
        format: "h2d",
        stats: { nodes: res.stats.nodes, width: w, height: h },
      };
    }

    if (lowerName.endsWith(".make") || isMakeArchive(bytes)) {
      const snapshot = makeToHtmlSnapshot(bytes);
      const res = htmlSnapshotToOps(snapshot, at);
      const rootNode = res.ops.find((op) => op.kind === "create" && op.node.id === res.rootId);
      const w = (rootNode && rootNode.kind === "create" ? rootNode.node.width : 1200) ?? 1200;
      const h = (rootNode && rootNode.kind === "create" ? rootNode.node.height : 800) ?? 800;
      return {
        ops: res.ops,
        rootId: res.rootId,
        rootIds: res.rootIds,
        format: "make",
        stats: { nodes: res.stats.nodes, pages: res.stats.pages, width: w, height: h },
      };
    }
  }

  // 3. Détection JSON (Swiftma HTML Snapshot ou tableau d'opérations)
  if (text && (lowerName.endsWith(".json") || text.trim().startsWith("{") || text.trim().startsWith("["))) {
    try {
      const parsed = JSON.parse(text);

      // Cas 3a : Swiftma HTML Snapshot
      if (parsed && typeof parsed === "object" && (parsed.format === "swiftma-html" || parsed.root || parsed.pages)) {
        const res = htmlSnapshotToOps(parsed as HtmlSnapshot, at);
        const rootNode = res.ops.find((op) => op.kind === "create" && op.node.id === res.rootId);
        const w = (rootNode && rootNode.kind === "create" ? rootNode.node.width : 1200) ?? 1200;
        const h = (rootNode && rootNode.kind === "create" ? rootNode.node.height : 800) ?? 800;
        return {
          ops: res.ops,
          rootId: res.rootId,
          rootIds: res.rootIds,
          format: "swiftma-html",
          stats: { nodes: res.stats.nodes, pages: res.stats.pages, width: w, height: h },
        };
      }

      // Cas 3b : Lot direct d'opérations { ops: Op[] } ou Op[]
      const rawOps = Array.isArray(parsed) ? parsed : Array.isArray(parsed.ops) ? parsed.ops : null;
      if (rawOps && rawOps.length > 0 && (rawOps[0] as any)?.kind) {
        const firstCreate = (rawOps as any[]).find((o) => o && o.kind === "create");
        return {
          ops: rawOps as Op[],
          rootId: firstCreate ? firstCreate.node.id : "",
          format: "ops",
          stats: { nodes: rawOps.length, width: 800, height: 600 },
        };
      }
    } catch {}
  }

  // 4. Détection SVG
  const isSvg = lowerName.endsWith(".svg") || (text && text.trim().startsWith("<svg")) || (text && text.includes("<svg"));
  if (isSvg && text) {
    try {
      const res = svgToOps(text, at, baseName);
      if (res.ops.length > 0) {
        return {
          ops: res.ops,
          rootId: res.rootId,
          format: "svg",
          stats: { nodes: res.stats.nodes, width: res.stats.width, height: res.stats.height },
        };
      }
    } catch {}

    // Fallback image si le SVG ne peut être vectorisé en calques
    const dims = parseSvgDimensions(text);
    const b64 = bytes ? bytesToBase64(bytes) : bytesToBase64(new TextEncoder().encode(text));
    const src = `data:image/svg+xml;base64,${b64}`;
    const node = makeNode("image", {
      name: baseName || "SVG",
      x: at.x,
      y: at.y,
      width: dims.width,
      height: dims.height,
      image: { src },
    }, newId());

    return {
      ops: [{ kind: "create", node }],
      rootId: node.id,
      format: "svg",
      stats: { nodes: 1, width: dims.width, height: dims.height },
    };
  }

  // 5. Détection Images raster (PNG, JPEG, GIF, WebP)
  if (bytes) {
    const imgInfo = getImageDimensions(bytes);
    if (imgInfo || lowerName.match(/\.(png|jpe?g|gif|webp)$/i)) {
      const mime = imgInfo?.mimeType ?? (lowerName.endsWith(".png") ? "image/png" : lowerName.endsWith(".gif") ? "image/gif" : lowerName.endsWith(".webp") ? "image/webp" : "image/jpeg");
      const width = imgInfo?.width ?? 800;
      const height = imgInfo?.height ?? 600;
      const b64 = bytesToBase64(bytes);
      const src = `data:${mime};base64,${b64}`;

      const node = makeNode("image", {
        name: baseName || "Image",
        x: at.x,
        y: at.y,
        width,
        height,
        image: { src },
      }, newId());

      return {
        ops: [{ kind: "create", node }],
        rootId: node.id,
        format: "image",
        stats: { nodes: 1, width, height },
      };
    }
  }

  throw new Error(`Format de fichier non reconnu pour « ${fileName} ». Formats supportés : .h2d, .make, .swiftma.json, .svg, .png, .jpg, .webp, .gif`);
}
