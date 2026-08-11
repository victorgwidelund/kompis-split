import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import pg from "pg";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

test("accounts, invitations, authorization, archive and audit preserve the ledger", { timeout: 30_000 }, async () => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) return test.skip("TEST_DATABASE_URL saknas");
  const databaseName = `kompis_split_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const port = 20_000 + (process.pid % 20_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = "";
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl.toString(),
      APP_PASSWORD: "bootstrap-secret-123",
      COOKIE_SECRET: "integration-cookie-secret-at-least-32-bytes",
      COOKIE_SECURE: "false",
      TRUST_PROXY: "false",
      APP_VERSION: "1.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });

  async function request(path, { method = "GET", body, cookie, origin = baseUrl } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    if (!["GET", "HEAD"].includes(method)) headers.Origin = origin;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }

  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { const health = await request("/health"); if (health.response.ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, `Servern startade inte:\n${logs}`);

    const initial = await request("/api/session");
    assert.equal(initial.payload.needsSetup, true);
    assert.equal(initial.payload.version, "1.1");
    assert.match(initial.response.headers.get("permissions-policy"), /camera=\(self\)/);

    const indexResponse = await fetch(`${baseUrl}/`);
    const indexHtml = await indexResponse.text();
    assert.match(indexHtml, /href="\/styles\.css\?v=1\.1"/);
    assert.match(indexHtml, /src="\/app\.js\?v=1\.1"/);
    assert.equal(indexResponse.headers.get("cache-control"), "no-store");

    const appResponse = await fetch(`${baseUrl}/app.js?v=1.1`);
    assert.equal(appResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const rejectedOrigin = await request("/api/setup", { method: "POST", origin: "https://evil.example", body: {} });
    assert.equal(rejectedOrigin.response.status, 403);

    const setup = await request("/api/setup", { method: "POST", body: { setupPassword: "bootstrap-secret-123", name: "Victor", email: "victor@example.test", password: "my-secure-password", swishPhone: "0701234567" } });
    assert.equal(setup.response.status, 201, JSON.stringify(setup.payload));
    assert.equal(setup.payload.user.isAdmin, true);
    const ownerCookie = cookieFrom(setup.response);
    assert.match(ownerCookie, /^kompis_session=/);
    const ownerSession = await request("/api/session", { cookie: ownerCookie });
    assert.equal(ownerSession.payload.authenticated, true, JSON.stringify(ownerSession.payload));

    const friendInvite = await request("/api/friend-invitations", { method: "POST", cookie: ownerCookie, body: {} });
    assert.equal(friendInvite.response.status, 201, JSON.stringify(friendInvite.payload));
    assert.match(friendInvite.payload.invitation.qrDataUrl, /^data:image\/png;base64,/);
    const friendPreview = await request("/api/invitations/preview", { method: "POST", body: { token: friendInvite.payload.invitation.token } });
    assert.equal(friendPreview.payload.invitation.kind, "friend");
    assert.equal(friendPreview.payload.invitation.tripName, null);

    const registration = await request("/api/register", { method: "POST", body: { inviteToken: friendInvite.payload.invitation.token, name: "Anna", email: "anna@example.test", password: "another-secure-password", swishPhone: "0709876543" } });
    assert.equal(registration.response.status, 201, JSON.stringify(registration.payload));
    assert.equal(registration.payload.tripId, null);
    const memberCookie = cookieFrom(registration.response);

    const created = await request("/api/trips", { method: "POST", cookie: ownerCookie, body: { name: "Sälen", startDate: "2026-12-10", endDate: "2026-12-13" } });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    const tripId = created.payload.trip.id;
    const invite = await request(`/api/trips/${tripId}/invitations`, { method: "POST", cookie: ownerCookie, body: {} });
    assert.equal(invite.response.status, 201, JSON.stringify(invite.payload));
    assert.match(invite.payload.invitation.qrDataUrl, /^data:image\/png;base64,/);
    const token = invite.payload.invitation.token;
    const preview = await request("/api/invitations/preview", { method: "POST", body: { token } });
    assert.equal(preview.payload.invitation.kind, "trip");
    assert.equal(preview.payload.invitation.tripName, "Sälen");
    const joinedTrip = await request("/api/invitations/join", { method: "POST", cookie: memberCookie, body: { token } });
    assert.equal(joinedTrip.payload.tripId, tripId);

    const memberDashboard = await request("/api/dashboard", { cookie: memberCookie });
    assert.equal(memberDashboard.payload.trips.length, 1);
    assert.equal(memberDashboard.payload.contacts[0].email, "victor@example.test");
    const forbiddenAdmin = await request("/api/admin", { cookie: memberCookie });
    assert.equal(forbiddenAdmin.response.status, 403);
    const contacts = await request("/api/contacts", { cookie: memberCookie });
    assert.equal(contacts.payload.contacts[0].email, "victor@example.test");
    const search = await request("/api/users/search?q=Vic", { cookie: memberCookie });
    assert.equal(search.payload.users[0].email, "victor@example.test");
    assert.equal(search.payload.users[0].isContact, true);

    const forbiddenArchive = await request(`/api/trips/${tripId}/archive`, { method: "POST", cookie: memberCookie, body: { archived: true } });
    assert.equal(forbiddenArchive.response.status, 403);

    const trip = await request(`/api/trips/${tripId}`, { cookie: ownerCookie });
    assert.equal(trip.payload.trip.participants.length, 2);
    const [ownerParticipant, memberParticipant] = trip.payload.trip.participants;
    const defaultCategories = await request("/api/categories", { cookie: ownerCookie });
    assert.equal(defaultCategories.payload.categories.length, 5);
    const customCategory = await request("/api/categories", { method: "POST", cookie: ownerCookie, body: { name: "Fika", emoji: "☕" } });
    assert.equal(customCategory.response.status, 201, JSON.stringify(customCategory.payload));
    assert.match(customCategory.payload.createdSlug, /^custom-/);
    const customCategoryRecord = customCategory.payload.categories.find((item) => item.slug === customCategory.payload.createdSlug);
    assert.equal(customCategoryRecord.name, "Fika");
    const expense = await request(`/api/trips/${tripId}/expenses`, {
      method: "POST",
      cookie: ownerCookie,
      body: { title: "Middag", amount: "100.01", payerId: ownerParticipant.id, category: "food", splitMode: "equal", entries: [{ participantId: ownerParticipant.id, value: 1 }, { participantId: memberParticipant.id, value: 1 }] },
    });
    assert.equal(expense.response.status, 201, JSON.stringify(expense.payload));
    assert.equal(expense.payload.trip.totalCents, 10001);
    assert.equal(expense.payload.trip.expenses[0].expenseDate, null);
    assert.deepEqual(expense.payload.trip.expenses[0].shares.map((share) => share.amountCents), [5001, 5000]);

    const memberCannotEdit = await request(`/api/expenses/${expense.payload.trip.expenses[0].id}`, {
      method: "PATCH",
      cookie: memberCookie,
      body: { title: "Manipulerad", amount: "75", payerId: memberParticipant.id, category: "other", splitMode: "equal", entries: [{ participantId: ownerParticipant.id, value: 1 }, { participantId: memberParticipant.id, value: 1 }] },
    });
    assert.equal(memberCannotEdit.response.status, 403);
    const edited = await request(`/api/expenses/${expense.payload.trip.expenses[0].id}`, {
      method: "PATCH",
      cookie: ownerCookie,
      body: { title: "Middag uppdaterad", amount: "120.01", payerId: memberParticipant.id, expenseDate: "2026-12-11", category: customCategory.payload.createdSlug, splitMode: "exact", entries: [{ participantId: ownerParticipant.id, value: "60.01" }, { participantId: memberParticipant.id, value: "60.00" }] },
    });
    assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
    assert.equal(edited.payload.trip.totalCents, 12001);
    assert.equal(edited.payload.trip.expenses[0].title, "Middag uppdaterad");
    assert.equal(edited.payload.trip.expenses[0].payerId, memberParticipant.id);
    assert.deepEqual(edited.payload.trip.expenses[0].shares.map((share) => share.amountCents), [6001, 6000]);

    const statistics = await request("/api/statistics", { cookie: ownerCookie });
    assert.equal(statistics.response.status, 200, JSON.stringify(statistics.payload));
    assert.deepEqual(statistics.payload.summary, { expenseCount: 1, tripCount: 1, totalCents: 12001, averageCents: 12001 });
    assert.equal(statistics.payload.categories[0].name, "Fika");
    assert.equal(statistics.payload.categories[0].totalCents, 12001);
    assert.equal(statistics.payload.merchants[0].name, "Middag uppdaterad");
    assert.equal(statistics.payload.payers[0].name, memberParticipant.name);
    assert.equal(statistics.payload.trend[0].month, "2026-12");

    const quickTab = await request("/api/quick-tabs", {
      method: "POST", cookie: ownerCookie,
      body: { name: "Middag på Kajen", merchant: "Bistro Kajen", receiptDate: "2026-12-11", total: "150.01", items: [{ name: "Lager", quantity: 2, amount: "100.01" }, { name: "Pommes", quantity: 1, amount: "50.00" }] },
    });
    assert.equal(quickTab.response.status, 201, JSON.stringify(quickTab.payload));
    assert.equal(quickTab.payload.quickTab.items.length, 3);
    assert.deepEqual(quickTab.payload.quickTab.items.map((item) => item.amountCents), [5001, 5000, 5000]);
    const quickTabId = quickTab.payload.quickTab.id;
    const quickPreview = await request("/api/invitations/preview", { method: "POST", body: { token: quickTab.payload.invitation.token } });
    assert.equal(quickPreview.payload.invitation.kind, "quick_tab");
    assert.equal(quickPreview.payload.invitation.quickTabName, "Middag på Kajen");
    const anonymousQuickTab = await request(`/api/quick-tabs/${quickTabId}`);
    assert.equal(anonymousQuickTab.response.status, 401);
    const guestJoin = await request("/api/quick-tabs/guest-join", {
      method: "POST", body: { token: quickTab.payload.invitation.token, name: "Erik Gäst", swishPhone: "0701112233" },
    });
    assert.equal(guestJoin.response.status, 201, JSON.stringify(guestJoin.payload));
    assert.equal(guestJoin.payload.quickTabId, quickTabId);
    const guestCookie = cookieFrom(guestJoin.response);
    assert.match(guestCookie, new RegExp(`^kompis_quick_guest_${quickTabId}=`));
    const guestDashboard = await request("/api/dashboard", { cookie: guestCookie });
    assert.equal(guestDashboard.response.status, 401);
    const joinedQuickTab = await request("/api/invitations/join", { method: "POST", cookie: memberCookie, body: { token: quickTab.payload.invitation.token } });
    assert.equal(joinedQuickTab.payload.quickTabId, quickTabId);
    const firstQuickItem = quickTab.payload.quickTab.items[0].id;
    const secondQuickItem = quickTab.payload.quickTab.items[1].id;
    const thirdQuickItem = quickTab.payload.quickTab.items[2].id;
    await request(`/api/quick-tabs/${quickTabId}/claims`, { method: "POST", cookie: ownerCookie, body: { itemId: firstQuickItem, claimed: true } });
    await request(`/api/quick-tabs/${quickTabId}/claims`, { method: "POST", cookie: memberCookie, body: { itemId: firstQuickItem, claimed: true } });
    const memberClaims = await request(`/api/quick-tabs/${quickTabId}/claims`, { method: "POST", cookie: memberCookie, body: { itemId: secondQuickItem, claimed: true } });
    assert.equal(memberClaims.payload.quickTab.claimedCents, 10001);
    assert.equal(memberClaims.payload.quickTab.unclaimedCents, 5000);
    assert.deepEqual(Object.fromEntries(memberClaims.payload.quickTab.personTotals.map((item) => [item.name, item.amountCents])), {
      Victor: 2501, "Erik Gäst": 0, Anna: 7500,
    });
    const guestClaims = await request(`/api/quick-tabs/${quickTabId}/claims`, { method: "POST", cookie: guestCookie, body: { itemId: thirdQuickItem, claimed: true } });
    assert.equal(guestClaims.response.status, 200, JSON.stringify(guestClaims.payload));
    assert.equal(guestClaims.payload.quickTab.currentViewerKey.startsWith("g:"), true);
    assert.equal(guestClaims.payload.quickTab.claimedCents, 15001);
    assert.equal(guestClaims.payload.quickTab.unclaimedCents, 0);
    assert.deepEqual(Object.fromEntries(guestClaims.payload.quickTab.personTotals.map((item) => [item.name, item.amountCents])), {
      Victor: 2501, "Erik Gäst": 5000, Anna: 7500,
    });
    assert.equal(guestClaims.payload.quickTab.personTotals.find((item) => item.name === "Erik Gäst").swishPhone, "+46701112233");
    const memberCannotCloseQuickTab = await request(`/api/quick-tabs/${quickTabId}/close`, { method: "POST", cookie: memberCookie, body: { closed: true } });
    assert.equal(memberCannotCloseQuickTab.response.status, 403);
    const closedQuickTab = await request(`/api/quick-tabs/${quickTabId}/close`, { method: "POST", cookie: ownerCookie, body: { closed: true } });
    assert.ok(closedQuickTab.payload.quickTab.closedAt);
    const quickTabList = await request("/api/quick-tabs", { cookie: memberCookie });
    assert.equal(quickTabList.payload.quickTabs[0].myClaimCount, 2);

    const archivedCategory = await request(`/api/categories/${customCategoryRecord.id}`, { method: "PATCH", cookie: ownerCookie, body: { archived: true } });
    assert.ok(archivedCategory.payload.categories.find((item) => item.id === customCategoryRecord.id).archivedAt);
    const rejectedArchivedCategory = await request(`/api/expenses/${expense.payload.trip.expenses[0].id}`, {
      method: "PATCH",
      cookie: ownerCookie,
      body: { title: "Ska nekas", amount: "120.01", payerId: memberParticipant.id, category: customCategory.payload.createdSlug, splitMode: "equal", entries: [{ participantId: ownerParticipant.id, value: 1 }, { participantId: memberParticipant.id, value: 1 }] },
    });
    assert.equal(rejectedArchivedCategory.response.status, 400);

    const receiptBytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("kompis-split-test")]);
    const receiptUploadResponse = await fetch(`${baseUrl}/api/expenses/${expense.payload.trip.expenses[0].id}/receipts`, {
      method: "POST",
      headers: { Cookie: ownerCookie, Origin: baseUrl, "Content-Type": "image/png", "X-File-Name": encodeURIComponent("middagskvitto.png") },
      body: receiptBytes,
    });
    const receiptUpload = await receiptUploadResponse.json();
    assert.equal(receiptUploadResponse.status, 201, JSON.stringify(receiptUpload));
    assert.equal(receiptUpload.trip.expenses[0].receipts.length, 1);
    const receiptId = receiptUpload.trip.expenses[0].receipts[0].id;
    const downloadedReceipt = await fetch(`${baseUrl}/api/receipts/${receiptId}`, { headers: { Cookie: ownerCookie } });
    assert.equal(downloadedReceipt.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await downloadedReceipt.arrayBuffer()), receiptBytes);
    const memberCannotDeleteReceipt = await request(`/api/receipts/${receiptId}`, { method: "DELETE", cookie: memberCookie, body: {} });
    assert.equal(memberCannotDeleteReceipt.response.status, 403);

    const memberCannotVoid = await request(`/api/expenses/${expense.payload.trip.expenses[0].id}`, { method: "DELETE", cookie: memberCookie, body: {} });
    assert.equal(memberCannotVoid.response.status, 403);

    const voided = await request(`/api/expenses/${expense.payload.trip.expenses[0].id}`, { method: "DELETE", cookie: ownerCookie, body: {} });
    assert.equal(voided.response.status, 200);
    const afterVoid = await request(`/api/trips/${tripId}`, { cookie: ownerCookie });
    assert.equal(afterVoid.payload.trip.totalCents, 0);

    const archived = await request(`/api/trips/${tripId}/archive`, { method: "POST", cookie: ownerCookie, body: { archived: true } });
    assert.ok(archived.payload.trip.archivedAt);
    const blockedWrite = await request(`/api/trips/${tripId}/payments`, { method: "POST", cookie: ownerCookie, body: { fromId: memberParticipant.id, toId: ownerParticipant.id, amount: "1" } });
    assert.equal(blockedWrite.response.status, 409);
    const memberCannotTrash = await request(`/api/trips/${tripId}/trash`, { method: "POST", cookie: memberCookie, body: { deleted: true } });
    assert.equal(memberCannotTrash.response.status, 403);
    const trashed = await request(`/api/trips/${tripId}/trash`, { method: "POST", cookie: ownerCookie, body: { deleted: true } });
    assert.equal(trashed.response.status, 200);
    const dashboardWithoutTrash = await request("/api/dashboard", { cookie: ownerCookie });
    assert.equal(dashboardWithoutTrash.payload.trips.length, 0);
    const hiddenTrip = await request(`/api/trips/${tripId}`, { cookie: ownerCookie });
    assert.equal(hiddenTrip.response.status, 404);
    const overviewWithTrash = await request("/api/admin", { cookie: ownerCookie });
    assert.ok(overviewWithTrash.payload.trips.find((item) => item.id === tripId).deletedAt);
    assert.equal(overviewWithTrash.payload.stats.deletedTripCount, 1);
    const untrashed = await request(`/api/trips/${tripId}/trash`, { method: "POST", cookie: ownerCookie, body: { deleted: false } });
    assert.equal(untrashed.response.status, 200);
    const restored = await request(`/api/trips/${tripId}/archive`, { method: "POST", cookie: ownerCookie, body: { archived: false } });
    assert.equal(restored.payload.trip.archivedAt, null);

    const privateTrip = await request("/api/trips", { method: "POST", cookie: memberCookie, body: { name: "Annas plan" } });
    assert.equal(privateTrip.response.status, 201, JSON.stringify(privateTrip.payload));
    assert.equal(privateTrip.payload.trip.startDate, null);
    const adminOverview = await request("/api/admin", { cookie: ownerCookie });
    assert.equal(adminOverview.response.status, 200, JSON.stringify(adminOverview.payload));
    assert.equal(adminOverview.payload.users.length, 2);
    assert.equal(adminOverview.payload.trips.length, 2);
    const adminCanOpenEveryTrip = await request(`/api/trips/${privateTrip.payload.trip.id}`, { cookie: ownerCookie });
    assert.equal(adminCanOpenEveryTrip.response.status, 200);
    assert.equal(adminCanOpenEveryTrip.payload.trip.role, "admin");

    const memberId = registration.payload.user.id;
    const promoted = await request(`/api/admin/users/${memberId}`, { method: "PATCH", cookie: ownerCookie, body: { isAdmin: true } });
    assert.equal(promoted.response.status, 200);
    assert.equal(promoted.payload.user.isAdmin, true);
    const demoted = await request(`/api/admin/users/${memberId}`, { method: "PATCH", cookie: ownerCookie, body: { isAdmin: false } });
    assert.equal(demoted.payload.user.isAdmin, false);
    const disabled = await request(`/api/admin/users/${memberId}`, { method: "PATCH", cookie: ownerCookie, body: { isDisabled: true } });
    assert.equal(disabled.response.status, 200);
    const disabledSession = await request("/api/dashboard", { cookie: memberCookie });
    assert.equal(disabledSession.response.status, 401);
  } catch (error) {
    await admin.end().catch(() => {});
    throw error;
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  const verification = new pg.Client({ connectionString: databaseUrl.toString() });
  await verification.connect();
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action = 'expense.updated'")).rows[0].count), 1);
  const revision = (await verification.query("SELECT payload_json FROM audit_log WHERE action = 'expense.updated'")).rows[0].payload_json;
  assert.equal(Number(revision.previous.amountCents), 10001);
  assert.deepEqual(revision.previous.shares.map((share) => Number(share.amountCents)), [5001, 5000]);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action = 'expense.voided'")).rows[0].count), 1);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action IN ('trip.deleted', 'trip.undeleted')")).rows[0].count), 2);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action = 'receipt.created'")).rows[0].count), 1);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action IN ('friend_invitation.created', 'friend_invitation.joined')")).rows[0].count), 2);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM expense_receipts")).rows[0].count), 0);
  assert.equal((await verification.query("SELECT voided_at IS NOT NULL voided FROM expenses WHERE title = 'Middag uppdaterad'")).rows[0].voided, true);
  assert.ok((await verification.query("SELECT expense_date FROM expenses WHERE title = 'Middag uppdaterad'")).rows[0].expense_date);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM schema_migrations")).rows[0].count), 5);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM quick_tabs")).rows[0].count), 1);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM quick_tab_guests")).rows[0].count), 1);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM quick_tab_claims")).rows[0].count), 4);
  await verification.end();
  await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await admin.end();
});
