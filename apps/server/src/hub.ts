// Client de l'API REST du hub (Rust) : le service MCP/IA lit et écrit les fichiers par lui, AVEC L'IDENTIFICATION
// DE LA PERSONNE (jeton ou cookie relayés par le hub) : il n'a jamais plus de droits qu'elle.
import type { AiEvent, Author, DesignDocument, FileMeta, Op, PresenceUser, Project, Role } from "@swiftma/core";

export const HUB_URL = (process.env.SWIFTMA_HUB_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Identification d'une requête entrante, à réutiliser pour appeler le hub. */
export interface Credentials {
  authorization?: string;
  cookie?: string;
}

export function credentialsOf(headers: Record<string, string | string[] | undefined>): Credentials {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return { authorization: one(headers.authorization), cookie: one(headers.cookie) };
}

/** Clé stable d'une personne (pour mémoriser son fichier choisi), sans garder le secret en clair. */
export async function credentialsKey(c: Credentials): Promise<string> {
  const data = new TextEncoder().encode(`${c.authorization ?? ""}|${c.cookie ?? ""}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest).toString("hex");
}

export function hubClient(creds: Credentials) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (creds.authorization) headers.Authorization = creds.authorization;
    if (creds.cookie) headers.Cookie = creds.cookie;
    const res = await fetch(HUB_URL + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Hub : erreur ${res.status}`);
    return data;
  }
  const f = (id: string) => `/api/files/${encodeURIComponent(id)}`;
  return {
    projects: () => call<Project[]>("GET", "/api/projects"),
    files: (projectId: string) => call<FileMeta[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/files`),
    file: (id: string) => call<{ file: FileMeta; doc: DesignDocument; version: number; role: Role }>("GET", f(id)),
    activeFile: () => call<{ file: FileMeta }>("GET", "/api/active-file"),
    presence: (id: string) => call<{ users: PresenceUser[]; mcpLastSeen: number | null }>("GET", `${f(id)}/presence`),
    postOps: (id: string, ops: Op[], author: Author, label?: string) =>
      call<{ ok: true; version: number }>("POST", `${f(id)}/ops`, { ops, author, label, origin: author }),
    postEvent: (id: string, event: AiEvent) => call<{ ok: true }>("POST", `${f(id)}/events`, { event }),
  };
}

export type HubClient = ReturnType<typeof hubClient>;
