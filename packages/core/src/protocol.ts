// Messages échangés entre l'éditeur et le hub (Rust) sur WebSocket, et types de l'API REST.
// Contrat complet : docs/hub.md.

import type { DesignDocument } from "./model.js";
import type { Author, Op } from "./ops.js";

export type ClientMessage =
  | { type: "ops"; ops: Op[]; label?: string; origin: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "selection"; ids: string[] }
  | { type: "cursor"; x: number | null; y: number | null };

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  selection: string[];
  cursor: { x: number; y: number } | null;
}

export type ServerMessage =
  | { type: "doc"; doc: DesignDocument; version?: number }
  | { type: "ops"; ops: Op[]; author: Author; label?: string; origin?: string; version?: number }
  | { type: "error"; message: string }
  | { type: "ai"; event: AiEvent }
  | { type: "presence"; users: PresenceUser[]; mcpLastSeen: number | null };

export type AiEvent =
  | { kind: "start"; jobId: string; prompt: string }
  | { kind: "thinking"; jobId: string; text: string }
  | { kind: "tool"; jobId: string; name: string; summary: string }
  | { kind: "done"; jobId: string; text: string }
  | { kind: "error"; jobId: string; message: string };

// ---------- API REST du hub ----------

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  fileCount: number;
}

export interface FileMeta {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  hasThumbnail: boolean;
}

export interface Version {
  id: string;
  fileId: string;
  label: string;
  createdAt: number;
  nodeCount: number;
}
