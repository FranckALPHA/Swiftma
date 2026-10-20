// Plugins : des pages web chargées dans une iframe isolée, qui dessinent dans le fichier ouvert avec les MÊMES
// outils que l'IA et le MCP. Contrat complet pour les auteurs de plugins : docs/plugins.md.
//
//  - Un plugin = un manifeste JSON (nom, page, permissions) + une page web, hébergés n'importe où.
//  - L'iframe est en sandbox SANS allow-same-origin : le plugin n'a ni la session, ni les cookies, ni l'API
//    de l'instance. Il ne parle à Swiftma que par postMessage, et seulement avec les permissions déclarées.
//  - Ce qu'il fait passe par dispatch : Ctrl+Z, temps réel et droits (lecteur = lecture seule) s'appliquent.

import { designTools, runTool, toTree } from "@swiftma/core";
import { dispatch, getState, insertImageUrl, insertSvg, select, subscribe } from "./store";

export const PLUGIN_API_VERSION = 1;

export type Permission = "read" | "write";

export interface PluginManifest {
  id: string;
  name: string;
  description?: string;
  /** Page du plugin, relative au manifeste ou absolue. */
  main: string;
  permissions: Permission[];
  author?: string;
  homepage?: string;
}

export interface InstalledPlugin extends PluginManifest {
  manifestUrl: string;
  /** URL absolue de la page. */
  page: string;
  /** Ajouté par cette personne (sinon : plugin de l'instance, géré par l'administrateur). */
  personal: boolean;
}

const PERSONAL_KEY = "swiftma-plugins";

/** Lit et valide un manifeste. */
export async function fetchManifest(manifestUrl: string): Promise<PluginManifest & { page: string }> {
  const url = new URL(manifestUrl, location.href);
  if (url.protocol !== "https:" && url.origin !== location.origin && url.hostname !== "localhost") {
    throw new Error("Le manifeste doit être servi en HTTPS.");
  }
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Manifeste introuvable (${res.status}).`);
  const m = (await res.json()) as Partial<PluginManifest>;
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(m.id)) throw new Error("Manifeste : « id » invalide (minuscules, chiffres, . _ -).");
  if (typeof m.name !== "string" || !m.name.trim()) throw new Error("Manifeste : « name » manquant.");
  if (typeof m.main !== "string") throw new Error("Manifeste : « main » (page du plugin) manquant.");
  const permissions = (Array.isArray(m.permissions) ? m.permissions : []).filter((p): p is Permission => p === "read" || p === "write");
  const page = new URL(m.main, url).href;
  if (!/^https?:/.test(page)) throw new Error("Manifeste : « main » doit être une page web.");
  return { id: m.id, name: m.name.trim().slice(0, 60), description: m.description?.slice(0, 200), main: m.main, permissions, author: m.author, homepage: m.homepage, page };
}

/** Plugins de l'instance (plugins.json, modifiable par l'administrateur) + ceux ajoutés dans ce navigateur. */
export async function loadInstalledPlugins(): Promise<{ plugins: InstalledPlugin[]; errors: string[] }> {
  const errors: string[] = [];
  let instance: string[] = [];
  try {
    const res = await fetch("/plugins.json", { cache: "no-cache" });
    if (res.ok) instance = ((await res.json()) as { plugins?: string[] }).plugins ?? [];
  } catch {
    // pas de liste d'instance : seulement les plugins personnels
  }
  const entries = [
    ...instance.map((u) => ({ url: u, personal: false })),
    ...personalUrls().map((u) => ({ url: u, personal: true })),
  ];
  const plugins: InstalledPlugin[] = [];
  for (const { url, personal } of entries) {
    try {
      const m = await fetchManifest(url);
      if (!plugins.some((p) => p.id === m.id)) plugins.push({ ...m, manifestUrl: new URL(url, location.href).href, personal });
    } catch (err) {
      errors.push(`${url} : ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { plugins, errors };
}

function personalUrls(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PERSONAL_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function addPersonalPlugin(manifestUrl: string) {
  const urls = personalUrls().filter((u) => u !== manifestUrl);
  try {
    localStorage.setItem(PERSONAL_KEY, JSON.stringify([...urls, manifestUrl]));
  } catch {
    throw new Error("Impossible d'enregistrer le plugin dans ce navigateur.");
  }
}

export function removePersonalPlugin(manifestUrl: string) {
  try {
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(personalUrls().filter((u) => u !== manifestUrl)));
  } catch {
    // stockage indisponible : rien à retirer
  }
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  read: "Lire le fichier ouvert et la sélection",
  write: "Créer et modifier des éléments (annulable avec Ctrl+Z)",
};

// ---------- Pont plugin ⇄ éditeur ----------

type Request = { swiftma: number; id: number | string; method: string; params?: Record<string, unknown> };

const MAX_PAYLOAD = 8 * 1024 * 1024; // un SVG ou une image : 8 Mo au plus

/** Méthodes de l'API, avec la permission requise. */
const METHODS: Record<string, { perm: Permission | null; run: (p: Record<string, unknown>, plugin: InstalledPlugin) => unknown }> = {
  // Sans permission : savoir à qui l'on parle
  getInfo: { perm: null, run: () => ({ apiVersion: PLUGIN_API_VERSION, editor: "swiftma", tools: designTools.map((t) => t.name) }) },
  notify: {
    perm: null,
    run: (p, plugin) => {
      const message = String(p.message ?? "").slice(0, 200);
      window.dispatchEvent(new CustomEvent("swiftma-plugin-notify", { detail: `${plugin.name} : ${message}` }));
      return true;
    },
  },
  getSelection: {
    perm: "read",
    run: () => {
      const { doc, selection } = getState();
      return selection.filter((id) => doc.nodes[id]).map((id) => toTree(doc, id));
    },
  },
  getDocument: { perm: "read", run: () => ({ name: getState().doc.name, tree: getState().doc.roots.map((id) => toTree(getState().doc, id)) }) },
  insertSvg: {
    perm: "write",
    run: (p) => {
      const svg = String(p.svg ?? "");
      if (!svg || svg.length > MAX_PAYLOAD) throw new Error("svg manquant ou trop gros (8 Mo max).");
      return insertSvg(svg, String(p.name ?? "SVG").slice(0, 80), { scaleWithFrame: p.scaleWithFrame !== false }).then((id) => ({ id }));
    },
  },
  insertImage: {
    perm: "write",
    run: (p) => {
      const url = String(p.url ?? "");
      if (!/^(https:|data:image\/)/.test(url) || url.length > MAX_PAYLOAD) throw new Error("url : https: ou data:image/ attendu (8 Mo max).");
      return insertImageUrl(url, String(p.name ?? "Image").slice(0, 80)).then((id) => ({ id }));
    },
  },
  select: { perm: "read", run: (p) => (select((Array.isArray(p.ids) ? p.ids : []).map(String).filter((id) => getState().doc.nodes[id])), true) },
  // Les outils de design partagés avec l'IA et le MCP (create_nodes, add_auto_layout, export_react…)
  runTool: {
    perm: "write",
    run: (p) => {
      const ctx = {
        get doc() {
          return getState().doc;
        },
        get selection() {
          return getState().selection;
        },
        commit: (ops: Parameters<typeof dispatch>[0], label: string) => dispatch(ops, label),
      };
      const res = runTool(ctx, String(p.name ?? ""), p.input);
      if (!res.ok) throw new Error(res.error);
      return res.result;
    },
  },
};

/**
 * Relie une iframe de plugin à l'éditeur. Renvoie la fonction qui coupe le lien (fermeture du plugin).
 * Seuls les messages de CETTE iframe sont écoutés ; l'éditeur ne lui envoie que des réponses et des événements.
 */
export function connectPlugin(frame: HTMLIFrameElement, plugin: InstalledPlugin): () => void {
  const post = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ swiftma: PLUGIN_API_VERSION, ...msg }, "*");
  const onMessage = async (e: MessageEvent) => {
    if (e.source !== frame.contentWindow) return;
    const req = e.data as Request;
    if (!req || typeof req !== "object" || req.swiftma !== PLUGIN_API_VERSION || typeof req.method !== "string") return;
    const method = Object.prototype.hasOwnProperty.call(METHODS, req.method) ? METHODS[req.method] : undefined;
    try {
      if (!method) throw new Error(`Méthode inconnue : ${req.method}`);
      if (method.perm && !plugin.permissions.includes(method.perm)) throw new Error(`Permission « ${method.perm} » non déclarée dans le manifeste.`);
      if (method.perm === "write" && getState().role === "viewer") throw new Error("Lecture seule : tu peux voir ce fichier, pas le modifier.");
      const result = await method.run(req.params ?? {}, plugin);
      post({ id: req.id, result: result ?? null });
    } catch (err) {
      post({ id: req.id, error: err instanceof Error ? err.message : String(err) });
    }
  };
  window.addEventListener("message", onMessage);
  // Événement « selection » pour les plugins qui lisent : ils suivent la sélection sans la demander en boucle
  let last = getState().selection;
  const unsubscribe = plugin.permissions.includes("read")
    ? subscribe(() => {
        const { selection } = getState();
        if (selection === last) return;
        last = selection;
        post({ event: "selection", ids: selection });
      })
    : () => {};
  return () => {
    window.removeEventListener("message", onMessage);
    unsubscribe();
  };
}
