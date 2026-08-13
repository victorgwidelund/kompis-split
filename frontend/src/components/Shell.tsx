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

export function Shell({ user, version, trips, view, guestMode, onNavigate, onNewTrip, onNewQuickTab, onLogout, onReportBug, children }: ShellProps) {
  if (guestMode) return <div className="app-shell guest-mode"><main className="main">{children}</main></div>;
  const active = trips.filter((trip) => !trip.archivedAt);
  const archived = trips.filter((trip) => trip.archivedAt);
  const tripLink = (trip: TripSummary, index: number) => (
    <button key={trip.id} className={`trip-link ${view.page === "trip" && view.id === trip.id ? "active" : ""}`} onClick={() => onNavigate({ page: "trip", id: trip.id })}>
      <span className="trip-emoji">{["✦", "⌁", "◇", "◉"][index % 4]}</span>
      <span><strong>{trip.name}</strong><small>{trip.participantCount} {trip.participantCount === 1 ? "person" : "personer"}</small></span>
    </button>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand brand-button" onClick={() => onNavigate({ page: "dashboard" })}><span className="brand-mark">KS</span><span>Kompis<br /><strong>Split</strong></span></button>
        <button className="button dark wide" onClick={onNewTrip}><span>＋</span> Ny grupp</button>
        <button className="button coral-button wide" onClick={onNewQuickTab}><span>✓</span> Snabbnota</button>
        <button className="button ghost wide statistics-nav" onClick={() => onNavigate({ page: "statistics" })}><span>⌁</span> Statistik</button>
        <button className="button ghost wide guide-nav" onClick={() => onNavigate({ page: "guide" })}><span>？</span> Användarguide</button>
        {user.isAdmin && <button className="button ghost wide admin-nav" onClick={() => onNavigate({ page: "admin" })}><span>⚙</span> Administration</button>}
        <div className="side-heading"><span>Aktiva grupper</span><span className="count">{active.length}</span></div>
        <nav className="trip-list" aria-label="Aktiva grupper">{active.length ? active.map(tripLink) : <small className="side-empty">Inga aktiva grupper</small>}</nav>
        {!!archived.length && <div className="archive-section"><div className="side-heading"><span>Arkiv</span><span className="count">{archived.length}</span></div><nav className="trip-list archive-list" aria-label="Arkiverade grupper">{archived.map(tripLink)}</nav></div>}
        <button className="button ghost wide bug-report-nav" onClick={onReportBug}><span>⚠</span> Rapportera en bugg</button>
        <div className="sidebar-footer"><div className="security-dot" /><div><strong>{user.name}</strong><small>{user.email}</small></div><button className="icon-button" aria-label="Logga ut" title="Logga ut" onClick={onLogout}>↗</button></div>
        <small className="app-version sidebar-version" title={`Installerad appversion: ${version}`}>Version {shortVersion(version)}</small>
      </aside>
      <main className="main">
        <header className="mobile-header">
          <button className="brand brand-button" onClick={() => onNavigate({ page: "dashboard" })}><span className="brand-mark">KS</span><span>Kompis <strong>Split</strong></span></button>
          <div className="mobile-actions"><small className="app-version mobile-version">{shortVersion(version)}</small><button className="icon-button" aria-label="Rapportera en bugg" title="Rapportera en bugg" onClick={onReportBug}>⚠</button><button className="icon-button coral-button" aria-label="Ny snabbnota" onClick={onNewQuickTab}>✓</button><button className="icon-button" aria-label="Statistik" onClick={() => onNavigate({ page: "statistics" })}>⌁</button><button className="icon-button" aria-label="Användarguide" onClick={() => onNavigate({ page: "guide" })}>？</button>{user.isAdmin && <button className="icon-button" aria-label="Administration" onClick={() => onNavigate({ page: "admin" })}>⚙</button>}<button className="icon-button dark" aria-label="Ny grupp" onClick={onNewTrip}>＋</button></div>
        </header>
        {children}
      </main>
    </div>
  );
}
