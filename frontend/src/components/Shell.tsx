import { useRef, useState } from "react";
import { BottomNav } from "./BottomNav";
import type { TripSummary, User, View } from "../types/models";
import { shortVersion } from "../utils/format";

interface ShellProps {
  user: User;
  version: string;
  trips: TripSummary[];
  view: View;
  guestMode?: boolean;
  onNavigate: (view: View) => void;
  onNewTrip: () => void;
  onNewQuickTab: () => void;
  onLogout: () => void;
  onReportBug: () => void;
  children: React.ReactNode;
}

// A small hidden nod for the initiated: click the logo five times quickly. Purely decorative.
const hammarbyMessages = [
  "Hej Bajare! 💚🤍 Kom igen Hammarby!",
  "Dags för en kall öl? 🍺",
  "Håll ut! ✊💚",
  "Grönvitt hjärta, delade notor 💚🤍",
  "Bajen i hjärtat, jämnt i plånboken 💚",
];

export function Shell({ user, version, trips, view, guestMode, onNavigate, onNewTrip, onNewQuickTab, onLogout, onReportBug, children }: ShellProps) {
  const [easterEgg, setEasterEgg] = useState<string | null>(null);
  const brandClicks = useRef<number[]>([]);
  const handleBrandClick = () => {
    const now = Date.now();
    brandClicks.current = [...brandClicks.current.filter((time) => now - time < 2500), now];
    if (brandClicks.current.length >= 5) {
      brandClicks.current = [];
      setEasterEgg(hammarbyMessages[Math.floor(Math.random() * hammarbyMessages.length)] ?? null);
      window.setTimeout(() => setEasterEgg(null), 3200);
    }
    onNavigate({ page: "dashboard" });
  };
  if (guestMode) return <div className="app-shell guest-mode"><main className="main">{children}</main></div>;
  const active = trips.filter((trip) => !trip.archivedAt);
  const archived = trips.filter((trip) => trip.archivedAt);
  const tripLink = (trip: TripSummary, index: number) => (
    <button key={trip.id} className={`trip-link ${view.page === "trip" && view.id === trip.id ? "active" : ""}`} onClick={() => onNavigate({ page: "trip", id: trip.id })}>
      <span className="trip-emoji">{["✦", "⌁", "◇", "◉"][index % 4]}</span>
      <span><strong>{trip.name}</strong><small>{trip.participantCount} {trip.participantCount === 1 ? "person" : "personer"}</small></span>
    </button>
  );
  // Desktop-only: the sidebar still lists these directly (no "Mer" concept there). On mobile the
  // identical set of destinations lives in MorePage instead, reached via the bottom nav -- keeping
  // them here too would be the exact "duplicate navigation in both bars" the redesign avoids.
  const secondaryNav = <>
    <button className="button ghost wide statistics-nav" onClick={() => onNavigate({ page: "statistics" })} title="Se trender och översikt"><span>📊</span> Statistik</button>
    <button className="button ghost wide guide-nav" onClick={() => onNavigate({ page: "guide" })} title="Så här funkar appen"><span>？</span> Användarguide</button>
    {user.isAdmin && <button className="button ghost wide admin-nav" onClick={() => onNavigate({ page: "admin" })} title="Hantera användare, grupper och buggrapporter"><span>⚙</span> Administration</button>}
    <button className="button ghost wide bug-report-nav" onClick={onReportBug}><span>⚠</span> Rapportera en bugg</button>
  </>;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand brand-button" onClick={handleBrandClick}><span className="brand-mark">KS</span><span>Kompis<br /><strong>Split</strong></span></button>
        <button className="button dark wide" onClick={onNewTrip}><span>＋</span> Ny grupp</button>
        <button className="button coral-button wide" onClick={onNewQuickTab}><span>⚡</span> Snabbnota</button>
        <div className="side-heading"><span>Aktiva grupper</span><span className="count">{active.length}</span></div>
        <nav className="trip-list" aria-label="Aktiva grupper">{active.length ? active.map(tripLink) : <small className="side-empty">Inga aktiva grupper</small>}</nav>
        {!!archived.length && <div className="archive-section"><div className="side-heading"><span>Arkiv</span><span className="count">{archived.length}</span></div><nav className="trip-list archive-list" aria-label="Arkiverade grupper">{archived.map(tripLink)}</nav></div>}
        <div className="sidebar-secondary">{secondaryNav}</div>
        <div className="sidebar-footer"><div className="security-dot" /><div><strong>{user.name}</strong><small>{user.email}</small></div><button className="icon-button" aria-label="Logga ut" title="Logga ut" onClick={onLogout}>↗</button></div>
        <small className="app-version sidebar-version" title={`Installerad appversion: ${version}`}>Version {shortVersion(version)}</small>
      </aside>
      <main className="main">
        <header className="mobile-header">
          <button className="brand brand-button" onClick={handleBrandClick}><span className="brand-mark">KS</span><span>Kompis <strong>Split</strong></span></button>
        </header>
        {children}
      </main>
      <BottomNav view={view} onNavigate={onNavigate} />
      {easterEgg && <div className="hammarby-toast" role="status">{easterEgg}</div>}
    </div>
  );
}
