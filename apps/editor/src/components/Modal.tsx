import { createPortal } from "react-dom";

// Rendue dans <body> : les panneaux flottants (backdrop-filter, transform) enfermeraient sinon une
// fenêtre « position: fixed » ouverte depuis eux, et la couperaient à leur taille.
export function Modal({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  return createPortal(
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{title}</b>
          {actions}
          <button className="ghost" onClick={onClose}>Fermer</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
