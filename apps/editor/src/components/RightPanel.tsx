import { useEffect, useRef, useState } from "react";
import { exportReact } from "@nyota/core";
import { USER_ID, getState, setRightTab, useEditor, zoomBy, zoomTo, zoomToFit } from "../store";
import { downloadReactZip } from "../exporting";
import { IconChevron, IconDownload } from "./icons";
import { DesignTab, McpModal } from "./Properties";

export function RightPanel() {
  const tab = useEditor((s) => s.rightTab);
  const connected = useEditor((s) => s.connected);
  const users = useEditor((s) => s.presence.users);
  const selection = useEditor((s) => s.selection);
  const [mcp, setMcp] = useState(false);
  const target = exportTarget(selection);

  return (
    <aside className="right">
      <div className="right-head">
        <button className="presence" title={connected ? users.map((u) => u.name + (u.id === USER_ID ? " (vous)" : "")).join(", ") : "Hors ligne"} onClick={() => setMcp(true)}>
          {!connected && <span className="avatar off">·</span>}
          {connected && users.slice(0, 4).map((u) => (
            <span key={u.id} className="avatar" style={{ background: u.color }}>{u.name.slice(0, 1).toUpperCase()}</span>
          ))}
          {users.length > 4 && <span className="avatar more">+{users.length - 4}</span>}
        </button>
        <div className="flex1" />
        <button
          className="btn primary-btn"
          disabled={!target}
          title={target ? "Télécharger le projet React (.zip)" : "Sélectionne un élément à exporter"}
          onClick={() => target && downloadReactZip(getState().doc, target)}
        >
          <IconDownload size={14} /> Exporter
        </button>
      </div>
      <div className="tabs">
        <button className={tab === "design" ? "on" : ""} onClick={() => setRightTab("design")}>Design</button>
        <button className={tab === "code" ? "on" : ""} onClick={() => setRightTab("code")}>Code</button>
        <div className="flex1" />
        <ZoomMenu />
      </div>
      <div className="right-body">{tab === "design" ? <DesignTab /> : <CodeTab />}</div>
      {mcp && <McpModal onClose={() => setMcp(false)} />}
    </aside>
  );
}

/** L'élément à exporter : la sélection, ou sa frame de premier niveau si on a sélectionné plusieurs choses. */
function exportTarget(selection: string[]): string | null {
  return selection.length === 1 ? selection[0]! : null;
}

function ZoomMenu() {
  const scale = useEditor((s) => s.view.scale);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const item = (label: string, kbd: string, fn: () => void) => (
    <button onClick={() => (fn(), setOpen(false))}>
      <span>{label}</span>
      <kbd>{kbd}</kbd>
    </button>
  );
  return (
    <div className="zoom-menu" ref={ref}>
      <button className="zoom-btn" onClick={() => setOpen(!open)}>
        {Math.round(scale * 100)}% <IconChevron size={10} />
      </button>
      {open && (
        <div className="menu">
          {item("Zoom avant", "Ctrl +", () => zoomBy(1.25))}
          {item("Zoom arrière", "Ctrl −", () => zoomBy(0.8))}
          {item("Tout afficher", "Maj 1", () => zoomToFit(getState().doc.roots))}
          {item("Cadrer la sélection", "Maj 2", () => zoomToFit())}
          {item("Zoom à 100 %", "Maj 0", () => zoomTo(1))}
        </div>
      )}
    </div>
  );
}

/** Onglet « Code » : l'export React de la sélection, fichier par fichier, mis à jour en direct. */
function CodeTab() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const target = exportTarget(selection);
  const [file, setFile] = useState<string | null>(null);
  if (!target || !doc.nodes[target]) {
    return <p className="hint pad">Sélectionne une frame ou un élément pour voir son code React.</p>;
  }
  const files = exportReact(doc, target, { project: false });
  const names = Object.keys(files).filter((f) => f.endsWith(".jsx") || f.endsWith(".css"));
  const current = file && names.includes(file) ? file : names[0]!;
  const content = files[current] as string;
  return (
    <div className="code-tab">
      <div className="file-list">
        {names.map((f) => (
          <button key={f} className={f === current ? "on" : ""} onClick={() => setFile(f)}>
            {f.replace("src/components/", "")}
          </button>
        ))}
      </div>
      <div className="code-actions">
        <button className="ghost" onClick={() => navigator.clipboard.writeText(content)}>Copier</button>
        <button className="ghost" onClick={() => downloadReactZip(doc, target)}>Télécharger le .zip</button>
      </div>
      <pre className="code">{content}</pre>
    </div>
  );
}
