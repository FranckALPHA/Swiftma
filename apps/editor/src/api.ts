// API REST du hub (docs/hub.md).
import type { DesignDocument, FileMeta, Op, Project, Version } from "@nyota/core";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
  return data;
}

export const api = {
  projects: () => call<Project[]>("GET", "/api/projects"),
  createProject: (name: string) => call<Project>("POST", "/api/projects", { name }),
  renameProject: (id: string, name: string) => call<Project>("PATCH", `/api/projects/${id}`, { name }),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
  files: (projectId: string) => call<FileMeta[]>("GET", `/api/projects/${projectId}/files`),
  createFile: (projectId: string, name: string, doc?: DesignDocument) => call<FileMeta>("POST", `/api/projects/${projectId}/files`, { name, doc }),
  file: (id: string) => call<{ file: FileMeta; doc: DesignDocument; version: number }>("GET", `/api/files/${id}`),
  renameFile: (id: string, name: string) => call<FileMeta>("PATCH", `/api/files/${id}`, { name }),
  moveFile: (id: string, projectId: string) => call<FileMeta>("PATCH", `/api/files/${id}`, { projectId }),
  deleteFile: (id: string) => call<{ ok: true }>("DELETE", `/api/files/${id}`),
  duplicateFile: (id: string) => call<FileMeta>("POST", `/api/files/${id}/duplicate`),
  postOps: (id: string, ops: Op[], label?: string) => call<{ ok: true; version: number }>("POST", `/api/files/${id}/ops`, { ops, label, author: "human" }),
  putThumbnail: (id: string, dataUrl: string) => call<{ ok: true }>("PUT", `/api/files/${id}/thumbnail`, { dataUrl }),
  thumbnailUrl: (id: string, updatedAt: number) => `/api/files/${id}/thumbnail?v=${updatedAt}`,
  versions: (id: string) => call<Version[]>("GET", `/api/files/${id}/versions`),
  createVersion: (id: string, label: string) => call<Version>("POST", `/api/files/${id}/versions`, { label }),
  restoreVersion: (id: string, vid: string) => call<{ ok: true; version: number }>("POST", `/api/files/${id}/versions/${vid}/restore`),
};
