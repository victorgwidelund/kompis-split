import { initials } from "../utils/format";

const colors = ["#c7e6d2", "#f6ca67", "#bfc6fb", "#ffc6b7", "#d5c2e8", "#b9dcdf"];

export function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return <span className="avatar" style={{ background: colors[index % colors.length] }}>{initials(name)}</span>;
}
