import { type DesignNode, variantProperties } from "@nyota/core";
import { insertInstance, select, useEditor, zoomToFit } from "../store";
import { IconComponent } from "./icons";

/** Onglet « Composants » : tous les composants principaux du document, prêts à être insérés. */
export function AssetsPanel() {
  const doc = useEditor((s) => s.doc);
  const all = Object.values(doc.nodes).filter((n) => n.isComponent);
  const sets = Object.values(doc.nodes).filter((n) => n.isComponentSet);
  const loose = all.filter((c) => !(c.parentId && doc.nodes[c.parentId]?.isComponentSet));
  const show = (n: DesignNode) => (select([n.id]), zoomToFit([n.id]));
  return (
    <div className="assets">
      <div className="side-section-title">Composants</div>
      {!all.length && (
        <p className="hint pad">
          Aucun composant pour l'instant. Sélectionne une frame (ou des éléments) puis <b>Ctrl+Alt+K</b> pour en créer un :
          ses instances suivront chacune de ses modifications.
        </p>
      )}
      {loose.map((c) => (
        <div key={c.id} className="asset" title="Cliquer pour insérer une instance · double-clic pour voir le composant" onClick={() => insertInstance(c.id)} onDoubleClick={() => show(c)}>
          <IconComponent size={12} />
          <span className="name">{c.name}</span>
          <span className="meta">{Math.round(c.width)}×{Math.round(c.height)}</span>
        </div>
      ))}
      {sets.map((set) => {
        const props = variantProperties(doc, set.id);
        return (
          <div key={set.id} className="asset-set">
            <div className="asset set-head" onDoubleClick={() => show(set)} title="Double-clic pour voir l'ensemble">
              <IconComponent size={12} />
              <span className="name">{set.name}</span>
              <span className="meta">{Object.entries(props).map(([k, v]) => `${k} (${v.length})`).join(", ")}</span>
            </div>
            {set.children.map((id) => doc.nodes[id]!).filter((c) => c.isComponent).map((c) => (
              <div key={c.id} className="asset variant" title="Cliquer pour insérer cette variante" onClick={() => insertInstance(c.id)} onDoubleClick={() => show(c)}>
                <span className="name">{Object.values(c.variant ?? {}).join(" · ") || c.name}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
