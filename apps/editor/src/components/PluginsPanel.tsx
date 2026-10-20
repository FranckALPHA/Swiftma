import { useEffect, useRef, useState } from "react";
import { type InstalledPlugin, PERMISSION_LABELS, addPersonalPlugin, connectPlugin, fetchManifest, loadInstalledPlugins, removePersonalPlugin } from "../plugins";
import { IconChevron, IconPlug, IconPlus } from "./icons";

// Le plugin ouvert reste ouvert quand on change d'onglet puis qu'on revient
let lastOpened: string | null = null;

/** Onglet « Plugins » : la liste, l'ajout par URL de manifeste, et le plugin ouvert dans son cadre isolé. */
export function PluginsPanel() {
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(lastOpened);
  const [adding, setAdding] = useState(false);

  const reload = () =>
    void loadInstalledPlugins().then(({ plugins: list, errors: errs }) => {
      setPlugins(list);
      setErrors(errs);
    });
  useEffect(reload, []);
  useEffect(() => {
    lastOpened = openId;
  }, [openId]);

  const open = plugins?.find((p) => p.id === openId);
  if (open) return <PluginFrame plugin={open} onBack={() => setOpenId(null)} />;

  return (
    <div className="plugins">
      <div className="side-section-title row-between">
        <span>Plugins</span>
        <button className="icon-btn" title="Ajouter un plugin" onClick={() => setAdding(!adding)}>
          <IconPlus size={14} />
        </button>
      </div>
      {adding && <AddPlugin onDone={() => (setAdding(false), reload())} />}
      {plugins === null && <p className="hint pad">Chargement…</p>}
      {plugins?.length === 0 && !adding && <p className="hint pad">Aucun plugin. Ajoute-en un avec son URL de manifeste (+).</p>}
      {plugins?.map((p) => (
        <div key={p.id} className="plugin-row" onClick={() => setOpenId(p.id)} title={p.description}>
          <span className="plugin-icon"><IconPlug size={14} /></span>
          <span className="plugin-text">
            <span className="name">{p.name}</span>
            {p.description && <span className="desc">{p.description}</span>}
          </span>
          {p.personal ? (
            <button
              className="ghost"
              title="Retirer ce plugin de ce navigateur"
              onClick={(e) => (e.stopPropagation(), removePersonalPlugin(p.manifestUrl), reload())}
            >
              Retirer
            </button>
          ) : (
            <span className="pill">Instance</span>
          )}
        </div>
      ))}
      {errors.length > 0 && (
        <p className="hint pad plugin-errors">
          Plugins indisponibles :<br />
          {errors.map((e) => <span key={e}>{e}<br /></span>)}
        </p>
      )}
      <p className="hint pad">
        Un plugin est une page web qui dessine dans ton fichier avec les mêmes outils que l'IA, dans un cadre isolé :
        il ne voit ni ta session ni tes autres fichiers. Créer un plugin : <code>docs/plugins.md</code>.
      </p>
    </div>
  );
}

function AddPlugin({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof fetchManifest>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await fetchManifest(url.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="section plugin-add">
      <input
        placeholder="https://…/manifest.json"
        value={url}
        autoFocus
        onChange={(e) => (setUrl(e.target.value), setPreview(null))}
        onKeyDown={(e) => e.key === "Enter" && url.trim() && void check()}
      />
      {!preview && (
        <button className="btn" disabled={!url.trim() || busy} onClick={() => void check()}>
          {busy ? "Vérification…" : "Vérifier"}
        </button>
      )}
      {error && <p className="hint plugin-errors">{error}</p>}
      {preview && (
        <>
          <div className="kv"><span>Plugin</span><b>{preview.name}</b></div>
          <div className="kv"><span>Page</span><b title={preview.page}>{new URL(preview.page).host}</b></div>
          <p className="hint">Il pourra :</p>
          <ul className="plugin-perms">
            {preview.permissions.length ? preview.permissions.map((p) => <li key={p}>{PERMISSION_LABELS[p]}</li>) : <li>Rien dans le fichier (aucune permission)</li>}
          </ul>
          <button className="btn primary-btn" onClick={() => (addPersonalPlugin(url.trim()), onDone())}>Ajouter ce plugin</button>
        </>
      )}
    </div>
  );
}

function PluginFrame({ plugin, onBack }: { plugin: InstalledPlugin; onBack: () => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const disconnect = connectPlugin(frame, plugin);
    let timer = 0;
    const onNotify = (e: Event) => {
      setNotice((e as CustomEvent<string>).detail);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setNotice(null), 3500);
    };
    window.addEventListener("swiftma-plugin-notify", onNotify);
    return () => {
      disconnect();
      window.removeEventListener("swiftma-plugin-notify", onNotify);
      window.clearTimeout(timer);
    };
  }, [plugin]);
  return (
    <div className="plugin-open">
      <div className="plugin-head">
        <button className="ghost" onClick={onBack} title="Retour à la liste des plugins">
          <span className="back"><IconChevron size={10} /></span> Plugins
        </button>
        <b>{plugin.name}</b>
      </div>
      {/* Sans allow-same-origin : origine opaque, aucun accès à la session ni au stockage de Swiftma */}
      <iframe
        ref={ref}
        className="plugin-frame"
        title={plugin.name}
        src={plugin.page}
        sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
      />
      {notice && <div className="plugin-notice">{notice}</div>}
    </div>
  );
}
