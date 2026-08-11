import { EmptyState } from "../../components/EmptyState";
import type { RankItem, StatisticsResponse } from "../../types/models";
import { formatMoney, initials, monthFormat } from "../../utils/format";

function RankList({ items, icon }: { items: RankItem[]; icon: (item: RankItem, index: number) => string }) {
  const max = Math.max(...items.map((item) => item.totalCents), 1);
  return <div className="rank-list">{items.length ? items.map((item, index) => <article className="rank-row" key={`${item.name}-${index}`}><span className="rank-icon">{icon(item, index)}</span><div className="rank-main"><div className="rank-copy"><span><strong>{item.name}</strong><small>{item.expenseCount} {item.expenseCount === 1 ? "utgift" : "utgifter"}</small></span><b>{formatMoney(item.totalCents)}</b></div><span className="rank-track"><span style={{ width: `${Math.max(3, Math.round(item.totalCents / max * 100))}%` }} /></span></div></article>) : <EmptyState title="Inte tillräckligt med data ännu">Statistiken växer när ni lägger till utgifter.</EmptyState>}</div>;
}

export function StatisticsPage({ data, onBack, onRefresh }: { data: StatisticsResponse; onBack: () => void; onRefresh: () => void }) {
  const max = Math.max(...data.trend.map((item) => item.totalCents), 1);
  return <section className="statistics-view">
    <header className="dashboard-heading"><div><button className="mobile-back visible-back" onClick={onBack}>← Till startsidan</button><p className="eyebrow">För den nyfikne</p><h1>Rolig statistik</h1><p>Kategorier, platser, personer och trender från resorna du kan se.</p></div><button className="button ghost" onClick={onRefresh}>Uppdatera</button></header>
    <div className="summary-grid statistics-summary"><article className="hero-stat coral"><span className="stat-icon">↗</span><p>Totalt registrerat</p><strong>{formatMoney(data.summary.totalCents)}</strong><small>{data.summary.tripCount} {data.summary.tripCount === 1 ? "resa" : "resor"}</small></article><article className="hero-stat cobalt"><span className="stat-icon">÷</span><p>Snittutgift</p><strong>{formatMoney(data.summary.averageCents)}</strong><small>per registrerad utgift</small></article><article className="member-stat"><p>Antal utgifter</p><strong>{data.summary.expenseCount}</strong><small>arkiverade resor räknas med</small></article></div>
    <div className="statistics-grid">
      <section className="panel statistics-trend-panel"><div className="panel-title"><div><p className="eyebrow">Över tid</p><h2>Månadsutveckling</h2></div><small>Senaste 12 månaderna med utgifter</small></div><div className="trend-chart">{data.trend.length ? data.trend.map((item) => { const label = monthFormat.format(new Date(`${item.month}-01T12:00:00`)); return <article className="trend-column" key={item.month} title={`${label}: ${formatMoney(item.totalCents)}`}><strong>{formatMoney(item.totalCents)}</strong><span className="trend-bar-space"><span className="trend-bar" style={{ height: `${Math.max(8, Math.round(item.totalCents / max * 100))}%` }} /></span><small>{label}</small><em>{item.expenseCount} st</em></article>; }) : <EmptyState title="Ingen trend ännu">Månadsutvecklingen visas när en utgift har registrerats.</EmptyState>}</div></section>
      <section className="panel"><div className="panel-title"><div><p className="eyebrow">Vad</p><h2>Kategorier</h2></div></div><RankList items={data.categories} icon={(item) => item.emoji || "🧾"} /></section>
      <section className="panel"><div className="panel-title"><div><p className="eyebrow">Var</p><h2>Restauranger &amp; platser</h2></div></div><RankList items={data.merchants} icon={(_, index) => String(index + 1)} /></section>
      <section className="panel"><div className="panel-title"><div><p className="eyebrow">Vem</p><h2>Tog notan</h2></div></div><RankList items={data.payers} icon={(item, index) => initials(item.name) || String(index + 1)} /></section>
    </div><p className="statistics-note">Statistiken omfattar aktiva och arkiverade resor du har tillgång till. Borttagna resor och borttagna utgifter räknas inte.</p>
  </section>;
}
