import { useEffect, useRef } from "react";

export function Modal({ open, onClose, children, wide = false }: { open: boolean; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className={`dialog-card${wide ? " wide-dialog" : ""}`}>{children}</div>
    </dialog>
  );
}

export function DialogHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }) {
  return <div className="dialog-header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><button type="button" className="dialog-close" aria-label="Stäng" onClick={onClose}>×</button></div>;
}
