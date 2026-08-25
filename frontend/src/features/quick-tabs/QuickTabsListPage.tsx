import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import type { QuickTabSummary, View } from "../../types/models";
import { formatMoney } from "../../utils/format";

interface Props {
  quickTabs: QuickTabSummary[];
  onNavigate: (view: View) => void;
  onNewQuickTab: () => void;
}

function QuickTabRow({ tab, onOpen }: { tab: QuickTabSummary; onOpen: () => void }) {
  return (
    <button className={`group-row${tab.closedAt ? " closed" : ""}`} onClick={onOpen}>
      <span className="quick-tab-card-icon">{tab.closedAt ? "✓" : "●"}</span>
      <span className="group-row-main">
        <strong>{tab.name}</strong>
        <small>{tab.merchant || "Snabbnota"} · {tab.myClaimCount}/{tab.itemCount} avbockade av dig</small>
      </span>
      <span className="group-row-balance">{formatMoney(tab.totalCents)}</span>
    </button>
  );
}

export function QuickTabsListPage({ quickTabs, onNavigate, onNewQuickTab }: Props) {
  const [filter, setFilter] = useState<"active" | "closed">("active");
  const active = quickTabs.filter((tab) => !tab.closedAt);
  const closed = quickTabs.filter((tab) => tab.closedAt);
  const shown = filter === "active" ? active : closed;
  return (
    <section className="page-view quick-tabs-list-view">
      <header className="page-heading">
        <div><p className="eyebrow">Dela ett kvitto direkt</p><h1>Snabbnota</h1></div>
      </header>
      <button className="button coral-button wide scan-cta" onClick={onNewQuickTab}>📷 Skanna ny nota</button>
      <fieldset className="segmented two">
        <legend className="visually-hidden">Filtrera snabbnotor</legend>
        <label><input type="radio" name="quick-tab-filter" checked={filter === "active"} onChange={() => setFilter("active")} /><span>Aktiva ({active.length})</span></label>
        <label><input type="radio" name="quick-tab-filter" checked={filter === "closed"} onChange={() => setFilter("closed")} /><span>Avslutade ({closed.length})</span></label>
      </fieldset>
      <div className="group-row-list">
        {shown.length
          ? shown.map((tab) => <QuickTabRow key={tab.id} tab={tab} onOpen={() => onNavigate({ page: "quick-tab", id: tab.id })} />)
          : <EmptyState title={filter === "active" ? "Ingen aktiv snabbnota" : "Inget avslutat ännu"}>{filter === "active" ? "Skanna ett kvitto och låt alla bocka av sina egna rader." : "Avslutade snabbnotor hamnar här."}</EmptyState>}
      </div>
    </section>
  );
}
