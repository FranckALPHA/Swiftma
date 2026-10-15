// Design → projet React : un composant par nœud.
//
// Règle de modularité :
//  - le composant ENFANT décrit son apparence (taille, couleur, radius, texte…) dans son propre CSS ;
//  - le composant PARENT décide où l'enfant est posé (left/top/rotation) via une classe qu'il lui passe.
// Chaque composant reste donc réutilisable ailleurs, et la page entière reste fidèle au design.

import { type AutoLayout, type DesignDocument, type DesignNode, type DesignStyles, type Sizing } from "./model.js";
import { tokenName } from "./styles.js";
import { componentSetOf, variantProperties } from "./components.js";
import { type FontVariant, cssShadows, absolutePlacementCss, sizeBoundsCss, stretchesWithParent, cssEffects, cssFontStack, cssGradient, cssMask, cssStroke, fontVariants, googleFontUrls, invertMatrix, svgRadialGradient, svgStops } from "./paint.js";

/** Fichiers générés : du texte, ou du binaire encodé en base64 (images). */
export type FileMap = Record<string, string | { base64: string }>;

export interface ReactExportOptions {
  /** Inclure le squelette Vite (package.json, index.html, main.jsx…) pour obtenir un projet lançable. */
  project?: boolean;
}

interface Comp {
  node: DesignNode;
  name: string; // PascalCase unique
  parent: Comp | null;
  children: Comp[];
  /** Instance d'un composant réutilisable : rendue par <Def …props /> au lieu d'une copie de son contenu. */
  use?: { def: MainDef; props: Record<string, string>; style: Record<string, number> };
  /** Nœud qui fait partie de la définition d'un composant réutilisable. */
  inDef?: MainDef;
  /** Texte d'un composant réutilisable : son contenu peut venir d'une prop (via le contexte du composant). */
  textProp?: string;
  /** Racine d'une variante (ou du composant) : elle fournit le contexte des textes. */
  defRoot?: boolean;
}

/** Composant réutilisable exporté : un composant principal, ou un ensemble de variantes. */
interface MainDef {
  name: string; // nom du composant React (ex. Bouton)
  setId: string | null;
  variantProps: { prop: string; key: string; values: string[]; def: string }[];
  textProps: { prop: string; key: string; def: string }[]; // key = clé de texte (nom de calque + rang)
  variants: { componentId: string; comp: Comp; values: string[] }[];
}

export function exportReact(doc: DesignDocument, rootId: string, opts: ReactExportOptions = {}): FileMap {
  const root = doc.nodes[rootId];
  if (!root) throw new Error(`Nœud introuvable : ${rootId}`);

  TOKENS = buildTokens(doc.styles);

  // 1. Arbre des composants avec des noms uniques ; les instances deviennent des usages de composants réutilisables
  const used = new Set(["App", "React", "Fragment"]);
  const defs = new Map<string, MainDef>(); // id du composant principal ou de l'ensemble → définition
  const defining = new Set<string>();

  const defFor = (mainId: string): MainDef | null => {
    const main = doc.nodes[mainId];
    if (!main?.isComponent) return null;
    const setNode = componentSetOf(doc, mainId);
    const key = setNode?.id ?? mainId;
    const existing = defs.get(key);
    if (existing) return existing;
    if (defining.has(key)) return null; // composant qui se contient lui-même : rendu tel quel
    defining.add(key);
    const comps = setNode ? setNode.children.map((id) => doc.nodes[id]!).filter((c) => c.isComponent && c.visible) : [main];
    const def: MainDef = { name: uniqueBase(setNode?.name ?? main.name, used, "Composant"), setId: setNode?.id ?? null, variantProps: [], textProps: [], variants: [] };
    defs.set(key, def);
    if (setNode) {
      const props = variantProperties(doc, setNode.id);
      const propNames = new Set<string>();
      def.variantProps = Object.entries(props).map(([k, values]) => {
        let prop = camel(k) || "variante";
        for (let i = 2; propNames.has(prop) || RESERVED.has(prop); i++) prop = (camel(k) || "variante") + i;
        propNames.add(prop);
        return { prop, key: k, values, def: comps[0]?.variant?.[k] ?? values[0] ?? "" };
      });
    }
    // Props de texte : une par texte (hors instances imbriquées), réunies par nom de calque entre variantes
    const textPropNames = new Set([...def.variantProps.map((v) => v.prop), ...RESERVED]);
    for (const c of comps) {
      for (const [key, t] of textKeys(doc, c.id)) {
        if (def.textProps.some((x) => x.key === key)) continue;
        const [name, nth] = key.split("#");
        let prop = camel(name!) + (Number(nth) > 1 ? nth : "") || "texte";
        if (/^[0-9]/.test(prop)) prop = "texte" + prop;
        for (let i = 2; textPropNames.has(prop); i++) prop = (camel(name!) || "texte") + i;
        textPropNames.add(prop);
        def.textProps.push({ prop, key, def: t.text?.content ?? "" });
      }
    }
    for (const c of comps) {
      const values = def.variantProps.map((v) => c.variant?.[v.key] ?? v.def);
      const comp: Comp = {
        node: c,
        name: setNode ? uniqueBase(`${def.name} ${values.join(" ")}`, used, def.name) : def.name,
        parent: null,
        children: [],
        inDef: def,
        defRoot: true,
      };
      if (!setNode) used.add(def.name);
      const keys = new Map([...textKeys(doc, c.id)].map(([k, t]) => [t.id, k]));
      comp.children = kids(c).map((k) => build(k, comp, def, keys));
      def.variants.push({ componentId: c.id, comp, values });
    }
    defining.delete(key);
    return def;
  };

  const kids = (n: DesignNode) => n.children.map((id) => doc.nodes[id]!).filter((c) => c.visible);

  const build = (node: DesignNode, parent: Comp | null, inDef?: MainDef, keys?: Map<string, string>): Comp => {
    // Instance (ou composant principal posé dans la page) → usage du composant réutilisable
    const mainId = node.instanceOf ?? (node.isComponent && parent ? node.id : null);
    if (mainId && parent) {
      const def = defFor(mainId);
      const props = def ? usageProps(doc, node, mainId, def) : null;
      if (def && props) {
        const variantRoot = doc.nodes[mainId]!;
        const style: Record<string, number> = {};
        if (sizingOfNode(node, "h") === "fixed" && Math.abs(node.width - variantRoot.width) > 0.01) style.width = r(node.width);
        if (sizingOfNode(node, "v") === "fixed" && Math.abs(node.height - variantRoot.height) > 0.01) style.height = r(node.height);
        return { node, name: uniqueName(node, used), parent, children: [], use: { def, props, style }, inDef };
      }
    }
    const comp: Comp = { node, name: uniqueName(node, used), parent, children: [], inDef };
    if (inDef && node.type === "text" && keys?.has(node.id)) comp.textProp = inDef.textProps.find((t) => t.key === keys.get(node.id))?.prop;
    comp.children = kids(node).map((c) => build(c, comp, inDef, keys));
    return comp;
  };
  const tree = build(root, null);

  // 2. Un fichier .jsx + un .module.css par composant ; un fichier par composant réutilisable
  const files: FileMap = {};
  const walk = (c: Comp) => {
    if (c.use) return; // rendu par son composant réutilisable
    const dir = `src/components/${c.name}`;
    const asset = c.node.image ? imageAsset(c) : null;
    if (asset?.file) files[asset.file.path] = { base64: asset.file.base64 };
    files[`${dir}/${c.name}.jsx`] = componentJsx(c, asset?.importPath ?? null);
    files[`${dir}/${c.name}.module.css`] = componentCss(c);
    c.children.forEach(walk);
  };
  walk(tree);
  for (const def of defs.values()) {
    def.variants.forEach((v) => walk(v.comp));
    files[`src/components/${def.name}/${def.name}Textes.js`] =
      `// Textes de ${def.name} : passés en props au composant, lus par ses éléments de texte.
` +
      `import { createContext } from "react";

export const ${def.name}Textes = createContext({});
`;
    if (def.setId) files[`src/components/${def.name}/${def.name}.jsx`] = variantsJsx(def);
  }

  if (TOKENS.css) files["src/styles/tokens.css"] = TOKENS.css;
  files["STRUCTURE.md"] = structureMd(tree, [...defs.values()]);
  const all = [...allNodes(tree), ...[...defs.values()].flatMap((d) => d.variants.flatMap((v) => allNodes(v.comp)))];
  if (opts.project !== false) Object.assign(files, projectFiles(tree, fontVariants(all), !!TOKENS.css));
  TOKENS = null;
  return files;
}

// ---------- Styles partagés → variables CSS ----------

interface Tokens {
  css: string;
  color: Map<string, string>;
  text: Map<string, Record<"family" | "size" | "weight" | "line" | "spacing", string>>;
  effect: Map<string, string>;
}
let TOKENS: Tokens | null = null;

function buildTokens(styles: DesignStyles | undefined): Tokens {
  const t: Tokens = { css: "", color: new Map(), text: new Map(), effect: new Map() };
  if (!styles) return t;
  const taken = new Set<string>();
  const unique = (prefix: string, name: string) => {
    const base = tokenName(prefix, name);
    let v = base;
    for (let i = 2; taken.has(v); i++) v = `${base}-${i}`;
    taken.add(v);
    return v;
  };
  const lines: string[] = [];
  for (const [id, c] of Object.entries(styles.colors ?? {})) {
    const v = unique("color", c.name);
    t.color.set(id, v);
    lines.push(`  ${v}: ${c.value}; /* ${c.name} */`);
  }
  for (const [id, s] of Object.entries(styles.texts ?? {})) {
    const base = unique("text", s.name);
    const vars = { family: `${base}-family`, size: `${base}-size`, weight: `${base}-weight`, line: `${base}-line-height`, spacing: `${base}-letter-spacing` };
    t.text.set(id, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, `var(${v})`])) as Tokens["text"] extends Map<string, infer V> ? V : never);
    lines.push(
      `  /* ${s.name} */`,
      `  ${vars.family}: ${cssFontStack({ fontFamily: s.fontFamily })};`,
      `  ${vars.size}: ${px(s.fontSize)};`,
      `  ${vars.weight}: ${s.fontWeight};`,
      `  ${vars.line}: ${s.lineHeight};`,
      `  ${vars.spacing}: ${s.letterSpacing ?? 0}px;`,
    );
  }
  for (const [id, e] of Object.entries(styles.effects ?? {})) {
    const shadow = cssShadows({ type: "rect", fill: "#000", gradient: null }, e.shadows).boxShadow;
    if (!shadow) continue;
    const v = unique("shadow", e.name);
    t.effect.set(id, v);
    lines.push(`  ${v}: ${shadow}; /* ${e.name} */`);
  }
  if (lines.length) t.css = `/* Styles partagés du design (générés par Nyota) : modifiez-les ici, tout le site suit. */\n:root {\n${lines.join("\n")}\n}\n`;
  return t;
}

/** Variable CSS d'un style de couleur, si l'élément y est lié. */
const cv = (id: string | null | undefined) => (id && TOKENS?.color.has(id) ? `var(${TOKENS.color.get(id)})` : null);
/** Variable CSS d'une propriété d'un style de texte. */
const tv = (id: string | null | undefined, k: "family" | "size" | "weight" | "line" | "spacing") => (id && TOKENS?.text.get(id)?.[k]) || null;

const RESERVED = new Set(["className", "style", "children", "key", "ref", "text", "src", "alt"]);

/** Textes d'un composant (hors instances imbriquées), avec une clé stable : nom de calque + rang parmi les homonymes. */
function textKeys(doc: DesignDocument, rootId: string): Map<string, DesignNode> {
  const out = new Map<string, DesignNode>();
  const seen = new Map<string, number>();
  const walk = (id: string, top: boolean) => {
    const n = doc.nodes[id]!;
    if (!top && n.instanceOf) return;
    if (n.type === "text" && n.visible) {
      const nth = (seen.get(n.name) ?? 0) + 1;
      seen.set(n.name, nth);
      out.set(`${n.name}#${nth}`, n);
    }
    n.children.forEach((c) => walk(c, false));
  };
  walk(rootId, true);
  return out;
}

/**
 * Props d'une instance : variante et textes surchargés. null si l'instance a d'autres surcharges (couleur, position…),
 * qui ne s'expriment pas en props : elle est alors exportée telle quelle, pour rester fidèle.
 */
function usageProps(doc: DesignDocument, inst: DesignNode, mainId: string, def: MainDef): Record<string, string> | null {
  const props: Record<string, string> = {};
  const main = doc.nodes[mainId]!;
  for (const v of def.variantProps) props[v.prop] = main.variant?.[v.key] ?? v.def;
  if (inst.isComponent) return props; // le composant principal lui-même, posé dans la page
  if ((inst.overrides ?? []).some((o) => o !== "width" && o !== "height")) return null;
  const keyOf = new Map([...textKeys(doc, mainId)].map(([k, t]) => [t.id, k]));
  let ok = true;
  const walk = (id: string, top: boolean) => {
    const n = doc.nodes[id]!;
    if (!top) {
      const over = n.overrides ?? [];
      if (n.instanceOf && n.sourceId) {
        // Instance imbriquée : acceptée seulement si elle n'a aucune surcharge (elle est alors identique au composant)
        if (hasOverrides(doc, n.id)) ok = false;
        return;
      }
      if (over.some((o) => o !== "text.content")) ok = false;
      if (over.includes("text.content")) {
        const key = n.sourceId ? keyOf.get(n.sourceId) : undefined;
        const tp = key ? def.textProps.find((t) => t.key === key) : undefined;
        if (!tp) ok = false;
        else props[tp.prop] = n.text?.content ?? "";
      }
    }
    n.children.forEach((c) => walk(c, false));
  };
  walk(inst.id, true);
  return ok ? props : null;
}

function hasOverrides(doc: DesignDocument, id: string): boolean {
  const n = doc.nodes[id]!;
  return !!n.overrides?.length || n.children.some((c) => hasOverrides(doc, c));
}

const sizingOfNode = (n: DesignNode, axis: "h" | "v") => (axis === "h" ? n.sizingH : n.sizingV) ?? "fixed";

/** Composant d'un ensemble de variantes : choisit la variante selon ses props. */
function variantsJsx(def: MainDef): string {
  const imports = def.variants.map((v) => `import ${v.comp.name} from "../${v.comp.name}/${v.comp.name}.jsx";`);
  const table = def.variants.map((v) => `  ${JSON.stringify(v.values.join(" / "))}: ${v.comp.name},`);
  const params = def.variantProps.map((v) => `${v.prop} = ${JSON.stringify(v.def)}`);
  const docs = def.variantProps.map((v) => `//   ${v.prop} : ${v.values.map((x) => JSON.stringify(x)).join(" | ")}`);
  return [
    `// ${def.name} — composant à variantes (généré par Nyota)`,
    `// Props de variante :`,
    ...docs,
    ...(def.textProps.length ? [`// Textes : ${def.textProps.map((t) => t.prop).join(", ")}`] : []),
    "",
    ...imports,
    "",
    "const VARIANTES = {",
    ...table,
    "};",
    "",
    `export default function ${def.name}({ ${[...params, "...props"].join(", ")} }) {`,
    `  const Variante = VARIANTES[[${def.variantProps.map((v) => v.prop).join(", ")}].join(" / ")] ?? ${def.variants[0]!.comp.name};`,
    "  return <Variante {...props} />;",
    "}",
    "",
  ].join("\n");
}

// ---------- Composants ----------

function componentJsx(c: Comp, imageImport: string | null): string {
  const { node } = c;
  const kind = { frame: "Frame", rect: "Rectangle", ellipse: "Ellipse", text: "Texte", path: "Vecteur", image: "Image" }[node.type];
  const header = [
    `// ${c.name} — ${kind} « ${node.name} » (généré par Nyota, id ${node.id})`,
    `// Parent : ${c.parent ? c.parent.name : "aucun (composant racine)"}`,
    ...(c.children.length ? [`// Enfants : ${c.children.map((k) => k.name).join(", ")}`] : []),
  ];
  const imports = [
    `import styles from "./${c.name}.module.css";`,
    ...[...new Set(c.children.map((k) => (k.use ? `import ${k.use.def.name} from "../${k.use.def.name}/${k.use.def.name}.jsx";` : `import ${k.name} from "../${k.name}/${k.name}.jsx";`)))],
  ];
  const ctx = c.inDef ? `${c.inDef.name}Textes` : "";
  if (c.textProp) imports.unshift(`import { useContext } from "react";`);
  if (c.textProp || c.defRoot) imports.push(`import { ${ctx} } from "../${c.inDef!.name}/${c.inDef!.name}Textes.js";`);
  const cx = "[styles.root, className].filter(Boolean).join(\" \")";

  let body: string;
  if (node.type === "image" && node.image) {
    const src = imageImport ? "imageSrc" : JSON.stringify(node.image.src);
    if (imageImport) imports.push(`import imageSrc from "${imageImport}";`);
    body = node.image.crop
      ? `export default function ${c.name}({ className, style, src = ${src}, alt = ${JSON.stringify(node.name)} }) {\n` +
        `  return (\n` +
        `    <div className={${cx}} style={style} data-nyota="${c.name}">\n` +
        `      <img className={styles.image} src={src} alt={alt} />\n` +
        `    </div>\n` +
        `  );\n` +
        `}\n`
      : `export default function ${c.name}({ className, style, src = ${src}, alt = ${JSON.stringify(node.name)} }) {\n` +
        `  return <img className={${cx}} style={style} src={src} alt={alt} data-nyota="${c.name}" />;\n` +
        `}\n`;
  } else if (node.type === "path" && node.path) {
    const p = node.path;
    const gid = `nyota-${c.name}`;
    const attrs = [
      `d=${JSON.stringify(p.d)}`,
      isIdentity(p.matrix) ? "" : `transform="matrix(${p.matrix.map(r4).join(" ")})"`,
      node.gradient ? `fill="url(#${gid})"` : `fill=${JSON.stringify(node.fill ?? "none")}`,
      p.fillRule === "evenodd" ? `fillRule="evenodd"` : "",
      node.stroke ? svgStrokeAttrs(node.stroke) : "",
    ].filter(Boolean);
    body =
      `export default function ${c.name}({ className, style }) {\n` +
      `  return (\n` +
      `    <svg className={${cx}} style={style} viewBox="0 0 ${r(node.width) || 1} ${r(node.height) || 1}" data-nyota="${c.name}">\n` +
      (node.gradient ? `      <defs>${svgGradient(gid, node)}</defs>\n` : "") +
      `      <path ${attrs.join(" ")} />\n` +
      `    </svg>\n` +
      `  );\n` +
      `}\n`;
  } else if (node.type === "text" && c.textProp) {
    // Texte d'un composant réutilisable : la prop « ${c.textProp} » du composant, sinon le texte du design
    const def = JSON.stringify(node.text?.content ?? "");
    body =
      `export default function ${c.name}({ className, style, text }) {\n` +
      `  const textes = useContext(${ctx});\n` +
      `  return (\n` +
      `    <p className={${cx}} style={style} data-nyota="${c.name}">\n` +
      `      {text ?? textes.${c.textProp} ?? ${def}}\n` +
      `    </p>\n` +
      `  );\n` +
      `}\n`;
  } else if (node.type === "text") {
    const def = JSON.stringify(node.text?.content ?? "");
    body =
      `export default function ${c.name}({ className, style, text = ${def} }) {\n` +
      `  return (\n` +
      `    <p className={${cx}} style={style} data-nyota="${c.name}">\n` +
      `      {text}\n` +
      `    </p>\n` +
      `  );\n` +
      `}\n`;
  } else {
    const kids = c.children.map((k) => (k.use ? usageJsx(k, `styles.${slotClass(k)}`) : `      <${k.name} className={styles.${slotClass(k)}} />`));
    const inner = [...kids, "      {children}"];
    body = c.defRoot
      ? `export default function ${c.name}({ className, style, children, ...textes }) {\n` +
        `  return (\n` +
        `    <${ctx}.Provider value={textes}>\n` +
        `      <div className={${cx}} style={style} data-nyota="${c.name}">\n` +
        inner.map((l) => "  " + l).join("\n") +
        `\n      </div>\n` +
        `    </${ctx}.Provider>\n` +
        `  );\n` +
        `}\n`
      : `export default function ${c.name}({ className, style, children }) {\n` +
        `  return (\n` +
        `    <div className={${cx}} style={style} data-nyota="${c.name}">\n` +
        inner.join("\n") +
        `\n    </div>\n` +
        `  );\n` +
        `}\n`;
  }
  return `${header.join("\n")}\n\n${imports.join("\n")}\n\n${body}`;
}

function componentCss(c: Comp): string {
  const n = c.node;
  const sw = sizing(c, "h");
  const sh = sizing(c, "v");
  // Largeur : fixe, ajustée au contenu, ou toute la place (racine) ; un enfant « remplir » est dimensionné par son parent
  // (dans une colonne en auto-layout, la largeur max est posée par le parent avec le garde-fou responsive)
  const capped = flows(c) && c.parent!.node.layout!.direction === "column" && sizing(c, "h") !== "fill";
  const root: string[] = ["box-sizing: border-box", ...sizeBoundsCss(capped ? { ...n, maxWidth: null } : n)];
  if (sw === "fixed") root.push(`width: ${px(n.width)}`);
  else if (sw === "hug") root.push("width: fit-content");
  else if (!c.parent) root.push("width: 100%");
  const height = (): string[] => (sh === "fixed" ? [`height: ${px(n.height)}`] : sh === "hug" ? ["height: fit-content"] : []);
  if (n.type === "text" && n.text) {
    // Le texte peut déborder de sa boîte en hauteur, comme dans l'éditeur.
    root.push(
      ...(sh === "fixed" ? [`min-height: ${px(n.height)}`] : []),
      "margin: 0",
      `font-family: ${tv(n.textStyle, "family") ?? cssFontStack(n.text)}`,
      `font-size: ${tv(n.textStyle, "size") ?? px(n.text.fontSize)}`,
      `font-weight: ${tv(n.textStyle, "weight") ?? n.text.fontWeight}`,
      ...(n.text.italic ? ["font-style: italic"] : []),
      ...(n.text.letterSpacing ? [`letter-spacing: ${tv(n.textStyle, "spacing") ?? `${n.text.letterSpacing}px`}`] : []),
      ...(n.text.decoration ? [`text-decoration: ${n.text.decoration}`] : []),
      // Contour des lettres, centré sur leur tracé comme en SVG
      ...(n.stroke && n.stroke.width > 0 ? [`-webkit-text-stroke: ${px(n.stroke.width)} ${n.stroke.color}`] : []),
      `line-height: ${tv(n.textStyle, "line") ?? n.text.lineHeight}`,
      ...(n.gradient
        ? [`background: ${cssGradient(n.gradient, n.width, n.height)}`, "-webkit-background-clip: text", "background-clip: text", "color: transparent"]
        : [`color: ${cv(n.fillStyle) ?? n.text.color}`]),
      `text-align: ${n.text.align}`,
      "white-space: pre-wrap",
      "overflow-wrap: break-word",
    );
  } else if (n.type === "path") {
    // Le vecteur est dessiné par le <svg> lui-même ; on garde un débordement visible pour les contours.
    root.push(...height(), "display: block", "overflow: visible");
  } else if (n.type === "image") {
    root.push(...height(), "display: block");
    if (n.image?.crop) root.push("overflow: hidden");
    else root.push("object-fit: cover");
    if (n.radius) root.push(`border-radius: ${px(n.radius)}`);
  } else {
    root.push(...height());
    if (n.layout) root.push(...flexCss(n.layout));
    if (n.gradient) root.push(`background: ${cssGradient(n.gradient, n.width, n.height)}`);
    else if (n.fill) root.push(`background: ${cv(n.fillStyle) ?? n.fill}`);
    if (n.type === "ellipse") root.push("border-radius: 50%");
    else if (n.radius) root.push(`border-radius: ${px(n.radius)}`);
    if (n.type === "frame" && n.clip) {
      root.push("overflow: hidden");
      if (n.clipPath) {
        const mask = cssMask(n.clipPath, n.width, n.height);
        root.push(`-webkit-mask: ${mask}`, `mask: ${mask}`); // forme libre du masque
      }
    }
  }
  // Contour centré sur le bord (moitié dehors, moitié dedans), dessiné par deux box-shadow : plus fidèle que
  // « outline », dont le décalage fractionnaire est arrondi par les navigateurs
  const strokeShadow = n.stroke && n.stroke.width > 0 && n.type !== "path" && n.type !== "text" ? cssStroke({ ...n.stroke, color: cv(n.strokeStyle) ?? n.stroke.color }) : null;
  if (n.opacity !== 1) root.push(`opacity: ${n.opacity}`);
  const fx = cssEffects(n);
  // Ombres d'un style partagé : sa variable CSS (même valeur)
  if (fx.boxShadow && n.effectStyle && TOKENS?.effect.has(n.effectStyle)) fx.boxShadow = `var(${TOKENS.effect.get(n.effectStyle)})`;
  const boxShadow = [strokeShadow, fx.boxShadow].filter(Boolean).join(", ");
  if (boxShadow) root.push(`box-shadow: ${boxShadow}`);
  if (fx.filter) root.push(`filter: ${fx.filter}`);
  if (fx.backdropFilter) root.push(`backdrop-filter: ${fx.backdropFilter}`, `-webkit-backdrop-filter: ${fx.backdropFilter}`);

  const extra: string[] = [];
  const crop = n.image?.crop;
  if (crop) {
    // Image recadrée : on l'agrandit puis on la décale pour ne montrer que la zone voulue
    const w = n.width / crop.width;
    const h = n.height / crop.height;
    extra.push(
      `/* Recadrage de l'image (identique au design) */\n.image {\n  position: absolute;\n  display: block;\n  max-width: none;\n` +
        `  width: ${px(w)};\n  height: ${px(h)};\n  left: ${px(-crop.x * w)};\n  top: ${px(-crop.y * h)};\n}`,
    );
  }
  const blocks = [
    `/* Apparence de ${c.name} */\n.root {\n  ${root.join(";\n  ")};\n}`,
    // Spécificité nulle : le placement décidé par le parent (position: absolute) l'emporte toujours,
    // quel que soit l'ordre de chargement des fichiers CSS.
    `/* Par défaut (composant utilisé seul) */\n:where(.root) {\n  position: relative;\n}`,
    ...extra,
  ];

  // Placement des enfants : c'est le parent qui décide où ils vont.
  for (const k of c.children) {
    if (flows(k)) {
      // Dans l'auto-layout : pas de coordonnées, le flexbox les place ; on dit seulement comment l'enfant se dimensionne
      const row = n.layout!.direction === "row";
      const p = ["position: relative"];
      if (sizing(k, row ? "h" : "v") === "fill") p.push("flex: 1 1 0", row ? "min-width: 0" : "min-height: 0");
      else p.push("flex-shrink: 0");
      if (sizing(k, row ? "v" : "h") === "fill") p.push("align-self: stretch");
      // Responsive : un élément de largeur fixe ne déborde pas d'un parent devenu plus étroit
      if (!row && sizing(k, "h") !== "fill") p.push(k.node.maxWidth ? `max-width: min(100%, ${px(k.node.maxWidth)})` : "max-width: 100%");
      blocks.push(`/* ${k.name} dans l'auto-layout de ${c.name} */\n.${slotClass(k)} {\n  ${p.join(";\n  ")};\n}`);
      continue;
    }
    const p = absolutePlacementCss(k.node, n.width, n.height);
    blocks.push(`/* Placement de ${k.name} dans ${c.name} */\n.${slotClass(k)} {\n  ${p.join(";\n  ")};\n}`);
  }
  return blocks.join("\n\n") + "\n";
}

/** Le nœud suit-il l'auto-layout de son parent ? */
const flows = (c: Comp) => !!c.parent?.node.layout && !c.node.absolute;

/** Dimensionnement effectif : « remplir » n'a de sens que dans un auto-layout (ou pour la racine, en largeur),
 *  « ajuster » que pour une frame en auto-layout. Sinon : taille fixe. */
function sizing(c: Comp, axis: "h" | "v"): Sizing {
  const s = (axis === "h" ? c.node.sizingH : c.node.sizingV) ?? "fixed";
  // Remplir un parent qui s'ajuste à son contenu ne veut rien dire (il n'aurait plus de taille) : taille fixe, comme dans Figma
  if (s === "fill" && flows(c) && sizing(c.parent!, axis) !== "hug") return "fill";
  if (s === "fill" && !c.parent && axis === "h") return "fill";
  // Ancré des deux côtés (ou à l'échelle) : la taille vient du placement décidé par le parent
  if (c.parent && !flows(c) && stretchesWithParent(c.node, axis)) return "fill";
  if (s === "hug" && (c.node.layout || c.node.type === "text")) return "hug";
  return "fixed";
}

/** Auto-layout → flexbox. */
function flexCss(L: AutoLayout): string[] {
  const row = L.direction === "row";
  const wrap = row && L.wrap;
  const [t, r_, b, l] = L.padding;
  const flex = { start: "flex-start", center: "center", end: "flex-end", "space-between": "space-between" };
  return [
    "display: flex",
    `flex-direction: ${L.direction}`,
    ...(wrap ? ["flex-wrap: wrap", "align-content: flex-start", `gap: ${px(L.wrapGap ?? L.gap)} ${px(L.gap)}`] : L.gap ? [`gap: ${px(L.gap)}`] : []),
    ...(t || r_ || b || l ? [`padding: ${[t, r_, b, l].map(px).join(" ")}`] : []),
    ...(L.justify !== "start" ? [`justify-content: ${flex[L.justify]}`] : []),
    `align-items: ${flex[L.align]}`,
  ];
}

// ---------- Projet ----------

function projectFiles(tree: Comp, fonts: FontVariant[], tokens: boolean): FileMap {
  const slug = kebab(tree.node.name) || "nyota-export";
  // Un <link> par famille : une variante inexistante ne fait pas échouer les autres polices
  const fontLink = fonts.length
    ? `    <link rel="preconnect" href="https://fonts.googleapis.com" />\n` +
      `    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n` +
      googleFontUrls(fonts).map((f) => `    <link href="${f.url.replace(/&/g, "&amp;")}" rel="stylesheet" />\n`).join("")
    : "";
  return {
    "package.json": JSON.stringify(
      {
        name: slug,
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
        dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" },
        devDependencies: { "@vitejs/plugin-react": "^5.0.4", vite: "^7.1.12" },
      },
      null,
      2,
    ) + "\n",
    "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`,
    "index.html":
      `<!doctype html>\n<html lang="fr">\n  <head>\n    <meta charset="UTF-8" />\n` +
      `    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n` +
      `    <title>${escapeHtml(tree.node.name)}</title>\n    <link rel="icon" href="data:," />\n${fontLink}  </head>\n  <body>\n` +
      `    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
    "src/main.jsx":
      `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n` +
      (tokens ? `import "./styles/tokens.css";\n` : "") +
      `import "./index.css";\n\n` +
      `createRoot(document.getElementById("root")).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
    "src/App.jsx":
      `import ${tree.name} from "./components/${tree.name}/${tree.name}.jsx";\n\n` +
      `export default function App() {\n  return (\n    <main className="stage">\n      <${tree.name} />\n    </main>\n  );\n}\n`,
    "src/index.css":
      `*, *::before, *::after { box-sizing: border-box; }\nbody { margin: 0; background: #e5e5e5; }\n` +
      // Maquette responsive (la racine prend toute la largeur) : pleine page ; sinon, centrée comme une maquette
      (tree.node.sizingH === "fill"
        ? `.stage { min-height: 100vh; }\n`
        : `.stage { min-height: 100vh; display: grid; place-items: center; padding: 40px; }\n`),
    "README.md":
      `# ${tree.node.name}\n\nExport React généré par **Nyota** : un composant par élément du design.\n\n` +
      "```bash\nnpm install\nnpm run dev\n```\n\n" +
      `- Chaque composant est dans \`src/components/<Nom>/\` (\`.jsx\` + \`.module.css\`).\n` +
      `- Le CSS d'un composant décrit **son apparence** ; le CSS de son parent décrit **où il est placé**.\n` +
      `- Tous les composants acceptent \`className\` et \`style\` ; les textes acceptent \`text\` ; les conteneurs acceptent \`children\`.\n` +
      `- L'arbre complet est dans [STRUCTURE.md](STRUCTURE.md).\n`,
  };
}

/** Usage d'un composant réutilisable dans son parent : <Bouton className=… etat="Survol" libelle="Payer" />. */
function usageJsx(k: Comp, cls: string): string {
  const u = k.use!;
  const attrs = [`className={${cls}}`, ...Object.entries(u.props).map(([p, v]) => `${p}=${jsxString(v)}`)];
  if (Object.keys(u.style).length) attrs.push(`style={${JSON.stringify(u.style)}}`);
  return `      <${u.def.name} ${attrs.join(" ")} />`;
}

const jsxString = (v: string) => (/^[^"\\{}<>\n]*$/.test(v) ? JSON.stringify(v) : `{${JSON.stringify(v)}}`);

function structureMd(tree: Comp, defs: MainDef[]): string {
  const lines: string[] = [];
  const walk = (c: Comp, depth: number, out: string[]) => {
    if (c.use) {
      const props = Object.entries(c.use.props).map(([p, v]) => `${p}=${JSON.stringify(v)}`).join(" ");
      out.push(`${"  ".repeat(depth)}- **<${c.use.def.name}${props ? " " + props : ""} />** — instance « ${c.node.name} »`);
      return;
    }
    out.push(`${"  ".repeat(depth)}- **${c.name}** — ${c.node.type} « ${c.node.name} » (${r(c.node.width)}×${r(c.node.height)})`);
    c.children.forEach((k) => walk(k, depth + 1, out));
  };
  walk(tree, 0, lines);
  let md = `# Structure des composants\n\nQui contient qui (le parent pose ses enfants) :\n\n${lines.join("\n")}\n`;
  if (defs.length) {
    md += `\n## Composants réutilisables\n\nChaque instance du design utilise le même composant, avec ses props :\n`;
    for (const d of defs) {
      md += `\n### ${d.name}\n\n`;
      for (const v of d.variantProps) md += `- \`${v.prop}\` (variante « ${v.key} ») : ${v.values.map((x) => `\`${x}\``).join(", ")} — défaut \`${v.def}\`\n`;
      for (const t of d.textProps) md += `- \`${t.prop}\` (texte) — défaut ${JSON.stringify(t.def)}\n`;
      for (const v of d.variants) {
        const sub: string[] = [];
        walk(v.comp, 0, sub);
        md += `\n${d.variants.length > 1 ? `Variante ${v.values.join(" / ")} :\n\n` : ""}${sub.join("\n")}\n`;
      }
    }
  }
  return md;
}

// ---------- Utilitaires ----------

function uniqueBase(label: string, used: Set<string>, fallback: string): string {
  let base = pascal(label);
  if (!base || !/^[A-Z]/.test(base)) base = fallback + base;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

const camel = (s: string) => {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : "";
};

function uniqueName(node: DesignNode, used: Set<string>): string {
  let base = pascal(node.name);
  if (!base || !/^[A-Z]/.test(base)) base = pascal(node.type) + base;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

const words = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
const pascal = (s: string) => words(s).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
const kebab = (s: string) => words(s).join("-").toLowerCase();
const slotClass = (c: Comp) => "slot" + c.name;
const px = (v: number) => `${r(v)}px`;
const r = (v: number) => Math.round(v * 100) / 100;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Image en data URL → fichier dans src/assets/ ; une URL distante reste telle quelle. */
function imageAsset(c: Comp): { importPath: string | null; file: { path: string; base64: string } | null } {
  const m = /^data:image\/([a-z+]+);base64,(.*)$/i.exec(c.node.image!.src);
  if (!m) return { importPath: null, file: null };
  const ext = m[1]!.toLowerCase().replace("jpeg", "jpg").replace("svg+xml", "svg");
  const name = `${c.name}.${ext}`;
  return { importPath: `../../assets/${name}`, file: { path: `src/assets/${name}`, base64: m[2]! } };
}

/** Dégradé d'un vecteur : défini en pixels du nœud, ramené dans le repère du tracé par l'inverse de sa matrice. */
function svgGradient(id: string, n: DesignNode): string {
  const g = n.gradient!;
  const inv = `matrix(${invertMatrix(n.path!.matrix).map(r4).join(" ")})`;
  if (g.type === "radial") return svgRadialGradient(id, g, n.width, n.height, inv, true);
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" gradientTransform="${inv}" x1="${r(g.start[0] * n.width)}" y1="${r(g.start[1] * n.height)}" x2="${r(g.end[0] * n.width)}" y2="${r(g.end[1] * n.height)}">${svgStops(g, true)}</linearGradient>`;
}

/** Contour d'un vecteur. L'épaisseur est en pixels du nœud : elle ne doit pas suivre la matrice du tracé
 *  (non-scaling-stroke), comme dans l'éditeur et dans Figma. */
function svgStrokeAttrs(st: NonNullable<DesignNode["stroke"]>): string {
  return [
    `stroke=${JSON.stringify(st.color)} strokeWidth={${st.width}} vectorEffect="non-scaling-stroke"`,
    st.cap && st.cap !== "butt" ? `strokeLinecap="${st.cap}"` : "",
    st.join && st.join !== "miter" ? `strokeLinejoin="${st.join}"` : "",
    st.dash?.length ? `strokeDasharray="${st.dash.map(r4).join(" ")}"` : "",
    st.miterLimit && st.miterLimit !== 4 ? `strokeMiterlimit={${st.miterLimit}}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const isIdentity = (m: number[]) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

function allNodes(c: Comp, out: DesignNode[] = []): DesignNode[] {
  out.push(c.node);
  c.children.forEach((k) => allNodes(k, out));
  return out;
}
