import type { TripSummary } from "../types/models";
import { formatDate, formatMoney } from "../utils/format";

// Compact single-line group row shared by the Grupper list and Hem's active-groups preview, so
// the two places that show "a group at a glance" can never quietly drift apart.
export function GroupRow({ trip, index, onOpen }: { trip: TripSummary; index: number; onOpen: () => void }) {
  const balance = Number(trip.myBalanceCents || 0);
  return (
    <button className="group-row" onClick={onOpen}>
      <span className="trip-emoji">{["✦", "⌁", "◇", "◉"][index % 4]}</span>
      <span className="group-row-main">
        <strong>{trip.name}</strong>
        <small>{trip.participantCount} {trip.participantCount === 1 ? "person" : "personer"}{trip.startDate ? ` · ${formatDate(trip.startDate)}` : ""}</small>
      </span>
      <span className={`group-row-balance ${balance > 0 ? "positive" : balance < 0 ? "negative" : ""}`}>{balance ? formatMoney(Math.abs(balance)) : "Jämnt"}</span>
    </button>
  );
}
