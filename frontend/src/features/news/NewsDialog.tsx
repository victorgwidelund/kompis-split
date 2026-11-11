import { DialogHeader, Modal } from "../../components/Modal";
import { newsEntries } from "./news";

export function NewsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Modal open={open} onClose={onClose}><DialogHeader eyebrow="Vad är nytt?" title="Nyheter" onClose={onClose} />
    {newsEntries.map((entry, index) => <article className={`news-entry${index === 0 ? " latest" : ""}`} key={entry.id}>
      <p className="eyebrow">{index === 0 ? `Senast · ${entry.date}` : entry.date}</p>
      <h3>{entry.title}</h3>
      <ul>{entry.items.map((item) => <li key={item}>{item}</li>)}</ul>
    </article>)}
    <button className="button primary wide" type="button" onClick={onClose}>Toppen!</button>
  </Modal>;
}
