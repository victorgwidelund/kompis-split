import { useState } from "react";
import { api } from "../api/client";
import { DialogHeader, Modal } from "./Modal";
import type { InvitationResult, Trip } from "../types/models";
import { copyText } from "../utils/browser";
import { formatDate } from "../utils/format";

export function NewTripDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (trip: Trip) => Promise<void> }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); if (busy) return; const form = event.currentTarget; setError(""); setBusy(true); try { const payload = await api<{ trip: Trip }>("/api/trips", { method: "POST", body: Object.fromEntries(new FormData(form)) }); await onCreated(payload.trip); form.reset(); onClose(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Kunde inte skapa gruppen"); } finally { setBusy(false); } };
  return <Modal open={open} onClose={onClose}><form onSubmit={submit}><DialogHeader eyebrow="Ett nytt äventyr" title="Skapa grupp" onClose={onClose} /><label>Gruppens namn<input name="name" placeholder="t.ex. Helg i Sälen" maxLength={80} required /></label><div className="form-row"><label>Startar<input name="startDate" type="date" /></label><label>Slutar<input name="endDate" type="date" /></label></div><p className="form-error" role="alert">{error}</p><button className="button primary wide" type="submit" disabled={busy}>{busy ? "Skapar…" : "Skapa grupp"} <span>→</span></button></form></Modal>;
}

export function FriendInviteDialog({ open, onClose, notify }: { open: boolean; onClose: () => void; notify: (message: string) => void }) {
  const [invitation, setInvitation] = useState<InvitationResult | null>(null);
  const create = async () => { try { const payload = await api<{ invitation: InvitationResult }>("/api/friend-invitations", { method: "POST", body: {} }); setInvitation({ ...payload.invitation, path: new URL(payload.invitation.path, location.origin).href }); } catch (caught) { notify(caught instanceof Error ? caught.message : "Kunde inte skapa väninbjudan"); } };
  return <Modal open={open} onClose={onClose}><DialogHeader eyebrow="Utöka gänget" title="Bjud in en vän" onClose={onClose} /><p className="muted">Inbjudan är inte kopplad till någon grupp. När vännen skapar konto eller loggar in sparas ni som kontakter hos varandra.</p><button className="button primary wide" onClick={() => void create()}>Skapa väninbjudan</button>{invitation && <div className="invite-output"><div className="invite-qr"><img src={invitation.qrDataUrl} alt="QR-kod för väninbjudan" /><strong>Skanna för att bli vänner</strong><small>Koden kan användas en gång och gäller i 14 dagar.</small></div><label>Inbjudningslänk<input readOnly value={invitation.path} /></label><button className="button dark wide" onClick={() => void copyText(invitation.path).then(() => notify("Väninbjudan kopierades"))}>Kopiera länk</button>{invitation.expiresAt && <p className="muted">Gäller till {formatDate(invitation.expiresAt)} och kan användas en gång.</p>}</div>}</Modal>;
}
