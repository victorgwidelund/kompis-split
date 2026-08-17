# Kompis Split – UX audit and refinement (v1.21.0)

Date: 2026-08-17
Scope: product UX, mobile usability and visual-design refinement across the existing frontend. No backend architecture, financial logic, OCR pipeline, or demo-mode isolation changed.

## Method

Every frontend page/feature file and `public/styles.css` was read in full rather than sampled. Claims about layout problems were confirmed by measurement, not assumption: the app was run locally against a real Postgres database and inspected in-browser at 320/375/390/430/768/1280px using `getBoundingClientRect()`/`scrollWidth`/`clientWidth`, contrast ratios were computed from the actual hex values in `:root`, and interactive behaviors (overflow menu open/close, outside-click, Escape, keyboard focus) were exercised programmatically and re-checked after each fix.

Findings are classified UX-P0 (broken or misleading) through UX-P3 (minor polish). P0, P1, and high-value P2 findings were fixed. Per the brief's own instruction, low-value P3 cosmetic polish was intentionally not chased.

## Findings and changes

### UX-P0 — broken

**1. Money fields silently rejected the Swedish decimal comma.**
`type="number"` inputs return an empty value the instant a comma is typed (confirmed directly: `input.value = '249,50'` → `input.value === ''`), because HTML number inputs require a period internally regardless of `lang`/`inputMode`. A user typing an amount the natural Swedish way (`249,50`) would see the field silently go blank. Fixed at every layer the value passes through, not just the input:
- `frontend/src/features/trips/ExpenseDialog.tsx` (main amount + per-person split value), `frontend/src/features/quick-tabs/QuickTabDialog.tsx` (total + per-item amount), `frontend/src/features/trips/TripDialogs.tsx` (`PaymentDialog` amount) — switched to `type="text" inputMode="decimal"` with a permissive `onChange` filter, the same pattern already used for quick-tab quantities since v1.16.0.
- `src/server.ts`'s `parseAmount()` and a new `parseDecimal()` helper used by `calculateShares()` in `src/split.ts` — the server now accepts `249,50` and `249.50` identically, since a determined client can always bypass the frontend's input type.
- New tests: `tests/split.test.mjs` ("Swedish comma-decimal values are accepted identically to period-decimal values") and a full create→verify→void regression in `tests/server.integration.test.mjs`.

**2. The mobile header overflowed horizontally.**
Measured, not assumed: at 375px width the mobile header's icon row (Statistik, Guide, Admin, bug-report, quick-tab, new-group — six icon buttons plus a version badge) exceeded the viewport, pushing `document.documentElement.scrollWidth` past `clientWidth`. Fixed by restructuring `frontend/src/components/Shell.tsx`'s mobile header down to brand + two primary actions (Ny grupp, Snabbnota) + a single 44×44 "⋯" overflow button that opens a small popover menu (Statistik / Användarguide / Administration / Rapportera en bugg), closing on outside-click, `Escape`, or item selection. Re-measured at 320/375/390/430px after the fix: zero horizontal overflow at every width, including with the version badge visible (a residual 2px overflow at exactly 320px traced to the version badge was fixed by hiding that badge below 360px — `@media (max-width: 360px)`).

### UX-P1 — major usability

**3. The dashboard's "remind unpaid" button showed even when nobody owed you anything**, sitting in the primary header action row regardless of balance. `frontend/src/features/dashboard/DashboardPage.tsx`: the button now only renders when `net > 0`, and lives inside the net-balance stat card itself (new `.stat-cta` style) rather than competing with "Ny grupp" for primary billing — the reminder is now attached to the exact number it acts on.

**4. Group-page mobile actions buried the primary action last.** `.header-actions` on `frontend/src/features/trips/TripPage.tsx` rendered "＋ Lägg till utgift" (the primary, most-used action) after four secondary/destructive buttons; on the mobile 2-column grid layout that put it in the bottom-right cell. DOM order now leads with the primary action, followed by frequency-ordered secondary actions, with the destructive "Ta bort grupp" last. The dashboard's own heading actions had the identical anti-pattern (primary "Ny grupp" listed last) and got the same fix for consistency.

**5. Sidebar/mobile navigation hierarchy buried the thing people open most.** The trip list sat below four secondary nav links (Statistik/Guide/Admin/Bug-report); those now group into one visually-separated `.sidebar-secondary` section directly above the account footer, and the trip list moves up to immediately follow the two primary create-actions.

**6. `viewport-fit=cover` was missing**, silently turning every existing `env(safe-area-inset-*)` rule in the CSS into a no-op on notched iPhones (the dialog bottom padding, the body bottom padding). Added to `frontend/index.html`'s viewport meta tag, and gave `.mobile-header` a matching `env(safe-area-inset-top)` allowance so the header itself clears the notch/Dynamic Island.

**7. Icon-only touch targets were 38×38px**, under the ~44×44px baseline for reliable thumb targets (WCAG 2.2 SC 2.5.8 uses 24px as the hard minimum, but 44px is the accepted comfortable target and is what the rest of this app's primary buttons already use). `.icon-button` in `public/styles.css` is now 44×44.

### UX-P2 — clarity and consistency

**8. Avatar initials broke on names with leading punctuation.** `initials()` in `frontend/src/utils/format.ts` took `part[0]` literally, so a guest-typed name like `-Anna Svensson` produced `-S` instead of `AS`. Now finds the first actual Unicode letter per word (`\p{L}`) instead of the first character. Covered by new tests in `frontend/src/utils/format.test.ts`.

**9. The Snabbnota create icon ("✓") looked like a completion/checkmark**, not a "create new" affordance, and collided visually with the unrelated "closed tab" checkmark used elsewhere in the UI. Changed to "⚡" (matching the "quick" in Snabbnota) in both the sidebar and mobile header.

**10. No visible keyboard-focus indicator on icon buttons, trip links, text buttons, receipt-chip links, the segmented split-mode control, or split-participant checkboxes** — all reachable by keyboard but effectively invisible while tabbing through. Extended the existing `:focus-visible` ring to all of them, including a same-technique fix for the segmented control (whose real `<input>` is visually hidden, so the ring is applied to its visible sibling `<span>` when the hidden input has focus).

**11. Dialogs had no `aria-labelledby`.** `frontend/src/components/Modal.tsx` now tags `DialogHeader`'s `<h2>` with a `useId()`-generated id and points the `<dialog>`'s `aria-labelledby` at it once the dialog opens, so screen readers announce the dialog's actual title ("Ny utgift", "Bjud in till gruppen", etc.) instead of reading the whole subtree. Zero call-site changes needed — every dialog already composes `<Modal>` + `<DialogHeader>`.

**12. `--muted` (#6d716b on #f5f0e8) computed to ≈4.38:1 contrast**, just under the 4.5:1 WCAG AA threshold for normal text. Darkened to `#63675f` (≈5.1:1), a small enough shift to be visually indistinguishable as "the same muted gray" while clearing AA with margin.

### UX-P3 — noted, not chased

Per the brief's own instruction, cosmetic-only items were not pursued this pass: further spacing-rhythm micro-adjustments, a fully unified icon-style pass beyond the one ambiguous icon actually fixed above, and typography-scale nuances beyond what was needed to hit the P0–P2 fixes. None of these affect comprehension, task completion, or trust, so they weren't worth the churn the brief explicitly warned against.

## Reviewed and intentionally left unchanged

- **Visual identity** — the warm paper/coral/cobalt/mint/sun palette, rounded hand-drawn brand mark, and "friendly, not corporate" tone are untouched. No gradients, glassmorphism, oversized hero areas, or generic-SaaS patterns were introduced.
- **Hammarby and beer easter eggs** — the five-click logo toast and the 🍺-next-to-beer-named-receipt-rows logic in `Shell.tsx`/quick-tab rendering are untouched.
- **Demo mode** — no demo-related file was touched; isolation, the denylist, and batch cleanup are exactly as before. It remains the safe environment for testing this and future changes.
- **Financial logic** — `allocateByWeights`, `allocateItemQuantities`, `simplifyDebts` in `src/split.ts` are untouched; only the *parsing* of a typed value into a number changed (comma vs. period), never the splitting/settlement math itself.
- **OCR pipeline** — zero files in the receipt-OCR path changed.
- **Framework/dependency choices** — no UI framework migration, no new icon library; the one icon change (✓ → ⚡) reused the existing inline-emoji convention already used everywhere else in the app.
- **App.tsx routing/state architecture** — not refactored; all fixes were local to the components that needed them.

## Permanent design principles

These are meant to outlive this change and guide future UI work on Kompis Split:

1. **Primary action first in DOM order**, especially in any layout that becomes a mobile grid — grid auto-placement follows DOM order, so "last in the markup" silently becomes "buried in the bottom-right cell" on small screens.
2. **Icon-only controls are 44×44px minimum** and always carry both `aria-label` and `title`.
3. **Every interactive element needs a visible `:focus-visible` state.** For controls built on a visually-hidden native input (radio/checkbox-as-pill patterns), apply the ring to the visible sibling via `input:focus-visible + span`, not the hidden input itself.
4. **Any field a user might type a decimal amount into must be `type="text" inputMode="decimal"` with a manual filter, never `type="number"`** — number inputs silently reject the Swedish comma. Always parse comma-or-period at the point a typed value first becomes a number, on both client and server.
5. **A CTA that only applies in one state (e.g., "you're owed money") should only render in that state**, and should live next to the number it acts on rather than in a general action bar.
6. **Dialogs compose `<Modal>` + `<DialogHeader>`** — that pairing is what wires up `aria-labelledby` automatically; don't build a dialog's heading without `DialogHeader`.
7. **Don't add generic modern-SaaS visual patterns** (gradients-everywhere, glassmorphism, oversized hero sections, pill-everything, decorative motion) without a specific comprehension/trust/speed justification tied to this app's existing warm/paper identity.

## Validation

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` (build + 39 `node --test` cases including the OCR suite, financial-splitting suite, and the full account/invitation/authorization/archive/audit integration test against a real throwaway Postgres database via `TEST_DATABASE_URL`, run explicitly rather than left to auto-skip) — all passing.
- `vitest run` (frontend unit tests, including new `initials()` coverage) — 6/6 passing.
- Manual browser verification against `kompis_split_dev`: login, dashboard (reminder CTA gating, reordered heading actions), mobile header at 320/375/390/430px (zero horizontal overflow, confirmed by direct measurement), overflow menu (open, correct items, outside-click close, `Escape` close, item click closes+navigates), desktop sidebar DOM order, trip page action order, expense dialog `aria-labelledby` resolution.
