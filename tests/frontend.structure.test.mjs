import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const htmlPath = new URL("../public/index.html", import.meta.url);
const appPath = new URL("../public/app.js", import.meta.url);

test("the Swedish account UI has unique IDs and every direct selector exists", async () => {
  const [html, app] = await Promise.all([readFile(htmlPath, "utf8"), readFile(appPath, "utf8")]);
  assert.match(html, /<html lang="sv">/);
  assert.match(html, /id="setup-form"/);
  assert.match(html, /id="register-form"/);
  assert.match(html, /id="dashboard-view"/);
  assert.match(html, /id="invite-dialog"/);
  assert.match(html, /id="admin-view"/);
  assert.match(html, /id="statistics-view"/);
  assert.match(html, /id="statistics-trend"/);
  assert.match(html, /id="statistics-categories"/);
  assert.match(html, /id="statistics-merchants"/);
  assert.match(html, /id="statistics-payers"/);
  assert.match(html, /id="quick-tab-view"/);
  assert.match(html, /id="quick-tab-dialog"/);
  assert.match(html, /id="quick-tab-receipt-input"/);
  assert.match(html, /id="quick-tab-receipt-input"[^>]*accept="image\/\*"/);
  assert.match(html, /id="expense-receipt-input"[^>]*accept="image\/\*"/);
  assert.doesNotMatch(html, /capture="environment"/);
  assert.match(html, /id="quick-tab-items"/);
  assert.match(html, /id="quick-tab-person-totals"/);
  assert.match(html, /id="quick-tab-invite-qr"/);
  assert.match(html, /id="dashboard-friends"/);
  assert.match(html, /id="expense-dialog-title"/);
  assert.match(html, /id="expense-submit-label"/);
  assert.match(html, /class="app-version auth-version"/);
  assert.match(html, /class="app-version sidebar-version"/);
  assert.match(html, /id="delete-trip-button"/);
  assert.match(html, /id="active-trips-card"/);
  assert.match(html, /id="dashboard-trips-panel"/);
  assert.match(html, /id="category-dialog"/);
  assert.match(html, /id="receipt-file-input"/);
  assert.match(html, /id="expense-receipt-input"/);
  assert.match(html, /id="expense-receipt-status"/);
  assert.match(html, /id="friend-invite-dialog"/);
  assert.match(html, /id="invite-qr"/);
  assert.match(html, /id="friend-invite-qr"/);
  assert.match(app, /data-add-receipt/);
  assert.match(app, /data-delete-receipt/);
  assert.match(app, /navigator\.clipboard/);
  assert.match(app, /document\.execCommand\("copy"\)/);
  assert.match(app, /new EventSource/);
  assert.match(app, /data-quick-claim/);
  assert.doesNotMatch(html, /name="expenseDate"[^>]*required/);
  assert.equal(
    [...html.matchAll(/name="splitMode"/g)].length,
    4,
    "utgiftsdialogen ska ha exakt fyra delningssätt",
  );

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML innehåller dubbla id-attribut");
  const referencedIds = new Set([...app.matchAll(/\$\("#([A-Za-z0-9_-]+)"/g)].map((match) => match[1]));
  const missing = [...referencedIds].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, []);
});
