import { useState } from "react";
import { api, getBreadcrumbs, upload } from "../api/client";
import { prepareReceiptFile, validateOriginalReceiptFile } from "../features/receipts/imagePrep";
import { DialogHeader, Modal } from "./Modal";

interface Props {
  open: boolean;
  version: string;
  onClose: () => void;
  notify: (message: string) => void;
}

export function BugReportDialog({ open, version, onClose, notify }: Props) {
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotWarning, setScreenshotWarning] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reset = () => { setDescription(""); setScreenshot(null); setScreenshotWarning(""); setError(""); setBusy(false); };
  const close = () => { reset(); onClose(); };
  const pickScreenshot = async (file?: File) => {
    if (!file) return;
    const problem = validateOriginalReceiptFile(file);
    if (problem) { setScreenshotWarning(problem); setScreenshot(null); return; }
    setScreenshotWarning("");
    setScreenshot(await prepareReceiptFile(file));
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return; setError(""); setBusy(true);
    try {
      const payload = await api<{ id: number }>("/api/bug-reports", {
        method: "POST",
        body: { description, pageUrl: location.href, userAgent: navigator.userAgent, appVersion: version, breadcrumbs: getBreadcrumbs() },
      });
      if (screenshot) { try { await upload(`/api/bug-reports/${payload.id}/screenshot`, screenshot); } catch { notify("Rapporten skickades, men skärmbilden kunde inte sparas"); } }
      close(); notify("Tack! Buggrapporten skickades.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Kunde inte skicka rapporten"); }
    finally { setBusy(false); }
  };
  const breadcrumbs = getBreadcrumbs();
  return <Modal open={open} onClose={close}><form onSubmit={submit}>
    <DialogHeader eyebrow="Hjälp oss felsöka" title="Rapportera en bugg" onClose={close} />
    <label>Vad hände?<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={4} placeholder="Beskriv vad du gjorde och vad som gick fel…" required /></label>
    <label>Skärmbild (valfritt)<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void pickScreenshot(event.target.files?.[0])} />{screenshotWarning && <small className="form-error">{screenshotWarning}</small>}{screenshot && <small>{screenshot.name} bifogas</small>}</label>
    <details className="bug-report-context"><summary>Teknisk information som bifogas automatiskt</summary>
      <small>Sida: {location.pathname}{location.hash}</small>
      <small>Appversion: {version}</small>
      <small>Webbläsare: {navigator.userAgent}</small>
      {breadcrumbs.length > 0 && <ul className="bug-report-breadcrumbs">{breadcrumbs.map((entry, index) => <li key={index}>{entry}</li>)}</ul>}
    </details>
    <p className="form-error" role="alert">{error}</p>
    <button className="button primary wide dialog-submit" type="submit" disabled={busy}>{busy ? "Skickar…" : "Skicka rapport"} <span>→</span></button>
  </form></Modal>;
}
