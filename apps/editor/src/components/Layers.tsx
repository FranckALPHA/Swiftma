import { useState } from "react";
import { type DesignNode, type NodeProps } from "@nyota/core";
import { useRef } from "react";
import { dispatch, getState, importSvgFile, select, useEditor } from "../store";
import { IconCaretDown, IconCaretRight, IconComponent, IconInstance, IconEllipse, IconEye, IconEyeOff, IconFrame, IconImage, IconImport, IconLock, IconPen, IconRect, IconText, IconUnlock } from "./icons";

const ICON: Record<DesignNode["type"], () => React.ReactNode> = {
  frame: () => <IconFrame size={12} />,
  rect: () => <IconRect size={12} />,
  ellipse: () => <IconEllipse size={12} />,
  text: () => <IconText size={12} />,
  path: () => <IconPen size={12} />,
  image: () => <IconImage size={12} />,
};

/** Panneau gauche « Fichier » : en-tête du document puis calques, comme dans Figma. */
export function FilePanel() {
  const doc = useEditor((s) => s.doc);
  const connected = useEditor((s) => s.connected);
  const [renaming, setRenaming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="file-panel">
      <div className="file-head">
        {renaming ? (
          <input
            autoFocus
            className="doc-input"
            defaultValue={doc.name}
            onBlur={(e) => (setRenaming(false), e.target.value.trim() && dispatch([{ kind: "set-doc", props: { name: e.target.value.trim() } }], "Renommer"))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        ) : (
          <div className="doc-title" title="Double-clic pour renommer" onDoubleClick={() => setRenaming(true)}>
            {doc.name}
          </div>
        )}
        <div className="doc-meta">
          Local <span className={"badge " + (connected ? "ok" : "off")}>{connected ? "Synchronisé" : "Hors ligne"}</span>
        </div>
      </div>

      <div className="side-section-title row-between">
        Calques
        <button className="icon-btn" title="Importer un SVG (ou glisse-le sur le canevas)" onClick={() => fileRef.current?.click()}>
          <IconImport size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".svg,image/svg+xml"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importSvgFile(f);
            e.target.value = "";
          }}
        />
      </div>
      <div className="layers">
        {doc.roots.length === 0 && (
          <p className="hint">Dessine une frame (F), importe un SVG, ou colle une capture d'écran pour que l'IA la reproduise.</p>
        )}
        {[...doc.roots].reverse().map((id) => (
          <LayerRow key={id} id={id} depth={0} />
        ))}
      </div>
    </div>
  );
}

function LayerRow({ id, depth }: { id: string; depth: number }) {
  const node = useEditor((s) => s.doc.nodes[id]);
  const selected = useEditor((s) => s.selection.includes(id));
  const [open, setOpen] = useState(depth === 0);
  const [renaming, setRenaming] = useState(false);
  if (!node) return null;
  const update = (props: NodeProps) => dispatch([{ kind: "update", id, props }]);
  const kind = node.isComponent || node.isComponentSet ? "component" : node.instanceOf ? "instance" : "";
  return (
    <>
      <div
        className={"layer" + (selected ? " selected" : "") + (node.visible ? "" : " hidden") + (depth === 0 ? " top" : "") + (kind ? " " + kind : "")}
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={(e) => select(e.shiftKey ? [...new Set([...getState().selection, id])] : [id])}
        onDoubleClick={() => setRenaming(true)}
      >
        <span className="caret" onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
          {node.children.length ? open ? <IconCaretDown size={10} /> : <IconCaretRight size={10} /> : null}
        </span>
        <span className={"icon" + (kind ? " " + kind : "")}>{kind === "component" ? <IconComponent size={12} /> : kind === "instance" ? <IconInstance size={12} /> : ICON[node.type]()}</span>
        {renaming ? (
          <input
            autoFocus
            defaultValue={node.name}
            onBlur={(e) => (setRenaming(false), e.target.value && update({ name: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        ) : (
          <span className="name">{node.name}</span>
        )}
        <span className={"actions" + (node.locked || !node.visible ? " pinned" : "")}>
          <button title="Verrouiller" onClick={(e) => (e.stopPropagation(), update({ locked: !node.locked }))}>
            {node.locked ? <IconLock size={12} /> : <IconUnlock size={12} />}
          </button>
          <button title="Afficher / masquer" onClick={(e) => (e.stopPropagation(), update({ visible: !node.visible }))}>
            {node.visible ? <IconEye size={12} /> : <IconEyeOff size={12} />}
          </button>
        </span>
      </div>
      {open && [...node.children].reverse().map((c) => <LayerRow key={c} id={c} depth={depth + 1} />)}
    </>
  );
}
