const money = new Intl.NumberFormat("sv-SE", { style: "currency", currency: "SEK", maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" });
export const monthFormat = new Intl.DateTimeFormat("sv-SE", { month: "short", year: "2-digit" });

export function formatMoney(ore: number): string {
  return money.format((Number(ore) || 0) / 100).replace("SEK", "kr");
}

export function kronorToOre(value: FormDataEntryValue | string | number): number {
  const normalized = String(value).trim().replace(",", ".");
  return Math.round(Number(normalized || 0) * 100);
}

export function formatDate(value: string | null | undefined, fallback = "Inga datum angivna"): string {
  if (!value) return fallback;
  const text = String(value);
  const date = text.includes("T") || text.includes(" ")
    ? new Date(text.replace(" ", "T") + (text.includes("Z") ? "" : "Z"))
    : new Date(`${text}T12:00:00`);
  return dateFormat.format(date);
}

export function initials(name: string): string {
  return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function formatBytes(bytes: number): string {
  const size = Number(bytes) || 0;
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} kB` : `${(size / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

export function shortVersion(version: string): string {
  return version.startsWith("sha-") ? version.slice(0, 11) : version.replace(/^v/, "");
}
