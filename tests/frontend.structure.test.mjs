import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("React-ingången är svensk, mobilanpassad och Vite-baserad", async () => {
  const [html, main, app] = await Promise.all([
    read("frontend/index.html"), read("frontend/src/main.tsx"), read("frontend/src/App.tsx"),
  ]);
  assert.match(html, /<html lang="sv">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1.0"/);
  assert.match(html, /id="root"/);
  assert.match(html, /src="\/src\/main\.tsx"/);
  assert.match(main, /createRoot/);
  assert.match(app, /DashboardPage/);
  assert.match(app, /TripPage/);
  assert.match(app, /QuickTabPage/);
  assert.match(app, /StatisticsPage/);
  assert.match(app, /AdminPage/);
});

test("alla bevarade arbetsflöden har React-komponenter och centrala API-anrop", async () => {
  const [auth, dashboard, trip, tripDialogs, expense, quick, quickDialog, statistics, admin, client] = await Promise.all([
    read("frontend/src/features/auth/AuthScreen.tsx"),
    read("frontend/src/features/dashboard/DashboardPage.tsx"),
    read("frontend/src/features/trips/TripPage.tsx"),
    read("frontend/src/features/trips/TripDialogs.tsx"),
    read("frontend/src/features/trips/ExpenseDialog.tsx"),
    read("frontend/src/features/quick-tabs/QuickTabPage.tsx"),
    read("frontend/src/features/quick-tabs/QuickTabDialog.tsx"),
    read("frontend/src/features/statistics/StatisticsPage.tsx"),
    read("frontend/src/features/admin/AdminPage.tsx"),
    read("frontend/src/api/client.ts"),
  ]);
  assert.match(auth, /quick-guest/);
  assert.match(dashboard, /Vänner/);
  assert.match(trip, /Arkivera/);
  assert.match(trip, /data|Kvitto|receipt/);
  assert.match(tripDialogs, /users\/search/);
  assert.match(tripDialogs, /Hantera kategorier/);
  assert.match(expense, /receipts\/analyze/);
  assert.match(expense, /\["equal", "percentage", "exact", "shares"\]/);
  assert.match(quick, /new EventSource/);
  assert.match(quick, /swishPaymentUrl/);
  assert.match(quickDialog, /quick-tabs\/analyze/);
  assert.match(statistics, /Månadsutveckling/);
  assert.match(admin, /admin.user|onUserUpdate/);
  assert.match(client, /credentials: "same-origin"/);
});

test("produktionsbygget innehåller hashad JavaScript och ingen vanilla-appreferens", async () => {
  const html = await read("frontend/dist/index.html");
  assert.match(html, /assets\/index-[A-Za-z0-9_-]+\.js/);
  assert.doesNotMatch(html, /app\.js/);
});
