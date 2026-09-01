import { useEffect, useRef, useState } from "react";
import { api, upload } from "../../api/client";
import { Avatar } from "../../components/Avatar";
import { EmptyState } from "../../components/EmptyState";
import { MoreIcon } from "../../components/icons";
import { DialogHeader, Modal } from "../../components/Modal";
import { useIsMobile } from "../../hooks/useIsMobile";
import type { Category, Expense, Participant, Settlement, Trip, User } from "../../types/models";
import { copyText, swishPaymentUrl } from "../../utils/browser";
import { formatBytes, formatDate, formatMoney } from "../../utils/format";
import { isHeicFile, maxOriginalReceiptBytes, prepareReceiptFile } from "../receipts/imagePrep";

export type TripDialog = "invite" | "person" | "expense" | "categories" | "payment" | null;
export interface PaymentPreset { fromId: number; toId: number; amountCents: number }

interface Props {
  trip: Trip;
  user: User;
  categories: Category[];
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onOpenDialog: (dialog: TripDialog, expense?: Expense, payment?: PaymentPreset, readOnly?: boolean) => void;
  notify: (message: string) => void;
}

export function TripPage({ trip, user, categories, onBack, onRefresh, onOpenDialog, notify }: Props) {
  const [tab, setTab] = useState<"overview" | "expenses" | "settle" | "people">("overview");
  const [expenseFilter, setExpenseFilter] = useState<"all" | "mine">("all");
  const [uploadingReceiptFor, setUploadingReceiptFor] = useState<number | null>(null);
  const [viewingParticipant, setViewingParticipant] = useState<Participant | null>(null);
  const receiptInput = useRef<HTMLInputElement>(null);
  const receiptExpense = useRef<number | null>(null);
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Outside-click / Escape close, same pattern Shell.tsx's mobile overflow menu used before it
  // was replaced by the Mer page -- this is now the only popover menu left in the app.
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("mousedown", closeOnOutsideClick); document.removeEventListener("keydown", closeOnEscape); };
  }, [menuOpen]);
  const manager = ["owner", "admin"].includes(trip.role);
  const archived = Boolean(trip.archivedAt);
  const person = (id: number) => trip.participants.find((item) => item.id === Number(id));
  const canVoid = (createdBy: number) => manager || createdBy === user.id;
  // The signed-in user's own participant row in this trip, if they have one -- an admin
  // viewing someone else's group, or a member removed and re-added as a guest, may not.
  const myParticipantId = trip.participants.find((item) => item.userId === user.id)?.id;
  const myShareOf = (expense: Expense) => myParticipantId != null ? expense.shares.find((share) => share.participantId === myParticipantId) : undefined;
  const category = (slug: string) => categories.find((item) => item.slug === slug) || { emoji: "🧾", name: slug || "Övrigt" };
  const mutate = async (work: () => Promise<unknown>, success: string) => { try { await work(); await onRefresh(); notify(success); } catch (error) { notify(error instanceof Error ? error.message : "Något gick fel"); } };
  const archive = async () => {
    const restoring = archived; if (!confirm(restoring ? "Återställ gruppen och tillåt nya ändringar?" : "Arkivera gruppen? Alla utgifter och saldon bevaras.")) return;
    await mutate(() => api(`/api/trips/${trip.id}/archive`, { method: "POST", body: { archived: !restoring } }), restoring ? "Gruppen återställdes" : "Gruppen arkiverades"); if (!restoring) onBack();
  };
  const trash = async () => {
    if (!archived) return notify("Arkivera gruppen först");
    if (!confirm("Ta bort gruppen från alla vanliga vyer? Utgifter och betalningar sparas, men uppladdade kvitton raderas permanent och kan inte återställas.")) return;
    try { await api(`/api/trips/${trip.id}/trash`, { method: "POST", body: { deleted: true } }); notify("Gruppen flyttades till papperskorgen"); onBack(); } catch (error) { notify(error instanceof Error ? error.message : "Kunde inte ta bort gruppen"); }
  };
  const uploadReceipt = async (file?: File) => {
    const expenseId = receiptExpense.current; if (!file || !expenseId) return;
    if (isHeicFile(file)) return notify("HEIC-bilder stöds inte direkt. Byt kamerans bildformat till \"Mest kompatibelt\" eller spara bilden som JPEG först.");
    if (file.type === "application/pdf") {
      if (file.size > 8 * 1024 * 1024) return notify("PDF-kvitton får vara högst 8 MB");
      setUploadingReceiptFor(expenseId);
      try {
        notify("Laddar upp kvittot…");
        await mutate(() => upload(`/api/expenses/${expenseId}/receipts`, file, { "X-File-Name": encodeURIComponent(file.name) }), "Kvittot sparades");
      } finally { setUploadingReceiptFor(null); }
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return notify("Välj en JPG-, PNG-, WebP- eller PDF-fil");
    if (file.size > maxOriginalReceiptBytes) return notify(`Bilden är för stor (max ${Math.round(maxOriginalReceiptBytes / 1024 / 1024)} MB)`);
    setUploadingReceiptFor(expenseId);
    try {
      notify("Förbereder bild…");
      const prepared = await prepareReceiptFile(file);
      notify("Laddar upp kvittot…");
      await mutate(() => upload(`/api/expenses/${expenseId}/receipts`, prepared, { "X-File-Name": encodeURIComponent(prepared.name) }), "Kvittot sparades");
    } finally { setUploadingReceiptFor(null); }
  };
  const expenseRow = (expense: Expense, allowAction = true) => {
    const receipts = expense.receipts || [];
    const openExpense = () => onOpenDialog("expense", expense, undefined, !canVoid(expense.createdBy));
    const myShare = myShareOf(expense);
    return <article className="expense-entry" key={expense.id}><div className="expense-row expense-row-clickable" role="button" tabIndex={0} onClick={openExpense} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openExpense(); } }}><span className="category-icon" title={category(expense.category).name}>{category(expense.category).emoji}</span><div className="expense-main"><strong>{expense.title}</strong><small>{person(expense.payerId)?.name || "Okänd"} betalade · {formatDate(expense.expenseDate, "Inget datum")} · delat mellan {expense.shares.length}{expense.comments.length ? ` · 💬 ${expense.comments.length}` : ""}</small></div><div className="expense-amount">{formatMoney(expense.amountCents)}{myShare && <span className="mine-badge">Din andel {formatMoney(myShare.amountCents)}</span>}</div>{allowAction && canVoid(expense.createdBy) && !archived && <div className="expense-actions"><button className="delete-button" aria-label={`Ta bort ${expense.title} från beräkningen`} onClick={(event) => { event.stopPropagation(); if (confirm("Ta bort utgiften från beräkningen? Originalposten sparas i historiken.")) void mutate(() => api(`/api/expenses/${expense.id}`, { method: "DELETE", body: {} }), "Utgiften togs bort från beräkningen"); }}>×</button></div>}</div><div className="receipt-list">{receipts.map((receipt) => <span className="receipt-chip" key={receipt.id}><a href={`/api/receipts/${receipt.id}`} target="_blank" rel="noopener">{receipt.mimeType === "application/pdf" ? "PDF" : "Kvitto"} · {receipt.fileName} <small>{formatBytes(receipt.byteSize)}</small></a>{allowAction && canVoid(receipt.createdBy) && !archived && <button type="button" aria-label={`Ta bort ${receipt.fileName}`} onClick={() => confirm("Ta bort kvittot permanent? Själva utgiften påverkas inte.") && void mutate(() => api(`/api/receipts/${receipt.id}`, { method: "DELETE", body: {} }), "Kvittot togs bort")}>×</button>}</span>)}{allowAction && !archived && receipts.length < 5 && <button className={`receipt-upload${uploadingReceiptFor === expense.id ? " busy" : ""}`} type="button" disabled={uploadingReceiptFor === expense.id} onClick={() => { receiptExpense.current = expense.id; receiptInput.current?.click(); }}>{uploadingReceiptFor === expense.id ? "Laddar upp…" : "＋ Lägg till kvitto"}</button>}</div></article>;
  };
  const settlementCard = (item: Settlement) => { const from = person(item.fromId); const to = person(item.toId); if (!from || !to) return null; const swish = to.swishPhone ? swishPaymentUrl(to.swishPhone, item.amountCents, trip.name) : ""; const details = `${from.name} betalar ${to.name} ${formatMoney(item.amountCents)} — ${trip.name}`; return <article className="settlement-card" key={`${item.fromId}-${item.toId}`}><div className="settlement-route"><div><Avatar name={from.name} index={item.fromId} userId={from.userId} /><strong>{from.name}</strong></div><span className="route-arrow">→</span><div><Avatar name={to.name} index={item.toId} userId={to.userId} /><strong>{to.name}</strong></div></div><div className="settlement-amount"><small>ska betala</small><strong>{formatMoney(item.amountCents)}</strong></div><div className="settlement-actions"><button className={`button ${swish ? "primary" : "ghost"}`} onClick={() => { if (swish) { location.href = swish; setTimeout(() => void copyText(details), 700); } else void copyText(details).then(() => notify("Betalningsdetaljer kopierade")); }}>{swish ? "Öppna Swish" : "Kopiera detaljer"}</button><button className="button ghost" disabled={archived} onClick={() => onOpenDialog("payment", undefined, { fromId: item.fromId, toId: item.toId, amountCents: item.amountCents })}>Markera betald</button></div></article>; };
  const openAmount = trip.settlements.reduce((sum, item) => sum + item.amountCents, 0);
  const myExpenseCount = myParticipantId != null ? trip.expenses.filter((expense) => myShareOf(expense)).length : 0;
  const visibleExpenses = expenseFilter === "mine" ? trip.expenses.filter((expense) => myShareOf(expense)) : trip.expenses;
  const participantExpenses = viewingParticipant ? trip.expenses.filter((expense) => expense.payerId === viewingParticipant.id) : [];
  const participantTotal = participantExpenses.reduce((sum, expense) => sum + expense.amountCents, 0);
  return <section className="trip-view">
    <input ref={receiptInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={(event) => { void uploadReceipt(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    <header className="trip-header"><div><button className="mobile-back" onClick={onBack}>← Alla grupper</button><p className="eyebrow">{trip.startDate ? `${formatDate(trip.startDate)}${trip.endDate ? ` — ${formatDate(trip.endDate)}` : ""}` : "AKTIV GRUPP"}</p><h1>{trip.name}</h1>{archived && <p className="archive-note">Den här gruppen är arkiverad och skrivskyddad.</p>}</div>
      {isMobile ? <div className="header-actions">
        {!archived && <button className="button primary" onClick={() => onOpenDialog("expense")}>＋ Lägg till utgift</button>}
        {manager && <div className="mobile-menu-wrap" ref={menuRef}>
          <button className="icon-button" aria-label="Fler alternativ" title="Fler alternativ" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreIcon /></button>
          {menuOpen && <div className="mobile-menu" role="menu">
            {!archived && <button className="button ghost wide" onClick={() => { onOpenDialog("person"); setMenuOpen(false); }}>Lägg till vän</button>}
            {!archived && <button className="button ghost wide" onClick={() => { onOpenDialog("invite"); setMenuOpen(false); }}>Bjud in</button>}
            <button className="button ghost wide" onClick={() => { void archive(); setMenuOpen(false); }}>{archived ? "Återställ grupp" : "Arkivera"}</button>
            {archived && <button className="button ghost wide danger" onClick={() => { void trash(); setMenuOpen(false); }}>Ta bort grupp</button>}
          </div>}
        </div>}
      </div> : <div className="header-actions">{!archived && <button className="button primary" onClick={() => onOpenDialog("expense")}>＋ Lägg till utgift</button>}{manager && !archived && <button className="button ghost" onClick={() => onOpenDialog("person")}>Lägg till vän</button>}{manager && !archived && <button className="button ghost" onClick={() => onOpenDialog("invite")}>Bjud in</button>}{manager && <button className="button ghost" onClick={() => void archive()}>{archived ? "Återställ grupp" : "Arkivera"}</button>}{manager && archived && <button className="button ghost danger" onClick={() => void trash()}>Ta bort grupp</button>}</div>}
    </header>
    <nav className="tabs" aria-label="Gruppens vyer">{([["overview", "Översikt"], ["expenses", "Utgifter"], ["settle", "Gör upp"], ["people", "Personer"]] as const).map(([key, label]) => <button className={`tab${tab === key ? " active" : ""}`} key={key} onClick={() => setTab(key)}>{label}{key === "settle" && <span className="tab-count">{trip.settlements.length}</span>}</button>)}</nav>
    {tab === "overview" && <div>{isMobile ? <div className="trip-summary-strip">
        <div className="strip-stat"><small>Spenderat</small><strong>{formatMoney(trip.totalCents)}</strong></div>
        <div className="strip-stat"><small>Kvar att göra upp</small><strong>{formatMoney(openAmount)}</strong></div>
        <div className="strip-stat"><small>Personer</small><strong>{trip.participants.length}</strong></div>
      </div> : <div className="summary-grid"><article className="hero-stat coral"><span className="stat-icon">↗</span><p>Totalt spenderat</p><strong>{formatMoney(trip.totalCents)}</strong><small>{trip.expenses.length === 1 ? "1 utgift registrerad" : `${trip.expenses.length} utgifter registrerade`}</small></article><article className="hero-stat cobalt"><span className="stat-icon">◎</span><p>Kvar att göra upp</p><strong>{formatMoney(openAmount)}</strong><small>{trip.settlements.length ? `${trip.settlements.length} betalningar kvar` : "Alla ligger jämnt"}</small></article><article className="member-stat"><p>Är med i gruppen</p><div className="avatar-stack">{trip.participants.slice(0, 5).map((item, index) => <Avatar name={item.name} index={index} userId={item.userId} key={item.id} />)}</div><strong>{trip.participants.length} {trip.participants.length === 1 ? "person" : "personer"}</strong>{manager && !archived && <button className="text-button" onClick={() => onOpenDialog("person")}>Lägg till någon →</button>}</article></div>}<div className="dashboard-grid"><section className="panel"><div className="panel-title"><div><p className="eyebrow">Det senaste</p><h2>Senaste utgifterna</h2></div><button className="text-button" onClick={() => setTab("expenses")}>Visa alla →</button></div><div className="expense-list">{trip.expenses.length ? trip.expenses.slice(0, 4).map((expense) => expenseRow(expense, false)) : <EmptyState title="Inget spenderat ännu">Lägg till den första utgiften när någon tar notan.</EmptyState>}</div></section><section className="panel balance-panel"><div className="panel-title"><div><p className="eyebrow">Snabbkoll</p><h2>Saldon</h2></div></div><div className="balance-list">{trip.participants.map((item, index) => { const balance = Number(trip.balances[item.id] || 0); return <button type="button" className="balance-row" key={item.id} onClick={() => setViewingParticipant(item)}><Avatar name={item.name} index={index} userId={item.userId} /><div className="balance-name"><strong>{item.name}</strong><small>{balance > 0 ? "får tillbaka" : balance < 0 ? "är skyldig" : "ligger jämnt"}</small></div><strong className={balance > 0 ? "positive" : balance < 0 ? "negative" : ""}>{balance ? formatMoney(Math.abs(balance)) : "—"}</strong></button>; })}</div><button className="button dark wide" onClick={() => setTab("settle")}>Se vem som betalar vem <span>→</span></button></section></div></div>}
    {tab === "expenses" && <section className="panel full-panel"><div className="panel-title"><div><p className="eyebrow">Varje öre</p><h2>Alla utgifter</h2></div>{!archived && <button className="button dark" onClick={() => onOpenDialog("expense")}>＋ Lägg till utgift</button>}</div>{myParticipantId != null && <div className="expense-filter" role="group" aria-label="Filtrera utgifter">
      <button type="button" className={expenseFilter === "all" ? "active" : ""} onClick={() => setExpenseFilter("all")}>Alla utgifter</button>
      <button type="button" className={expenseFilter === "mine" ? "active" : ""} onClick={() => setExpenseFilter("mine")}>Jag är med<span className="tab-count">{myExpenseCount}</span></button>
    </div>}<div className="expense-list roomy">{visibleExpenses.length ? visibleExpenses.map((expense) => expenseRow(expense)) : expenseFilter === "mine" ? <EmptyState title="Du är inte med i någon utgift ännu">Utgifter du läggs till i visas här.</EmptyState> : <EmptyState title="Inga kvitton, inga problem">Utgifterna visas här när ni lägger till dem.</EmptyState>}</div></section>}
    {tab === "settle" && <div><div className="settle-intro"><p className="eyebrow">Kortaste vägen till jämnt</p><h2>Gör upp med färre betalningar.</h2><p>Vi räknar ihop allt så gruppen bara behöver göra betalningarna som faktiskt behövs.</p></div><div className="settlement-grid">{trip.settlements.length ? trip.settlements.map(settlementCard) : <div className="panel" style={{ gridColumn: "1/-1" }}><EmptyState title="Allt är uppgjort ✦">Ingen är skyldig någon något just nu.</EmptyState></div>}</div><section className="panel payment-history"><div className="panel-title"><div><p className="eyebrow">Klart</p><h2>Registrerade betalningar</h2></div></div><div className="expense-list">{trip.payments.length ? trip.payments.map((payment) => <article className="expense-row" key={payment.id}><span className="category-icon">✓</span><div className="expense-main"><strong>{person(payment.fromId)?.name} betalade {person(payment.toId)?.name}</strong><small>{payment.note || "Betalning"} · {formatDate(payment.paidAt)}</small></div><div className="expense-amount positive">{formatMoney(payment.amountCents)}</div>{canVoid(payment.createdBy) && !archived && <button className="delete-button" aria-label="Ta bort betalning" onClick={() => confirm("Ta bort betalningen från beräkningen? Originalposten sparas i historiken.") && void mutate(() => api(`/api/payments/${payment.id}`, { method: "DELETE", body: {} }), "Betalningen togs bort från beräkningen")}>×</button>}</article>) : <EmptyState title="Inga betalningar registrerade">Färdiga betalningar visas här.</EmptyState>}</div></section></div>}
    {tab === "people" && <section className="panel full-panel"><div className="panel-title"><div><p className="eyebrow">Gänget</p><h2>Personer i gruppen</h2></div>{manager && !archived && <button className="button dark" onClick={() => onOpenDialog("person")}>＋ Lägg till vän</button>}</div><div className="people-grid">{trip.participants.length ? trip.participants.map((item, index) => <button type="button" className="person-card" key={item.id} onClick={() => setViewingParticipant(item)}><Avatar name={item.name} index={index} userId={item.userId} /><strong>{item.name}</strong><small>{item.userId ? "Registrerad användare" : "Gäst"}</small><small>{item.swishPhone ? `Swish ${item.swishPhone}` : "Inget Swish-nummer"}</small></button>) : <EmptyState title="Vilka ska med?">Lägg till vänner för att börja dela utgifter.</EmptyState>}</div></section>}
    <Modal open={Boolean(viewingParticipant)} onClose={() => setViewingParticipant(null)} wide><DialogHeader eyebrow="Person" title={viewingParticipant?.name || ""} onClose={() => setViewingParticipant(null)} /><p className="muted">{participantExpenses.length ? `Betalade för ${participantExpenses.length} ${participantExpenses.length === 1 ? "utgift" : "utgifter"} · ${formatMoney(participantTotal)} totalt` : "Har inte betalat för någon utgift ännu."}</p><div className="expense-list roomy">{participantExpenses.map((expense) => expenseRow(expense, false))}</div></Modal>
  </section>;
}
