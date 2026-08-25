import { GroupsIcon, HomeIcon, MoreIcon, QuickTabIcon, StatsIcon } from "./icons";
import type { View } from "../types/models";

interface NavItem { label: string; icon: () => React.JSX.Element; target: View; matches: (view: View) => boolean; emphasize?: boolean }

const items: NavItem[] = [
  { label: "Hem", icon: HomeIcon, target: { page: "dashboard" }, matches: (view) => view.page === "dashboard" },
  { label: "Grupper", icon: GroupsIcon, target: { page: "groups" }, matches: (view) => view.page === "groups" || view.page === "trip" },
  { label: "Snabbnota", icon: QuickTabIcon, target: { page: "quick-tabs" }, matches: (view) => view.page === "quick-tabs" || view.page === "quick-tab", emphasize: true },
  { label: "Statistik", icon: StatsIcon, target: { page: "statistics" }, matches: (view) => view.page === "statistics" },
  { label: "Mer", icon: MoreIcon, target: { page: "more" }, matches: (view) => ["more", "guide", "admin", "friends"].includes(view.page) },
];

export function BottomNav({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  return (
    <nav className="bottom-nav" aria-label="Huvudnavigering">
      {items.map((item) => {
        const active = item.matches(view);
        return (
          <button
            key={item.label}
            type="button"
            className={`bottom-nav-item${active ? " active" : ""}${item.emphasize ? " emphasize" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(item.target)}
          >
            <item.icon />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
