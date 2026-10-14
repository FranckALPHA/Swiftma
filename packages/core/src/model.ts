// Modèle de document Nyota : un dictionnaire plat de nœuds + l'ordre des enfants.
// Plat = facile à modifier par opérations, facile à synchroniser, facile à lire pour une IA.

export type NodeType = "frame" | "rect" | "ellipse" | "text" | "path" | "image";

export interface Stroke {
  color: string;
  width: number;
}

export interface TextStyle {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
}

/** Vecteur : données SVG d'origine + matrice qui les ramène dans le repère local du nœud. */
export interface PathData {
  d: string;
  fillRule: "nonzero" | "evenodd";
  matrix: [number, number, number, number, number, number]; // a b c d e f, comme en SVG
}

export interface ImageData {
  src: string; // URL ou data URL
  /** Partie visible de l'image, en fractions de sa taille naturelle (0 à 1), étirée sur le nœud.
   *  Absent = remplissage « cover » centré. */
  crop?: { x: number; y: number; width: number; height: number };
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
  text: TextStyle | null;
  path?: PathData | null;
  image?: ImageData | null;
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
  if (node.path && node.width > 0 && node.height > 0) {
    const sx = width / node.width;
    const sy = height / node.height;
    const [a, b, c, d, e, f] = node.path.matrix;
    props.path = { ...node.path, matrix: [a * sx, b * sy, c * sx, d * sy, e * sx, f * sy] };
  }
  return props;
}
