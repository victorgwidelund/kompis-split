# Kompis Split – mobile information architecture redesign (v1.24.0)

Date: 2026-08-25
Scope: mobile navigation and information architecture. No financial logic, backend API, OCR pipeline, authentication/security semantics, or database schema changed. Desktop is unchanged — verified by measurement, not assumed (see below).

## Method

Every in-scope file was read in full (`AGENTS.md`, `PROJECT_CONTEXT.md`, `UX_AUDIT.md`, all 18 `frontend/src/**/*.tsx` files, `types/models.ts`, `public/styles.css`, the 3 util modules) before any change was made. The app was run locally against a freshly seeded, representative `kompis_split_dev` Postgres dataset (4–6 groups in varying states, 2 quick tabs, guest participants) and inspected in-browser at 320/375/390/430/768/1280px using `getBoundingClientRect()`/`scrollWidth`/`scrollHeight`, both before writing any code and again after, against the same dataset.

## Problems found (before, measured at 390×844)

- **Home (`DashboardPage`) `scrollHeight` = 3202px** — 3.8× the viewport height.
- The first group card didn't appear until **821px** down the page.
- The heading + 3 stat cards alone occupied the first **446px**, before any real content.
- Home rendered **13 large card containers** in one scroll — every section showed its entire list (all groups, all quick tabs, all friends, the whole archive), never a preview.
- **Trip overview**: the 3 `hero-stat`/`member-stat` cards alone spanned **477px** (top 400 → bottom 877 at 390px width) before any expense/balance content.
- Mobile navigation was 2 icon buttons (Ny grupp, Snabbnota) + one "⋯" overflow popover (Statistik/Guide/Admin/Bug-report) in a sticky header — no persistent way to reach Grupper/Snabbnota/Statistik directly.
- The same pattern (eyebrow+heading, decorative-circle `hero-stat` cards) repeated near-identically across Dashboard, Trip, QuickTab, Statistics, and Admin.

## New mobile information architecture

A persistent bottom nav (Hem · Grupper · Snabbnota · Statistik · Mer), shown only ≤720px — the same breakpoint the app already used to switch from the sidebar to the mobile header — replaces the header's action buttons and overflow menu.

- **Hem**: greeting, one net-balance card (with the existing `net>0`-gated payment-reminder CTA), the first 3 active groups with "Visa alla →", a compact recent-expenses list. Quick tabs, friends, and the archive moved to their own destinations.
- **Grupper** (new): Aktiva/Arkiv segmented filter, compact one-line rows (name, participant count, date, balance), "Ny grupp".
- **Snabbnota** (new list view): a prominent "Skanna ny nota" action, Aktiva/Avslutade segmented filter over compact rows. Opening an existing quick tab still routes to the unchanged `QuickTabPage`.
- **Statistik**: unchanged component, reached directly instead of through Home.
- **Mer** (new): account identity, Vänner (new `FriendsPage`, lifted from Home's friends panel), Användarguide, Rapportera en bugg, Administration (admin-only), version, Logga ut.

**Trip page**: header simplified to the primary "＋ Lägg till utgift" action plus a "⋯" overflow (Lägg till vän / Bjud in / Arkivera / Ta bort), reusing the same popover pattern the old mobile header used. The 3 overview stat cards became one compact summary strip (spenderat / kvar att göra upp / personer). The Översikt/Utgifter/Gör upp/Personer tabs are untouched — still a secondary in-page nav, not a second bottom bar.

**Desktop (>720px) is unchanged.** Every structural change above is gated behind the same runtime check (`useIsMobile()`, backed by `matchMedia("(max-width: 720px)")`) the CSS already uses, not a new breakpoint. `DashboardPage` and `TripPage` render their original, full JSX on desktop; nothing in that code path was edited.

## Files changed

- New: `frontend/src/components/BottomNav.tsx`, `frontend/src/components/icons.tsx` (small inline-SVG set, scoped to the bottom nav / Mer / Trip-header overflow only — existing emoji/glyph icons elsewhere are untouched), `frontend/src/components/GroupRow.tsx` (shared by Grupper and Hem's preview), `frontend/src/hooks/useIsMobile.ts`, `frontend/src/features/groups/GroupsPage.tsx`, `frontend/src/features/quick-tabs/QuickTabsListPage.tsx`, `frontend/src/features/friends/FriendsPage.tsx`, `frontend/src/features/more/MorePage.tsx`.
- Modified: `frontend/src/types/models.ts` (`View` union gains `groups`/`quick-tabs`/`friends`/`more` — pure addition, no existing hash format changed), `frontend/src/App.tsx` (routing wiring; no new data fetching — every new page renders from state `refreshDashboard()` already loads), `frontend/src/components/Shell.tsx` (mobile header trimmed to the brand mark; bottom nav wired in), `frontend/src/features/dashboard/DashboardPage.tsx`, `frontend/src/features/trips/TripPage.tsx`, `public/styles.css`.

## A real bug found during this work, not just written code

`.segmented input { position: absolute; opacity: 0; }` (the invisible-radio-over-a-styled-pill technique already used by `ExpenseDialog`'s split-mode control) only worked because every existing use happened to sit inside a `<dialog>`, whose UA stylesheet gives it `position: absolute` — that accidentally became the input's containing block. `GroupsPage`/`QuickTabsListPage` are the first use of `.segmented` *outside* a dialog: with no positioned ancestor, the input's containing block became the viewport itself, so it rendered edge-to-edge (measured: 390px wide, right edge past the viewport) and produced real horizontal overflow. Fixed at the source — `.segmented label { position: relative; }` plus `.segmented input { inset: 0; }` — which also makes the *existing* dialog usage correct by explicit rule rather than by accident. Caught by measuring `scrollWidth` vs `clientWidth`, not by inspection.

## Measurements: before vs. after (390×844, populated dataset)

| Metric | Before | After |
|---|---|---|
| Home `document.documentElement.scrollHeight` | 3202px | 902px (**−71.8%**) |
| Height above the first active group | 821px | 315px |
| Large card containers on Home | 13 | 1 |
| Primary destinations reachable without scrolling | 0 (no persistent nav) | 5 (bottom nav) |
| Horizontal overflow (`scrollWidth > clientWidth`) | none | none |
| Trip overview: height of the stat-card block | 477px | ~90px (one compact strip) |

Desktop at 1280×900: `scrollHeight` = 2217px both before and after this change — pixel-identical, confirming no desktop regression.

## Accessibility checks performed

- 320/375/390/430/768/1280px swept for `scrollWidth === clientWidth`; the one real overflow found (above) was fixed and re-verified at all six widths.
- Bottom-nav items measured ≥44×44 (48px height in practice); real keyboard `Tab` (not `.focus()`, which doesn't satisfy `:focus-visible`) confirmed the shared focus ring renders on bottom-nav items and Trip-header overflow items.
- Real keyboard `Escape` confirmed closing the Trip-header overflow menu, matching the existing Shell pattern it's modeled on.
- A native `<dialog>` opened from the Trip-header overflow menu (Bjud in) renders correctly above the bottom nav — expected, since `showModal()` uses the browser's top layer, which composites above any fixed-position element regardless of z-index.
- A 62-character group name was created and verified to truncate with an ellipsis, not overflow, in both the Grupper list and Home's preview.
- Guest quick-tab mode verified with a real guest session (not just code reading): no bottom nav, no sidebar, no mobile header — `.app-shell.guest-mode` renders only the quick-tab content.
- 768px confirmed to render the desktop sidebar layout (same as before this change) — intentionally not given a third, tablet-specific tier.
- `prefers-reduced-motion` rule untouched; not exercised live this pass, but no motion/transition was added to any new component.
- Admin-only visibility of "Administration" in Mer verified by reading the code path (`{user.isAdmin && ...}`, identical to the already-shipped gate in `Shell.tsx`'s desktop sidebar) rather than a second live account switch.

## Deliberately left unchanged

- All backend code, API contracts, financial calculations, and the OCR pipeline — nothing in `src/` was touched.
- Desktop layout and behavior for every page — verified pixel-identical (see measurements above), not just "should be fine."
- The Trip page's `Översikt/Utgifter/Gör upp/Personer` tabs, `Utgifter`/`Gör upp`/`Personer` tab bodies, `QuickTabPage` (the detail view), `StatisticsPage`, `AdminPage`, and `GuidePage` — reused as-is, reached from new places but not rewritten.
- Existing icon usage outside the new nav surfaces (trip-emoji, stat-icon glyphs, category emoji, edit/delete ×) — not migrated to the new SVG set.
- Visual identity — warm paper/coral/cobalt/mint/sun palette, Hammarby and beer easter eggs, demo mode.

## Validation

- `pnpm typecheck` / `pnpm lint` — clean.
- `pnpm test` (build + 57 `node --test` cases + 6 vitest) — all green; no financial/OCR test needed changing.
- `tests/server.integration.test.mjs` run explicitly against real Postgres (not left to auto-skip) — green.
- `docker compose config --quiet` — not runnable in this environment (no local Docker); left for CI, which already gates every merge to `main` on it.
- Manual browser verification: login, Hem, Grupper (segmented filter, open a group), add expense, switch trip tabs, Snabbnota (create + open existing), Statistik, Mer (Vänner, Guide, Administration link, Logga ut), quick-tab guest mode, long group name, keyboard focus/Escape, dialog-above-bottom-nav.
