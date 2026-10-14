// Modèle de document Nyota : un dictionnaire plat de nœuds + l'ordre des enfants.
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
}

export interface DesignDocument {
  id: string;
  name: string;
  background?: string; // couleur du canevas (« page »)
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
    if (node.clipPath) props.clipPath = scale(node.clipPath);
  }
  return props;
}
