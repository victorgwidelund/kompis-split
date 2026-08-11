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

    const rejectedOrigin = await request("/api/setup", { method: "POST", origin: "https://evil.example", body: {} });
    assert.equal(rejectedOrigin.response.status, 403);

    const setup = await request("/api/setup", { method: "POST", body: { setupPassword: "bootstrap-secret-123", name: "Victor", email: "victor@example.test", password: "my-secure-password", swishPhone: "0701234567" } });
    assert.equal(setup.response.status, 201, JSON.stringify(setup.payload));
    assert.equal(setup.payload.user.isAdmin, true);
    const ownerCookie = cookieFrom(setup.response);
    assert.match(ownerCookie, /^kompis_session=/);

    const created = await request("/api/trips", { method: "POST", cookie: ownerCookie, body: { name: "Sälen", startDate: "2026-12-10", endDate: "2026-12-13" } });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    const tripId = created.payload.trip.id;

    const invite = await request(`/api/trips/${tripId}/invitations`, { method: "POST", cookie: ownerCookie, body: {} });
    assert.equal(invite.response.status, 201, JSON.stringify(invite.payload));
    const token = invite.payload.invitation.token;
    const preview = await request("/api/invitations/preview", { method: "POST", body: { token } });
    assert.equal(preview.payload.invitation.tripName, "Sälen");

    const registration = await request("/api/register", { method: "POST", body: { inviteToken: token, name: "Anna", email: "anna@example.test", password: "another-secure-password", swishPhone: "0709876543" } });
    assert.equal(registration.response.status, 201, JSON.stringify(registration.payload));
    const memberCookie = cookieFrom(registration.response);

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
      body: { title: "Middag uppdaterad", amount: "120.01", payerId: memberParticipant.id, expenseDate: "2026-12-11", category: "food", splitMode: "exact", entries: [{ participantId: ownerParticipant.id, value: "60.01" }, { participantId: memberParticipant.id, value: "60.00" }] },
    });
    assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
    assert.equal(edited.payload.trip.totalCents, 12001);
    assert.equal(edited.payload.trip.expenses[0].title, "Middag uppdaterad");
    assert.equal(edited.payload.trip.expenses[0].payerId, memberParticipant.id);
    assert.deepEqual(edited.payload.trip.expenses[0].shares.map((share) => share.amountCents), [6001, 6000]);

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
  assert.equal((await verification.query("SELECT voided_at IS NOT NULL voided FROM expenses WHERE title = 'Middag uppdaterad'")).rows[0].voided, true);
  assert.ok((await verification.query("SELECT expense_date FROM expenses WHERE title = 'Middag uppdaterad'")).rows[0].expense_date);
  assert.equal(Number((await verification.query("SELECT COUNT(*) count FROM schema_migrations")).rows[0].count), 2);
  await verification.end();
  await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await admin.end();
});
