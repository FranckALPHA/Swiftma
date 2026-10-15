import { useState } from "react";
import { type AutoLayout, type StyleKind, applyOps, colorName, deleteStyleOps, extractStylesOps, upsertStyleOps, DEFAULT_BACKGROUND, type DesignDocument, type DesignNode, addVariantOps, combineAsVariantsOps, componentSetOf, detachInstanceOps, resetOverridesOps, setVariantOps, variantProperties, type Gradient, type NodeProps, type Shadow, type Sizing, addAutoLayoutOps, cssGradient, exportHtml, inFlow, resizeOps, toTree } from "@swiftma/core";
import { addAutoLayout, createComponent, dispatch, insertInstance, makeResponsive, select, setRightTab, useEditor, zoomToFit } from "../store";
import { downloadReactZip } from "../exporting";
import { IconCode, IconComponent, IconInstance, IconDownload, IconPen, IconEye, IconEyeOff, IconMinus, IconPlug, IconPlus } from "./icons";
import { Modal } from "./Modal";

/** Onglet « Design » du panneau de droite : propriétés de la sélection, ou de la page. */
export function DesignTab() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const node = selection.length === 1 ? doc.nodes[selection[0]!] : undefined;
  if (selection.length > 1) {
    const allComponents = selection.every((id) => doc.nodes[id]?.isComponent);
    return (
      <Section title={`${selection.length} éléments sélectionnés`}>
        <p className="hint">Sélectionne un seul élément pour modifier ses propriétés.</p>
        <div className="row">
          <button className="btn ghost-btn" title="Maj+A" onClick={() => addAutoLayout(selection)}>Auto-layout</button>
          {allComponents ? (
            <button className="btn component-btn" onClick={() => {
              const res = combineAsVariantsOps(doc, selection);
              if (res) (dispatch(res.ops, "Réunir en variantes"), select([res.id]));
            }}><IconComponent size={14} /> Réunir en variantes</button>
          ) : (
            <button className="btn ghost-btn" title="Ctrl+Alt+K" onClick={() => createComponent(selection)}><IconComponent size={14} /> Composant</button>
          )}
        </div>
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
      <StylesSection />
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
        <div className="kv"><span>Personnes dans ce fichier</span><b>{presence.users.map((u) => u.name).join(", ") || "—"}</b></div>
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
    <Modal title="Connecter une IA à Swiftma (MCP)" onClose={onClose}>
      <p>Swiftma expose un serveur MCP : toute IA compatible peut lire et dessiner dans tes fichiers, en direct, avec tes droits.</p>
      <p>1. Crée un jeton d'accès : écran Projets → ton nom (en bas à gauche) → <b>Jetons d'accès</b>.</p>
      <p>2. <b>Claude Code</b> :</p>
      <pre>{`claude mcp add --transport http swiftma ${url} \
  --header "Authorization: Bearer <ton jeton>"`}</pre>
      <p><b>Autres clients MCP (Cursor, Claude Desktop…)</b></p>
      <pre>{JSON.stringify({ mcpServers: { swiftma: { type: "http", url, headers: { Authorization: "Bearer <ton jeton>" } } } }, null, 2)}</pre>
      <p className="hint">
        Par défaut, l'IA travaille sur le fichier que tu as ouvert en dernier. Elle peut aussi lister tes projets et ouvrir un autre fichier.
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
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  const flow = inFlow(doc, node);
  const [responsiveInfo, setResponsiveInfo] = useState<string | null>(null);

  return (
    <>
      <div className="node-head">
        <span className="node-kind">{KIND[node.type]}</span>
        <span className="node-name">{node.name}</span>
      </div>

      <ComponentSection node={node} />

      <Section title="Position">
        {flow ? (
          <p className="hint">Placé par l'auto-layout de « {parent!.name} ». Glisse-le pour changer son ordre.</p>
        ) : (
          <div className="grid2">
            <Num label="X" value={node.x} onChange={(x) => set({ x })} />
            <Num label="Y" value={node.y} onChange={(y) => set({ y })} />
            <Num label="↻" value={node.rotation} suffix="°" onChange={(rotation) => set({ rotation })} />
          </div>
        )}
        {parent?.layout && (
          <label className="check">
            <input type="checkbox" checked={!!node.absolute} onChange={(e) => set({ absolute: e.target.checked })} /> Position absolue (hors auto-layout)
          </label>
        )}
      </Section>

      <Section title="Dimensions">
        <div className="grid2">
          <Num label="L" value={node.width} min={1} onChange={(width) => dispatch(resizeOps(doc, node.id, width, node.height, node.sizingH && node.sizingH !== "fixed" ? { sizingH: "fixed" } : {}), "Redimensionner")} />
          <Num label="H" value={node.height} min={1} onChange={(height) => dispatch(resizeOps(doc, node.id, node.width, height, node.sizingV && node.sizingV !== "fixed" ? { sizingV: "fixed" } : {}), "Redimensionner")} />
          {(flow || node.layout || !node.parentId || node.type === "text") && (
            <>
              <SizingSelect value={node.sizingH} fill={flow || !node.parentId} hug={!!node.layout || node.type === "text"} onChange={(sizingH) => set({ sizingH })} />
              <SizingSelect value={node.sizingV} fill={flow} hug={!!node.layout || node.type === "text"} onChange={(sizingV) => set({ sizingV })} />
            </>
          )}
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

      <BoundsSection node={node} set={set} />

      {parent && (!parent.layout || node.absolute) && <ConstraintsSection node={node} set={set} />}

      {node.type === "frame" && <AutoLayoutSection node={node} set={set} />}

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
          <StylePicker
            kind="texts"
            value={node.textStyle}
            onPick={(textStyle) => set({ textStyle })}
            onCreate={() => {
              const t = node.text!;
              const res = upsertStyleOps(doc, "texts", { name: `${t.fontFamily} ${t.fontSize} ${WEIGHTS[t.fontWeight] ?? t.fontWeight}`, fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight, lineHeight: t.lineHeight, ...(t.letterSpacing ? { letterSpacing: t.letterSpacing } : {}), ...(t.italic ? { italic: true } : {}) });
              dispatch([...res.ops, { kind: "update", id: node.id, props: { textStyle: res.id } }], "Créer un style de texte");
            }}
          />
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
        {node.type === "frame" && (
          <>
            <button
              className="btn ghost-btn"
              title="Passe en auto-layout chaque zone régulière (lignes, colonnes) sans rien déplacer : le code exporté s'adapte à l'écran"
              onClick={() => {
                const n = makeResponsive(node.id);
                setResponsiveInfo(n ? `${n} frame(s) passée(s) en auto-layout, sans rien déplacer.` : "Aucune zone régulière trouvée : les positions restent fixes.");
              }}
            >
              Rendre responsive
            </button>
            {responsiveInfo && <p className="hint">{responsiveInfo}</p>}
          </>
        )}
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

// ---------- Styles partagés ----------

const KIND_LABEL = { colors: "couleur", texts: "texte", effects: "ombre" } as const;
const NO_STYLES = {};

/** Lien vers un style partagé : pastille du style lié (avec « détacher »), ou choix d'un style / création. */
function StylePicker({ kind, value, onPick, onCreate }: { kind: StyleKind; value?: string | null; onPick: (id: string | null) => void; onCreate: () => void }) {
  // (objet vide constant : un nouvel objet à chaque lecture ferait boucler React)
  const styles = (useEditor((s) => s.doc.styles?.[kind]) ?? NO_STYLES) as Record<string, { name: string; value?: string }>;
  const linked = value ? styles[value] : undefined;
  if (linked) {
    return (
      <div className="style-chip" title="Ce réglage suit le style partagé : le modifier ici détache l'élément du style">
        {kind === "colors" && <span className="dot" style={{ background: linked.value }} />}
        <span className="flex1">{linked.name}</span>
        <button className="icon-btn" title="Détacher du style (garde les valeurs)" onClick={() => onPick(null)}><IconMinus size={14} /></button>
      </div>
    );
  }
  return (
    <select
      className="style-select"
      value=""
      onChange={(e) => (e.target.value === "+" ? onCreate() : e.target.value && onPick(e.target.value))}
    >
      <option value="">◆ Style de {KIND_LABEL[kind]}…</option>
      {Object.entries(styles).map(([id, st]) => <option key={id} value={id}>{st.name}</option>)}
      <option value="+">＋ Créer un style à partir de ce réglage</option>
    </select>
  );
}

/** Liste des styles du document (aucune sélection) : renommer, modifier, supprimer, détecter. */
function StylesSection() {
  const doc = useEditor((s) => s.doc);
  const st = doc.styles ?? {};
  const [info, setInfo] = useState<string | null>(null);
  const count = Object.keys(st.colors ?? {}).length + Object.keys(st.texts ?? {}).length + Object.keys(st.effects ?? {}).length;
  const rename = (kind: StyleKind, id: string, name: string) => {
    const cur = (st[kind] as Record<string, { name: string }>)[id]!;
    if (name && name !== cur.name) dispatch(upsertStyleOps(doc, kind, { ...cur, name }, id).ops, "Renommer le style");
  };
  const nameInput = (kind: StyleKind, id: string, name: string) => (
    <input className="flex1" defaultValue={name} key={id + name} onBlur={(e) => rename(kind, id, e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
  );
  const remove = (kind: StyleKind, id: string) => (
    <button className="icon-btn" title="Supprimer le style (les éléments gardent leurs valeurs)" onClick={() => dispatch(deleteStyleOps(doc, kind, id), "Supprimer le style")}><IconMinus size={14} /></button>
  );
  return (
    <Section
      title={`Styles${count ? ` (${count})` : ""}`}
      action={
        <button className="icon-btn" title="Nouveau style de couleur" onClick={() => dispatch(upsertStyleOps(doc, "colors", { name: `Couleur ${Object.keys(st.colors ?? {}).length + 1}`, value: "#0D99FF" }).ops, "Nouveau style")}>
          <IconPlus size={14} />
        </button>
      }
    >
      {Object.entries(st.colors ?? {}).map(([id, c]) => (
        <div className="row" key={id}>
          <label className="swatch" style={{ background: c.value }}>
            <input type="color" value={c.value.slice(0, 7)} onChange={(e) => dispatch(upsertStyleOps(doc, "colors", { ...c, value: e.target.value.toUpperCase() + c.value.slice(7) }, id).ops, "Modifier le style")} />
          </label>
          {nameInput("colors", id, c.name)}
          {remove("colors", id)}
        </div>
      ))}
      {Object.entries(st.texts ?? {}).map(([id, t]) => (
        <div key={id}>
          <div className="row">
            <span className="style-aa" style={{ fontFamily: t.fontFamily, fontWeight: t.fontWeight }}>Aa</span>
            {nameInput("texts", id, t.name)}
            {remove("texts", id)}
          </div>
          <div className="grid2">
            <Num label="Aa" value={t.fontSize} min={1} onChange={(fontSize) => dispatch(upsertStyleOps(doc, "texts", { ...t, fontSize }, id).ops, "Modifier le style")} />
            <select value={t.fontWeight} onChange={(e) => dispatch(upsertStyleOps(doc, "texts", { ...t, fontWeight: Number(e.target.value) }, id).ops, "Modifier le style")}>
              {Object.entries(WEIGHTS).map(([w, label]) => <option key={w} value={w}>{label}</option>)}
            </select>
          </div>
        </div>
      ))}
      {Object.entries(st.effects ?? {}).map(([id, e]) => (
        <div className="row" key={id}>
          <span className="style-shadow" style={{ boxShadow: e.shadows.map((x) => `${x.type === "inner" ? "inset " : ""}${x.x}px ${x.y}px ${x.blur}px ${x.spread}px ${x.color}`).join(", ") }} />
          {nameInput("effects", id, e.name)}
          {remove("effects", id)}
        </div>
      ))}
      <button
        className="btn ghost-btn"
        title="Crée des styles à partir des couleurs, typographies et ombres répétées dans le document, et y lie les éléments"
        onClick={() => {
          let total = { colors: 0, texts: 0, effects: 0 };
          let current = doc;
          const ops = doc.roots.flatMap((rid) => {
            const res = extractStylesOps(current, rid);
            current = structuredClone(current);
            applyOps(current, res.ops);
            total = { colors: total.colors + res.counts.colors, texts: total.texts + res.counts.texts, effects: total.effects + res.counts.effects };
            return res.ops;
          });
          dispatch(ops, "Détecter les styles");
          setInfo(`${total.colors} couleur(s), ${total.texts} typographie(s), ${total.effects} ombre(s) détectées.`);
        }}
      >
        Détecter les styles
      </button>
      {info && <p className="hint">{info}</p>}
    </Section>
  );
}

// ---------- Composants ----------

function ComponentSection({ node }: { node: DesignNode }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const main = node.instanceOf ? doc.nodes[node.instanceOf] : undefined;
  const set = node.isComponent ? componentSetOf(doc, node.id) : main ? componentSetOf(doc, main.id) : null;
  const props = set ? variantProperties(doc, set.id) : {};
  const overridden = node.instanceOf ? countOverrides(doc, node.id) : 0;

  if (node.isComponentSet) {
    return (
      <Section title={<span className="component-head"><IconComponent size={12} /> Ensemble de variantes</span>}>
        <p className="hint">Chaque composant de cet ensemble est une variante. Renomme leurs propriétés en sélectionnant une variante.</p>
      </Section>
    );
  }
  if (node.isComponent) {
    const variant = node.variant ?? {};
    return (
      <Section title={<span className="component-head"><IconComponent size={12} /> Composant principal</span>}>
        {Object.entries(variant).map(([k, v]) => (
          <div className="grid2" key={k}>
            <input defaultValue={k} key={"k" + k} title="Nom de la propriété" onBlur={(e) => {
              const nk = e.target.value.trim();
              if (!nk || nk === k || !set) return;
              // Renommer une propriété la renomme dans toutes les variantes de l'ensemble
              dispatch(set.children.map((id) => doc.nodes[id]!).filter((c) => c.variant && k in c.variant).map((c) => ({
                kind: "update" as const, id: c.id, props: { variant: Object.fromEntries(Object.entries(c.variant!).map(([a, b]) => [a === k ? nk : a, b])) },
              })), "Renommer la propriété");
            }} />
            <input defaultValue={v} key={"v" + v} title="Valeur de cette variante" onBlur={(e) => e.target.value.trim() && e.target.value !== v && dispatch([{ kind: "update", id: node.id, props: { variant: { ...variant, [k]: e.target.value.trim() } } }], "Renommer la variante")} />
          </div>
        ))}
        <div className="row">
          <button className="btn component-btn" onClick={() => insertInstance(node.id)}><IconInstance size={14} /> Insérer une instance</button>
          <button className="btn ghost-btn" title="Ajouter une variante (copie de ce composant)" onClick={() => {
            const res = addVariantOps(doc, node.id);
            if (res) (dispatch(res.ops, "Ajouter une variante"), select([res.id]));
          }}>+ Variante</button>
        </div>
      </Section>
    );
  }
  if (node.instanceOf) {
    return (
      <Section title={<span className="component-head"><IconInstance size={12} /> Instance{main ? ` de « ${set ? set.name : main.name} »` : " (composant supprimé)"}</span>}>
        {Object.entries(props).map(([k, values]) => (
          <div className="row" key={k}>
            <span className="flex1">{k}</span>
            <select value={main?.variant?.[k] ?? ""} onChange={(e) => dispatch(setVariantOps(doc, node.id, k, e.target.value), "Changer de variante")}>
              {values.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        ))}
        <div className="row">
          {main && <button className="btn ghost-btn" onClick={() => (select([main.id]), zoomToFit([main.id]))}>Aller au composant</button>}
          <button className="btn ghost-btn" title="En faire une frame ordinaire" onClick={() => dispatch(detachInstanceOps(doc, node.id), "Détacher l'instance")}>Détacher</button>
        </div>
        {overridden > 0 && (
          <button className="ghost" onClick={() => dispatch(resetOverridesOps(doc, node.id), "Réinitialiser l'instance")}>
            Réinitialiser {overridden} surcharge{overridden > 1 ? "s" : ""}
          </button>
        )}
      </Section>
    );
  }
  if (node.type === "frame" || selection.length > 1) {
    return (
      <Section title="Composant" action={<button className="icon-btn" title="Créer un composant (Ctrl+Alt+K)" onClick={() => createComponent(selection)}><IconComponent size={14} /></button>} />
    );
  }
  return null;
}

function countOverrides(doc: DesignDocument, id: string): number {
  const n = doc.nodes[id]!;
  return (n.overrides?.length ?? 0) + n.children.reduce((s, c) => s + countOverrides(doc, c), 0);
}

// ---------- Contraintes et bornes de taille ----------

const H_CONSTRAINTS = { left: "Gauche", right: "Droite", "left-right": "Gauche et droite", center: "Centre", scale: "Échelle" } as const;
const V_CONSTRAINTS = { top: "Haut", bottom: "Bas", "top-bottom": "Haut et bas", center: "Centre", scale: "Échelle" } as const;

function ConstraintsSection({ node, set }: { node: DesignNode; set: (p: NodeProps) => void }) {
  const c = node.constraints ?? { h: "left" as const, v: "top" as const };
  return (
    <Section title="Contraintes">
      <div className="grid2">
        <select title="Quand le parent change de largeur" value={c.h} onChange={(e) => set({ constraints: { ...c, h: e.target.value as typeof c.h } })}>
          {Object.entries(H_CONSTRAINTS).map(([k, label]) => <option key={k} value={k}>↔ {label}</option>)}
        </select>
        <select title="Quand le parent change de hauteur" value={c.v} onChange={(e) => set({ constraints: { ...c, v: e.target.value as typeof c.v } })}>
          {Object.entries(V_CONSTRAINTS).map(([k, label]) => <option key={k} value={k}>↕ {label}</option>)}
        </select>
      </div>
    </Section>
  );
}

function BoundsSection({ node, set }: { node: DesignNode; set: (p: NodeProps) => void }) {
  const has = node.minWidth != null || node.maxWidth != null || node.minHeight != null || node.maxHeight != null;
  const [open, setOpen] = useState(has);
  const field = (label: string, key: "minWidth" | "maxWidth" | "minHeight" | "maxHeight") => (
    <label className="num">
      <span className="num-label">{label}</span>
      <input
        placeholder="—"
        defaultValue={node[key] ?? ""}
        key={`${node.id}-${key}-${node[key] ?? ""}`}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const v = raw === "" ? null : Number(raw.replace(",", "."));
          if (v === null || (Number.isFinite(v) && v >= 0)) set({ [key]: v } as NodeProps);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </label>
  );
  if (!open && !has) {
    return (
      <Section title="Taille min / max" action={<button className="icon-btn" title="Bornes de taille (responsive)" onClick={() => setOpen(true)}><IconPlus size={14} /></button>} />
    );
  }
  return (
    <Section
      title="Taille min / max"
      action={<button className="icon-btn" title="Retirer les bornes" onClick={() => (set({ minWidth: null, maxWidth: null, minHeight: null, maxHeight: null }), setOpen(false))}><IconMinus size={14} /></button>}
    >
      <div className="grid2">
        {field("L min", "minWidth")}
        {field("L max", "maxWidth")}
        {field("H min", "minHeight")}
        {field("H max", "maxHeight")}
      </div>
    </Section>
  );
}

// ---------- Auto-layout ----------

const SIZING_LABELS: Record<Sizing, string> = { fixed: "Fixe", fill: "Remplir", hug: "Ajuster" };

function SizingSelect({ value, fill, hug, onChange }: { value?: Sizing; fill: boolean; hug: boolean; onChange: (s: Sizing) => void }) {
  const options: Sizing[] = ["fixed", ...(fill ? (["fill"] as const) : []), ...(hug ? (["hug"] as const) : [])];
  return (
    <select value={value ?? "fixed"} onChange={(e) => onChange(e.target.value as Sizing)}>
      {options.map((o) => <option key={o} value={o}>{SIZING_LABELS[o]}</option>)}
    </select>
  );
}

const ALIGNS = ["start", "center", "end"] as const;

function AutoLayoutSection({ node, set }: { node: DesignNode; set: (p: NodeProps) => void }) {
  const doc = useEditor((s) => s.doc);
  const L = node.layout;
  const setL = (patch: Partial<AutoLayout>) => set({ layout: { ...L!, ...patch } });
  const row = L?.direction === "row";
  return (
    <Section
      title="Auto-layout"
      action={
        L ? (
          <button
            className="icon-btn"
            title="Retirer l'auto-layout (les éléments restent où ils sont)"
            onClick={() => set({ layout: null, ...(node.sizingH === "hug" ? { sizingH: "fixed" } : {}), ...(node.sizingV === "hug" ? { sizingV: "fixed" } : {}) })}
          >
            <IconMinus size={14} />
          </button>
        ) : (
          <button className="icon-btn" title="Ajouter l'auto-layout (Maj+A)" onClick={() => dispatch(addAutoLayoutOps(doc, node.id), "Ajouter l'auto-layout")}>
            <IconPlus size={14} />
          </button>
        )
      }
    >
      {L && (
        <>
          <div className="row">
            <div className="seg flex1">
              <button className={row ? "on" : ""} title="Horizontal" onClick={() => setL({ direction: "row" })}>→</button>
              <button className={!row ? "on" : ""} title="Vertical" onClick={() => setL({ direction: "column", wrap: false })}>↓</button>
              {row && <button className={L.wrap ? "on" : ""} title="Retour à la ligne" onClick={() => setL({ wrap: !L.wrap })}>↵</button>}
            </div>
            <div className="seg flex1">
              <button className={L.justify === "space-between" ? "on" : ""} title="Répartir l'espace entre les éléments" onClick={() => setL({ justify: L.justify === "space-between" ? "start" : "space-between" })}>
                ⇹
              </button>
            </div>
          </div>
          <div className="row">
            {/* Grille d'alignement 3×3 : colonnes = horizontal, lignes = vertical, comme dans Figma */}
            <div className="align-grid">
              {ALIGNS.map((v) =>
                ALIGNS.map((h) => {
                  const main = row ? h : v;
                  const cross = row ? v : h;
                  const on = L.align === cross && (L.justify === main || (L.justify === "space-between" && main === "start"));
                  return (
                    <button
                      key={v + h}
                      className={on ? "on" : ""}
                      title={`${{ start: "Haut", center: "Milieu", end: "Bas" }[v]} — ${{ start: "gauche", center: "centre", end: "droite" }[h]}`}
                      onClick={() => setL({ align: cross, justify: L.justify === "space-between" ? "space-between" : main })}
                    />
                  );
                }),
              )}
            </div>
            <div className="grid2 flex1">
              <Num label={row ? "↔" : "↕"} value={L.gap} min={0} onChange={(gap) => setL({ gap })} />
              {row && L.wrap && <Num label="↕" value={L.wrapGap ?? L.gap} min={0} onChange={(wrapGap) => setL({ wrapGap })} />}
            </div>
          </div>
          <div className="grid2">
            {(["↑", "→", "↓", "←"] as const).map((label, i) => (
              <Num key={label} label={label} value={L.padding[i]!} min={0} onChange={(v) => setL({ padding: L.padding.map((p, j) => (j === i ? v : p)) as AutoLayout["padding"] })} />
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

// ---------- Remplissage (couleur unie ou dégradé) ----------

function FillSection({ node, set }: { node: DesignNode; set: (p: NodeProps) => void }) {
  const doc = useEditor((s) => s.doc);
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
      {(node.fillStyle || (solid && !g)) && (
        <StylePicker
          kind="colors"
          value={node.fillStyle}
          onPick={(fillStyle) => set({ fillStyle })}
          onCreate={() => {
            const res = upsertStyleOps(doc, "colors", { name: colorName(solid!), value: solid! });
            dispatch([...res.ops, { kind: "update", id: node.id, props: { fillStyle: res.id } }], "Créer un style de couleur");
          }}
        />
      )}
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
  const doc = useEditor((s) => s.doc);
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
      {(node.effectStyle || shadows.length > 0) && (
        <StylePicker
          kind="effects"
          value={node.effectStyle}
          onPick={(effectStyle) => set({ effectStyle })}
          onCreate={() => {
            const res = upsertStyleOps(doc, "effects", { name: `Ombre ${Object.keys(doc.styles?.effects ?? {}).length + 1}`, shadows });
            dispatch([...res.ops, { kind: "update", id: node.id, props: { effectStyle: res.id } }], "Créer un style d'ombre");
          }}
        />
      )}
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
