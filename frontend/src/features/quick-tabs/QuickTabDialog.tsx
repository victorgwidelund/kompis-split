import { useState } from "react";
import { api, upload } from "../../api/client";
import { DialogHeader, Modal } from "../../components/Modal";
import type { InvitationResult, OcrResponse, QuickTab, OcrSuggestionItem } from "../../types/models";
import { kronorToOre, formatMoney } from "../../utils/format";
import { receiptAiStatus, validateReceiptImage } from "../receipts/ocr";
import { prepareReceiptFile } from "../receipts/imagePrep";

type EditableItem = { key: string; name: string; quantity: string; amount: string };
const emptyItem = (): EditableItem => ({ key: crypto.randomUUID(), name: "", quantity: "1", amount: "" });

export function QuickTabDialog({ open, onClose, onCreated, notify }: { open: boolean; onClose: () => void; onCreated: (tab: QuickTab, invitation: InvitationResult) => Promise<void>; notify: (message: string) => void }) {
  const [items, setItems] = useState<EditableItem[]>([emptyItem()]);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [status, setStatus] = useState("Inget kvitto valt ännu.");
  const [statusClass, setStatusClass] = useState("");
  const [values, setValues] = useState({ name: "", merchant: "", receiptDate: "", total: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patchValue = (name: keyof typeof values, value: string) => setValues((current) => ({ ...current, [name]: value }));
  const reset = () => { setItems([emptyItem()]); setReceipt(null); setStatus("Inget kvitto valt ännu."); setStatusClass(""); setValues({ name: "", merchant: "", receiptDate: "", total: "" }); setError(""); setBusy(false); };
  const close = () => { reset(); onClose(); };
  const analyze = async (file?: File) => {
    if (!file) return; const validation = validateReceiptImage(file);
    if (validation) { setStatus(validation); setStatusClass("warning"); return; }
    setStatusClass("reading"); setStatus("Förbereder bild…");
    const prepared = await prepareReceiptFile(file, (message) => setStatus(message));
    setReceipt(prepared); setStatusClass("reading"); setStatus("AI:n läser och kontrollerar kvittoraderna … Det tar normalt några sekunder.");
    try {
      const payload = await upload<OcrResponse>("/api/quick-tabs/analyze", prepared); const suggestion = payload.suggestion || {}; const suggested = suggestion.items || [];
      const rows = suggested.map((item: OcrSuggestionItem) => ({ key: crypto.randomUUID(), name: item.name || "", quantity: String(item.quantity || 1), amount: String(item.amount || "") }));
      if (rows.length) setItems(rows);
      const itemTotal = suggested.reduce((sum, item) => sum + kronorToOre(item.amount || 0), 0); const total = suggestion.amount || (itemTotal ? (itemTotal / 100).toFixed(2) : "");
      setValues((current) => ({ ...current, name: suggestion.title ? `Nota på ${suggestion.title}` : current.name, merchant: suggestion.title || current.merchant, receiptDate: suggestion.expenseDate || current.receiptDate, total: total || current.total }));
      const engine = payload.source !== "tesseract" ? "lokal AI + OCR" : "lokal OCR";
      setStatusClass(payload.needsReview ? "warning" : "success");
      setStatus(rows.length ? `${rows.length} kvittorader hittades med ${engine}.${receiptAiStatus(payload.ai)}${payload.needsReview ? " Summorna skiljer sig – kontrollera raderna extra noga." : " Kontrollera namn, antal och summor."}` : "Inga säkra rader hittades. Lägg till rätterna manuellt.");
    } catch (caught) { setStatusClass("warning"); setStatus(`${caught instanceof Error ? caught.message : "Kunde inte läsa kvittot"} Du kan fortfarande fylla i raderna manuellt.`); }
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return; setError(""); setBusy(true);
    try {
      const payload = await api<{ quickTab: QuickTab; invitation: InvitationResult }>("/api/quick-tabs", { method: "POST", body: { ...values, items: items.map(({ name, quantity, amount }) => ({ name, quantity: Math.min(20, Math.max(1, Number(quantity) || 1)), amount })) } });
      if (receipt) { try { await upload(`/api/quick-tabs/${payload.quickTab.id}/receipt`, receipt); payload.quickTab.hasReceipt = true; } catch { notify("Snabbnotan skapades, men kvittobilden kunde inte sparas"); } }
      await onCreated(payload.quickTab, payload.invitation); close();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Kunde inte skapa snabbnotan"); setBusy(false); }
  };
  const rowCents = items.reduce((sum, item) => sum + kronorToOre(item.amount), 0); const totalCents = kronorToOre(values.total); const difference = totalCents - rowCents;
  return <Modal open={open} onClose={close} wide><form onSubmit={submit}><DialogHeader eyebrow="Separat från resorna" title="Skanna en snabbnota" onClose={close} /><section className="receipt-capture"><div className="receipt-capture-copy"><strong>Fotografera hela kvittot</strong><small>Ta ett nytt foto eller välj en befintlig bild. Bildvalet finns alltid kvar om Chrome-kameran inte startar korrekt.</small></div><div className="receipt-actions"><label className="button dark receipt-camera-button">▣ Ta foto<input type="file" accept="image/*" capture="environment" hidden onChange={(event) => void analyze(event.target.files?.[0])} /></label><label className="button ghost receipt-camera-button">Välj bild<input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => void analyze(event.target.files?.[0])} /></label></div><p className={`receipt-status ${statusClass}`} aria-live="polite">{status}</p></section>
    <div className="form-row"><label>Notans namn<input value={values.name} onChange={(event) => patchValue("name", event.target.value)} maxLength={100} placeholder="t.ex. Middag på Kajen" required /></label><label>Restaurang/plats<input value={values.merchant} onChange={(event) => patchValue("merchant", event.target.value)} maxLength={100} placeholder="Valfritt" /></label></div><div className="form-row"><label>Datum<input type="date" value={values.receiptDate} onChange={(event) => patchValue("receiptDate", event.target.value)} /></label><label>Totalbelopp (SEK)<input type="number" min="0.01" step="0.01" inputMode="decimal" value={values.total} onChange={(event) => patchValue("total", event.target.value)} required /></label></div>
    <div className="quick-item-heading"><div><p className="eyebrow">Kvittorader</p><h3>Kontrollera mat och dryck</h3></div><button className="button ghost small-button" type="button" onClick={() => setItems((current) => [...current, emptyItem()])}>＋ Lägg till rad</button></div><div className="quick-item-editor">{items.map((item) => <div className="quick-edit-row" key={item.key}><label className="grow">Rätt eller dryck<input value={item.name} maxLength={100} required onChange={(event) => setItems((current) => current.map((row) => row.key === item.key ? { ...row, name: event.target.value } : row))} /></label><label>Antal<input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={2} value={item.quantity} required onChange={(event) => setItems((current) => current.map((row) => row.key === item.key ? { ...row, quantity: event.target.value.replace(/\D/g, "") } : row))} /></label><label>Radsumma SEK<input type="number" min="0.01" step="0.01" inputMode="decimal" value={item.amount} required onChange={(event) => setItems((current) => current.map((row) => row.key === item.key ? { ...row, amount: event.target.value } : row))} /></label><button className="delete-button quick-remove-item" type="button" aria-label="Ta bort rad" onClick={() => setItems((current) => current.length === 1 ? [emptyItem()] : current.filter((row) => row.key !== item.key))}>×</button></div>)}</div>
    <p className="split-summary">{items.length} {items.length === 1 ? "rad" : "rader"} · {formatMoney(rowCents)}{totalCents ? difference === 0 ? " · stämmer med totalen" : ` · ${formatMoney(Math.abs(difference))} ${difference > 0 ? "saknas i raderna" : "över totalen"}` : ""}</p><p className="form-error" role="alert">{error}</p><button className="button primary wide dialog-submit" type="submit" disabled={busy}>{busy ? "Skapar…" : "Skapa och bjud in"} <span>→</span></button></form></Modal>;
}
