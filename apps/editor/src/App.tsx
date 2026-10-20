import { useEffect } from "react";
import { Canvas, isTyping } from "./components/Canvas";
import { FilePanel } from "./components/Layers";
import { AssetsPanel } from "./components/Assets";
import { AiPanel } from "./components/AiPanel";
import { PluginsPanel } from "./components/PluginsPanel";
import { Rail } from "./components/Rail";
import { RightPanel } from "./components/RightPanel";
import { TOOLS, Toolbar } from "./components/Toolbar";
import { addAutoLayout, attachImage, copySelection, createComponent, cutSelection, deleteSelection, dispatch, duplicateSelection, group, importSvgFile, importSvgText, insertImage, isClipboardText, getState, pasteClipboard, redo, removeAutoLayout, reorder, select, setTool, toggleSelection, undo, ungroup, useEditor, zoomBy, zoomTo, zoomToFit } from "./store";

/** Un champ de saisie a le focus : copier, coller et les raccourcis lui reviennent. */
const editingText = () => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
};

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
      if (mod && k === "d") return e.preventDefault(), duplicateSelection();
      if (mod && e.shiftKey && e.code === "KeyH" && selection.length) return e.preventDefault(), toggleSelection("visible");
      if (mod && e.shiftKey && e.code === "KeyL" && selection.length) return e.preventDefault(), toggleSelection("locked");
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
      if (e.key === "Delete" || e.key === "Backspace") return deleteSelection();
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
    // Coller une image = un calque image sur le canevas ; onglet IA ouvert = l'envoyer à l'IA
    const onPaste = (e: ClipboardEvent) => {
      if (editingText()) return;
      // Éléments copiés dans Swiftma (cet onglet, un autre onglet ou un autre fichier)
      const textData = e.clipboardData?.getData("text/plain")?.trim();
      if (isClipboardText(textData)) {
        e.preventDefault();
        pasteClipboard(textData!);
        return;
      }
      // Code SVG collé (ex. « Copier en SVG » depuis Figma) → maquette éditable
      if (textData && /^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(textData)) {
        e.preventDefault();
        void importSvgText(textData, "SVG collé");
        return;
      }
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void (getState().leftTab === "ai" ? attachImage(file) : insertImage(file));
      }
    };
    // Ctrl+C / Ctrl+X : la sélection part dans le presse-papiers du système (collable dans un autre onglet)
    const onCopy = (e: ClipboardEvent) => {
      if (editingText() || !getState().selection.length) return;
      const text = e.type === "cut" ? cutSelection() : copySelection();
      if (!text) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCopy);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCopy);
    };
  }, []);

  return (
    <div className="app">
      <Rail />
      <aside className="left">{leftTab === "file" ? <FilePanel /> : leftTab === "assets" ? <AssetsPanel /> : leftTab === "plugins" ? <PluginsPanel /> : <AiPanel />}</aside>
      <main
        className="center"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const file = e.dataTransfer.files[0];
          if (!file) return;
          e.preventDefault();
          if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) void importSvgFile(file);
          else if (file.type.startsWith("image/")) {
            const { leftTab: tab, view } = getState();
            if (tab === "ai") return void attachImage(file);
            // Posée là où on la lâche
            const r = e.currentTarget.getBoundingClientRect();
            const at = { x: (e.clientX - r.left - view.x) / view.scale, y: (e.clientY - r.top - view.y) / view.scale };
            void insertImage(file, at, file.name.replace(/\.[a-z0-9]+$/i, "") || "Image");
          }
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

