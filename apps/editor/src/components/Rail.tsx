import { useState } from "react";
import { setLeftTab, useEditor } from "../store";
import { IconComponent, IconFile, IconHelp, IconLogo, IconPlug, IconSparkle } from "./icons";
import { SOURCE_URL } from "../source";
import { Modal } from "./Modal";

/** Barre d'icônes verticale à gauche (Fichier, IA, aide). */
export function Rail() {
  const tab = useEditor((s) => s.leftTab);
  const aiBusy = useEditor((s) => s.aiBusy);
  const [help, setHelp] = useState(false);
  return (
    <nav className="rail">
      <div className="rail-logo" title="Swiftma"><IconLogo /></div>
      <RailButton active={tab === "file"} label="Fichier" onClick={() => setLeftTab("file")}><IconFile /></RailButton>
      <RailButton active={tab === "assets"} label="Composants" onClick={() => setLeftTab("assets")}><IconComponent /></RailButton>
      <RailButton active={tab === "plugins"} label="Plugins" onClick={() => setLeftTab("plugins")}><IconPlug /></RailButton>
      <RailButton active={tab === "ai"} label="IA" onClick={() => setLeftTab("ai")} dot={aiBusy}><IconSparkle /></RailButton>
      <div className="rail-spacer" />
      <RailButton label="Aide" onClick={() => setHelp(true)}><IconHelp /></RailButton>
      {help && <ShortcutsModal onClose={() => setHelp(false)} />}
    </nav>
  );
}

function RailButton({ active, label, onClick, children, dot }: { active?: boolean; label: string; onClick: () => void; children: React.ReactNode; dot?: boolean }) {
  return (
    <button className={"rail-btn" + (active ? " active" : "")} onClick={onClick} title={label}>
      <span className="rail-icon">{children}{dot && <i className="rail-dot" />}</span>
      <span className="rail-label">{label}</span>
    </button>
  );
}

const SHORTCUTS: [string, string][] = [
  ["V F R O T H", "Sélection, Frame, Rectangle, Ellipse, Texte, Main"],
  ["Espace + glisser / molette", "Déplacer le canevas"],
  ["Ctrl + molette", "Zoom"],
  ["Maj + 1 / Maj + 0", "Tout afficher / Zoom 100 %"],
  ["Ctrl+Z / Ctrl+Maj+Z", "Annuler / Rétablir (y compris l'IA)"],
  ["Ctrl+Alt+K", "Créer un composant"],
  ["Maj+A", "Ajouter un auto-layout (ou englober la sélection)"],
  ["Alt+Maj+A", "Retirer l'auto-layout"],
  ["Ctrl+G / Ctrl+Maj+G", "Grouper / Dissocier (groupe ou auto-layout)"],
  ["Ctrl+↑ / Ctrl+↓", "Avancer / Reculer d'un cran"],
  ["Ctrl+Maj+↑ / Ctrl+Maj+↓", "Premier plan / Arrière-plan"],
  ["Clic droit", "Menu de l'élément"],
  ["Ctrl+C / Ctrl+X / Ctrl+V", "Copier / Couper / Coller (aussi d'un onglet ou d'un fichier à l'autre)"],
  ["Ctrl+D", "Dupliquer"],
  ["Ctrl+Maj+H / Ctrl+Maj+L", "Masquer / Verrouiller"],
  ["Glisser dans une frame", "L'élément y entre ; hors de la frame, il en sort"],
  ["Suppr", "Supprimer"],
  ["Flèches (+Maj)", "Décaler de 1 px (10 px)"],
  ["Double-clic sur un texte", "Éditer le texte"],
  ["Ctrl+V avec une image", "La poser sur le canevas (onglet IA ouvert : l'envoyer à l'IA)"],
];

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Raccourcis clavier" onClose={onClose}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint pad">
        Swiftma est un logiciel libre (AGPL-3.0). <a href={SOURCE_URL} target="_blank" rel="noreferrer">Code source</a>
      </p>
    </Modal>
  );
}
