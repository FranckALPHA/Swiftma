// Styles partagés (design tokens) : couleurs, typographies et ombres nommées au niveau du document.
//
// Un élément lié à un style (fillStyle, strokeStyle, textStyle, effectStyle) prend ses valeurs : changer le style
// change tous les éléments liés (passe de dérivation). Modifier directement la propriété détache l'élément du style,
// comme dans Figma. À l'export, chaque style devient une variable CSS (src/styles/tokens.css).

import type { DesignDocument, DesignNode, DesignStyles, NodeProps, Shadow, TextStyleDef } from "./model.js";
import { newId } from "./model.js";
import { type Op, registerDerivePass } from "./ops.js";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const TEXT_KEYS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "italic"] as const;

/** Valeurs qu'un élément doit avoir d'après ses styles. */
function styledProps(styles: DesignStyles, n: DesignNode): NodeProps {
  const props: NodeProps = {};
  const color = n.fillStyle ? styles.colors?.[n.fillStyle]?.value : undefined;
  if (color) {
    if (n.type === "text" && n.text) {
      if (n.text.color !== color) props.text = { ...props.text, color };
    } else if (n.fill !== color || n.gradient) {
      props.fill = color;
      if (n.gradient) props.gradient = null;
    }
  }
  const stroke = n.strokeStyle ? styles.colors?.[n.strokeStyle]?.value : undefined;
  if (stroke && n.stroke && n.stroke.color !== stroke) props.stroke = { ...n.stroke, color: stroke };
  const ts = n.textStyle ? styles.texts?.[n.textStyle] : undefined;
  if (ts && n.text) {
    for (const k of TEXT_KEYS) {
      const want = ts[k] ?? (k === "letterSpacing" ? 0 : k === "italic" ? false : undefined);
      const have = n.text[k] ?? (k === "letterSpacing" ? 0 : k === "italic" ? false : undefined);
      if (!same(want, have)) props.text = { ...props.text, [k]: want };
    }
  }
  const fx = n.effectStyle ? styles.effects?.[n.effectStyle] : undefined;
  if (fx && !same(fx.shadows, n.shadows)) props.shadows = structuredClone(fx.shadows);
  return props;
}

/** Passe de dérivation : les éléments liés rattrapent leurs styles. */
export function applyStyles(doc: DesignDocument): Op[] {
  const styles = doc.styles;
  if (!styles) return [];
  const ops: Op[] = [];
  for (const n of Object.values(doc.nodes)) {
    if (!n.fillStyle && !n.strokeStyle && !n.textStyle && !n.effectStyle) continue;
    const props = styledProps(styles, n);
    if (Object.keys(props).length) ops.push({ kind: "update", id: n.id, props });
  }
  return ops;
}
registerDerivePass(applyStyles);

/**
 * Modifications d'un humain ou d'une IA : changer directement une propriété stylée détache l'élément de ce style
 * (sauf si l'opération pose elle-même un style).
 */
export function withStyleDetach(doc: DesignDocument, ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.kind !== "update") {
      out.push(op);
      continue;
    }
    const n = doc.nodes[op.id];
    if (!n) {
      out.push(op);
      continue;
    }
    const p = op.props;
    const detach: NodeProps = {};
    const touchesColor = n.type === "text" ? p.text?.color !== undefined : p.fill !== undefined || (p.gradient !== undefined && p.gradient !== null);
    if (n.fillStyle && touchesColor && !("fillStyle" in p)) detach.fillStyle = null;
    if (n.strokeStyle && p.stroke !== undefined && p.stroke?.color !== doc.styles?.colors?.[n.strokeStyle]?.value && !("strokeStyle" in p)) detach.strokeStyle = null;
    if (n.textStyle && p.text && TEXT_KEYS.some((k) => k in p.text!) && !("textStyle" in p)) detach.textStyle = null;
    if (n.effectStyle && p.shadows !== undefined && !("effectStyle" in p)) detach.effectStyle = null;
    out.push(Object.keys(detach).length ? { ...op, props: { ...p, ...detach } } : op);
  }
  return out;
}

// ---------- Création et détection ----------

export type StyleKind = "colors" | "texts" | "effects";

/** Ajoute ou remplace un style (renvoie l'opération et l'id). */
export function upsertStyleOps(doc: DesignDocument, kind: StyleKind, style: { name: string } & Record<string, unknown>, id = newId()): { ops: Op[]; id: string } {
  const styles: DesignStyles = structuredClone(doc.styles ?? {});
  (styles[kind] ??= {} as never);
  (styles[kind] as Record<string, unknown>)[id] = style;
  return { ops: [{ kind: "set-doc", props: { styles } }], id };
}

export function deleteStyleOps(doc: DesignDocument, kind: StyleKind, id: string): Op[] {
  const styles: DesignStyles = structuredClone(doc.styles ?? {});
  delete (styles[kind] as Record<string, unknown> | undefined)?.[id];
  const key = kind === "texts" ? "textStyle" : kind === "effects" ? "effectStyle" : null;
  // Les éléments liés gardent leurs valeurs, mais ne sont plus liés
  const unlink: Op[] = Object.values(doc.nodes).flatMap((n): Op[] => {
    const props: NodeProps = {};
    if (key && n[key] === id) props[key] = null;
    if (kind === "colors" && n.fillStyle === id) props.fillStyle = null;
    if (kind === "colors" && n.strokeStyle === id) props.strokeStyle = null;
    return Object.keys(props).length ? [{ kind: "update", id: n.id, props }] : [];
  });
  return [...unlink, { kind: "set-doc", props: { styles } }];
}

/**
 * Détecte les styles d'une maquette (après un import SVG par exemple) : les couleurs utilisées au moins 3 fois,
 * les typographies au moins 2 fois et les ombres au moins 2 fois deviennent des styles nommés, et les éléments
 * concernés y sont liés. Rien ne change à l'écran.
 */
export function extractStylesOps(doc: DesignDocument, rootId: string): { ops: Op[]; counts: Record<StyleKind, number> } {
  const nodes: DesignNode[] = [];
  const walk = (id: string) => {
    const n = doc.nodes[id]!;
    nodes.push(n);
    n.children.forEach(walk);
  };
  walk(rootId);
  const styles: DesignStyles = structuredClone(doc.styles ?? {});
  styles.colors ??= {};
  styles.texts ??= {};
  styles.effects ??= {};
  const existingColor = new Map(Object.entries(styles.colors).map(([id, s]) => [s.value.toUpperCase(), id]));

  // Couleurs
  const colorUse = new Map<string, number>();
  const colorOf = (n: DesignNode) => (n.type === "text" ? n.text?.color : n.gradient || n.type === "image" ? null : n.fill)?.toUpperCase() ?? null;
  for (const n of nodes) {
    const c = colorOf(n);
    if (c && !n.fillStyle) colorUse.set(c, (colorUse.get(c) ?? 0) + 1);
  }
  const usedNames = new Set(Object.values(styles.colors).map((s) => s.name));
  let colors = 0;
  for (const [value, count] of [...colorUse].sort((a, b) => b[1] - a[1])) {
    if (count < 3 || existingColor.has(value)) continue;
    let name = colorName(value);
    for (let i = 2; usedNames.has(name); i++) name = `${colorName(value)} ${i}`;
    usedNames.add(name);
    const id = newId();
    styles.colors[id] = { name, value };
    existingColor.set(value, id);
    colors++;
  }

  // Typographies
  const textKey = (n: DesignNode) => JSON.stringify(TEXT_KEYS.map((k) => n.text![k] ?? (k === "letterSpacing" ? 0 : k === "italic" ? false : null)));
  const textUse = new Map<string, { count: number; sample: DesignNode }>();
  for (const n of nodes) if (n.text && !n.textStyle) {
    const k = textKey(n);
    const e = textUse.get(k) ?? { count: 0, sample: n };
    e.count++;
    textUse.set(k, e);
  }
  const textIds = new Map<string, string>();
  for (const [k, s] of Object.entries(styles.texts)) textIds.set(JSON.stringify(TEXT_KEYS.map((x) => s[x] ?? (x === "letterSpacing" ? 0 : x === "italic" ? false : null))), k);
  const textNames = new Set(Object.values(styles.texts).map((s) => s.name));
  let texts = 0;
  for (const [k, { count, sample }] of [...textUse].sort((a, b) => b[1].sample.text!.fontSize - a[1].sample.text!.fontSize)) {
    if (count < 2 || textIds.has(k)) continue;
    const t = sample.text!;
    let name = `${t.fontFamily} ${Math.round(t.fontSize * 10) / 10} ${WEIGHT_NAMES[t.fontWeight] ?? t.fontWeight}${t.italic ? " italique" : ""}`;
    for (let i = 2; textNames.has(name); i++) name = `${name.replace(/ \d+$/, "")} ${i}`;
    textNames.add(name);
    const id = newId();
    const def: TextStyleDef = { name, fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight, lineHeight: t.lineHeight };
    if (t.letterSpacing) def.letterSpacing = t.letterSpacing;
    if (t.italic) def.italic = true;
    styles.texts[id] = def;
    textIds.set(k, id);
    texts++;
  }

  // Ombres
  const fxUse = new Map<string, number>();
  for (const n of nodes) if (n.shadows?.length && !n.effectStyle) fxUse.set(JSON.stringify(n.shadows), (fxUse.get(JSON.stringify(n.shadows)) ?? 0) + 1);
  const fxIds = new Map(Object.entries(styles.effects).map(([id, s]) => [JSON.stringify(s.shadows), id]));
  let effects = 0;
  for (const [k, count] of fxUse) {
    if (count < 2 || fxIds.has(k)) continue;
    const id = newId();
    styles.effects[id] = { name: `Ombre ${Object.keys(styles.effects).length + 1}`, shadows: JSON.parse(k) as Shadow[] };
    fxIds.set(k, id);
    effects++;
  }

  const ops: Op[] = [{ kind: "set-doc", props: { styles } }];
  for (const n of nodes) {
    const props: NodeProps = {};
    const c = colorOf(n);
    if (c && !n.fillStyle && existingColor.has(c)) props.fillStyle = existingColor.get(c)!;
    if (n.text && !n.textStyle && textIds.has(textKey(n))) props.textStyle = textIds.get(textKey(n))!;
    if (n.shadows?.length && !n.effectStyle && fxIds.has(JSON.stringify(n.shadows))) props.effectStyle = fxIds.get(JSON.stringify(n.shadows))!;
    if (Object.keys(props).length) ops.push({ kind: "update", id: n.id, props });
  }
  return { ops, counts: { colors, texts, effects } };
}

const WEIGHT_NAMES: Record<number, string> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

/** Nom lisible d'une couleur : « Bleu », « Gris clair », « Noir »… */
export function colorName(hex: string): string {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  const alpha = v.length === 8 ? ` ${Math.round((parseInt(v.slice(6), 16) / 255) * 100)} %` : "";
  if (s < 0.12 || max - min < 0.04) {
    if (l > 0.97) return "Blanc" + alpha;
    if (l < 0.08) return "Noir" + alpha;
    return (l > 0.7 ? "Gris clair" : l < 0.35 ? "Gris foncé" : "Gris") + alpha;
  }
  let h = 0;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  const hue = h < 15 || h >= 345 ? "Rouge" : h < 40 ? "Orange" : h < 65 ? "Jaune" : h < 160 ? "Vert" : h < 195 ? "Cyan" : h < 250 ? "Bleu" : h < 290 ? "Violet" : "Rose";
  return hue + (l > 0.75 ? " clair" : l < 0.3 ? " foncé" : "") + alpha;
}

/** Nom de variable CSS d'un style (« Bleu clair » → --color-bleu-clair). */
export function tokenName(prefix: string, name: string): string {
  const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `--${prefix}-${slug || "style"}`;
}
