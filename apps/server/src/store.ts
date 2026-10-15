// Le document fait autorité côté serveur. Toute écriture (éditeur, IA, MCP) passe par commit().

import fs from "node:fs";
import path from "node:path";
import {
  type Author, type DesignDocument, type Op, type ServerMessage, type ToolContext,
  applyOps, createDocument, withOverrides, withStyleDetach,
} from "@nyota/core";

interface HistoryEntry { forward: Op[]; inverse: Op[]; label: string; author: Author }

export class Store {
  doc: DesignDocument;
  selection: string[] = [];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<(msg: ServerMessage) => void>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private file: string) {
    this.doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : createDocument("Mon premier design");
  }

  subscribe(fn: (msg: ServerMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(msg: ServerMessage) {
    for (const fn of this.listeners) fn(msg);
  }

  commit(ops: Op[], author: Author, label = "Modification", origin?: string) {
    if (!ops.length) return;
    const inverse = applyOps(this.doc, ops); // lève une erreur si invalide, sans rien modifier
    this.undoStack.push({ forward: ops, inverse, label, author });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    this.broadcast({ type: "ops", ops, author, label, origin });
    this.scheduleSave();
  }

  undo() { this.replay(this.undoStack, this.redoStack, "inverse"); }
  redo() { this.replay(this.redoStack, this.undoStack, "forward"); }

  private replay(from: HistoryEntry[], to: HistoryEntry[], dir: "inverse" | "forward") {
    const entry = from.pop();
    if (!entry) return;
    const ops = entry[dir];
    applyOps(this.doc, ops);
    to.push(entry);
    this.broadcast({ type: "ops", ops, author: entry.author, label: entry.label });
    this.scheduleSave();
  }

  /** Contexte pour exécuter les outils de design au nom d'un auteur donné. */
  toolContext(author: Author): ToolContext {
    return {
      doc: this.doc,
      selection: this.selection,
      commit: (ops, label) => this.commit(withStyleDetach(this.doc, withOverrides(this.doc, ops)), author, label),
    };
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.doc));
    }, 300);
  }
}
