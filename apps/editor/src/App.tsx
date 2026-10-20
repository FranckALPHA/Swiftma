import { useEffect } from "react";
import { type Op, makeNode, newId, subtree } from "@swiftma/core";
import { Canvas, isTyping } from "./components/Canvas";
import { FilePanel } from "./components/Layers";
import { AssetsPanel } from "./components/Assets";
import { AiPanel } from "./components/AiPanel";
import { Rail } from "./components/Rail";
import { RightPanel } from "./components/RightPanel";
import { TOOLS, Toolbar } from "./components/Toolbar";
import { addAutoLayout, attachImage, createComponent, dispatch, group, importSvgFile, importSvgText, getState, redo, removeAutoLayout, reorder, select, setTool, undo, ungroup, useEditor, zoomBy, zoomTo, zoomToFit } from "./store";

// Disposition inspirée des outils de design pro :
// barre d'icônes | panneau Fichier/IA | canevas + barre d'outils flottante | panneau Design/Code
export function App() {
  const leftTab = useEditor((s) => s.leftTab);
  const error = useEditor((s) => s.lastError);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const { selection, doc } = getState();
      if (mod && k === "z") return e.preventDefault(), e.shiftKey ? redo() : undo();
      if (mod && k === "y") return e.preventDefault(), redo();
      if (mod && k === "d") return e.preventDefault(), duplicate(selection);
      if (mod && k === "a") return e.preventDefault(), select(doc.roots);
      if (mod && (e.key === "=" || e.key === "+")) return e.preventDefault(), zoomBy(1.25);
      if (mod && e.key === "-") return e.preventDefault(), zoomBy(0.8);
      if (mod && e.altKey && e.code === "KeyK" && selection.length) return e.preventDefault(), createComponent(selection);
      if (mod && e.code === "KeyG" && selection.length) return e.preventDefault(), e.shiftKey ? ungroup(selection) : group(selection);
      if (e.altKey && e.shiftKey && !mod && e.code === "KeyA" && selection.length) return e.preventDefault(), removeAutoLayout(selection);
      if (e.shiftKey && !mod && k === "a" && selection.length) return e.preventDefault(), addAutoLayout(selection);
      // Ordre d'empilement : Ctrl+↑/↓ (ou ] / [), avec Maj tout devant / tout derrière
      if (mod && selection.length && (e.key === "ArrowUp" || e.key === "]" || e.key === "}"))
        return e.preventDefault(), reorder(selection, e.shiftKey ? "front" : "forward");
      if (mod && selection.length && (e.key === "ArrowDown" || e.key === "[" || e.key === "{"))
        return e.preventDefault(), reorder(selection, e.shiftKey ? "back" : "backward");
      if (e.shiftKey && e.code === "Digit1") return zoomToFit(doc.roots);
      if (e.shiftKey && e.code === "Digit2") return zoomToFit();
      if (e.shiftKey && e.code === "Digit0") return zoomTo(1);
      if (e.key === "Delete" || e.key === "Backspace") {
        const top = selection.filter((id) => !selection.some((o) => o !== id && subtree(doc, o).includes(id)));
        return dispatch(top.map((id) => ({ kind: "delete", id })), "Supprimer");
      }
      if (e.key === "Escape") return select([]), setTool("select");
      if (e.key.startsWith("Arrow") && selection.length) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        return dispatch(selection.map((id) => ({ kind: "update", id, props: { x: doc.nodes[id]!.x + dx, y: doc.nodes[id]!.y + dy } })), "Décaler");
      }
      if (!mod && !e.shiftKey) {
        const t = TOOLS.find((t) => t.key === k);
        if (t) setTool(t.id);
      }
    };
    // Coller une image n'importe où = l'envoyer à l'IA
    const onPaste = (e: ClipboardEvent) => {
      // Code SVG collé (ex. « Copier en SVG » depuis Figma) → maquette éditable
      const textData = e.clipboardData?.getData("text/plain")?.trim();
      if (textData && /^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(textData)) {
        e.preventDefault();
        void importSvgText(textData, "SVG collé");
        return;
      }
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void attachImage(file);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => (window.removeEventListener("keydown", onKey), window.removeEventListener("paste", onPaste));
  }, []);

  return (
    <div className="app">
      <Rail />
      <aside className="left">{leftTab === "file" ? <FilePanel /> : leftTab === "assets" ? <AssetsPanel /> : <AiPanel />}</aside>
      <main
        className="center"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const file = e.dataTransfer.files[0];
          if (!file) return;
          e.preventDefault();
          if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) void importSvgFile(file);
          else if (file.type.startsWith("image/")) void attachImage(file);
        }}
      >
        <Canvas />
        <Toolbar />
        {error && <div className="toast">{error}</div>}
      </main>
      <RightPanel />
    </div>
  );
}

/** Ctrl+D : copie la sélection (avec ses enfants) décalée de 16 px. */
function duplicate(ids: string[]) {
  const { doc } = getState();
  const ops: Op[] = [];
  const newIds: string[] = [];
  const copy = (id: string, parentId: string | null, offset: number) => {
    const src = doc.nodes[id]!;
    const { id: _i, type, parentId: _p, children, ...props } = src;
    const node = makeNode(type, { ...props, text: src.text ?? undefined, x: src.x + offset, y: src.y + offset }, newId());
    node.parentId = parentId;
    ops.push({ kind: "create", node });
    children.forEach((c) => copy(c, node.id, 0));
    return node.id;
  };
  for (const id of ids) if (doc.nodes[id]) newIds.push(copy(id, doc.nodes[id]!.parentId, 16));
  dispatch(ops, "Dupliquer");
  select(newIds);
}
