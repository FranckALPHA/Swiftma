// Contexte des outils de design pour un fichier du hub.
//
// Les outils (packages/core/src/tools.ts) lisent un document et produisent des opérations. Ici, le document vient du
// hub ; chaque lot est appliqué localement (règles du design : auto-layout, composants, styles…) puis envoyé « résolu »
// au hub, qui le diffuse en direct aux éditeurs ouverts sur le fichier.

import { type Author, type Op, type ToolContext, applyOpsDetailed, withOverrides, withStyleDetach } from "@nyota/core";
import { hub } from "./hub.js";

/** Fichier choisi explicitement (outil open_file) ; sinon, le dernier fichier ouvert ou modifié dans le hub. */
let chosenFile: string | null = null;
export const chooseFile = (id: string | null) => (chosenFile = id);

export async function resolveFile(fileId?: string): Promise<string> {
  if (fileId) return fileId;
  if (chosenFile) return chosenFile;
  try {
    return (await hub.activeFile()).file.id;
  } catch {
    throw new Error("Aucun fichier ouvert : ouvre un fichier dans l'éditeur Nyota, ou appelle list_files puis open_file.");
  }
}

export interface FileContext {
  fileId: string;
  ctx: ToolContext;
  /** Envoie au hub les lots produits par l'outil, dans l'ordre. */
  flush(): Promise<void>;
}

export async function fileContext(fileId: string | undefined, author: Author): Promise<FileContext> {
  const id = await resolveFile(fileId);
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
