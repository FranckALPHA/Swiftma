// Client de l'API REST du hub (Rust) : le service MCP/IA lit et écrit les fichiers par lui.
import type { AiEvent, Author, DesignDocument, FileMeta, Op, PresenceUser, Project } from "@nyota/core";

export const HUB_URL = (process.env.NYOTA_HUB_URL ?? "http://localhost:4000").replace(/\/$/, "");

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(HUB_URL + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Hub : erreur ${res.status}`);
  return data;
}

export const hub = {
  projects: () => call<Project[]>("GET", "/api/projects"),
  files: (projectId: string) => call<FileMeta[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/files`),
  file: (id: string) => call<{ file: FileMeta; doc: DesignDocument; version: number }>("GET", `/api/files/${encodeURIComponent(id)}`),
  activeFile: () => call<{ file: FileMeta }>("GET", "/api/active-file"),
  presence: (id: string) => call<{ users: PresenceUser[]; mcpLastSeen: number | null }>("GET", `/api/files/${encodeURIComponent(id)}/presence`),
  postOps: (id: string, ops: Op[], author: Author, label?: string) =>
    call<{ ok: true; version: number }>("POST", `/api/files/${encodeURIComponent(id)}/ops`, { ops, author, label, origin: author }),
  postEvent: (id: string, event: AiEvent) => call<{ ok: true }>("POST", `/api/files/${encodeURIComponent(id)}/events`, { event }),
};
