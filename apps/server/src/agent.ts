// L'agent IA intégré : il reçoit une demande (et éventuellement une capture d'écran)
// et dessine dans le document avec les MÊMES outils que ceux exposés en MCP.
// Chaque appel d'outil est appliqué immédiatement : l'utilisateur voit le design se construire en direct.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { type AiEvent, type DesignDocument, designTools, newId, runTool } from "@nyota/core";
import { fileContext } from "./files.js";

const MODEL = process.env.NYOTA_MODEL ?? "claude-opus-5-5";
const MAX_TURNS = 30;

const SYSTEM = `Tu es le moteur de design de Nyota, un outil de conception d'interfaces statiques.
Tu construis des interfaces en appelant des outils qui créent et modifient des nœuds : frame, rect, ellipse, text.

Règles du document :
- x/y sont relatifs au parent. Une frame est un conteneur (souvent un écran ou une carte) qui rogne son contenu.
- Les textes ont une largeur/hauteur explicites : prévois une boîte assez grande (hauteur ≈ fontSize × lineHeight × nombre de lignes).
- Couleurs en hexadécimal. Le radius s'applique aux frames et rectangles.
- Nomme chaque nœud de façon utile (« Bouton principal », « Carte produit », « Barre de navigation »).
- Préfère l'auto-layout (propriété layout d'une frame, comme flexbox) pour les piles, rangées, listes, boutons et cartes :
  les enfants se placent seuls dans l'ordre (pas besoin de x/y), et le code exporté devient responsive.
  sizingH/sizingV : "fill" pour remplir le parent (ex. sections pleine largeur), "hug" pour s'ajuster au contenu (boutons).
  La frame racine d'un écran : sizingH "fill". Un décor qui doit rester à sa place : absolute true.

Quand on te donne une capture d'écran :
- Reproduis l'interface fidèlement dans UNE frame racine aux dimensions indiquées (applique le facteur d'échelle fourni).
- Mesure positions, tailles, couleurs, rayons et tailles de police à partir de l'image, au pixel près autant que possible.
- Structure en sous-frames logiques en auto-layout (en-tête, cartes, listes, boutons) plutôt qu'en formes à plat.
- Remplace icônes et photos par des formes simples (ellipse ou rect grisé) portant un nom explicite.
- Construis en peu d'appels : un gros create_nodes vaut mieux que vingt petits. Corrige ensuite avec update_nodes si besoin.

Pour modifier un design existant, appelle d'abord get_document ou get_selection.
Termine par une phrase courte qui résume ce que tu as fait.`;

const tools: Anthropic.Beta.BetaTool[] = designTools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: jsonSchema(t.input),
  eager_input_streaming: true,
}));

export interface DesignRequest {
  prompt: string;
  image?: {
    data: string; // base64
    mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    width: number; // dimensions de l'image envoyée
    height: number;
    frameWidth: number; // taille voulue pour la frame (ex. 390 pour un écran mobile @3x)
    frameHeight: number;
  };
}

export async function runDesignAgent(fileId: string, req: DesignRequest, emit: (e: AiEvent) => void): Promise<string> {
  const jobId = newId();
  emit({ kind: "start", jobId, prompt: req.prompt });

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    const message = "Aucune clé API : définis ANTHROPIC_API_KEY avant de lancer le serveur.";
    emit({ kind: "error", jobId, message });
    throw new Error(message);
  }
  const client = new Anthropic();

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const start = await fileContext(fileId, "ai");
  if (req.image) {
    content.push({ type: "image", source: { type: "base64", media_type: req.image.mediaType, data: req.image.data } });
    const origin = freeSpot(start.ctx.doc);
    content.push({
      type: "text",
      text:
        `Capture d'écran : ${req.image.width}×${req.image.height} px. ` +
        `Frame racine attendue : ${req.image.frameWidth}×${req.image.frameHeight} px ` +
        `(facteur ${round(req.image.frameWidth / req.image.width)} entre pixels de l'image et unités du design). ` +
        `Pose-la sur le canevas en x=${origin.x}, y=${origin.y} (zone libre).`,
    });
  }
  const selection = start.ctx.selection;
  content.push({
    type: "text",
    text: (req.prompt || "Reproduis cette interface.") + (selection.length ? `\n\n(Sélection actuelle : ${selection.join(", ")})` : ""),
  });

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content }];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        system: SYSTEM,
        tools,
        messages,
      });
      stream.on("thinking", (delta) => emit({ kind: "thinking", jobId, text: delta }));
      const message = await stream.finalMessage();
      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") throw new Error("La demande a été refusée par le modèle.");
      if (message.stop_reason === "max_tokens") throw new Error("Réponse tronquée (max_tokens atteint).");
      if (message.stop_reason === "pause_turn") continue;

      const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (!calls.length) {
        const text = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        emit({ kind: "done", jobId, text: text || "Terminé." });
        return text;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        // Document frais à chaque appel : quelqu'un a pu modifier le fichier entre-temps
        const fc = await fileContext(fileId, "ai");
        let res = runTool(fc.ctx, call.name, call.input);
        if (res.ok) await fc.flush().catch((e: Error) => (res = { ok: false, error: e.message }));
        emit({ kind: "tool", jobId, name: call.name, summary: res.ok ? summarize(call.name, call.input) : `erreur : ${res.error}` });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: res.ok ? JSON.stringify(res.result ?? { ok: true }) : res.error,
          is_error: !res.ok,
        });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error(`Arrêt après ${MAX_TURNS} tours.`);
  } catch (err) {
    const message = describeError(err);
    emit({ kind: "error", jobId, message });
    throw new Error(message);
  }
}

function summarize(name: string, input: unknown): string {
  const i = input as Record<string, unknown[] | undefined>;
  if (name === "create_nodes") return `${i.nodes?.length ?? 0} nœud(s) créés`;
  if (name === "update_nodes") return `${i.updates?.length ?? 0} nœud(s) modifiés`;
  if (name === "delete_nodes") return `${i.ids?.length ?? 0} nœud(s) supprimés`;
  return name;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Clé API invalide.";
  if (err instanceof Anthropic.RateLimitError) return "Limite de requêtes atteinte, réessaie dans un instant.";
  if (err instanceof Anthropic.APIError) return `Erreur API (${err.status ?? "réseau"}) : ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Un emplacement libre à droite de tout ce qui existe déjà sur le canevas. */
function freeSpot(doc: DesignDocument): { x: number; y: number } {
  let maxX = -100;
  let minY = 0;
  for (const id of doc.roots) {
    const n = doc.nodes[id]!;
    maxX = Math.max(maxX, n.x + n.width);
    minY = Math.min(minY, n.y);
  }
  return { x: Math.round(maxX + 100), y: Math.round(minY) };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function jsonSchema(schema: z.ZodObject): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest as Anthropic.Beta.BetaTool.InputSchema;
}
