// Contexte des outils de design pour un fichier du hub.
//
// Les outils (packages/core/src/tools.ts) lisent un document et produisent des opérations. Ici, le document vient du
// hub ; chaque lot est appliqué localement (règles du design : auto-layout, composants, styles…) puis envoyé « résolu »
// au hub, qui le diffuse en direct aux éditeurs ouverts sur le fichier. Tout passe par l'identification de la personne.

import { type Author, type Op, type ToolContext, applyOpsDetailed, withOverrides, withStyleDetach } from "@swiftma/core";
import type { HubClient } from "./hub.js";

/** Fichier choisi explicitement (outil open_file), par personne ; sinon, son dernier fichier ouvert ou modifié. */
const chosenFiles = new Map<string, string>();
export const chooseFile = (who: string, id: string | null) => (id ? chosenFiles.set(who, id) : chosenFiles.delete(who));

export async function resolveFile(hub: HubClient, who: string, fileId?: string): Promise<string> {
  if (fileId) return fileId;
  const chosen = chosenFiles.get(who);
  if (chosen) return chosen;
  try {
    return (await hub.activeFile()).file.id;
  } catch {
    throw new Error("Aucun fichier ouvert : ouvre un fichier dans l'éditeur Swiftma, ou appelle list_files puis open_file.");
  }
}

export interface FileContext {
  fileId: string;
  ctx: ToolContext;
  /** Envoie au hub les lots produits par l'outil, dans l'ordre. */
  flush(): Promise<void>;
}

export async function fileContext(hub: HubClient, id: string, author: Author): Promise<FileContext> {
  const { doc } = await hub.file(id);
  // La sélection d'une personne présente dans le fichier (pour « modifie ce que j'ai sélectionné »)
  const presence = await hub.presence(id).catch(() => null);
  const selection = (presence?.users.find((u) => u.selection.length)?.selection ?? []).filter((n) => doc.nodes[n]);
  const queue: { ops: Op[]; label: string }[] = [];
  const ctx: ToolContext = {
    doc,
    selection,
    commit(ops, label) {
      const marked = withStyleDetach(doc, withOverrides(doc, ops));
      const { derived } = applyOpsDetailed(doc, marked); // lève une erreur lisible si le lot est invalide
      queue.push({ ops: [...marked, ...derived], label });
    },
  };
  return {
    fileId: id,
    ctx,
    async flush() {
      for (const { ops, label } of queue.splice(0)) await hub.postOps(id, ops, author, label);
    },
  };
}
