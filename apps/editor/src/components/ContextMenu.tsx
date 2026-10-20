import { useEffect, useRef } from "react";
import { subtree } from "@swiftma/core";
import { addAutoLayout, createComponent, dispatch, getState, group, removeAutoLayout, reorder, ungroup, zoomToFit } from "../store";

type Item = { label: string; kbd?: string; run: () => void; danger?: boolean } | "sep";

/** Menu du clic droit sur le canevas, à la manière des menus contextuels d'iOS. */
export function ContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const { doc, selection } = getState();
  const nodes = selection.map((id) => doc.nodes[id]).filter((n) => !!n);
  const items: Item[] = [];
  if (!nodes.length) {
    items.push({ label: "Tout afficher", kbd: "Maj 1", run: () => zoomToFit(doc.roots) });
  } else {
    const frames = nodes.filter((n) => n.type === "frame" && n.children.length && !n.isComponent && !n.isComponentSet && !n.instanceOf);
    items.push(
      { label: "Premier plan", kbd: "Ctrl Maj ↑", run: () => reorder(selection, "front") },
      { label: "Avancer", kbd: "Ctrl ↑", run: () => reorder(selection, "forward") },
      { label: "Reculer", kbd: "Ctrl ↓", run: () => reorder(selection, "backward") },
      { label: "Arrière-plan", kbd: "Ctrl Maj ↓", run: () => reorder(selection, "back") },
      "sep",
      { label: "Grouper", kbd: "Ctrl G", run: () => group(selection) },
    );
    if (frames.length) items.push({ label: "Dissocier", kbd: "Ctrl Maj G", run: () => ungroup(frames.map((f) => f.id)) });
    items.push("sep", { label: "Ajouter un auto-layout", kbd: "Maj A", run: () => addAutoLayout(selection) });
    if (nodes.some((n) => n.layout)) items.push({ label: "Retirer l'auto-layout", kbd: "Alt Maj A", run: () => removeAutoLayout(selection) });
    items.push(
      { label: "Créer un composant", kbd: "Ctrl Alt K", run: () => createComponent(selection) },
      "sep",
      { label: "Cadrer la sélection", kbd: "Maj 2", run: () => zoomToFit() },
      {
        label: "Supprimer",
        kbd: "Suppr",
        danger: true,
        run: () => {
          const top = selection.filter((id) => !selection.some((o) => o !== id && subtree(doc, o).includes(id)));
          dispatch(top.map((id) => ({ kind: "delete", id })), "Supprimer");
        },
      },
    );
  }

  // Reste dans la fenêtre même près des bords
  const height = items.reduce((h, it) => h + (it === "sep" ? 9 : 30), 12);
  const left = Math.min(x, window.innerWidth - 248);
  const top = Math.min(y, window.innerHeight - height - 8);
  return (
    <div ref={ref} className="context-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="cm-sep" />
        ) : (
          <button key={i} className={it.danger ? "danger" : ""} onClick={() => (it.run(), onClose())}>
            <span>{it.label}</span>
            {it.kbd && <kbd>{it.kbd}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
