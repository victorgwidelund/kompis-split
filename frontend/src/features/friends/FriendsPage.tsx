import { Avatar } from "../../components/Avatar";
import { EmptyState } from "../../components/EmptyState";
import type { User } from "../../types/models";

interface Props {
  contacts: User[];
  onBack: () => void;
  onInviteFriend: () => void;
}

export function FriendsPage({ contacts, onBack, onInviteFriend }: Props) {
  return (
    <section className="page-view friends-view">
      <header className="page-heading">
        <div><button className="mobile-back visible-back" onClick={onBack}>← Mer</button><p className="eyebrow">Ditt gäng</p><h1>Vänner</h1></div>
        <button className="button primary" onClick={onInviteFriend}>＋ Bjud in vän</button>
      </header>
      <div className="friends-grid">
        {contacts.length
          ? contacts.map((friend, index) => (
            <article className="friend-card" key={friend.id}>
              <Avatar name={friend.name} index={index} userId={friend.id} />
              <span><strong>{friend.name}</strong><small>{friend.email}</small><small>{friend.swishPhone ? `Swish ${friend.swishPhone}` : "Inget Swish-nummer"}</small></span>
            </article>
          ))
          : <EmptyState title="Inga sparade vänner ännu">Vänner sparas automatiskt när ni delar en grupp eller lägger till en registrerad användare.</EmptyState>}
      </div>
    </section>
  );
}
