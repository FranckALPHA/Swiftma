import { type Tool, redo, setLeftTab, setTool, undo, useEditor } from "../store";
import { IconCursor, IconEllipse, IconFrame, IconHand, IconRect, IconRedo, IconSparkle, IconText, IconUndo } from "./icons";

export const TOOLS: { id: Tool; key: string; icon: () => React.ReactNode; label: string }[] = [
  { id: "select", key: "v", icon: () => <IconCursor />, label: "Sélection (V)" },
  { id: "frame", key: "f", icon: () => <IconFrame />, label: "Frame (F)" },
  { id: "rect", key: "r", icon: () => <IconRect />, label: "Rectangle (R)" },
  { id: "ellipse", key: "o", icon: () => <IconEllipse />, label: "Ellipse (O)" },
  { id: "text", key: "t", icon: () => <IconText />, label: "Texte (T)" },
  { id: "hand", key: "h", icon: () => <IconHand />, label: "Main (H / Espace)" },
];

/** Barre d'outils flottante en bas du canevas. */
export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const leftTab = useEditor((s) => s.leftTab);
  return (
    <div className="toolbar">
      <div className="tb-group">
        {TOOLS.map((t) => (
          <button key={t.id} title={t.label} className={"tb-btn" + (tool === t.id ? " active" : "")} onClick={() => setTool(t.id)}>
            {t.icon()}
          </button>
        ))}
      </div>
      <div className="tb-sep" />
      <div className="tb-group">
        <button className="tb-btn" title="Annuler (Ctrl+Z)" onClick={undo}><IconUndo /></button>
        <button className="tb-btn" title="Rétablir (Ctrl+Maj+Z)" onClick={redo}><IconRedo /></button>
        <button
          className={"tb-btn ai" + (leftTab === "ai" ? " on" : "")}
          title="Designer avec l'IA"
          onClick={() => setLeftTab(leftTab === "ai" ? "file" : "ai")}
        >
          <IconSparkle />
        </button>
      </div>
    </div>
  );
}
