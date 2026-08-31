import { useEffect, useRef, useState } from "react";
import { Avatar } from "../../components/Avatar";
import { EmptyState } from "../../components/EmptyState";
import { DialogHeader, Modal } from "../../components/Modal";
import { api, upload } from "../../api/client";
import type { InvitationResult, QuickTab } from "../../types/models";
import { copyText, swishPaymentUrl } from "../../utils/browser";
import { formatDate, formatMoney } from "../../utils/format";
import { isHeicFile, maxOriginalReceiptBytes, prepareReceiptFile } from "../receipts/imagePrep";

interface Props {
  tab: QuickTab;
  initialInvitation?: InvitationResult | null;
  guestMode: boolean;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onChanged: (tab: QuickTab) => void;
  notify: (message: string) => void;
}

// A small, purely cosmetic nod to the important things in life — never affects splitting logic.
const beerPattern = /öl|\b(pilsner|lager|ipa|stout|porter|ale|beer)\b/i;
const isBeer = (name: string) => beerPattern.test(name);

export function QuickTabPage({ tab, initialInvitation, guestMode, onBack, onRefresh, onChanged, notify }: Props) {
  const [invitation, setInvitation] = useState<InvitationResult | null>(initialInvitation || null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [connected, setConnected] = useState(false);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const receiptInput = useRef<HTMLInputElement>(null);
  const uploadReceipt = async (file?: File) => {
    if (!file) return;
    if (isHeicFile(file)) return notify("HEIC-bilder stöds inte direkt. Byt kamerans bildformat till \"Mest kompatibelt\" eller spara bilden som JPEG först.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return notify("Välj en JPG-, PNG- eller WebP-bild.");
    if (file.size > maxOriginalReceiptBytes) return notify(`Bilden är för stor (max ${Math.round(maxOriginalReceiptBytes / 1024 / 1024)} MB)`);
    setUploadingReceipt(true);
    try {
      notify("Förbereder bild…");
      const prepared = await prepareReceiptFile(file);
      notify("Laddar upp kvittot…");
      await upload(`/api/quick-tabs/${tab.id}/receipt`, prepared);
      await onRefresh();
      notify("Kvittot sparades");
    } catch (error) { notify(error instanceof Error ? error.message : "Kunde inte spara kvittot"); }
    finally { setUploadingReceipt(false); }
  };
  useEffect(() => {
    const source = new EventSource(`/api/quick-tabs/${tab.id}/events`);
    source.addEventListener("update", () => { void onRefresh(); });
    source.onopen = () => setConnected(true); source.onerror = () => setConnected(false);
    return () => source.close();
  }, [tab.id, onRefresh]);
  const owner = tab.members.find((member) => member.role === "owner");
  const mine = tab.personTotals.find((member) => member.viewerKey === tab.currentViewerKey);
  const claim = async (itemId: number, quantity: number) => {
    try { const response = await api<{ quickTab: QuickTab }>(`/api/quick-tabs/${tab.id}/claims`, { method: "POST", body: { itemId, quantity } }); onChanged(response.quickTab); }
    catch (error) { await onRefresh(); notify(error instanceof Error ? error.message : "Kunde inte spara valet"); }
  };
  const invite = async () => {
    try { const response = await api<{ invitation: InvitationResult }>(`/api/quick-tabs/${tab.id}/invitations`, { method: "POST", body: {} }); setInvitation(response.invitation); }
    catch (error) { notify(error instanceof Error ? error.message : "Kunde inte skapa inbjudan"); }
  };
  const pay = async () => {
    if (!owner || !mine?.amountCents) return;
    const details = `${mine.name} betalar ${owner.name} ${formatMoney(mine.amountCents)} — ${tab.name}`;
    const url = owner.swishPhone ? swishPaymentUrl(owner.swishPhone, mine.amountCents, tab.name) : "";
    if (url) { window.location.assign(url); setTimeout(() => void copyText(details), 700); }
    else { await copyText(details); notify("Betalningsinformationen kopierades"); }
  };
  const markPaid = async (viewerKey: string, paid: boolean) => {
    try { const response = await api<{ quickTab: QuickTab }>(`/api/quick-tabs/${tab.id}/payments`, { method: "POST", body: { viewerKey, paid } }); onChanged(response.quickTab); notify(paid ? "Markerad som betald" : "Markeringen togs bort"); }
    catch (error) { await onRefresh(); notify(error instanceof Error ? error.message : "Kunde inte uppdatera betalstatusen"); }
  };
  const close = async () => {
    const closing = !tab.closedAt;
    if (closing && !confirm("Avsluta snabbnotan? Alla markeringar sparas men kan inte ändras förrän du öppnar den igen.")) return;
    try { const response = await api<{ quickTab: QuickTab }>(`/api/quick-tabs/${tab.id}/close`, { method: "POST", body: { closed: closing } }); onChanged(response.quickTab); notify(closing ? "Snabbnotan avslutades" : "Snabbnotan öppnades igen"); }
    catch (error) { notify(error instanceof Error ? error.message : "Kunde inte uppdatera snabbnotan"); }
  };
  return <section className="quick-tab-view">
    <input ref={receiptInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => { void uploadReceipt(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    <header className="trip-header"><div>{!guestMode && <button className="mobile-back" onClick={onBack}>← Till startsidan</button>}<p className="eyebrow">SNABBNOTA · <span className={connected ? "connected" : ""}>{tab.closedAt ? "Avslutad" : "Live"}</span></p><h1>{tab.name}</h1><p className="muted">{tab.merchant || "Ingen plats angiven"} · {formatDate(tab.receiptDate, "Inget datum")}</p></div><div className="header-actions">{tab.role !== "owner" && Number(mine?.amountCents || 0) > 0 && <button className="button primary" onClick={() => void pay()}>{owner?.swishPhone ? `Betala ${formatMoney(mine?.amountCents || 0)} med Swish` : `Kopiera betalningsinfo · ${formatMoney(mine?.amountCents || 0)}`}</button>}{tab.role === "owner" && <button className="button ghost" onClick={() => void invite()}>Bjud in</button>}{tab.hasReceipt && <button className="button ghost" onClick={() => setShowReceipt(true)}>Visa kvitto</button>}{tab.role === "owner" && <button className="button ghost" type="button" disabled={uploadingReceipt} onClick={() => receiptInput.current?.click()}>{uploadingReceipt ? "Laddar upp…" : tab.hasReceipt ? "Byt kvitto" : "＋ Lägg till kvitto"}</button>}{tab.role === "owner" && <button className="button dark" onClick={() => void close()}>{tab.closedAt ? "Öppna igen" : "Avsluta"}</button>}</div></header>
    <div className="summary-grid quick-tab-summary"><article className="hero-stat coral"><span className="stat-icon">✓</span><p>Avbockat</p><strong>{formatMoney(tab.claimedCents)}</strong><small>{tab.claimedQuantity} av {tab.totalQuantity} produkter har valts</small></article><article className="hero-stat cobalt"><span className="stat-icon">…</span><p>Ej avbockat</p><strong>{formatMoney(tab.unclaimedCents)}</strong><small>behöver fortfarande väljas</small></article><article className="member-stat"><p>Hela notan</p><strong>{formatMoney(tab.totalCents)}</strong><small>{tab.members.length} {tab.members.length === 1 ? "person deltar" : "personer deltar"}</small></article></div>
    <div className="quick-tab-layout"><section className="panel"><div className="panel-title"><div><p className="eyebrow">Vad tog du?</p><h2>Bocka av dina rader</h2></div><span className="live-pill">● Uppdateras live</span></div><div className="claim-list">{tab.items.length ? tab.items.map((item) => { const own = item.claims.find((claimItem) => claimItem.viewerKey === tab.currentViewerKey); const byOthers = item.claims.filter((claimItem) => claimItem.viewerKey !== tab.currentViewerKey).reduce((sum, claimItem) => sum + claimItem.quantity, 0); const maximum = Math.max(0, item.quantity - byOthers); const selected = own?.quantity || 0; return <article className={`claim-row${selected ? " mine" : ""}${tab.closedAt ? " closed" : ""}`} key={item.id}><select className="claim-quantity" aria-label={`Välj antal ${item.name}`} value={selected} disabled={Boolean(tab.closedAt)} onChange={(event) => void claim(item.id, Number(event.target.value))}>{Array.from({ length: maximum + 1 }, (_, quantity) => <option value={quantity} key={quantity}>{quantity} st</option>)}</select><span className="claim-copy"><strong>{item.name}{isBeer(item.name) && " 🍺"}</strong><small className="claim-unit-summary">{item.quantity > 1 ? `${item.quantity} st × ${formatMoney(item.unitAmountCents)}` : "1 st"}</small><span className="claimants">{item.claims.length ? item.claims.map((claimItem) => <span key={claimItem.viewerKey}>{claimItem.name} · {claimItem.quantity} st</span>) : <small>Ingen har valt ännu</small>}</span></span><b>{formatMoney(item.amountCents)}</b></article>; }) : <EmptyState title="Inga kvittorader">Skaparen behöver lägga till minst en rad.</EmptyState>}</div></section>
      <aside className="panel quick-tab-people-panel"><div className="panel-title"><div><p className="eyebrow">Fördelning</p><h2>Personer</h2></div></div><div className="quick-person-list">{tab.personTotals.map((person, index) => <article className="quick-person-row" key={person.viewerKey}><Avatar name={person.name} index={index} /><span><strong>{person.name}</strong><small>{person.viewerKey === tab.currentViewerKey ? "Du" : "Deltagare"}{person.swishPhone ? ` · ${person.swishPhone}` : ""}</small></span><span className="quick-person-amount"><b>{formatMoney(person.amountCents)}</b>{person.role !== "owner" && person.amountCents > 0 && (tab.role === "owner" ? <button className={`button ghost small-button ${person.paidAt ? "positive" : ""}`} onClick={() => void markPaid(person.viewerKey, !person.paidAt)}>{person.paidAt ? "✓ Betald" : "Markera betald"}</button> : person.paidAt ? <span className="role-badge positive-badge">Betald</span> : <span className="role-badge muted-badge">Obetald</span>)}</span></article>)}</div></aside></div>
    <Modal open={Boolean(invitation)} onClose={() => setInvitation(null)}><DialogHeader eyebrow="Dela snabbnotan" title="Bjud in" onClose={() => setInvitation(null)} />{invitation && <div className="invite-output"><div className="invite-qr"><img src={invitation.qrDataUrl} alt="QR-kod till snabbnotan" /><strong>Skanna och bocka av</strong></div><label>Inbjudningslänk<input readOnly value={invitation.path} /></label><button className="button dark wide" onClick={() => void copyText(new URL(invitation.path, location.origin).href).then(() => notify("Inbjudningslänken kopierades"))}>Kopiera länk</button></div>}</Modal>
    <Modal open={showReceipt} onClose={() => setShowReceipt(false)}><DialogHeader eyebrow="Kvitto" title={tab.name} onClose={() => setShowReceipt(false)} />{showReceipt && <img className="receipt-view-image" src={`/api/quick-tabs/${tab.id}/receipt`} alt="Kvitto" />}</Modal>
  </section>;
}
