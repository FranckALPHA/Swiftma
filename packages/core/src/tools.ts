// Les outils de design : UNE définition, trois usages.
//  1. le serveur MCP (Claude Desktop, Claude Code, Cursor… pilotent Nyota)
//  2. l'agent IA intégré (capture d'écran → design)
//  3. n'importe quel script ou plugin futur
// Chaque outil ne fait que lire le document et produire des opérations.

import { z } from "zod";
import { type DesignDocument, type DesignNode, makeNode, newId, toTree } from "./model.js";
import type { Op } from "./ops.js";
import { exportHtml } from "./export.js";
import { exportReact } from "./export-react.js";

export interface ToolContext {
  doc: DesignDocument;
  selection: string[];
  /** Applique les opérations (atomiquement) et les diffuse à tous les éditeurs connectés. */
  commit(ops: Op[], label: string): void;
}

export interface DesignTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  run(ctx: ToolContext, input: z.infer<S>): unknown;
}

const color = z
  .string()
  .regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)
  .describe("Couleur hexadécimale #RRGGBB ou #RRGGBBAA");

const textStyle = z.object({
  content: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  color: color.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  lineHeight: z.number().positive().optional(),
});

const props = {
  name: z.string().optional(),
  x: z.number().optional().describe("Position relative au parent, en px"),
  y: z.number().optional(),
  width: z.number().min(0).optional(),
  height: z.number().min(0).optional(),
  rotation: z.number().optional().describe("Degrés"),
  fill: color.nullable().optional().describe("null = pas de remplissage"),
  stroke: z.object({ color, width: z.number().min(0) }).nullable().optional(),
  radius: z.number().min(0).optional().describe("Rayon des coins en px"),
  opacity: z.number().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  clip: z.boolean().optional().describe("Une frame rogne-t-elle son contenu"),
  text: textStyle.optional().describe("Uniquement pour les nœuds de type text"),
  path: z
    .object({
      d: z.string().describe("Données de chemin SVG"),
      fillRule: z.enum(["nonzero", "evenodd"]).default("nonzero"),
      matrix: z
        .tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
        .default([1, 0, 0, 1, 0, 0])
        .describe("Matrice SVG (a b c d e f) qui place le chemin dans le repère du nœud"),
    })
    .optional()
    .describe("Uniquement pour les nœuds de type path (icônes, formes libres)"),
  gradient: z
    .object({
      type: z.enum(["linear", "radial"]),
      stops: z.array(z.object({ offset: z.number().min(0).max(1), color })).min(2),
      start: z.tuple([z.number(), z.number()]).describe("Linéaire : départ ; radial : centre. En fractions de la boîte (0 à 1)"),
      end: z.tuple([z.number(), z.number()]).describe("Linéaire : arrivée, en fractions de la boîte"),
      radius: z.tuple([z.number(), z.number()]).optional().describe("Radial : rayons horizontal et vertical, en fractions"),
    })
    .nullable()
    .optional()
    .describe("Dégradé (prioritaire sur fill). Ex. vertical : start [0.5, 0], end [0.5, 1]. null = couleur unie"),
  shadows: z
    .array(
      z.object({
        type: z.enum(["drop", "inner"]).describe("drop = ombre portée, inner = ombre interne"),
        x: z.number(),
        y: z.number(),
        blur: z.number().min(0),
        spread: z.number().default(0),
        color,
      }),
    )
    .nullable()
    .optional()
    .describe("Ombres, comme en CSS (ex. carte : drop, x 0, y 4, blur 16, color #00000014)"),
  image: z
    .object({
      src: z.string().describe("URL ou data URL"),
      crop: z
        .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
        .optional()
        .describe("Recadrage en fractions de l'image (0 à 1) ; absent = remplissage centré"),
    })
    .optional().describe("Uniquement pour les nœuds de type image"),
};

const nodeType = z.enum(["frame", "rect", "ellipse", "text", "path", "image"]);

function defineTool<S extends z.ZodObject>(t: DesignTool<S>): DesignTool<S> {
  return t;
}

/** Vue compacte d'un nœud : on omet les valeurs par défaut pour économiser des tokens. */
function compact(n: DesignNode, doc: DesignDocument): Record<string, unknown> {
  const out: Record<string, unknown> = { id: n.id, type: n.type, name: n.name, x: r(n.x), y: r(n.y), w: r(n.width), h: r(n.height) };
  if (n.fill) out.fill = n.fill;
  if (n.stroke) out.stroke = n.stroke;
  if (n.radius) out.radius = n.radius;
  if (n.rotation) out.rotation = n.rotation;
  if (n.opacity !== 1) out.opacity = n.opacity;
  if (!n.visible) out.visible = false;
  if (n.text) out.text = n.text;
  if (n.gradient) out.gradient = n.gradient;
  if (n.shadows?.length) out.shadows = n.shadows;
  // On résume les données volumineuses pour ne pas saturer le contexte de l'IA
  if (n.path) out.path = { d: n.path.d.length > 160 ? n.path.d.slice(0, 160) + `… (${n.path.d.length} car.)` : n.path.d };
  if (n.image) out.image = { src: n.image.src.startsWith("data:") ? `(image intégrée, ${Math.round(n.image.src.length / 1024)} Ko)` : n.image.src };
  if (n.children.length) out.children = n.children.map((c) => compact(doc.nodes[c]!, doc));
  return out;
}
const r = (v: number) => Math.round(v * 100) / 100;

export const designTools = [
  defineTool({
    name: "get_document",
    description:
      "Renvoie le document de design complet sous forme d'arbre (frames, formes, textes). " +
      "Les positions x/y sont relatives au parent. À appeler avant de modifier un design existant.",
    input: z.object({}),
    run: ({ doc }) => ({ name: doc.name, nodes: doc.roots.map((id) => compact(doc.nodes[id]!, doc)) }),
  }),

  defineTool({
    name: "get_selection",
    description: "Renvoie les nœuds actuellement sélectionnés par l'utilisateur dans l'éditeur.",
    input: z.object({}),
    run: ({ doc, selection }) => selection.filter((id) => doc.nodes[id]).map((id) => compact(doc.nodes[id]!, doc)),
  }),

  defineTool({
    name: "create_nodes",
    description:
      "Crée plusieurs nœuds en une fois, hiérarchie comprise. Chaque nœud a une `ref` locale (ex. \"card\") ; " +
      "`parent` vaut la ref d'un nœud créé plus haut dans la même liste, ou l'id d'un nœud existant, ou est omis " +
      "pour poser le nœud sur le canevas. Les parents doivent précéder leurs enfants. L'ordre de la liste = ordre " +
      "d'empilement (le dernier est au-dessus). Renvoie la correspondance ref → id.",
    input: z.object({
      nodes: z
        .array(
          z.object({
            ref: z.string().describe("Identifiant local unique dans cet appel"),
            parent: z.string().optional(),
            type: nodeType,
            ...props,
          }),
        )
        .min(1),
    }),
    run: ({ doc, commit }, { nodes }) => {
      const ids: Record<string, string> = {};
      const ops: Op[] = [];
      for (const { ref, parent, type, ...p } of nodes) {
        if (ids[ref]) throw new Error(`ref en double : ${ref}`);
        const parentId = parent ? (ids[parent] ?? (doc.nodes[parent] ? parent : undefined)) : null;
        if (parentId === undefined) throw new Error(`parent introuvable pour ${ref} : ${parent}`);
        const node = makeNode(type, p, newId());
        node.parentId = parentId;
        ids[ref] = node.id;
        ops.push({ kind: "create", node });
      }
      commit(ops, `Créer ${nodes.length} nœud(s)`);
      return { created: ids };
    },
  }),

  defineTool({
    name: "update_nodes",
    description: "Modifie les propriétés de nœuds existants (position, taille, couleur, radius, texte…).",
    input: z.object({
      updates: z.array(z.object({ id: z.string(), ...props })).min(1),
    }),
    run: ({ commit }, { updates }) => {
      commit(updates.map(({ id, ...p }) => ({ kind: "update", id, props: p })), `Modifier ${updates.length} nœud(s)`);
      return { updated: updates.map((u) => u.id) };
    },
  }),

  defineTool({
    name: "delete_nodes",
    description: "Supprime des nœuds (et leurs enfants).",
    input: z.object({ ids: z.array(z.string()).min(1) }),
    run: ({ commit }, { ids }) => {
      commit(ids.map((id) => ({ kind: "delete", id })), `Supprimer ${ids.length} nœud(s)`);
      return { deleted: ids };
    },
  }),

  defineTool({
    name: "move_node",
    description: "Change le parent d'un nœud et/ou sa place dans l'ordre d'empilement. parentId null = canevas.",
    input: z.object({ id: z.string(), parentId: z.string().nullable(), index: z.number().int().min(0).optional() }),
    run: ({ commit }, { id, parentId, index }) => {
      commit([{ kind: "move", id, parentId, index }], "Déplacer");
      return { ok: true };
    },
  }),

  defineTool({
    name: "export_code",
    description: "Exporte un nœud (généralement une frame) en HTML + CSS statique.",
    input: z.object({ id: z.string() }),
    run: ({ doc }, { id }) => {
      if (!doc.nodes[id]) throw new Error(`Nœud introuvable : ${id}`);
      return exportHtml(toTree(doc, id));
    },
  }),

  defineTool({
    name: "export_react",
    description:
      "Exporte un nœud en projet React (Vite) : un composant .jsx + .module.css par élément. Le parent importe " +
      "et place ses enfants ; chaque enfant ne décrit que son apparence. Renvoie un objet { chemin: contenu }.",
    input: z.object({
      id: z.string(),
      project: z.boolean().optional().describe("false = seulement les composants, sans le squelette Vite"),
    }),
    run: ({ doc }, { id, project }) => exportReact(doc, id, { project }),
  }),
];

export type AnyDesignTool = (typeof designTools)[number];

export function findTool(name: string): DesignTool | undefined {
  return designTools.find((t) => t.name === name) as DesignTool | undefined;
}

/** Valide l'entrée puis exécute. Les erreurs deviennent des messages lisibles pour l'IA. */
export function runTool(ctx: ToolContext, name: string, raw: unknown): { ok: true; result: unknown } | { ok: false; error: string } {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: `Outil inconnu : ${name}` };
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  try {
    return { ok: true, result: tool.run(ctx, parsed.data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
