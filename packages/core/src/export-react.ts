// Design → projet React : un composant par nœud.
//
// Règle de modularité :
//  - le composant ENFANT décrit son apparence (taille, couleur, radius, texte…) dans son propre CSS ;
//  - le composant PARENT décide où l'enfant est posé (left/top/rotation) via une classe qu'il lui passe.
// Chaque composant reste donc réutilisable ailleurs, et la page entière reste fidèle au design.

import { type AutoLayout, type DesignDocument, type DesignNode, type Sizing } from "./model.js";
import { type FontVariant, cssEffects, cssFontStack, cssGradient, cssMask, cssStroke, fontVariants, googleFontUrls, invertMatrix, svgRadialGradient, svgStops } from "./paint.js";

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
}

export function exportReact(doc: DesignDocument, rootId: string, opts: ReactExportOptions = {}): FileMap {
  const root = doc.nodes[rootId];
  if (!root) throw new Error(`Nœud introuvable : ${rootId}`);

  // 1. Arbre des composants avec des noms uniques
  const used = new Set(["App", "React", "Fragment"]);
  const build = (node: DesignNode, parent: Comp | null): Comp => {
    const comp: Comp = { node, name: uniqueName(node, used), parent, children: [] };
    comp.children = node.children
      .map((id) => doc.nodes[id]!)
      .filter((c) => c.visible)
      .map((c) => build(c, comp));
    return comp;
  };
  const tree = build(root, null);

  // 2. Un fichier .jsx + un .module.css par composant
  const files: FileMap = {};
  const walk = (c: Comp) => {
    const dir = `src/components/${c.name}`;
    const asset = c.node.image ? imageAsset(c) : null;
    if (asset?.file) files[asset.file.path] = { base64: asset.file.base64 };
    files[`${dir}/${c.name}.jsx`] = componentJsx(c, asset?.importPath ?? null);
    files[`${dir}/${c.name}.module.css`] = componentCss(c);
    c.children.forEach(walk);
  };
  walk(tree);

  files["STRUCTURE.md"] = structureMd(tree);
  if (opts.project !== false) Object.assign(files, projectFiles(tree, fontVariants(allNodes(tree))));
  return files;
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
    ...c.children.map((k) => `import ${k.name} from "../${k.name}/${k.name}.jsx";`),
  ];
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
    const kids = c.children.map((k) => `      <${k.name} className={styles.${slotClass(k)}} />`);
    body =
      `export default function ${c.name}({ className, style, children }) {\n` +
      `  return (\n` +
      `    <div className={${cx}} style={style} data-nyota="${c.name}">\n` +
      [...kids, "      {children}"].join("\n") +
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
  const root: string[] = ["box-sizing: border-box"];
  if (sw === "fixed") root.push(`width: ${px(n.width)}`);
  else if (sw === "hug") root.push("width: fit-content");
  else if (!c.parent) root.push("width: 100%");
  const height = (): string[] => (sh === "fixed" ? [`height: ${px(n.height)}`] : sh === "hug" ? ["height: fit-content"] : []);
  if (n.type === "text" && n.text) {
    // Le texte peut déborder de sa boîte en hauteur, comme dans l'éditeur.
    root.push(
      ...(sh === "fixed" ? [`min-height: ${px(n.height)}`] : []),
      "margin: 0",
      `font-family: ${cssFontStack(n.text)}`,
      `font-size: ${px(n.text.fontSize)}`,
      `font-weight: ${n.text.fontWeight}`,
      ...(n.text.italic ? ["font-style: italic"] : []),
      ...(n.text.letterSpacing ? [`letter-spacing: ${n.text.letterSpacing}px`] : []),
      ...(n.text.decoration ? [`text-decoration: ${n.text.decoration}`] : []),
      // Contour des lettres, centré sur leur tracé comme en SVG
      ...(n.stroke && n.stroke.width > 0 ? [`-webkit-text-stroke: ${px(n.stroke.width)} ${n.stroke.color}`] : []),
      `line-height: ${n.text.lineHeight}`,
      ...(n.gradient
        ? [`background: ${cssGradient(n.gradient, n.width, n.height)}`, "-webkit-background-clip: text", "background-clip: text", "color: transparent"]
        : [`color: ${n.text.color}`]),
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
    else if (n.fill) root.push(`background: ${n.fill}`);
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
  const strokeShadow = n.stroke && n.stroke.width > 0 && n.type !== "path" && n.type !== "text" ? cssStroke(n.stroke) : null;
  if (n.opacity !== 1) root.push(`opacity: ${n.opacity}`);
  const fx = cssEffects(n);
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
      if (!row && sizing(k, "h") !== "fill") p.push("max-width: 100%");
      blocks.push(`/* ${k.name} dans l'auto-layout de ${c.name} */\n.${slotClass(k)} {\n  ${p.join(";\n  ")};\n}`);
      continue;
    }
    const p = [`position: absolute`, `left: ${px(k.node.x)}`, `top: ${px(k.node.y)}`];
    if (k.node.rotation) p.push(`transform: rotate(${k.node.rotation}deg)`, "transform-origin: top left");
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
  if (s === "hug" && c.node.layout) return "hug";
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

function projectFiles(tree: Comp, fonts: FontVariant[]): FileMap {
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
      `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./index.css";\n\n` +
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

function structureMd(tree: Comp): string {
  const lines: string[] = [];
  const walk = (c: Comp, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- **${c.name}** — ${c.node.type} « ${c.node.name} » (${r(c.node.width)}×${r(c.node.height)})`);
    c.children.forEach((k) => walk(k, depth + 1));
  };
  walk(tree, 0);
  return `# Structure des composants\n\nQui contient qui (le parent pose ses enfants) :\n\n${lines.join("\n")}\n`;
}

// ---------- Utilitaires ----------

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
