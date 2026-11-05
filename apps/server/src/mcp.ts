// Swiftma comme serveur MCP : n'importe quelle IA compatible MCP peut lire et dessiner dans les fichiers du hub.

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultInsertPosition, designTools, importPayloadToOps, runTool } from "@swiftma/core";
import { z } from "zod";
import { chooseFile, fileContext, resolveFile } from "./files.js";
import { type Credentials, credentialsKey, hubClient } from "./hub.js";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

/** Un serveur MCP par requête, qui agit avec l'identification de la personne (relayée par le hub). */
export async function createMcpServer(creds: Credentials): Promise<McpServer> {
  const hub = hubClient(creds);
  const who = await credentialsKey(creds);
  const server = new McpServer(
    { name: "swiftma", version: "0.2.0" },
    {
      instructions:
        "Swiftma est un outil de design d'interface open source. Ses fichiers sont rangés en projets. Par défaut, les outils " +
        "agissent sur le fichier ouvert en dernier dans l'éditeur ; list_projects / list_files / open_file permettent d'en " +
        "choisir un autre. Appelle get_document avant de modifier un design. Les changements apparaissent en direct chez " +
        "les personnes qui ont le fichier ouvert. Préfère l'auto-layout, les composants et les styles partagés.\n\n" +
        "RÈGLES DE DÉVELOPPEMENT WEB ET EXPORT EN APPLICATION DE PRODUCTION :\n" +
        "1. IDENTIFICATION DU FICHIER : Ne devine JAMAIS un ID de fichier issu d'un ancien historique. Vérifie toujours le fichier actif dans l'URL ou via l'API avant d'agir.\n" +
        "2. FIDÉLITÉ VISUELLE STRICTE & ZÉRO INVENTION D'UI : Considère le design Swiftma comme l'unique source de vérité pour l'apparence, dimensions exactes, couleurs, typographie, textes, variantes (Normal / Survol) et assets. N'invente JAMAIS d'éléments absents du canevas Swiftma (INTERDICTION de créer des modales de connexion/démo, popups, notifications toast ou bannières flottantes non demandées par l'utilisateur).\n" +
        "3. SYSTÈME DE TAGS SÉMANTIQUES [tag]Nom DANS SWIFTMA : Renomme et tague D'ABORD les calques directement dans Swiftma via update_nodes avant d'exporter :\n" +
        "   - [bouton]Nom → <button type=\"button\"> avec état de survol automatique (Normal / Survol)\n" +
        "   - [lien]Nom → <a href=\"#\">\n" +
        "   - [input]Nom → <input type=\"text\">\n" +
        "   - [navbar]Nom → <nav> | [header]Nom → <header> | [section]Nom → <section> | [carte]Nom → <article> | [footer]Nom → <footer>\n" +
        "   - [decor]Nom → calque décoratif avec pointer-events: none (ne bloque jamais les clics)\n" +
        "4. PIOCHE DIRECTEMENT LE CODE SWIFTMA : Ne réécris pas le CSS ou les SVG de zéro. Pioche et transfère directement les blocs JSX, les classes CSS (.module.css), les variantes Normal/Survol et les vecteurs générés par Swiftma dans tes composants.\n" +
        "5. ARCHITECTURE PAR FONCTIONNALITÉ (Feature-Based) :\n" +
        "   - src/features/<nom>/ (composants et styles de chaque section du design)\n" +
        "   - src/components/ui/ (composants réutilisables à variantes : boutons, liens, cartes) & src/components/layout/ (Navbar, Footer)\n" +
        "   - src/pages/ (assemblage de la page)\n" +
        "   - Dépendances à sens unique (pages → features → components), composants compacts (< 150 lignes).\n\n" +
        "CHECKLIST DE VÉRIFICATION OBLIGATOIRE (À exécuter avant de conclure) :\n" +
        "- [ ] Fichier : L'ID du fichier exporté est bien celui demandé par l'utilisateur.\n" +
        "- [ ] Fidélité visuelle & Zéro ajout hors maquette : Le rendu correspond exactement au canevas Swiftma, sans modales ni popups inventées.\n" +
        "- [ ] Sémantique & Variantes : Les boutons sont des <button type=\"button\"> avec leurs variantes Normal/Survol, et les liens pointent vers href=\"#\".\n" +
        "- [ ] 0 Erreur console : Aucun crash, aucune exception JavaScript et aucune ressource en 404.\n" +
        "- [ ] Build & Interactivité : npm run build passe avec 0 erreur, les survols de boutons fonctionnent et aucun calque décoratif ne bloque les clics.",
    },
  );

  server.registerTool("list_projects", { description: "Liste les projets et leur nombre de fichiers.", inputSchema: z.object({}) }, async () => {
    try {
      return text(await hub.projects());
    } catch (e) {
      return fail((e as Error).message);
    }
  });

  server.registerTool(
    "create_project",
    { description: "Crée un nouveau projet pour ranger des fichiers de design.", inputSchema: z.object({ name: z.string().describe("Nom du projet") }) },
    async ({ name }) => {
      try {
        const project = await hub.createProject(name);
        return text({ ok: true, project });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "delete_project",
    { description: "Supprime définitivement un projet et tous ses fichiers.", inputSchema: z.object({ projectId: z.string().describe("Identifiant du projet") }) },
    async ({ projectId }) => {
      try {
        await hub.deleteProject(projectId);
        return text({ ok: true, deleted: projectId });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "list_files",
    { description: "Liste les fichiers d'un projet (id, nom, date de modification).", inputSchema: z.object({ projectId: z.string() }) },
    async ({ projectId }) => {
      try {
        return text(await hub.files(projectId));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "create_file",
    {
      description: "Crée un nouveau fichier de design dans un projet et le sélectionne comme fichier actif.",
      inputSchema: z.object({
        projectId: z.string().describe("Identifiant du projet"),
        name: z.string().optional().describe("Nom du fichier (défaut : Sans titre)"),
      }),
    },
    async ({ projectId, name = "Sans titre" }) => {
      try {
        const file = await hub.createFile(projectId, name);
        chooseFile(who, file.id);
        return text({ ok: true, file, active: true });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "delete_file",
    { description: "Supprime définitivement un fichier de design.", inputSchema: z.object({ fileId: z.string().describe("Identifiant du fichier à supprimer") }) },
    async ({ fileId }) => {
      try {
        await hub.deleteFile(fileId);
        chooseFile(who, null);
        return text({ ok: true, deleted: fileId });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
  server.registerTool(
    "open_file",
    {
      description: "Choisit le fichier sur lequel agissent les outils suivants (null = revenir au fichier ouvert dans l'éditeur).",
      inputSchema: z.object({ fileId: z.string().nullable() }),
    },
    async ({ fileId }) => {
      try {
        if (fileId) await hub.file(fileId); // vérifie qu'il existe
        chooseFile(who, fileId);
        const id = await resolveFile(hub, who);
        return text({ fileId: id, name: (await hub.file(id)).file.name });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  const importSchema = z.object({
    fileId: z.string().optional().describe("Fichier Swiftma cible (par défaut : celui ouvert dans l'éditeur)"),
    filePath: z.string().optional().describe("Chemin local du fichier à importer (.h2d, .make, .swiftma.json, .svg, .png, .jpg, .webp, .gif)"),
    fileContent: z.string().optional().describe("Contenu texte brut (SVG, JSON) ou data URL (data:image/...)"),
    base64: z.string().optional().describe("Données binaires encodées en base64 (.h2d, .make, images...)"),
    fileName: z.string().optional().describe("Nom du fichier ou du calque importé"),
    x: z.number().optional().describe("Position X sur le canevas (défaut : à droite des calques existants)"),
    y: z.number().optional().describe("Position Y sur le canevas (défaut : 0)"),
  });

  const handleImport = async (args: z.infer<typeof importSchema>) => {
    try {
      let bytes: Uint8Array | undefined;
      let textContent = args.fileContent;
      let fileName = args.fileName;

      if (args.filePath && args.filePath.trim()) {
        const resolved = path.resolve(args.filePath.trim());
        const buf = await fs.readFile(resolved);
        bytes = new Uint8Array(buf);
        if (!fileName) fileName = path.basename(resolved);
      } else if (args.base64 && args.base64.trim()) {
        const buf = Buffer.from(args.base64.trim(), "base64");
        bytes = new Uint8Array(buf);
      }

      const fc = await fileContext(hub, await resolveFile(hub, who, args.fileId), "mcp");
      const at = args.x !== undefined && args.y !== undefined
        ? { x: args.x, y: args.y }
        : defaultInsertPosition(fc.ctx.doc);
      if (args.x !== undefined && args.y === undefined) at.x = args.x;
      if (args.y !== undefined && args.x === undefined) at.y = args.y;

      const res = importPayloadToOps(
        { bytes, text: textContent, dataUrl: textContent?.startsWith("data:") ? textContent : undefined, fileName },
        { name: fileName, at },
      );

      fc.ctx.commit(res.ops, `Importer ${fileName ?? "fichier"} (${res.format})`);
      await fc.flush();

      return text({
        ok: true,
        imported: fileName ?? "fichier",
        format: res.format,
        rootId: res.rootId,
        nodesCount: res.stats.nodes,
        width: res.stats.width,
        height: res.stats.height,
        position: at,
      });
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  server.registerTool(
    "import_file",
    {
      description:
        "Importe n'importe quel fichier supporté par Swiftma (.h2d, .make, .swiftma.json, .svg, ou images PNG/JPG/WebP/GIF) " +
        "directement sur le canevas en calques éditables. Accepte un chemin de fichier local (filePath), ou du contenu texte/base64.",
      inputSchema: importSchema,
    },
    handleImport,
  );

  server.registerTool(
    "import_h2d",
    {
      description:
        "Importe directement un fichier .h2d (capture html.to.design) en calques éditables avec auto-layout, textes et styles complets. " +
        "Accepte un chemin de fichier local sur disque (filePath) ou du contenu base64 (base64).",
      inputSchema: importSchema,
    },
    handleImport,
  );

  for (const tool of designTools) {
    if (tool.name === "import_file") continue;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input.extend({ fileId: z.string().optional().describe("Fichier (par défaut : celui ouvert dans l'éditeur)") }) },
      async (args: Record<string, unknown>) => {
        const { fileId, ...input } = args;
        try {
          const fc = await fileContext(hub, await resolveFile(hub, who, fileId as string | undefined), "mcp");
          const res = runTool(fc.ctx, tool.name, input);
          if (!res.ok) return fail(res.error);
          await fc.flush();
          return text(res.result ?? { ok: true });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );
  }
  return server;
}
