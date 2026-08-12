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
    const assetPath = indexHtml.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/)?.[1];
    assert.ok(assetPath, "Vite-manifestet ska referera till en hashad React-bundle");
    assert.equal(indexResponse.headers.get("cache-control"), "no-store");

    const appResponse = await fetch(`${baseUrl}${assetPath}`);
    assert.equal(appResponse.status, 200);
    assert.match(appResponse.headers.get("content-type"), /text\/javascript/);
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

    const goodLogin = await request("/api/login", { method: "POST", body: { email: "victor@example.test", password: "my-secure-password" } });
    assert.equal(goodLogin.response.status, 200, JSON.stringify(goodLogin.payload));
    assert.match(cookieFrom(goodLogin.response), /^kompis_session=/);
    const wrongPassword = await request("/api/login", { method: "POST", body: { email: "victor@example.test", password: "nope-not-it" } });
    assert.equal(wrongPassword.response.status, 401);
    const unknownEmail = await request("/api/login", { method: "POST", body: { email: "nobody@example.test", password: "nope-not-it" } });
    assert.equal(unknownEmail.response.status, 401);
    assert.equal(unknownEmail.payload.error, wrongPassword.payload.error, "wrong password and unknown email must return the same generic message to avoid user enumeration");
    // Brute-force limiter is per-IP: drive it to the threshold, then confirm even a correct login is blocked.
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await request("/api/login", { method: "POST", body: { email: "nobody@example.test", password: "nope-not-it" } });
    }
    const lockedOut = await request("/api/login", { method: "POST", body: { email: "nobody@example.test", password: "nope-not-it" } });
    assert.equal(lockedOut.response.status, 429, JSON.stringify(lockedOut.payload));
    const lockedOutForEveryone = await request("/api/login", { method: "POST", body: { email: "victor@example.test", password: "my-secure-password" } });
    assert.equal(lockedOutForEveryone.response.status, 429);

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

    // IDOR: an ordinary authenticated user with no relationship to this trip must be rejected server-side,
    // never merely hidden client-side. Erik stays fully unrelated to tripId until later in this test.
    const erikFriendInvite = await request("/api/friend-invitations", { method: "POST", cookie: ownerCookie, body: {} });
    const erikRegistration = await request("/api/register", { method: "POST", body: { inviteToken: erikFriendInvite.payload.invitation.token, name: "Erik Utanför", email: "erik@example.test", password: "yet-another-secure-pw", swishPhone: "0705554433" } });
    assert.equal(erikRegistration.response.status, 201, JSON.stringify(erikRegistration.payload));
    const erikCookie = cookieFrom(erikRegistration.response);
    const erikId = erikRegistration.payload.user.id;
    const outsiderTripRead = await request(`/api/trips/${tripId}`, { cookie: erikCookie });
    assert.equal(outsiderTripRead.response.status, 403);
    const outsiderExpenseWrite = await request(`/api/trips/${tripId}/expenses`, { method: "POST", cookie: erikCookie, body: { title: "Smygutgift", amount: "10", payerId: 1, entries: [] } });
    assert.equal(outsiderExpenseWrite.response.status, 403);
    const outsiderParticipantWrite = await request(`/api/trips/${tripId}/participants`, { method: "POST", cookie: erikCookie, body: { name: "Inkräktare" } });
    assert.equal(outsiderParticipantWrite.response.status, 403);

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
    assert.equal(search.payload.users[0].swishPhone, null, "users/search must never expose phone numbers of unrelated people");

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
    assert.equal(quickTab.payload.quickTab.items.length, 2);
    assert.deepEqual(quickTab.payload.quickTab.items.map((item) => ({ name: item.name, quantity: item.quantity, amountCents: item.amountCents })), [
      { name: "Lager", quantity: 2, amountCents: 10001 },
      { name: "Pommes", quantity: 1, amountCents: 5000 },
    ]);
    const quickTabId = quickTab.payload.quickTab.id;
    const quickPreview = await request("/api/invitations/preview", { method: "POST", body: { token: quickTab.payload.invitation.token } });
    assert.equal(quickPreview.payload.invitation.kind, "quick_tab");
    assert.equal(quickPreview.payload.invitation.quickTabName, "Middag på Kajen");
    const anonymousQuickTab = await request(`/api/quick-tabs/${quickTabId}`);
    assert.equal(anonymousQuickTab.response.status, 401);
    const anonymousQuickTabEvents = await request(`/api/quick-tabs/${quickTabId}/events`);
    assert.equal(anonymousQuickTabEvents.response.status, 401);
    const outsiderQuickTabRead = await request(`/api/quick-tabs/${quickTabId}`, { cookie: erikCookie });
    assert.equal(outsiderQuickTabRead.response.status, 403);
    const outsiderQuickTabEvents = await request(`/api/quick-tabs/${quickTabId}/events`, { cookie: erikCookie });
    assert.equal(outsiderQuickTabEvents.response.status, 403);
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
    const lagerItem = quickTab.payload.quickTab.items[0].id;
    const pommesItem = quickTab.payload.quickTab.items[1].id;
    await request(`/api/quick-tabs/${quickTabId}/claims`, { method: "POST", cookie: ownerCookie, body: { itemId: lagerItem, quantity: 1 } });
    const tooManyBeers = await request(`/api/quick-tabs/${quickTabId}/claims`, { method: "POST", cookie: memberCookie, body: { itemId: lagerItem, quantity: 2 } });
    assert.equal(tooManyBeers.response.status, 409);
    const memberClaims = await request(`/api/quick-tabs/${quickTabId}/claims`, { method: "POST", cookie: memberCookie, body: { itemId: lagerItem, quantity: 1 } });
    assert.equal(memberClaims.payload.quickTab.claimedCents, 10001);
    assert.equal(memberClaims.payload.quickTab.unclaimedCents, 5000);
    assert.equal(memberClaims.payload.quickTab.items[0].claimedQuantity, 2);
    assert.deepEqual(memberClaims.payload.quickTab.items[0].claims.map((claim) => claim.quantity), [1, 1]);
    assert.equal(memberClaims.payload.quickTab.members.find((item) => item.role === "owner").swishPhone, "+46701234567");
    assert.deepEqual(Object.fromEntries(memberClaims.payload.quickTab.personTotals.map((item) => [item.name, item.amountCents])), {
      Victor: 5001, "Erik Gäst": 0, Anna: 5000,
    });
    const guestClaims = await request(`/api/quick-tabs/${quickTabId}/claims`, { method: "POST", cookie: guestCookie, body: { itemId: pommesItem, quantity: 1 } });
    assert.equal(guestClaims.response.status, 200, JSON.stringify(guestClaims.payload));
    assert.equal(guestClaims.payload.quickTab.currentViewerKey.startsWith("g:"), true);
    assert.equal(guestClaims.payload.quickTab.claimedCents, 15001);
    assert.equal(guestClaims.payload.quickTab.unclaimedCents, 0);
    assert.deepEqual(Object.fromEntries(guestClaims.payload.quickTab.personTotals.map((item) => [item.name, item.amountCents])), {
      Victor: 5001, "Erik Gäst": 5000, Anna: 5000,
    });
    assert.equal(guestClaims.payload.quickTab.personTotals.find((item) => item.name === "Erik Gäst").swishPhone, "+46701112233");

    // Re-opening the same invitation link must reconnect the existing guest, not spawn a duplicate.
    const guestRejoin = await request("/api/quick-tabs/guest-join", {
      method: "POST", cookie: guestCookie, body: { token: quickTab.payload.invitation.token, name: "Erik Gäst", swishPhone: "0701112233" },
    });
    assert.equal(guestRejoin.response.status, 200, JSON.stringify(guestRejoin.payload));
    assert.equal(guestRejoin.payload.guest.id, guestJoin.payload.guest.id, "reopening the invitation link must reconnect the same guest, not create a new one");
    const afterRejoin = await request(`/api/quick-tabs/${quickTabId}`, { cookie: guestCookie });
    assert.equal(afterRejoin.payload.quickTab.members.filter((member) => member.name === "Erik Gäst").length, 1);
    assert.equal(afterRejoin.payload.quickTab.claimedCents, 15001, "the guest's existing claim must survive reopening the link");

    // Re-opening the same invitation link while already an authenticated member must also be idempotent.
    const memberRejoin = await request("/api/invitations/join", { method: "POST", cookie: memberCookie, body: { token: quickTab.payload.invitation.token } });
    assert.equal(memberRejoin.response.status, 200, JSON.stringify(memberRejoin.payload));
    const afterMemberRejoin = await request(`/api/quick-tabs/${quickTabId}`, { cookie: ownerCookie });
    assert.equal(afterMemberRejoin.payload.quickTab.members.filter((member) => member.name === "Anna").length, 1);

    const memberCannotCloseQuickTab = await request(`/api/quick-tabs/${quickTabId}/close`, { method: "POST", cookie: memberCookie, body: { closed: true } });
    assert.equal(memberCannotCloseQuickTab.response.status, 403);
    const closedQuickTab = await request(`/api/quick-tabs/${quickTabId}/close`, { method: "POST", cookie: ownerCookie, body: { closed: true } });
    assert.ok(closedQuickTab.payload.quickTab.closedAt);
    // The creator must always be able to generate a fresh invitation, even while the tab is closed
    // (e.g. to have it ready before reopening it later); only actually joining a closed tab is blocked.
    const reinviteAfterClose = await request(`/api/quick-tabs/${quickTabId}/invitations`, { method: "POST", cookie: ownerCookie, body: {} });
    assert.equal(reinviteAfterClose.response.status, 201, JSON.stringify(reinviteAfterClose.payload));
    assert.notEqual(reinviteAfterClose.payload.invitation.token, quickTab.payload.invitation.token);
    const joinClosedTabBlocked = await request("/api/quick-tabs/guest-join", {
      method: "POST", body: { token: reinviteAfterClose.payload.invitation.token, name: "Sen Gäst", swishPhone: "0701119999" },
    });
    assert.equal(joinClosedTabBlocked.response.status, 409);

    // Swedish characters must survive unmangled through validation, storage, and every API response —
    // participant names, expense titles, and quick-tab merchant/item names alike.
    const swedishParticipant = await request(`/api/trips/${tripId}/participants`, { method: "POST", cookie: ownerCookie, body: { name: "Åsa Öhman-Ångström", swishPhone: "0709998877" } });
    assert.equal(swedishParticipant.response.status, 201, JSON.stringify(swedishParticipant.payload));
    const addedSwedishParticipant = swedishParticipant.payload.trip.participants.find((item) => item.name === "Åsa Öhman-Ångström");
    assert.ok(addedSwedishParticipant, "participant name with å/ä/ö must round-trip exactly");
    const swedishExpense = await request(`/api/trips/${tripId}/expenses`, {
      method: "POST", cookie: ownerCookie,
      body: { title: "Räksmörgås, Öl och Blåbärspaj", amount: "3.00", payerId: ownerParticipant.id, category: "food", splitMode: "equal", entries: [{ participantId: ownerParticipant.id, value: 1 }] },
    });
    assert.equal(swedishExpense.response.status, 201, JSON.stringify(swedishExpense.payload));
    const swedishExpenseRecord = swedishExpense.payload.trip.expenses.find((item) => item.title === "Räksmörgås, Öl och Blåbärspaj");
    assert.ok(swedishExpenseRecord, "expense title with å/ä/ö must round-trip exactly");
    // Void it again immediately — this block only proves the round-trip, later totalCents assertions
    // assume the trip's earlier expense state.
    await request(`/api/expenses/${swedishExpenseRecord.id}`, { method: "DELETE", cookie: ownerCookie, body: {} });
    const swedishQuickTab = await request("/api/quick-tabs", {
      method: "POST", cookie: ownerCookie,
      body: { name: "Ångbåtsbryggan", merchant: "Ångbåtsbryggans Café", total: "189.00", items: [{ name: "Köttbullar med lingon", quantity: 2, amount: "189.00" }] },
    });
    assert.equal(swedishQuickTab.response.status, 201, JSON.stringify(swedishQuickTab.payload));
    assert.equal(swedishQuickTab.payload.quickTab.name, "Ångbåtsbryggan");
    assert.equal(swedishQuickTab.payload.quickTab.merchant, "Ångbåtsbryggans Café");
    assert.equal(swedishQuickTab.payload.quickTab.items[0].name, "Köttbullar med lingon");
    const rereadSwedishQuickTab = await request(`/api/quick-tabs/${swedishQuickTab.payload.quickTab.id}`, { cookie: ownerCookie });
    assert.equal(rereadSwedishQuickTab.payload.quickTab.items[0].name, "Köttbullar med lingon", "Swedish text must survive a fresh read from the database, not just an in-memory echo");
    const swedishSearch = await request(`/api/users/search?q=${encodeURIComponent("Öhman")}`, { cookie: ownerCookie });
    assert.deepEqual(swedishSearch.payload.users, [], "Åsa is a guest participant, not a registered user, so the Swedish-character search itself must still work without erroring");

    const quickTabList = await request("/api/quick-tabs", { cookie: memberCookie });
    assert.equal(quickTabList.payload.quickTabs[0].myClaimCount, 1);

    const archivedCategory = await request(`/api/categories/${customCategoryRecord.id}`, { method: "PATCH", cookie: ownerCookie, body: { archived: true } });
    assert.ok(archivedCategory.payload.categories.find((item) => item.id === customCategoryRecord.id).archivedAt);
    const rejectedArchivedCategory = await request(`/api/expenses/${expense.payload.trip.expenses[0].id}`, {
      method: "PATCH",
      cookie: ownerCookie,
      body: { title: "Ska nekas", amount: "120.01", payerId: memberParticipant.id, category: customCategory.payload.createdSlug, splitMode: "equal", entries: [{ participantId: ownerParticipant.id, value: 1 }, { participantId: memberParticipant.id, value: 1 }] },
    });
    assert.equal(rejectedArchivedCategory.response.status, 400);

    // A real (tiny) PNG — the server re-normalizes every stored image with Sharp, so it must be
    // genuinely decodable, not just a valid magic-byte signature.
    const receiptBytes = Buffer.from("89504e470d0a1a0a0000000d4948445200000020000000200802000000fc18eda30000000970485973000003e8000003e801b57b526b00000031494441544889edd0310d000008c030fc9b0609bbf85a034b36fb6c048a45c9a26451b22859942c4a16258b9245e97dd1018b55f4a62fd707540000000049454e44ae426082", "hex");
    const receiptUploadResponse = await fetch(`${baseUrl}/api/expenses/${expense.payload.trip.expenses[0].id}/receipts`, {
      method: "POST",
      headers: { Cookie: ownerCookie, Origin: baseUrl, "Content-Type": "image/png", "X-File-Name": encodeURIComponent("middagskvitto.png") },
      body: receiptBytes,
    });
    const receiptUpload = await receiptUploadResponse.json();
    assert.equal(receiptUploadResponse.status, 201, JSON.stringify(receiptUpload));
    assert.equal(receiptUpload.trip.expenses[0].receipts.length, 1);
    const receiptId = receiptUpload.trip.expenses[0].receipts[0].id;
    // The server always re-encodes stored receipt images as normalized JPEG (strips metadata, caps
    // dimensions) regardless of the uploaded format, so the download is a JPEG, not a byte-identical PNG.
    assert.equal(receiptUpload.trip.expenses[0].receipts[0].fileName, "middagskvitto.jpg");
    assert.equal(receiptUpload.trip.expenses[0].receipts[0].mimeType, "image/jpeg");
    // Backend protection must never trust the client: correct magic bytes with an otherwise
    // malformed/undecodable body must be rejected, not silently stored as-is.
    const corruptImageBytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("this-is-not-a-real-png-body")]);
    const corruptUploadResponse = await fetch(`${baseUrl}/api/expenses/${expense.payload.trip.expenses[0].id}/receipts`, {
      method: "POST",
      headers: { Cookie: ownerCookie, Origin: baseUrl, "Content-Type": "image/png", "X-File-Name": "trasig.png" },
      body: corruptImageBytes,
    });
    assert.ok([413, 415].includes(corruptUploadResponse.status), `a correctly-signed but undecodable image must be rejected (413 or 415), not stored — got ${corruptUploadResponse.status}`);
    const downloadedReceipt = await fetch(`${baseUrl}/api/receipts/${receiptId}`, { headers: { Cookie: ownerCookie } });
    assert.equal(downloadedReceipt.headers.get("content-type"), "image/jpeg");
    const downloadedBytes = Buffer.from(await downloadedReceipt.arrayBuffer());
    assert.equal(downloadedBytes.subarray(0, 3).toString("hex"), "ffd8ff", "stored receipt must be a real, re-encoded JPEG");
    const outsiderReceiptRead = await request(`/api/receipts/${receiptId}`, { cookie: erikCookie });
    assert.equal(outsiderReceiptRead.response.status, 403);
    const memberCannotDeleteReceipt = await request(`/api/receipts/${receiptId}`, { method: "DELETE", cookie: memberCookie, body: {} });
    assert.equal(memberCannotDeleteReceipt.response.status, 403);

    const memberCannotVoid = await request(`/api/expenses/${expense.payload.trip.expenses[0].id}`, { method: "DELETE", cookie: memberCookie, body: {} });
    assert.equal(memberCannotVoid.response.status, 403);

    const voided = await request(`/api/expenses/${expense.payload.trip.expenses[0].id}`, { method: "DELETE", cookie: ownerCookie, body: {} });
    assert.equal(voided.response.status, 200);
    const afterVoid = await request(`/api/trips/${tripId}`, { cookie: ownerCookie });
    assert.equal(afterVoid.payload.trip.totalCents, 0);

    // contacts: saving a stranger is blocked until you actually share a trip or quick tab with them.
    const blockedContact = await request("/api/contacts", { method: "POST", cookie: memberCookie, body: { userId: erikId } });
    assert.equal(blockedContact.response.status, 403, JSON.stringify(blockedContact.payload));
    const erikJoinsTrip = await request(`/api/trips/${tripId}/participants`, { method: "POST", cookie: ownerCookie, body: { userId: erikId } });
    assert.equal(erikJoinsTrip.response.status, 201, JSON.stringify(erikJoinsTrip.payload));
    const allowedContact = await request("/api/contacts", { method: "POST", cookie: memberCookie, body: { userId: erikId } });
    assert.equal(allowedContact.response.status, 201, JSON.stringify(allowedContact.payload));

    // payments: any trip member can record one; only its creator or a manager can void it.
    const payment = await request(`/api/trips/${tripId}/payments`, { method: "POST", cookie: memberCookie, body: { fromId: memberParticipant.id, toId: ownerParticipant.id, amount: "25.00", note: "Swish" } });
    assert.equal(payment.response.status, 201, JSON.stringify(payment.payload));
    assert.equal(payment.payload.trip.payments[0].amountCents, 2500);
    const paymentId = payment.payload.trip.payments[0].id;
    const erikCannotVoidPayment = await request(`/api/payments/${paymentId}`, { method: "DELETE", cookie: erikCookie, body: {} });
    assert.equal(erikCannotVoidPayment.response.status, 403);
    const paymentVoided = await request(`/api/payments/${paymentId}`, { method: "DELETE", cookie: memberCookie, body: {} });
    assert.equal(paymentVoided.response.status, 200, JSON.stringify(paymentVoided.payload));

    // percentage split mode end-to-end through the HTTP API (the allocation math itself is covered in split.test.mjs).
    const percentageExpense = await request(`/api/trips/${tripId}/expenses`, { method: "POST", cookie: ownerCookie, body: { title: "Bensin", amount: "100", payerId: ownerParticipant.id, category: "travel", splitMode: "percentage", entries: [{ participantId: ownerParticipant.id, value: 60 }, { participantId: memberParticipant.id, value: 40 }] } });
    assert.equal(percentageExpense.response.status, 201, JSON.stringify(percentageExpense.payload));
    assert.deepEqual(percentageExpense.payload.trip.expenses[0].shares.map((share) => share.amountCents), [6000, 4000]);

    // concurrent receipt uploads on the same expense must never be able to exceed the per-expense cap.
    const concurrentReceipts = await Promise.all(Array.from({ length: 6 }, (_, index) => fetch(`${baseUrl}/api/expenses/${percentageExpense.payload.expenseId}/receipts`, {
      method: "POST",
      headers: { Cookie: ownerCookie, Origin: baseUrl, "Content-Type": "image/png", "X-File-Name": `race-${index}.png` },
      body: receiptBytes,
    })));
    const concurrentStatuses = concurrentReceipts.map((response) => response.status).sort((a, b) => a - b);
    assert.equal(concurrentStatuses.filter((status) => status === 201).length, 5, JSON.stringify(concurrentStatuses));
    assert.equal(concurrentStatuses.filter((status) => status === 409).length, 1, JSON.stringify(concurrentStatuses));

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
    assert.equal(adminOverview.payload.users.length, 3);
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

    // Demo mode: only an admin may enter, server-enforced regardless of what the client claims.
    const memberCannotEnterDemo = await request("/api/admin/demo/enter", { method: "POST", cookie: memberCookie, body: {} });
    assert.equal(memberCannotEnterDemo.response.status, 403);
    const realTripId = tripId;
    const enteredDemo = await request("/api/admin/demo/enter", { method: "POST", cookie: ownerCookie, body: {} });
    assert.equal(enteredDemo.response.status, 200, JSON.stringify(enteredDemo.payload));
    assert.equal(enteredDemo.payload.demoMode, true);
    const demoSession = await request("/api/session", { cookie: ownerCookie });
    assert.equal(demoSession.payload.demoMode, true);

    // Demo dashboard shows only fictional seeded trips, never the admin's real ones.
    const demoDashboard = await request("/api/dashboard", { cookie: ownerCookie });
    assert.deepEqual(demoDashboard.payload.trips.map((item) => item.name).sort(), ["Weekend i Göteborg", "Åre 2026"]);
    assert.deepEqual(demoDashboard.payload.contacts, [], "real contacts must never surface while in demo mode");
    const demoTripId = demoDashboard.payload.trips.find((item) => item.name === "Weekend i Göteborg").id;
    const demoTrip = await request(`/api/trips/${demoTripId}`, { cookie: ownerCookie });
    assert.equal(demoTrip.response.status, 200);
    assert.equal(demoTrip.payload.trip.participants.length, 5);
    assert.equal(demoTrip.payload.trip.expenses.length, 5);

    // A demo session must never reach a real trip, even one the admin genuinely owns — loadTrip
    // treats the context mismatch exactly like the trip not existing (404), not a bare 403, so it
    // doesn't even confirm the real trip's existence to a demo-context caller.
    const demoCannotReadRealTrip = await request(`/api/trips/${realTripId}`, { cookie: ownerCookie });
    assert.equal(demoCannotReadRealTrip.response.status, 404);
    // Writes that go straight through requireAccess (not loadTrip) still surface as 403.
    const demoCannotArchiveRealTrip = await request(`/api/trips/${realTripId}/archive`, { method: "POST", cookie: ownerCookie, body: { archived: true } });
    assert.equal(demoCannotArchiveRealTrip.response.status, 403);

    // Demo mode must never expose real contacts, send real invitations, or touch global admin data.
    for (const blocked of [
      () => request("/api/users/search?q=an", { cookie: ownerCookie }),
      () => request("/api/contacts", { cookie: ownerCookie }),
      () => request("/api/contacts", { method: "POST", cookie: ownerCookie, body: { userId: memberId } }),
      () => request("/api/admin", { cookie: ownerCookie }),
      () => request(`/api/admin/users/${memberId}`, { method: "PATCH", cookie: ownerCookie, body: { isAdmin: true } }),
      () => request("/api/friend-invitations", { method: "POST", cookie: ownerCookie, body: {} }),
      () => request(`/api/trips/${demoTripId}/invitations`, { method: "POST", cookie: ownerCookie, body: {} }),
    ]) {
      const result = await blocked();
      assert.equal(result.response.status, 403, JSON.stringify(result.payload));
    }

    // A trip created while demonstrating the app is isolated the same way as the seeded data.
    const demoCreatedTrip = await request("/api/trips", { method: "POST", cookie: ownerCookie, body: { name: "Admin-skapad demoresa" } });
    assert.equal(demoCreatedTrip.response.status, 201);
    assert.equal(demoCreatedTrip.payload.trip.participants.length, 1);
    const realDashboardBeforeExit = await request("/api/dashboard", { cookie: memberCookie });
    assert.equal(realDashboardBeforeExit.payload.trips.some((item) => item.name === "Admin-skapad demoresa"), false, "another user's real dashboard must never see demo trips");

    // Exiting demo mode discards every demo row and immediately restores the real context.
    const exitedDemo = await request("/api/admin/demo/exit", { method: "POST", cookie: ownerCookie, body: {} });
    assert.equal(exitedDemo.response.status, 200, JSON.stringify(exitedDemo.payload));
    assert.equal(exitedDemo.payload.demoMode, false);
    const afterExitSession = await request("/api/session", { cookie: ownerCookie });
    assert.equal(afterExitSession.payload.demoMode, false);
    const afterExitDashboard = await request("/api/dashboard", { cookie: ownerCookie });
    assert.equal(afterExitDashboard.payload.trips.some((item) => item.name === "Weekend i Göteborg"), false);
    assert.equal(afterExitDashboard.payload.trips.some((item) => item.id === realTripId), true, "the admin's real trips must be back after exiting demo mode");
    const demoTripGoneAfterExit = await request(`/api/trips/${demoTripId}`, { cookie: ownerCookie });
    assert.equal(demoTripGoneAfterExit.response.status, 404, "the demo trip's data must actually be deleted, not just hidden");

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
  // 1 from the original "Middag uppdaterad" void + 1 from voiding the Swedish-characters test expense.
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action = 'expense.voided'")).rows[0].count), 2);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action = 'payment.voided'")).rows[0].count), 1);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action IN ('trip.deleted', 'trip.undeleted')")).rows[0].count), 2);
  // 1 from the original upload + 5 from the concurrent-upload race-condition test (the cap rejects the 6th).
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action = 'receipt.created'")).rows[0].count), 6);
  // 2 from Anna's friend invitation + 2 from Erik's.
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM audit_log WHERE action IN ('friend_invitation.created', 'friend_invitation.joined')")).rows[0].count), 4);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM expense_receipts")).rows[0].count), 0);
  assert.equal((await verification.query("SELECT voided_at IS NOT NULL voided FROM expenses WHERE title = 'Middag uppdaterad'")).rows[0].voided, true);
  assert.ok((await verification.query("SELECT expense_date FROM expenses WHERE title = 'Middag uppdaterad'")).rows[0].expense_date);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM schema_migrations")).rows[0].count), 7);
  // 1 from "Middag på Kajen" + 1 from the Swedish-characters test quick tab ("Ångbåtsbryggan").
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM quick_tabs")).rows[0].count), 2);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM quick_tab_guests")).rows[0].count), 1);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM quick_tab_claims")).rows[0].count), 3);
  assert.equal(Number((await verification.query("SELECT quantity FROM quick_tab_items WHERE name = 'Lager'")).rows[0].quantity), 2);
  await verification.end();
  await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await admin.end();
});
