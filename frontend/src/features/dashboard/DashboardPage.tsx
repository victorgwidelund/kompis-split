import { useRef, useState } from "react";
import { Avatar } from "../../components/Avatar";
import { EmptyState } from "../../components/EmptyState";
import { GroupRow } from "../../components/GroupRow";
import { useIsMobile } from "../../hooks/useIsMobile";
import type { Category, DashboardResponse, QuickTabSummary, ReminderResult, TripSummary, User, View } from "../../types/models";
import { formatDate, formatMoney } from "../../utils/format";

interface Props {
  user: User;
  dashboard: DashboardResponse;
  quickTabs: QuickTabSummary[];
  categories: Category[];
  onNavigate: (view: View) => void;
  onNewTrip: () => void;
  onNewQuickTab: () => void;
  onInviteFriend: () => void;
  onRemindUnpaid: () => Promise<ReminderResult>;
  notify: (message: string) => void;
}

function TripCard({ trip, index, onOpen }: { trip: TripSummary; index: number; onOpen: () => void }) {
  const balance = Number(trip.myBalanceCents || 0);
  return <button className="trip-card" onClick={onOpen}><span className="trip-emoji">{["✦", "⌁", "◇", "◉"][index % 4]}</span><span className="trip-card-copy"><strong>{trip.name}</strong><small>{trip.participantCount} {trip.participantCount === 1 ? "person" : "personer"} · {formatMoney(trip.totalCents)}</small><em className={balance > 0 ? "positive" : balance < 0 ? "negative" : ""}>{balance > 0 ? `Får tillbaka ${formatMoney(balance)}` : balance < 0 ? `Skyldig ${formatMoney(-balance)}` : "Jämnt saldo"}</em></span></button>;
}

export function DashboardPage({ user, dashboard, quickTabs, categories, onNavigate, onNewTrip, onNewQuickTab, onInviteFriend, onRemindUnpaid, notify }: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const [reminding, setReminding] = useState(false);
  const isMobile = useIsMobile();
  const active = dashboard.trips.filter((trip) => !trip.archivedAt);
  const archived = dashboard.trips.filter((trip) => trip.archivedAt);
  const net = active.reduce((sum, trip) => sum + trip.myBalanceCents, 0);
  const spent = active.reduce((sum, trip) => sum + trip.totalCents, 0);
  const category = (slug: string) => categories.find((item) => item.slug === slug) || { emoji: "🧾", name: slug };
  const scrollToTrips = () => { panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); panelRef.current?.focus({ preventScroll: true }); };
  const remindUnpaid = async () => {
    if (!confirm("Skicka en påminnelse via mail till alla som är skyldiga dig pengar?")) return;
    setReminding(true);
    try {
      const result = await onRemindUnpaid();
      notify(result.total === 0 ? "Ingen är skyldig dig något just nu" : `Skickade ${result.sent} av ${result.total} påminnelser${result.errors.length ? ` (${result.errors.length} misslyckades)` : ""}`);
    } catch (error) { notify(error instanceof Error ? error.message : "Kunde inte skicka påminnelser"); }
    finally { setReminding(false); }
  };
  const firstName = user.name.split(/\s+/)[0];
  const balanceCard = <article className="hero-stat cobalt home-balance-card"><span className="stat-icon">↗</span><p>Ditt nettosaldo</p><strong className={net < 0 ? "negative" : ""}>{formatMoney(Math.abs(net))}</strong><small>{net > 0 ? "Du får tillbaka totalt" : net < 0 ? "Du är skyldig totalt" : "Du ligger jämnt"}</small>{net > 0 && <button type="button" className="stat-cta" disabled={reminding} onClick={() => void remindUnpaid()} title="Skicka en mailpåminnelse till alla som är skyldiga dig pengar">{reminding ? "Skickar…" : "🔔 Påminn om obetalt"}</button>}</article>;

  if (isMobile) {
    return <section className="home-dashboard mobile-home">
      <h1 className="mobile-greeting">Hej, {firstName}!</h1>
      {balanceCard}
      <section className="home-section">
        <div className="home-section-heading"><h2>Dina grupper</h2><button className="text-button" onClick={() => onNavigate({ page: "groups" })}>Visa alla →</button></div>
        <div className="group-row-list">{active.length ? active.slice(0, 3).map((trip, index) => <GroupRow key={trip.id} trip={trip} index={index} onOpen={() => onNavigate({ page: "trip", id: trip.id })} />) : <EmptyState title="Dags för nästa grupp?">Skapa en grupp och bjud in gänget med en länk.</EmptyState>}</div>
      </section>
      {!!dashboard.recentExpenses.length && <section className="home-section">
        <div className="home-section-heading"><h2>Senaste utgifterna</h2></div>
        <div className="expense-list">{dashboard.recentExpenses.slice(0, 4).map((expense) => <button key={expense.id} className="expense-row dashboard-expense" onClick={() => onNavigate({ page: "trip", id: expense.tripId })}><span className="category-icon" title={category(expense.category).name}>{category(expense.category).emoji}</span><span className="expense-main"><strong>{expense.title}</strong><small>{expense.tripName} · {expense.payerName} · {formatDate(expense.expenseDate, "Inget datum")}</small></span><span className="expense-amount">{formatMoney(expense.amountCents)}</span></button>)}</div>
      </section>}
    </section>;
  }

  return <section className="home-dashboard">
    <header className="dashboard-heading"><div><p className="eyebrow">Din överblick</p><h1>Hej, {firstName}!</h1><p>Alla grupper, utgifter och saldon på ett ställe.</p></div><div className="dashboard-heading-actions"><button className="button primary" onClick={onNewTrip}>＋ Ny grupp</button><button className="button ghost" onClick={() => onNavigate({ page: "statistics" })}>📊 Statistik</button></div></header>
    <div className="summary-grid home-stats">
      <button className="hero-stat coral stat-link" type="button" onClick={scrollToTrips}><span className="stat-icon">✦</span><p>Aktiva grupper</p><strong>{active.length}</strong><small>Visa pågående och kommande →</small></button>
      {balanceCard}
      <article className="member-stat"><p>Totalt registrerat</p><strong>{formatMoney(spent)}</strong><small>i aktiva grupper</small></article>
    </div>
    <div className="dashboard-grid home-grid">
      <section className="panel" ref={panelRef} tabIndex={-1}><div className="panel-title"><div><p className="eyebrow">På gång</p><h2>Dina grupper</h2></div></div><div className="trip-card-grid">{active.length ? active.map((trip, index) => <TripCard key={trip.id} trip={trip} index={index} onOpen={() => onNavigate({ page: "trip", id: trip.id })} />) : <EmptyState title="Dags för nästa grupp?">Skapa en grupp och bjud in gänget med en länk.</EmptyState>}</div></section>
      <section className="panel"><div className="panel-title"><div><p className="eyebrow">Senaste</p><h2>Utgifter</h2></div></div><div className="expense-list">{dashboard.recentExpenses.length ? dashboard.recentExpenses.map((expense) => <button key={expense.id} className="expense-row dashboard-expense" onClick={() => onNavigate({ page: "trip", id: expense.tripId })}><span className="category-icon" title={category(expense.category).name}>{category(expense.category).emoji}</span><span className="expense-main"><strong>{expense.title}</strong><small>{expense.tripName} · {expense.payerName} · {formatDate(expense.expenseDate, "Inget datum")}</small></span><span className="expense-amount">{formatMoney(expense.amountCents)}</span></button>) : <EmptyState title="Inga utgifter ännu">De senaste utgifterna från dina aktiva grupper visas här.</EmptyState>}</div></section>
    </div>
    <section className="panel quick-tabs-panel"><div className="panel-title"><div><p className="eyebrow">Dela direkt</p><h2>Snabbnotor</h2></div><button className="button coral-button small-button" onClick={onNewQuickTab}>＋ Skanna nota</button></div><div className="quick-tab-card-grid">{quickTabs.length ? quickTabs.map((tab) => <button key={tab.id} className={`quick-tab-card${tab.closedAt ? " closed" : ""}`} onClick={() => onNavigate({ page: "quick-tab", id: tab.id })}><span className="quick-tab-card-icon">{tab.closedAt ? "✓" : "●"}</span><span><strong>{tab.name}</strong><small>{tab.merchant || "Snabbnota"} · {tab.myClaimCount}/{tab.itemCount} avbockade av dig</small></span><b>{formatMoney(tab.totalCents)}</b></button>) : <EmptyState title="Ingen snabbnota ännu">Skanna ett restaurangkvitto och låt alla välja sina egna rader.</EmptyState>}</div></section>
    <section className="panel friends-panel"><div className="panel-title"><div><p className="eyebrow">Ditt gäng</p><h2>Vänner</h2></div><button className="button ghost small-button" onClick={onInviteFriend}>＋ Bjud in vän</button></div><div className="friends-grid">{dashboard.contacts.length ? dashboard.contacts.map((friend, index) => <article className="friend-card" key={friend.id}><Avatar name={friend.name} index={index} /><span><strong>{friend.name}</strong><small>{friend.email}</small><small>{friend.swishPhone ? `Swish ${friend.swishPhone}` : "Inget Swish-nummer"}</small></span></article>) : <EmptyState title="Inga sparade vänner ännu">Vänner sparas automatiskt när ni delar en grupp eller lägger till en registrerad användare.</EmptyState>}</div></section>
    {!!archived.length && <section className="panel archive-panel"><div className="panel-title"><div><p className="eyebrow">Sparat</p><h2>Arkiverade grupper</h2></div></div><div className="trip-card-grid compact">{archived.map((trip, index) => <TripCard key={trip.id} trip={trip} index={index} onOpen={() => onNavigate({ page: "trip", id: trip.id })} />)}</div></section>}
  </section>;
}
