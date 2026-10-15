export function Modal({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{title}</b>
          {actions}
          <button className="ghost" onClick={onClose}>Fermer</button>
        </div>
        {children}
      </div>
    </div>
  );
}
