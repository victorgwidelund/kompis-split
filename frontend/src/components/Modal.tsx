import { useEffect, useId, useRef } from "react";

export function Modal({ open, onClose, children, wide = false }: { open: boolean; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // DialogHeader tags its <h2> with a matching id via useId(); link it here so screen
      // readers announce the dialog's actual title instead of reading the whole subtree.
      const heading = dialog.querySelector("h2");
      if (heading?.id) dialog.setAttribute("aria-labelledby", heading.id);
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className={`dialog-card${wide ? " wide-dialog" : ""}`}>{children}</div>
    </dialog>
  );
}

export function DialogHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }) {
  const headingId = useId();
  return <div className="dialog-header"><div><p className="eyebrow">{eyebrow}</p><h2 id={headingId}>{title}</h2></div><button type="button" className="dialog-close" aria-label="Stäng" onClick={onClose}>×</button></div>;
}
