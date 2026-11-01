// Modèle de document Swiftma : un dictionnaire plat de nœuds + l'ordre des enfants.
// Plat = facile à modifier par opérations, facile à synchroniser, facile à lire pour une IA.

export type NodeType = "frame" | "rect" | "ellipse" | "text" | "path" | "image";

export interface Stroke {
  color: string;
  width: number;
  cap?: "butt" | "round" | "square"; // extrémités des traits
  join?: "miter" | "round" | "bevel"; // angles
  dash?: number[] | null; // pointillés : longueurs trait / espace…
  miterLimit?: number;
}

export interface TextStyle {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  italic?: boolean;
  letterSpacing?: number; // en px
  decoration?: string | null; // « underline », « line-through », « overline », combinables
  fallbackFonts?: string[]; // polices de secours, dans l'ordre (dont génériques : serif, monospace…)
}

/** Vecteur : données SVG d'origine + matrice qui les ramène dans le repère local du nœud. */
export interface PathData {
  d: string;
  fillRule: "nonzero" | "evenodd";
  matrix: [number, number, number, number, number, number]; // a b c d e f, comme en SVG
}

/** Masque de forme libre ; « fade » = opacité du masque variant selon un dégradé (fondu), alpha des couleurs. */
export interface ClipPath extends PathData {
  fade?: Gradient | null;
  parts?: PathData[]; // formes supplémentaires : la découpe est l'union de toutes les formes
}

export interface ImageData {
  src: string; // URL ou data URL
  /** Partie visible de l'image, en fractions de sa taille naturelle (0 à 1), étirée sur le nœud.
   *  Absent = remplissage « cover » centré. */
  crop?: { x: number; y: number; width: number; height: number };
}

export interface GradientStop {
  offset: number; // 0 à 1
  color: string; // #RRGGBB ou #RRGGBBAA
}

/** Dégradé. Les coordonnées sont en fractions de la boîte du nœud (0 à 1), il suit donc les redimensionnements. */
export interface Gradient {
  type: "linear" | "radial";
  stops: GradientStop[];
  start: [number, number]; // linéaire : point de départ ; radial : centre
  end: [number, number]; // linéaire : point d'arrivée
  radius?: [number, number]; // radial : rayons horizontal et vertical
  angle?: number; // radial : rotation de l'ellipse, en degrés
}

/** Ombre portée (« drop ») ou interne (« inner »), comme dans les outils de design. */
export interface Shadow {
  type: "drop" | "inner";
  x: number;
  y: number;
  blur: number; // rayon de flou, au sens CSS
  spread: number;
  color: string;
}

/** Auto-layout d'une frame (comme dans Figma, ou un conteneur flexbox) : ses enfants s'empilent tout seuls. */
export interface AutoLayout {
  direction: "row" | "column"; // horizontal ou vertical
  gap: number; // espace entre deux éléments, en px
  padding: [number, number, number, number]; // marges internes : haut, droite, bas, gauche
  justify: "start" | "center" | "end" | "space-between"; // répartition sur l'axe principal
  align: "start" | "center" | "end"; // alignement sur l'axe secondaire
  wrap?: boolean; // retour à la ligne (direction row uniquement)
  wrapGap?: number; // espace entre deux lignes (par défaut : gap)
}

/** Contraintes d'un élément en position libre : comment il suit son parent quand celui-ci change de taille. */
export interface Constraints {
  h: "left" | "right" | "left-right" | "center" | "scale";
  v: "top" | "bottom" | "top-bottom" | "center" | "scale";
}

/** Dimensionnement d'un nœud sur un axe : taille fixe, « remplir » le parent en auto-layout, ou « ajuster » au contenu. */
export type Sizing = "fixed" | "fill" | "hug";

/** Type d'animation ou d'interaction dynamique attachée à un calque. */
export type AnimationType =
  | "carousel"
  | "marquee"
  | "spin"
  | "pulse"
  | "shimmer"
  | "float"
  | "fade-in"
  | "reveal";

export interface NodeAnimation {
  type: AnimationType;
  /** Durée d'un cycle ou d'une transition en millisecondes (ex. 500, 2000). */
  duration?: number;
  /** Délai avant démarrage en millisecondes. */
  delay?: number;
  /** Fonction d'accélération CSS (ex. "ease", "linear", "cubic-bezier(0.22, 1, 0.36, 1)"). */
  easing?: string;
  /** Lecture en boucle infinie. */
  infinite?: boolean;
  /** Défilement automatique (pour un carrousel). */
  autoPlay?: boolean;
  /** Pas de défilement en pixels d'une carte (pour un carrousel). */
  stepPx?: number;
}

export const ANIMATION_PRESETS: { type: AnimationType; label: string; desc: string; defaultProps: NodeAnimation }[] = [
  { type: "carousel", label: "Carrousel horizontal", desc: "Piste coulissante interactive (Précédent / Suivant + auto-scroll)", defaultProps: { type: "carousel", duration: 500, easing: "cubic-bezier(0.22, 1, 0.36, 1)", infinite: true, autoPlay: true, stepPx: 304 } },
  { type: "marquee", label: "Défilement continu (Marquee)", desc: "Bandeau qui défile horizontalement en continu", defaultProps: { type: "marquee", duration: 18000, easing: "linear", infinite: true } },
  { type: "reveal", label: "Apparition au scroll (Reveal)", desc: "Fondu et translation douce à l'entrée dans l'écran", defaultProps: { type: "reveal", duration: 650, delay: 0, easing: "cubic-bezier(0.22, 1, 0.36, 1)", infinite: false } },
  { type: "pulse", label: "Pulsation (Pulse)", desc: "Battement doux d'opacité / échelle (indicateurs live, statuts)", defaultProps: { type: "pulse", duration: 2400, easing: "ease-in-out", infinite: true } },
  { type: "shimmer", label: "Reflet lumineux (Shimmer)", desc: "Balayage lumineux ou métallique périodique", defaultProps: { type: "shimmer", duration: 2000, easing: "linear", infinite: true } },
  { type: "spin", label: "Rotation continue (Spin)", desc: "Rotation 360° continue (icônes de chargement, radars)", defaultProps: { type: "spin", duration: 1100, easing: "linear", infinite: true } },
  { type: "float", label: "Flottement (Float)", desc: "Oscillation verticale douce en boucle", defaultProps: { type: "float", duration: 4000, easing: "ease-in-out", infinite: true } },
  { type: "fade-in", label: "Fondu d'entrée (Fade-in)", desc: "Apparition en fondu dès le chargement", defaultProps: { type: "fade-in", duration: 500, delay: 0, easing: "ease-out", infinite: false } },
];

export interface DesignNode {
  id: string;
  type: NodeType;
  name: string;
  parentId: string | null; // null = posé directement sur le canevas
  children: string[];
  // Position relative au parent
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string | null; // "#RRGGBB" ou "#RRGGBBAA"
  stroke: Stroke | null;
  radius: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  clip: boolean; // les frames rognent leur contenu
  clipPath?: ClipPath | null; // forme libre du masque (sinon rectangle arrondi), repère local du nœud
  text: TextStyle | null;
  path?: PathData | null;
  image?: ImageData | null;
  gradient?: Gradient | null; // prioritaire sur « fill » (qui garde une couleur de repli)
  shadows?: Shadow[] | null;
  layerBlur?: number | null; // flou de calque (valeur façon Figma : CSS blur(valeur / 2))
  backgroundBlur?: number | null; // flou d'arrière-plan, effet verre dépoli (CSS backdrop-filter)
  layout?: AutoLayout | null; // frame : auto-layout de ses enfants
  sizingH?: Sizing; // largeur (absent = fixe)
  sizingV?: Sizing; // hauteur (absent = fixe)
  absolute?: boolean; // ignoré par l'auto-layout du parent : reste à sa position x/y
  constraints?: Constraints | null; // position libre : ancrage quand le parent change de taille (absent = gauche, haut)
  minWidth?: number | null; // bornes de taille, respectées par l'auto-layout et à l'export
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  // Styles partagés : l'élément suit le style tant qu'on ne modifie pas directement la propriété
  fillStyle?: string | null; // couleur de remplissage (ou du texte)
  strokeStyle?: string | null; // couleur du contour
  textStyle?: string | null; // typographie
  effectStyle?: string | null; // ombres
  // Composants (comme dans Figma)
  isComponent?: boolean; // frame : composant principal
  isComponentSet?: boolean; // frame : ensemble de variantes (ses enfants sont des composants)
  variant?: Record<string, string> | null; // composant d'un ensemble : ses valeurs de propriétés (ex. { État: "Survol" })
  instanceOf?: string | null; // frame : instance de ce composant principal
  sourceId?: string | null; // nœud d'une instance : nœud correspondant dans le composant principal
  overrides?: string[] | null; // nœud d'une instance : propriétés modifiées localement (« fill », « text.content »…)
  animation?: NodeAnimation | null; // animation ou carrousel interactif attaché au calque
}

/** Styles partagés (design tokens) : couleurs, typographies et ombres nommées, réutilisées par les éléments. */
export interface DesignStyles {
  colors?: Record<string, { name: string; value: string }>;
  texts?: Record<string, TextStyleDef>;
  effects?: Record<string, { name: string; shadows: Shadow[] }>;
}
export interface TextStyleDef {
  name: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing?: number;
  italic?: boolean;
  fallbackFonts?: string[];
}

export interface DesignDocument {
  id: string;
  name: string;
  background?: string; // couleur du canevas (« page »)
  styles?: DesignStyles;
  nodes: Record<string, DesignNode>;
  roots: string[]; // ordre d'empilement sur le canevas (dernier = au-dessus)
}

export const DEFAULT_BACKGROUND = "#F5F5F5";

export type NodeProps = Partial<Omit<DesignNode, "id" | "type" | "parentId" | "children" | "text">> & {
  text?: Partial<TextStyle>;
};

export function createDocument(name = "Sans titre"): DesignDocument {
  return { id: newId(), name, background: DEFAULT_BACKGROUND, nodes: {}, roots: [] };
}

let counter = 0;
export function newId(): string {
  counter = (counter + 1) % 1e6;
  return Date.now().toString(36) + "-" + counter.toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

export const DEFAULT_TEXT: TextStyle = {
  content: "Texte",
  fontFamily: "Inter",
  fontSize: 16,
  fontWeight: 400,
  color: "#111111",
  align: "left",
  lineHeight: 1.3,
};

export function makeNode(type: NodeType, props: NodeProps = {}, id = newId()): DesignNode {
  const { text, ...rest } = props;
  return {
    id,
    type,
    name: defaultName(type),
    parentId: null,
    children: [],
    x: 0,
    y: 0,
    width: type === "text" ? 120 : 100,
    height: type === "text" ? 24 : 100,
    rotation: 0,
    fill: type === "frame" ? "#FFFFFF" : type === "text" || type === "image" ? null : type === "path" ? "#000000" : "#D9D9D9",
    stroke: null,
    radius: 0,
    opacity: 1,
    visible: true,
    locked: false,
    clip: type === "frame",
    text: type === "text" ? { ...DEFAULT_TEXT, ...text } : null,
    path: null,
    image: null,
    gradient: null,
    shadows: null,
    layerBlur: null,
    backgroundBlur: null,
    clipPath: null,
    layout: null,
    ...rest,
  };
}

function defaultName(type: NodeType): string {
  return { frame: "Frame", rect: "Rectangle", ellipse: "Ellipse", text: "Texte", path: "Vecteur", image: "Image" }[type];
}

export function siblingsOf(doc: DesignDocument, parentId: string | null): string[] {
  return parentId ? doc.nodes[parentId]!.children : doc.roots;
}

/** Position absolue (sur le canevas) d'un nœud, en remontant ses parents. */
export function absolutePosition(doc: DesignDocument, id: string): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cur: DesignNode | undefined = doc.nodes[id];
  while (cur) {
    x += cur.x;
    y += cur.y;
    cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
  }
  return { x, y };
}

/** Le nœud et tous ses descendants, parents d'abord. */
export function subtree(doc: DesignDocument, id: string): string[] {
  const out: string[] = [];
  const walk = (nid: string) => {
    out.push(nid);
    doc.nodes[nid]?.children.forEach(walk);
  };
  walk(id);
  return out;
}

/** Arbre lisible (pour les IA et l'export). */
export interface NodeTree extends Omit<DesignNode, "children" | "parentId"> {
  children: NodeTree[];
}

export function toTree(doc: DesignDocument, id: string): NodeTree {
  const { children, parentId: _p, ...n } = doc.nodes[id]!;
  return { ...n, children: children.map((c) => toTree(doc, c)) };
}

/** Propriétés pour redimensionner un nœud ; un vecteur voit aussi son dessin étiré. */
export function resizeProps(node: DesignNode, width: number, height: number): NodeProps {
  const props: NodeProps = { width, height };
  if (node.width > 0 && node.height > 0) {
    const sx = width / node.width;
    const sy = height / node.height;
    const scale = <T extends PathData>(p: T): T => {
      const [a, b, c, d, e, f] = p.matrix;
      return { ...p, matrix: [a * sx, b * sy, c * sx, d * sy, e * sx, f * sy] };
    };
    if (node.path) props.path = scale(node.path);
    if (node.clipPath) props.clipPath = { ...scale(node.clipPath), ...(node.clipPath.parts ? { parts: node.clipPath.parts.map(scale) } : {}) };
  }
  return props;
}

// ---------- Système de tags sémantiques [tag]Nom ----------

/** Balise sémantique posée en préfixe du nom d'un calque : ex. `[bouton]BookDemo`, `[lien]SignIn`, `[navbar]Header`, `[carousel]LatestResearch`. */
export type SemanticTag =
  | "bouton"
  | "lien"
  | "input"
  | "navbar"
  | "header"
  | "footer"
  | "aside"
  | "section"
  | "carte"
  | "carousel"
  | "decor";

export interface ParsedNodeTag {
  /** Rôle sémantique canonique (ou null si aucun tag explicite). */
  tag: SemanticTag | null;
  /** Texte brut entre crochets s'il existe (ex. "bouton", "lien", "navbar"). */
  rawTag: string | null;
  /** Nom nettoyé sans le préfixe `[tag]` (utilisé pour nommer proprement le composant React). */
  cleanName: string;
  /** Balise HTML sémantique correspondante à l'export. */
  htmlTag: "button" | "a" | "input" | "nav" | "header" | "footer" | "aside" | "section" | "article" | "div";
  /** Indique si le calque est purement décoratif et ne doit jamais bloquer les clics (`pointer-events: none`). */
  pointerEventsNone: boolean;
}

export const SEMANTIC_TAGS: { tag: SemanticTag; label: string; htmlTag: ParsedNodeTag["htmlTag"]; desc: string }[] = [
  { tag: "bouton", label: "[bouton]", htmlTag: "button", desc: "Bouton cliquable (<button type=\"button\"> + état Survol)" },
  { tag: "lien", label: "[lien]", htmlTag: "a", desc: "Lien de navigation (<a href=\"#\">)" },
  { tag: "input", label: "[input]", htmlTag: "input", desc: "Champ de saisie (<input>)" },
  { tag: "navbar", label: "[navbar]", htmlTag: "nav", desc: "Barre de navigation (<nav>)" },
  { tag: "header", label: "[header]", htmlTag: "header", desc: "En-tête (<header>)" },
  { tag: "aside", label: "[aside]", htmlTag: "aside", desc: "Barre latérale ou panneau complémentaire (<aside>)" },
  { tag: "section", label: "[section]", htmlTag: "section", desc: "Section de page (<section>)" },
  { tag: "carte", label: "[carte]", htmlTag: "article", desc: "Carte ou bloc autonome (<article>)" },
  { tag: "carousel", label: "[carousel]", htmlTag: "div", desc: "Carrousel / piste coulissante interactive" },
  { tag: "footer", label: "[footer]", htmlTag: "footer", desc: "Pied de page (<footer>)" },
  { tag: "decor", label: "[decor]", htmlTag: "div", desc: "Calque décoratif (pointer-events: none)" },
];

const TAG_ALIASES: Record<string, SemanticTag> = {
  bouton: "bouton",
  btn: "bouton",
  button: "bouton",
  cta: "bouton",
  lien: "lien",
  link: "lien",
  a: "lien",
  input: "input",
  champ: "input",
  search: "input",
  navbar: "navbar",
  nav: "navbar",
  navigation: "navbar",
  header: "header",
  entete: "header",
  "en-tete": "header",
  footer: "footer",
  pied: "footer",
  aside: "aside",
  sidebar: "aside",
  rail: "aside",
  dock: "aside",
  section: "section",
  carte: "carte",
  card: "carte",
  article: "carte",
  carousel: "carousel",
  carrousel: "carousel",
  slider: "carousel",
  decor: "decor",
  fond: "decor",
  overlay: "decor",
  ignore: "decor",
};

const TAG_TO_HTML: Record<SemanticTag, ParsedNodeTag["htmlTag"]> = {
  bouton: "button",
  lien: "a",
  input: "input",
  navbar: "nav",
  header: "header",
  aside: "aside",
  footer: "footer",
  section: "section",
  carte: "article",
  carousel: "div",
  decor: "div",
};

/** Extrait le préfixe `[tag]` éventuel du nom d'un calque et détermine sa balise HTML sémantique. */
export function parseNodeTag(name: string): ParsedNodeTag {
  const trimmed = (name ?? "").trim();
  const match = /^\[\s*([^\]]+?)\s*\]\s*(.*)$/.exec(trimmed);
  const isDecorByName = /pointer-events-none|—\s*(bordure|before|after)\b/i.test(trimmed);

  if (match) {
    const rawKey = match[1]!.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const rest = match[2]!.trim();
    const canonical = TAG_ALIASES[rawKey] ?? null;
    const cleanName = rest || match[1]!.trim();
    if (canonical) {
      return {
        tag: canonical,
        rawTag: canonical,
        cleanName,
        htmlTag: TAG_TO_HTML[canonical],
        pointerEventsNone: canonical === "decor" || isDecorByName,
      };
    }
    return {
      tag: null,
      rawTag: match[1]!.trim(),
      cleanName,
      htmlTag: "div",
      pointerEventsNone: isDecorByName,
    };
  }

  // Détection implicite pour les noms issus de captures DOM ou conventions courantes
  let htmlTag: ParsedNodeTag["htmlTag"] = "div";
  if (/^(button(\.|$)|Btn[A-Z])/i.test(trimmed)) htmlTag = "button";
  else if (/^(a\.|Link[A-Z])/i.test(trimmed)) htmlTag = "a";
  else if (/^(nav(\.|$)|Navbar\b)/i.test(trimmed)) htmlTag = "nav";
  else if (/^header(\.|$)/i.test(trimmed)) htmlTag = "header";
  else if (/^(footer(\.|$)|Footer\b)/i.test(trimmed)) htmlTag = "footer";
  else if (/^section(\.|$)/i.test(trimmed)) htmlTag = "section";

  return {
    tag: null,
    rawTag: null,
    cleanName: trimmed || "Element",
    htmlTag,
    pointerEventsNone: isDecorByName,
  };
}

/** Ajoute, remplace ou retire le préfixe `[tag]` devant le nom d'un calque. */
export function formatNodeTag(name: string, tag: SemanticTag | null): string {
  const { cleanName } = parseNodeTag(name);
  if (!tag) return cleanName;
  return `[${tag}]${cleanName}`;
}

