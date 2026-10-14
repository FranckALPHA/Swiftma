import { useState } from "react";
import { DEFAULT_BACKGROUND, type DesignNode, type Gradient, type NodeProps, type Shadow, cssGradient, exportHtml, resizeProps, toTree } from "@nyota/core";
import { dispatch, setRightTab, useEditor } from "../store";
import { downloadReactZip } from "../exporting";
import { IconCode, IconDownload, IconPen, IconEye, IconEyeOff, IconMinus, IconPlug, IconPlus } from "./icons";
import { Modal } from "./Modal";

/** Onglet « Design » du panneau de droite : propriétés de la sélection, ou de la page. */
export function DesignTab() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const node = selection.length === 1 ? doc.nodes[selection[0]!] : undefined;
  if (selection.length > 1) {
    return (
      <Section title={`${selection.length} éléments sélectionnés`}>
        <p className="hint">Sélectionne un seul élément pour modifier ses propriétés.</p>
      </Section>
    );
  }
  return node ? <NodeProperties node={node} /> : <PageProperties />;
}

// ---------- Aucune sélection : la page ----------

function PageProperties() {
  const background = useEditor((s) => s.doc.background ?? DEFAULT_BACKGROUND);
  const presence = useEditor((s) => s.presence);
  const [mcpOpen, setMcpOpen] = useState(false);
  const mcpActive = presence.mcpLastSeen !== null && Date.now() - presence.mcpLastSeen < 10 * 60_000;
  return (
    <>
      <Section title="Page">
        <ColorRow value={background} onChange={(v) => v && dispatch([{ kind: "set-doc", props: { background: v } }], "Couleur de page")} />
      </Section>
      <Section title="Exporter">
        <p className="hint">Sélectionne une frame pour l'exporter en React (un composant par élément) ou en HTML/CSS.</p>
      </Section>
      <Section
        title={
          <>
            MCP <span className={"pill" + (mcpActive ? " ok" : "")}>{mcpActive ? "IA connectée" : "en attente"}</span>
          </>
        }
        action={<button className="icon-btn" title="Connecter une IA" onClick={() => setMcpOpen(true)}><IconPlug size={14} /></button>}
      >
        <div className="kv"><span>Éditeurs ouverts</span><b>{presence.editors}</b></div>
        <div className="kv"><span>Dernier appel d'une IA</span><b>{presence.mcpLastSeen ? since(presence.mcpLastSeen) : "—"}</b></div>
      </Section>
      {mcpOpen && <McpModal onClose={() => setMcpOpen(false)} />}
    </>
  );
}

const since = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "à l'instant" : s < 3600 ? `il y a ${Math.round(s / 60)} min` : `il y a ${Math.round(s / 3600)} h`;
};

export function McpModal({ onClose }: { onClose: () => void }) {
  const url = `${location.origin}/mcp`;
  return (
    <Modal title="Connecter une IA à Nyota (MCP)" onClose={onClose}>
      <p>Nyota expose un serveur MCP : toute IA compatible peut lire et dessiner dans ce document, en direct.</p>
      <p><b>Claude Code</b></p>
      <pre>claude mcp add --transport http nyota {url}</pre>
      <p><b>Autres clients MCP (Cursor, Claude Desktop…)</b></p>
      <pre>{JSON.stringify({ mcpServers: { nyota: { type: "http", url } } }, null, 2)}</pre>
      <p className="hint">
        Outils exposés : get_document, get_selection, create_nodes, update_nodes, delete_nodes, move_node, export_code, export_react.
      </p>
    </Modal>
  );
}

// ---------- Un élément sélectionné ----------

const KIND: Record<DesignNode["type"], string> = { frame: "Frame", rect: "Rectangle", ellipse: "Ellipse", text: "Texte", path: "Vecteur", image: "Image" };
const WEIGHTS: Record<number, string> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };

function NodeProperties({ node }: { node: DesignNode }) {
  const doc = useEditor((s) => s.doc);
  const [html, setHtml] = useState<{ html: string; css: string } | null>(null);
  const set = (props: NodeProps) => dispatch([{ kind: "update", id: node.id, props }]);

  return (
    <>
      <div className="node-head">
        <span className="node-kind">{KIND[node.type]}</span>
        <span className="node-name">{node.name}</span>
      </div>

      <Section title="Position">
        <div className="grid2">
          <Num label="X" value={node.x} onChange={(x) => set({ x })} />
          <Num label="Y" value={node.y} onChange={(y) => set({ y })} />
          <Num label="↻" value={node.rotation} suffix="°" onChange={(rotation) => set({ rotation })} />
        </div>
      </Section>

      <Section title="Dimensions">
        <div className="grid2">
          <Num label="L" value={node.width} min={1} onChange={(width) => set(resizeProps(node, width, node.height))} />
          <Num label="H" value={node.height} min={1} onChange={(height) => set(resizeProps(node, node.width, height))} />
        </div>
        {node.type === "frame" && (
          <label className="check">
            <input type="checkbox" checked={node.clip} onChange={(e) => set({ clip: e.target.checked })} /> Rogner le contenu
          </label>
        )}
        {node.type === "frame" && node.clip && node.clipPath && (
          <div className="row mask-row">
            <IconPen size={12} /> <span className="flex1">Masque de forme libre</span>
            <button className="ghost" title="Rogner au rectangle de la frame" onClick={() => set({ clipPath: null })}>Retirer</button>
          </div>
        )}
      </Section>

      <Section title="Apparence" action={
        <button className="icon-btn" title={node.visible ? "Masquer" : "Afficher"} onClick={() => set({ visible: !node.visible })}>
          {node.visible ? <IconEye size={14} /> : <IconEyeOff size={14} />}
        </button>
      }>
        <div className="grid2">
          <Num label="◐" value={Math.round(node.opacity * 100)} min={0} suffix="%" onChange={(v) => set({ opacity: Math.min(100, v) / 100 })} />
          {(node.type === "frame" || node.type === "rect" || node.type === "image") && (
            <Num label="◜" value={node.radius} min={0} onChange={(radius) => set({ radius })} />
          )}
        </div>
      </Section>

      {node.text && (
        <Section title="Typographie">
          <div className="row">
            <input className="full" value={node.text.fontFamily} onChange={(e) => set({ text: { fontFamily: e.target.value } })} />
            <div className="seg">
              <button className={node.text.italic ? "on" : ""} title="Italique" style={{ fontStyle: "italic", width: 28 }} onClick={() => set({ text: { italic: !node.text!.italic } })}>I</button>
            </div>
          </div>
          <div className="grid2">
            <select value={node.text.fontWeight} onChange={(e) => set({ text: { fontWeight: Number(e.target.value) } })}>
              {Object.entries(WEIGHTS).map(([w, label]) => <option key={w} value={w}>{label}</option>)}
            </select>
            <Num label="Aa" value={node.text.fontSize} min={1} onChange={(fontSize) => set({ text: { fontSize } })} />
            <Num label="↕" value={node.text.lineHeight} step={0.05} min={0.5} onChange={(lineHeight) => set({ text: { lineHeight } })} />
            <div className="seg">
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} className={node.text!.align === a ? "on" : ""} onClick={() => set({ text: { align: a } })} title={a}>
                  {a === "left" ? "⫷" : a === "center" ? "≡" : "⫸"}
                </button>
              ))}
            </div>
          </div>
          <textarea className="text-content" value={node.text.content} onChange={(e) => set({ text: { content: e.target.value } })} />
        </Section>
      )}

      <FillSection node={node} set={set} />

      <Section
        title="Contour"
        action={!node.stroke && <button className="icon-btn" title="Ajouter" onClick={() => set({ stroke: { color: "#000000", width: 1 } })}><IconPlus size={14} /></button>}
      >
        {node.stroke && (
          <>
            <ColorRow value={node.stroke.color} onChange={(color) => color && set({ stroke: { ...node.stroke!, color } })} onRemove={() => set({ stroke: null })} />
            <div className="grid2">
              <Num label="≡" value={node.stroke.width} min={0} onChange={(width) => set({ stroke: { ...node.stroke!, width } })} />
            </div>
          </>
        )}
      </Section>

      <EffectsSection node={node} set={set} />

      <Section title="Exporter">
        <button className="btn" onClick={() => downloadReactZip(doc, node.id)}><IconDownload size={14} /> React (.zip)</button>
        <div className="row">
          <button className="btn ghost-btn" onClick={() => setHtml(exportHtml(toTree(doc, node.id)))}>HTML / CSS</button>
          <button className="btn ghost-btn" onClick={() => setRightTab("code")}><IconCode size={14} /> Voir le code</button>
        </div>
      </Section>

      {html && (
        <Modal
          title="HTML / CSS"
          onClose={() => setHtml(null)}
          actions={<button className="ghost" onClick={() => navigator.clipboard.writeText(`<style>\n${html.css}\n</style>\n\n${html.html}`)}>Copier</button>}
        >
          <pre>{`<style>\n${html.css}\n</style>\n\n${html.html}`}</pre>
        </Modal>
      )}
    </>
  );
}

// ---------- Remplissage (couleur unie ou dégradé) ----------

function FillSection({ node, set }: { node: DesignNode; set: (p: NodeProps) => void }) {
  const isText = node.type === "text";
  const solid = isText ? node.text!.color : node.fill;
  const g = node.gradient;
  const setSolid = (c: string | null) => (isText ? c && set({ text: { color: c } }) : set({ fill: c }));
  const toGradient = (type: Gradient["type"]) => {
    const base = (solid ?? "#D9D9D9").slice(0, 7);
    const stops = [{ offset: 0, color: base }, { offset: 1, color: base + "00" }];
    set({ gradient: type === "linear" ? { type, stops, start: [0.5, 0], end: [0.5, 1] } : { type, stops, start: [0.5, 0.5], end: [0.5, 0.5], radius: [0.5, 0.5] } });
  };
  const setG = (patch: Partial<Gradient>) => set({ gradient: { ...g!, ...patch } });
  return (
    <Section
      title={isText ? "Couleur du texte" : "Remplissage"}
      action={
        !g && !solid ? (
          <button className="icon-btn" title="Ajouter" onClick={() => setSolid("#D9D9D9")}><IconPlus size={14} /></button>
        ) : (
          <div className="seg small">
            <button className={!g ? "on" : ""} title="Couleur unie" onClick={() => set({ gradient: null, ...(isText ? {} : { fill: g?.stops[0]?.color ?? solid }) })}>■</button>
            <button className={g?.type === "linear" ? "on" : ""} title="Dégradé linéaire" onClick={() => (g ? setG({ type: "linear", start: [0.5, 0], end: [0.5, 1] }) : toGradient("linear"))}>▤</button>
            <button className={g?.type === "radial" ? "on" : ""} title="Dégradé radial" onClick={() => (g ? setG({ type: "radial", start: [0.5, 0.5], radius: [0.5, 0.5] }) : toGradient("radial"))}>◎</button>
          </div>
        )
      }
    >
      {g ? (
        <>
          <div className="gradient-preview" style={{ background: cssGradient(g, 100, 24) }} />
          {g.type === "radial" && (
            <div className="grid2">
              <Num label="↻" value={g.angle ?? 0} suffix="°" onChange={(angle) => setG({ angle })} />
              <Num label="↔" value={Math.round((g.radius?.[0] ?? 0.5) * 100)} min={1} suffix="%" onChange={(v) => setG({ radius: [v / 100, g.radius?.[1] ?? 0.5] })} />
            </div>
          )}
          {g.stops.map((st, i) => (
            <div className="row" key={i}>
              <div className="stop-pos">
                <Num label="" value={Math.round(st.offset * 100)} min={0} suffix="%" onChange={(v) => setG({ stops: g.stops.map((x, j) => (j === i ? { ...x, offset: Math.min(100, v) / 100 } : x)) })} />
              </div>
              <ColorRow
                value={st.color}
                onChange={(c) => c && setG({ stops: g.stops.map((x, j) => (j === i ? { ...x, color: c } : x)) })}
                onRemove={g.stops.length > 2 ? () => setG({ stops: g.stops.filter((_, j) => j !== i) }) : undefined}
              />
            </div>
          ))}
          <button className="ghost" onClick={() => setG({ stops: [...g.stops, { offset: 1, color: g.stops[g.stops.length - 1]!.color }].sort((a, b) => a.offset - b.offset) })}>
            + Ajouter un arrêt
          </button>
        </>
      ) : (
        solid && <ColorRow value={solid} onChange={setSolid} onRemove={isText ? undefined : () => set({ fill: null })} />
      )}
    </Section>
  );
}

// ---------- Effets : ombres portées et internes ----------

type EffectKind = Shadow["type"] | "layer" | "background";
const EFFECT_LABELS: Record<EffectKind, string> = { drop: "Portée", inner: "Interne", layer: "Flou de calque", background: "Flou d'arrière-plan" };

function EffectsSection({ node, set }: { node: DesignNode; set: (p: NodeProps) => void }) {
  const shadows = node.shadows ?? [];
  const update = (i: number, patch: Partial<Shadow>) => set({ shadows: shadows.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const newShadow = (type: Shadow["type"], blur = 12): Shadow => ({ type, x: 0, y: type === "drop" ? 4 : 2, blur, spread: 0, color: "#00000026" });

  /** Changer le type d'un effet : une ombre peut devenir un flou et inversement, comme dans Figma. */
  const retype = (from: { shadow?: number; blur?: "layer" | "background" }, to: EffectKind) => {
    const props: NodeProps = {};
    let list = shadows;
    let amount = 8;
    if (from.shadow !== undefined) {
      amount = shadows[from.shadow]!.blur || 8;
      if (to === "drop" || to === "inner") return update(from.shadow, { type: to });
      list = shadows.filter((_, j) => j !== from.shadow);
      props.shadows = list;
    } else if (from.blur) {
      amount = (from.blur === "layer" ? node.layerBlur : node.backgroundBlur) ?? 8;
      if (to === from.blur) return;
      props[from.blur === "layer" ? "layerBlur" : "backgroundBlur"] = null;
    }
    if (to === "layer") props.layerBlur = amount;
    else if (to === "background") props.backgroundBlur = amount;
    else props.shadows = [...list, newShadow(to, amount)];
    set(props);
  };
  const kindSelect = (value: EffectKind, onChange: (k: EffectKind) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value as EffectKind)}>
      {(Object.keys(EFFECT_LABELS) as EffectKind[]).map((k) => <option key={k} value={k}>{EFFECT_LABELS[k]}</option>)}
    </select>
  );
  const blurRow = (kind: "layer" | "background", value: number) => (
    <div className="effect" key={kind}>
      <div className="row">
        {kindSelect(kind, (k) => retype({ blur: kind }, k))}
        <button className="icon-btn" title="Retirer" onClick={() => set(kind === "layer" ? { layerBlur: null } : { backgroundBlur: null })}><IconMinus size={14} /></button>
      </div>
      <div className="grid2">
        <Num label="Flou" value={value} min={0} onChange={(v) => set(kind === "layer" ? { layerBlur: v } : { backgroundBlur: v })} />
      </div>
      {kind === "background" && !node.fill && !node.gradient && <p className="hint">Astuce : un fond semi-transparent rend l'effet verre dépoli visible.</p>}
    </div>
  );

  return (
    <Section
      title="Effets"
      action={
        <button className="icon-btn" title="Ajouter un effet" onClick={() => set({ shadows: [...shadows, newShadow("drop")] })}>
          <IconPlus size={14} />
        </button>
      }
    >
      {shadows.map((s, i) => (
        <div className="effect" key={i}>
          <div className="row">
            {kindSelect(s.type, (k) => retype({ shadow: i }, k))}
            <button className="icon-btn" title="Retirer" onClick={() => set({ shadows: shadows.filter((_, j) => j !== i) })}><IconMinus size={14} /></button>
          </div>
          <div className="grid2">
            <Num label="X" value={s.x} onChange={(x) => update(i, { x })} />
            <Num label="Y" value={s.y} onChange={(y) => update(i, { y })} />
            <Num label="Flou" value={s.blur} min={0} onChange={(blur) => update(i, { blur })} />
            <Num label="Ét." value={s.spread} onChange={(spread) => update(i, { spread })} />
          </div>
          <ColorRow value={s.color} onChange={(color) => color && update(i, { color })} />
        </div>
      ))}
      {!!node.layerBlur && blurRow("layer", node.layerBlur)}
      {!!node.backgroundBlur && blurRow("background", node.backgroundBlur)}
    </Section>
  );
}

// ---------- Briques ----------

export function Section({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Champ numérique : validé à Entrée ou en quittant le champ ; flèches haut/bas (+Maj) pour ajuster. */
function Num({ label, value, onChange, min, step = 1, suffix }: { label: string; value: number; onChange: (v: number) => void; min?: number; step?: number; suffix?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 100) / 100);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft.replace(",", "."));
    setDraft(null);
    if (Number.isFinite(v) && v !== value) onChange(min !== undefined ? Math.max(min, v) : v);
  };
  return (
    <label className="num">
      <span className="num-label">{label}</span>
      <input
        value={shown}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur(); // valide (onBlur) et rend la main aux raccourcis
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const next = Math.round((value + d) * 100) / 100;
            onChange(min !== undefined ? Math.max(min, next) : next);
          }
        }}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </label>
  );
}

/** Ligne couleur façon Figma : pastille, code hexadécimal, opacité en %, bouton retirer. */
function ColorRow({ value, onChange, onRemove }: { value: string; onChange: (v: string | null) => void; onRemove?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const hex = value.slice(1, 7).toUpperCase();
  const alpha = value.length === 9 ? Math.round((parseInt(value.slice(7), 16) / 255) * 100) : 100;
  const withAlpha = (h: string, a: number) =>
    "#" + h + (a >= 100 ? "" : Math.round((Math.max(0, a) / 100) * 255).toString(16).padStart(2, "0").toUpperCase());
  return (
    <div className="color-row">
      <label className="swatch" style={{ background: value }}>
        <input type="color" value={"#" + hex} onChange={(e) => onChange(withAlpha(e.target.value.slice(1).toUpperCase(), alpha))} />
      </label>
      <input
        className="hex"
        value={draft ?? hex}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const v = draft.trim().replace(/^#/, "").toUpperCase();
          setDraft(null);
          if (/^[0-9A-F]{6}$/.test(v)) onChange(withAlpha(v, alpha));
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <input
        className="alpha"
        defaultValue={alpha}
        key={alpha}
        onBlur={(e) => {
          const a = Number(e.target.value);
          if (Number.isFinite(a) && a !== alpha) onChange(withAlpha(hex, Math.min(100, a)));
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <span className="num-suffix">%</span>
      {onRemove && <button className="icon-btn" title="Retirer" onClick={onRemove}><IconMinus size={14} /></button>}
    </div>
  );
}
