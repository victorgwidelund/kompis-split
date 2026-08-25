// A small, consistent inline-SVG icon set for navigation/action affordances introduced by the
// mobile IA redesign (bottom nav, Mer menu, Trip-header overflow). Existing icon usage elsewhere
// in the app (trip-emoji, stat-icon glyphs, category emoji) is untouched on purpose -- this is not
// a wholesale icon-library migration, just one consistent treatment for the new surfaces.
const base = { viewBox: "0 0 24 24", width: 22, height: 22, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export function HomeIcon() { return <svg {...base}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9.5a.5.5 0 0 0 .5.5H10v-5.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V20h3.5a.5.5 0 0 0 .5-.5V10" /></svg>; }
export function GroupsIcon() { return <svg {...base}><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.7-4.7 5.5-4.7s4.9 1.7 5.5 4.7" /><path d="M15.5 6a3 3 0 0 1 0 5.8" /><path d="M15 14.6c2.4.3 4 1.9 4.5 4.4" /></svg>; }
export function QuickTabIcon() { return <svg {...base}><path d="M13 3 5.5 13.2h4.8L11 21l7.5-10.2h-4.8L13 3Z" /></svg>; }
export function StatsIcon() { return <svg {...base}><path d="M4 20V10" /><path d="M12 20V4" /><path d="M20 20v-7" /><path d="M4 20h16" /></svg>; }
export function MoreIcon({ size = 22 }: { size?: number } = {}) { return <svg {...base} width={size} height={size} strokeWidth={2.6}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>; }
export function GuideIcon() { return <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.4 2.4 0 1 1 3.4 2.2c-.9.5-1.4 1-1.4 2" /><circle cx="12" cy="16.3" r=".2" fill="currentColor" /></svg>; }
export function BugIcon() { return <svg {...base}><rect x="8" y="8" width="8" height="10" rx="4" /><path d="M12 8V5.5M9 6l1.5 1.7M15 6l-1.5 1.7M4 12h4M16 12h4M5 17l3.2-1.6M19 17l-3.2-1.6M5 8.5l3 1.7M19 8.5l-3 1.7" /></svg>; }
export function AdminIcon() { return <svg {...base}><path d="M12 3.5 5 6v6c0 4 3 6.8 7 8.5 4-1.7 7-4.5 7-8.5V6l-7-2.5Z" /><path d="m9.5 12 1.7 1.7L15 10" /></svg>; }
export function LogoutIcon() { return <svg {...base}><path d="M9 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3" /><path d="M15 8l4 4-4 4M19 12H9" /></svg>; }
export function ChevronRightIcon() { return <svg {...base} width={18} height={18}><path d="m9 6 6 6-6 6" /></svg>; }
