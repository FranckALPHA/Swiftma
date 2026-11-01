import { useEffect, useRef } from "react";
import { type SemanticTag, formatNodeTag, parseNodeTag } from "@swiftma/core";
import { addAutoLayout, copySelection, createComponent, cutSelection, deleteSelection, dispatch, duplicateSelection, enterPreview, getState, group, isClipboardText, pasteClipboard, removeAutoLayout, reorder, toggleSelection, ungroup, zoomToFit } from "../store";

/** Le presse-papiers du système si le navigateur l'autorise (copie d'un autre onglet), sinon la dernière copie ici. */
function paste() {
  const fallback = () => pasteClipboard();
  if (!navigator.clipboard?.readText) return fallback();
  navigator.clipboard.readText().then((t) => (isClipboardText(t) ? pasteClipboard(t) : fallback())).catch(fallback);
}

/** Copie aussi dans le presse-papiers du système, pour coller dans un autre onglet ou fichier. */
function copy(cut = false) {
  const text = cut ? cutSelection() : copySelection();
  if (text) navigator.clipboard?.writeText(text).catch(() => {});
}

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
    items.push({ label: "Coller", kbd: "Ctrl V", run: paste }, "sep", { label: "Tout afficher", kbd: "Maj 1", run: () => zoomToFit(doc.roots) });
  } else {
    const first = nodes[0]!;
    items.push(
      { label: "Copier", kbd: "Ctrl C", run: () => copy() },
      { label: "Couper", kbd: "Ctrl X", run: () => copy(true) },
      { label: "Coller", kbd: "Ctrl V", run: paste },
      { label: "Dupliquer", kbd: "Ctrl D", run: duplicateSelection },
      "sep",
    );
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
    if (frames.length === 1) {
      items.push({ label: "Aperçu site réel", kbd: "Ctrl P", run: () => enterPreview(frames[0]!.id, { w: 1280, h: 800 }) });
    }
    items.push("sep", { label: "Ajouter un auto-layout", kbd: "Maj A", run: () => addAutoLayout(selection) });
    if (nodes.some((n) => n.layout)) items.push({ label: "Retirer l'auto-layout", kbd: "Alt Maj A", run: () => removeAutoLayout(selection) });
    items.push(
      { label: "Créer un composant", kbd: "Ctrl Alt K", run: () => createComponent(selection) },
      "sep",
      {
        label: "Taguer [bouton]",
        kbd: "<button>",
        run: () => dispatch(nodes.map((n) => ({ kind: "update" as const, id: n.id, props: { name: formatNodeTag(n.name, "bouton" as SemanticTag) } })), "Taguer [bouton]"),
      },
      {
        label: "Taguer [lien]",
        kbd: "<a href=\"#\">",
        run: () => dispatch(nodes.map((n) => ({ kind: "update" as const, id: n.id, props: { name: formatNodeTag(n.name, "lien" as SemanticTag) } })), "Taguer [lien]"),
      },
      {
        label: "Taguer [section]",
        kbd: "<section>",
        run: () => dispatch(nodes.map((n) => ({ kind: "update" as const, id: n.id, props: { name: formatNodeTag(n.name, "section" as SemanticTag) } })), "Taguer [section]"),
      },
    );
    if (nodes.some((n) => parseNodeTag(n.name).rawTag)) {
      items.push({
        label: "Retirer le tag […]",
        run: () => dispatch(nodes.map((n) => ({ kind: "update" as const, id: n.id, props: { name: formatNodeTag(n.name, null) } })), "Retirer le tag"),
      });
    }
    items.push(
      "sep",
      { label: first.visible ? "Masquer" : "Afficher", kbd: "Ctrl Maj H", run: () => toggleSelection("visible") },
      { label: first.locked ? "Déverrouiller" : "Verrouiller", kbd: "Ctrl Maj L", run: () => toggleSelection("locked") },
      { label: "Cadrer la sélection", kbd: "Maj 2", run: () => zoomToFit() },
      { label: "Supprimer", kbd: "Suppr", danger: true, run: deleteSelection },
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
