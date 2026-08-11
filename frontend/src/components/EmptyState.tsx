export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children}</div>;
}
