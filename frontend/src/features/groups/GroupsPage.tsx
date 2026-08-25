import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { GroupRow } from "../../components/GroupRow";
import type { TripSummary, View } from "../../types/models";

interface Props {
  trips: TripSummary[];
  onNavigate: (view: View) => void;
  onNewTrip: () => void;
}

export function GroupsPage({ trips, onNavigate, onNewTrip }: Props) {
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const active = trips.filter((trip) => !trip.archivedAt);
  const archived = trips.filter((trip) => trip.archivedAt);
  const shown = filter === "active" ? active : archived;
  return (
    <section className="page-view groups-view">
      <header className="page-heading">
        <div><p className="eyebrow">Alla dina resor</p><h1>Grupper</h1></div>
        <button className="button primary" onClick={onNewTrip}>＋ Ny grupp</button>
      </header>
      <fieldset className="segmented two">
        <legend className="visually-hidden">Filtrera grupper</legend>
        <label><input type="radio" name="group-filter" checked={filter === "active"} onChange={() => setFilter("active")} /><span>Aktiva ({active.length})</span></label>
        <label><input type="radio" name="group-filter" checked={filter === "archived"} onChange={() => setFilter("archived")} /><span>Arkiv ({archived.length})</span></label>
      </fieldset>
      <div className="group-row-list">
        {shown.length
          ? shown.map((trip, index) => <GroupRow key={trip.id} trip={trip} index={index} onOpen={() => onNavigate({ page: "trip", id: trip.id })} />)
          : <EmptyState title={filter === "active" ? "Dags för nästa grupp?" : "Inget arkiverat"}>{filter === "active" ? "Skapa en grupp och bjud in gänget med en länk." : "Arkiverade grupper hamnar här."}</EmptyState>}
      </div>
    </section>
  );
}
