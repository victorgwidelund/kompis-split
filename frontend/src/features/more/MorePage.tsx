import { Avatar } from "../../components/Avatar";
import { AdminIcon, BugIcon, ChevronRightIcon, GroupsIcon, GuideIcon, LogoutIcon } from "../../components/icons";
import type { User, View } from "../../types/models";
import { shortVersion } from "../../utils/format";

interface Props {
  user: User;
  version: string;
  onNavigate: (view: View) => void;
  onReportBug: () => void;
  onLogout: () => void;
}

function MoreRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className="more-row" onClick={onClick}>
      <span className="more-row-icon">{icon}</span>
      <span className="more-row-label">{label}</span>
      <ChevronRightIcon />
    </button>
  );
}

export function MorePage({ user, version, onNavigate, onReportBug, onLogout }: Props) {
  return (
    <section className="page-view more-view">
      <header className="page-heading"><div><p className="eyebrow">Konto och mer</p><h1>Mer</h1></div></header>
      <div className="more-identity"><Avatar name={user.name} /><div><strong>{user.name}</strong><small>{user.email}</small></div></div>
      <nav className="more-menu" aria-label="Fler funktioner">
        <MoreRow icon={<GroupsIcon />} label="Vänner" onClick={() => onNavigate({ page: "friends" })} />
        <MoreRow icon={<GuideIcon />} label="Användarguide" onClick={() => onNavigate({ page: "guide" })} />
        <MoreRow icon={<BugIcon />} label="Rapportera en bugg" onClick={onReportBug} />
        {user.isAdmin && <MoreRow icon={<AdminIcon />} label="Administration" onClick={() => onNavigate({ page: "admin" })} />}
      </nav>
      <button className="more-row logout-row" onClick={onLogout}><span className="more-row-icon"><LogoutIcon /></span><span className="more-row-label">Logga ut</span></button>
      <small className="app-version more-version" title={`Installerad appversion: ${version}`}>Version {shortVersion(version)}</small>
    </section>
  );
}
