// API REST du hub (docs/hub.md).
import type { ApiToken, DesignDocument, FileMeta, Member, Op, Project, Role, User, Version } from "@swiftma/core";

/** Appelé quand le hub répond 401 (session expirée ou absente) : l'éditeur affiche l'écran de connexion. */
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
  if (!res.ok) throw new ApiError(data.error ?? `Erreur ${res.status}`, res.status);
  return data;
}

export const api = {
  // Comptes
  authConfig: () => call<{ signup: boolean; hasUsers: boolean }>("GET", "/api/auth/config"),
  me: () => call<User>("GET", "/api/auth/me"),
  register: (email: string, name: string, password: string) => call<User>("POST", "/api/auth/register", { email, name, password }),
  login: (email: string, password: string) => call<User>("POST", "/api/auth/login", { email, password }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  updateMe: (patch: { name?: string; password?: string; currentPassword?: string }) => call<User>("PATCH", "/api/auth/me", patch),
  tokens: () => call<ApiToken[]>("GET", "/api/auth/tokens"),
  createToken: (name: string) => call<ApiToken>("POST", "/api/auth/tokens", { name }),
  deleteToken: (id: string) => call<{ ok: true }>("DELETE", `/api/auth/tokens/${id}`),
  users: () => call<User[]>("GET", "/api/admin/users"),
  createUser: (email: string, name: string, password: string, isAdmin = false) => call<User>("POST", "/api/admin/users", { email, name, password, isAdmin }),
  // Membres d'un projet
  members: (projectId: string) => call<Member[]>("GET", `/api/projects/${projectId}/members`),
  addMember: (projectId: string, email: string, role: Role) => call<Member>("POST", `/api/projects/${projectId}/members`, { email, role }),
  setMemberRole: (projectId: string, userId: string, role: Role) => call<Member>("PATCH", `/api/projects/${projectId}/members/${userId}`, { role }),
  removeMember: (projectId: string, userId: string) => call<{ ok: true }>("DELETE", `/api/projects/${projectId}/members/${userId}`),
  projects: () => call<Project[]>("GET", "/api/projects"),
  createProject: (name: string) => call<Project>("POST", "/api/projects", { name }),
  renameProject: (id: string, name: string) => call<Project>("PATCH", `/api/projects/${id}`, { name }),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
  files: (projectId: string) => call<FileMeta[]>("GET", `/api/projects/${projectId}/files`),
  createFile: (projectId: string, name: string, doc?: DesignDocument) => call<FileMeta>("POST", `/api/projects/${projectId}/files`, { name, doc }),
  file: (id: string) => call<{ file: FileMeta; doc: DesignDocument; version: number; role: Role }>("GET", `/api/files/${id}`),
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
