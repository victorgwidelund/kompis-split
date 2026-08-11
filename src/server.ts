import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "./migrations.js";
import { closeDatabase, databaseReady, db } from "./database.js";
import { calculateShares, simplifyDebts } from "./split.js";

const scrypt = promisify(scryptCallback);
function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
const here = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(here, "..", "public");
const port = Number(process.env.PORT || 8787);
const appPassword = process.env.APP_PASSWORD || "";
const cookieSecure = process.env.COOKIE_SECURE === "true";
const cookieSecret = process.env.COOKIE_SECRET || createHash("sha256").update(appPassword || "local-development-only").digest("hex");
const trustProxy = process.env.TRUST_PROXY === "true";
const sessionDays = integerEnvironment("SESSION_DAYS", 30, 1, 365);
const appVersion = String(process.env.APP_VERSION || "dev").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "dev";
if (process.env.NODE_ENV === "production" && cookieSecret.length < 32) throw new Error("COOKIE_SECRET måste vara minst 32 tecken i produktion");
await applyMigrations();

function cleanText(value: unknown, field: string, maximum = 100) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} krävs`);
  if (text.length > maximum) throw new Error(`${field} är för långt`);
  return text;
}

function cleanEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) throw new Error("Ange en giltig e-postadress");
  return email;
}

function parseAmount(value: unknown) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw new Error("Ange ett giltigt belopp");
  return Math.round(amount * 100);
}

function validDate(value: unknown, fallback: string | null = null) {
  if (!value) return fallback;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("Ange ett giltigt datum");
  return text;
}

function normalizePhone(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (digits.startsWith("0")) digits = `+46${digits.slice(1)}`;
  const compact = digits.replace(/\D/g, "");
  if (compact.length < 8 || compact.length > 15) throw new Error("Ange ett giltigt Swish-nummer");
  return digits;
}

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function sessionId(token: string) { return createHmac("sha256", cookieSecret).update(token).digest("hex"); }

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function safeEqualStrings(first: unknown, second: unknown) {
  const left = Buffer.from(String(first));
  const right = Buffer.from(String(second));
  return left.length === right.length && timingSafeEqual(left, right);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...(cookieSecure ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

async function passwordRecord(password: unknown) {
  if (String(password).length < 10) throw new Error("Lösenordet måste vara minst 10 tecken");
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(String(password), salt, 64) as Buffer;
  return { salt, hash: hash.toString("hex") };
}

async function passwordMatches(password: unknown, user: any) {
  const calculated = await scrypt(String(password), user.password_salt, 64) as Buffer;
  const stored = Buffer.from(user.password_hash, "hex");
  return calculated.length === stored.length && timingSafeEqual(calculated, stored);
}

async function audit(actorUserId: number | null, tripId: number | null, action: string, entityType: string, entityId: number | null = null, payload: unknown = null) {
  await db.prepare("INSERT INTO audit_log (actor_user_id, trip_id, action, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)")
    .run(actorUserId || null, tripId || null, action, entityType, entityId, payload ? JSON.stringify(payload) : null);
}

function json(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Förfrågan är för stor");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new Error("Ogiltig JSON"); }
}

function cookieValue(request: IncomingMessage, name: string) {
  const pair = String(request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}

function sessionCookie(token: string) {
  return `kompis_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDays * 86400}${cookieSecure ? "; Secure" : ""}`;
}

function clearSessionCookie() {
  return `kompis_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure ? "; Secure" : ""}`;
}

async function createSession(userId: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDays * 86400000).toISOString();
  await db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(sessionId(token), userId, expiresAt);
  return token;
}

async function sessionUser(request: IncomingMessage) {
  const token = cookieValue(request, "kompis_session");
  if (!token) return null;
  return await db.prepare(`
    SELECT u.id, u.email, u.display_name, u.swish_phone, u.is_admin, u.is_disabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.is_disabled = FALSE
  `).get(sessionId(token)) || null;
}

function publicUser(user: any) {
  return { id: user.id, email: user.email, name: user.display_name, swishPhone: user.swish_phone, isAdmin: Boolean(user.is_admin) };
}

function requireAdmin(user: any) {
  if (!user?.is_admin) throw new HttpError(403, "Endast appadministratörer har tillgång till detta");
}

async function requireAccess(tripId: number, userId: number, roles: string[] | null = null) {
  const globalAdmin = await db.prepare("SELECT is_admin FROM users WHERE id = ? AND is_disabled = FALSE").get<any>(userId);
  if (globalAdmin?.is_admin) return "admin";
  const access = await db.prepare("SELECT role FROM trip_access WHERE trip_id = ? AND user_id = ?").get<any>(tripId, userId);
  if (!access) throw new HttpError(403, "Du har inte tillgång till den här resan");
  if (roles && !roles.includes(access.role)) throw new HttpError(403, "Du saknar behörighet för detta");
  return access.role;
}

async function requireActiveTrip(tripId: number) {
  const trip = await db.prepare("SELECT * FROM trips WHERE id = ?").get<any>(tripId);
  if (!trip) throw new HttpError(404, "Resan finns inte");
  if (trip.archived_at) throw new HttpError(409, "Återställ resan innan du gör ändringar");
}

async function requireRecordWriteAccess(tripId: number, userId: number, createdBy: number) {
  const role = await requireAccess(tripId, userId);
  if (!['owner', 'admin'].includes(role) && Number(createdBy) !== Number(userId)) {
    throw new HttpError(403, "Du kan bara ändra poster som du själv har lagt till");
  }
}

async function assertTripParticipant(tripId: number, participantId: number) {
  const person = await db.prepare("SELECT id FROM participants WHERE id = ? AND trip_id = ?").get(participantId, tripId);
  if (!person) throw new Error("En vald deltagare tillhör inte resan");
}

async function loadTrip(id: number, userId: number) {
  const trip = await db.prepare("SELECT * FROM trips WHERE id = ?").get<any>(id);
  if (!trip) return null;
  const role = await requireAccess(id, userId);
  const participantRows = await db.prepare("SELECT * FROM participants WHERE trip_id = ? ORDER BY id").all<any>(id);
  const participants = participantRows.map((person) => ({
    id: person.id, name: person.name, swishPhone: person.swish_phone, userId: person.user_id,
  }));
  const expenseRows = await db.prepare("SELECT * FROM expenses WHERE trip_id = ? AND voided_at IS NULL ORDER BY expense_date DESC NULLS LAST, id DESC").all<any>(id);
  const expenses = await Promise.all(expenseRows.map(async (expense) => ({
    id: expense.id, payerId: expense.payer_id, title: expense.title, amountCents: expense.amount_cents,
    expenseDate: expense.expense_date, category: expense.category, splitMode: expense.split_mode,
    createdBy: expense.created_by,
    shares: (await db.prepare("SELECT participant_id, amount_cents FROM expense_shares WHERE expense_id = ? ORDER BY participant_id").all<any>(expense.id)).map((share) => ({ participantId: share.participant_id, amountCents: share.amount_cents })),
  })));
  const paymentRows = await db.prepare("SELECT * FROM payments WHERE trip_id = ? AND voided_at IS NULL ORDER BY paid_at DESC, id DESC").all<any>(id);
  const payments = paymentRows.map((payment) => ({
    id: payment.id, fromId: payment.from_id, toId: payment.to_id, amountCents: payment.amount_cents,
    note: payment.note, paidAt: payment.paid_at, createdBy: payment.created_by,
  }));
  const totals = simplifyDebts(participants, expenses, payments);
  return {
    id: trip.id, name: trip.name, startDate: trip.start_date, endDate: trip.end_date,
    createdAt: trip.created_at, archivedAt: trip.archived_at, role, participants, expenses, payments,
    balances: totals.balances, settlements: totals.settlements,
    totalCents: expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
  };
}

async function dashboard(userId: number) {
  const rows = await db.prepare(`
    SELECT t.*, ta.role,
      (SELECT COUNT(*) FROM participants p WHERE p.trip_id = t.id) participant_count,
      (SELECT COALESCE(SUM(e.amount_cents), 0) FROM expenses e WHERE e.trip_id = t.id AND e.voided_at IS NULL) total_cents
    FROM trip_access ta JOIN trips t ON t.id = ta.trip_id
    WHERE ta.user_id = ? ORDER BY (t.archived_at IS NOT NULL), COALESCE(t.start_date, t.created_at::date) DESC, t.id DESC
  `).all<any>(userId);
  const trips = await Promise.all(rows.map(async (row) => {
    const full = await loadTrip(row.id, userId);
    if (!full) throw new Error("Resan försvann under laddningen");
    const linked = full.participants.find((person) => person.userId === userId);
    return {
      id: row.id, name: row.name, startDate: row.start_date, endDate: row.end_date, archivedAt: row.archived_at,
      role: row.role, participantCount: row.participant_count, totalCents: row.total_cents,
      myBalanceCents: linked ? Number(full.balances[linked.id] || 0) : 0,
      settlementCount: full.settlements.length,
    };
  }));
  const recentExpenses = (await db.prepare(`
    SELECT e.id, e.title, e.amount_cents, e.expense_date, e.category, e.trip_id, t.name trip_name, p.name payer_name
    FROM expenses e
    JOIN trips t ON t.id = e.trip_id
    JOIN trip_access ta ON ta.trip_id = t.id AND ta.user_id = ?
    JOIN participants p ON p.id = e.payer_id
    WHERE e.voided_at IS NULL AND t.archived_at IS NULL
    ORDER BY e.expense_date DESC NULLS LAST, e.id DESC LIMIT 12
  `).all<any>(userId)).map((item) => ({
    id: item.id, tripId: item.trip_id, tripName: item.trip_name, title: item.title,
    amountCents: item.amount_cents, expenseDate: item.expense_date, category: item.category, payerName: item.payer_name,
  }));
  const contacts = (await db.prepare(`
    SELECT u.id, u.email, u.display_name, u.swish_phone, u.is_admin
    FROM contacts c JOIN users u ON u.id = c.contact_user_id
    WHERE c.owner_user_id = ? AND u.is_disabled = FALSE
    ORDER BY lower(u.display_name)
  `).all<any>(userId)).map(publicUser);
  return { trips, recentExpenses, contacts };
}

async function adminOverview() {
  const stats = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) user_count,
      (SELECT COUNT(*) FROM users WHERE is_disabled = FALSE) active_user_count,
      (SELECT COUNT(*) FROM trips WHERE archived_at IS NULL) active_trip_count,
      (SELECT COUNT(*) FROM trips) trip_count,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM expenses WHERE voided_at IS NULL) total_cents
  `).get<any>();
  const users = (await db.prepare(`
    SELECT u.id, u.email, u.display_name, u.swish_phone, u.is_admin, u.is_disabled, u.created_at,
      (SELECT COUNT(*) FROM trip_access ta WHERE ta.user_id = u.id) trip_count,
      (SELECT COUNT(*) FROM trips t WHERE t.created_by = u.id) created_trip_count
    FROM users u ORDER BY u.is_admin DESC, u.is_disabled, lower(u.display_name), u.id
  `).all<any>()).map((item) => ({
    ...publicUser(item), isDisabled: Boolean(item.is_disabled), createdAt: item.created_at,
    tripCount: Number(item.trip_count), createdTripCount: Number(item.created_trip_count),
  }));
  const trips = (await db.prepare(`
    SELECT t.*, u.display_name owner_name,
      (SELECT COUNT(*) FROM trip_access ta WHERE ta.trip_id = t.id) member_count,
      (SELECT COUNT(*) FROM expenses e WHERE e.trip_id = t.id AND e.voided_at IS NULL) expense_count,
      (SELECT COALESCE(SUM(e.amount_cents), 0) FROM expenses e WHERE e.trip_id = t.id AND e.voided_at IS NULL) total_cents
    FROM trips t LEFT JOIN users u ON u.id = t.created_by
    ORDER BY (t.archived_at IS NOT NULL), t.created_at DESC, t.id DESC
  `).all<any>()).map((item) => ({
    id: item.id, name: item.name, startDate: item.start_date, endDate: item.end_date,
    archivedAt: item.archived_at, createdAt: item.created_at, ownerName: item.owner_name,
    memberCount: Number(item.member_count), expenseCount: Number(item.expense_count), totalCents: Number(item.total_cents),
  }));
  const activity = (await db.prepare(`
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at,
      u.display_name actor_name, t.name trip_name
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_user_id
    LEFT JOIN trips t ON t.id = a.trip_id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 30
  `).all<any>()).map((item) => ({
    id: item.id, action: item.action, entityType: item.entity_type, entityId: item.entity_id,
    createdAt: item.created_at, actorName: item.actor_name, tripName: item.trip_name,
  }));
  return {
    stats: {
      userCount: Number(stats.user_count), activeUserCount: Number(stats.active_user_count),
      activeTripCount: Number(stats.active_trip_count), tripCount: Number(stats.trip_count), totalCents: Number(stats.total_cents),
    }, users, trips, activity,
  };
}

async function invitationByToken(token: string) {
  if (!token) return null;
  return await db.prepare(`
    SELECT i.*, t.name trip_name, u.display_name inviter_name
    FROM invitations i JOIN trips t ON t.id = i.trip_id JOIN users u ON u.id = i.invited_by
    WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP AND i.use_count < i.max_uses
  `).get<any>(sha256(token)) || null;
}

async function joinInvitationRecords(invitation: any, userId: number) {
  if (await db.prepare("SELECT role FROM trip_access WHERE trip_id = ? AND user_id = ?").get(invitation.trip_id, userId)) return false;
  const changed = await db.prepare("UPDATE invitations SET use_count = use_count + 1 WHERE id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND use_count < max_uses").run(invitation.id);
  if (!changed.changes) throw new HttpError(409, "Inbjudan har redan använts fullt ut eller gått ut");
  await db.prepare("INSERT INTO trip_access (trip_id, user_id, role) VALUES (?, ?, 'member')").run(invitation.trip_id, userId);
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get<any>(userId);
  await db.prepare("INSERT INTO participants (trip_id, name, swish_phone, user_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(invitation.trip_id, user.display_name, user.swish_phone, userId);
  await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(invitation.invited_by, userId);
  await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(userId, invitation.invited_by);
  await audit(userId, invitation.trip_id, "invitation.joined", "invitation", invitation.id);
  return true;
}

async function joinInvitation(invitation: any, userId: number) {
  return db.transaction(() => joinInvitationRecords(invitation, userId));
}

const attempts = new Map<string, { count: number; resetAt: number }>();
function loginAllowed(ip: string) {
  const now = Date.now();
  const item = attempts.get(ip);
  if (!item || item.resetAt < now) { attempts.set(ip, { count: 0, resetAt: now + 15 * 60000 }); return true; }
  return item.count < 8;
}
function failedLogin(ip: string) { const item = attempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60000 }; item.count += 1; attempts.set(ip, item); }

function clientIp(request: IncomingMessage) {
  if (trustProxy) {
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress || "unknown";
}

function verifyOrigin(request: IncomingMessage) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method || "GET")) return;
  if (request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Ogiltigt ursprung");
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    const forwardedHost = trustProxy ? String(request.headers["x-forwarded-host"] || "").split(",")[0]?.trim() : "";
    if (new URL(origin).host !== (forwardedHost || request.headers.host)) throw new HttpError(403, "Ogiltigt ursprung");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "Ogiltigt ursprung");
  }
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL) {
  verifyOrigin(request);
  const user = await sessionUser(request);
  const userCount = Number((await db.prepare("SELECT COUNT(*) count FROM users").get<any>())?.count);

  if (request.method === "GET" && url.pathname === "/api/session") {
    return json(response, 200, { authenticated: Boolean(user), needsSetup: userCount === 0, version: appVersion, user: user ? publicUser(user) : null });
  }
  if (request.method === "POST" && url.pathname === "/api/invitations/preview") {
    const body = await readJson(request);
    const invitation = await invitationByToken(String(body.token || ""));
    return invitation ? json(response, 200, { invitation: { tripName: invitation.trip_name, inviterName: invitation.inviter_name, expiresAt: invitation.expires_at } }) : json(response, 404, { error: "Inbjudan är ogiltig eller har gått ut" });
  }
  if (request.method === "POST" && url.pathname === "/api/setup") {
    if (userCount !== 0) return json(response, 409, { error: "Appen är redan konfigurerad" });
    const body = await readJson(request);
    if (!appPassword || !safeEqualStrings(body.setupPassword || "", appPassword)) return json(response, 401, { error: "Fel installationslösenord" });
    const record = await passwordRecord(body.password);
    return db.transaction(async () => {
      await db.exec("SELECT pg_advisory_xact_lock(837451903)");
      if (Number((await db.prepare("SELECT COUNT(*) count FROM users").get<any>())?.count) !== 0) throw new HttpError(409, "Appen är redan konfigurerad");
      const result = await db.prepare("INSERT INTO users (email, display_name, password_hash, password_salt, swish_phone, is_admin) VALUES (?, ?, ?, ?, ?, TRUE) RETURNING id")
        .run(cleanEmail(body.email), cleanText(body.name, "Namn", 60), record.hash, record.salt, normalizePhone(body.swishPhone));
      const userId = Number(result.lastInsertRowid);
      await db.prepare("UPDATE trips SET created_by = ? WHERE created_by IS NULL").run(userId);
      for (const trip of await db.prepare("SELECT id FROM trips").all<any>()) {
        await db.prepare("INSERT INTO trip_access (trip_id, user_id, role) VALUES (?, ?, 'owner') ON CONFLICT DO NOTHING").run(trip.id, userId);
        const matchingParticipant = await db.prepare("SELECT id FROM participants WHERE trip_id = ? AND user_id IS NULL AND lower(name) = lower(?) ORDER BY id LIMIT 1").get<any>(trip.id, cleanText(body.name, "Namn", 60));
        if (matchingParticipant) await db.prepare("UPDATE participants SET user_id = ? WHERE id = ?").run(userId, matchingParticipant.id);
      }
      await audit(userId, null, "account.bootstrap", "user", userId);
      const createdUser = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
      return json(response, 201, { user: publicUser(createdUser) }, { "Set-Cookie": sessionCookie(await createSession(userId)) });
    });
  }
  if (request.method === "POST" && url.pathname === "/api/register") {
    const body = await readJson(request);
    const invitation = await invitationByToken(String(body.inviteToken || ""));
    if (!invitation) return json(response, 404, { error: "Inbjudan är ogiltig eller har gått ut" });
    const record = await passwordRecord(body.password);
    let userId;
    try {
      userId = await db.transaction(async () => {
        const result = await db.prepare("INSERT INTO users (email, display_name, password_hash, password_salt, swish_phone) VALUES (?, ?, ?, ?, ?) RETURNING id")
          .run(cleanEmail(body.email), cleanText(body.name, "Namn", 60), record.hash, record.salt, normalizePhone(body.swishPhone));
        const id = Number(result.lastInsertRowid);
        await joinInvitationRecords(invitation, id);
        return id;
      });
    } catch (error) {
      if ((error as any)?.code === "23505") return json(response, 409, { error: "E-postadressen finns redan. Logga in i stället." });
      throw error;
    }
    return json(response, 201, { user: publicUser(await db.prepare("SELECT * FROM users WHERE id = ?").get(userId)), tripId: invitation.trip_id }, { "Set-Cookie": sessionCookie(await createSession(userId)) });
  }
  if (request.method === "POST" && url.pathname === "/api/login") {
    const ip = clientIp(request);
    if (!loginAllowed(ip)) return json(response, 429, { error: "För många försök. Vänta en stund." });
    const body = await readJson(request);
    const account = await db.prepare("SELECT * FROM users WHERE email = ?").get<any>(cleanEmail(body.email));
    if (!account || account.is_disabled || !(await passwordMatches(body.password, account))) {
      failedLogin(ip); return json(response, 401, { error: "Fel e-postadress eller lösenord" });
    }
    attempts.delete(ip);
    return json(response, 200, { user: publicUser(account) }, { "Set-Cookie": sessionCookie(await createSession(account.id)) });
  }
  if (request.method === "POST" && url.pathname === "/api/logout") {
    const token = cookieValue(request, "kompis_session");
    if (token) await db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId(token));
    return json(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }
  if (!user) return json(response, 401, { error: "Logga in för att fortsätta" });

  let match;
  if (request.method === "GET" && url.pathname === "/api/admin") {
    requireAdmin(user);
    return json(response, 200, await adminOverview());
  }
  match = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (request.method === "PATCH" && match) {
    requireAdmin(user);
    const targetId = Number(match[1]);
    const target = await db.prepare("SELECT * FROM users WHERE id = ?").get<any>(targetId);
    if (!target) return json(response, 404, { error: "Användaren finns inte" });
    const body = await readJson(request);
    if (targetId === Number(user.id) && (body.isAdmin === false || body.isDisabled === true)) {
      throw new HttpError(409, "Du kan inte ta bort din egen adminåtkomst eller inaktivera ditt eget konto");
    }
    const isAdmin = typeof body.isAdmin === "boolean" ? body.isAdmin : Boolean(target.is_admin);
    const isDisabled = typeof body.isDisabled === "boolean" ? body.isDisabled : Boolean(target.is_disabled);
    await db.transaction(async () => {
      await db.prepare("UPDATE users SET is_admin = ?, is_disabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(isAdmin, isDisabled, targetId);
      if (isDisabled) await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(targetId);
      await audit(user.id, null, "admin.user.updated", "user", targetId, { isAdmin, isDisabled });
    });
    return json(response, 200, { user: publicUser(await db.prepare("SELECT * FROM users WHERE id = ?").get(targetId)) });
  }
  if (request.method === "POST" && url.pathname === "/api/invitations/join") {
    const body = await readJson(request);
    const invitation = await invitationByToken(String(body.token || ""));
    if (!invitation) return json(response, 404, { error: "Inbjudan är ogiltig eller har gått ut" });
    await joinInvitation(invitation, user.id);
    return json(response, 200, { tripId: invitation.trip_id });
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") return json(response, 200, await dashboard(user.id));
  if (request.method === "GET" && url.pathname === "/api/contacts") {
    const contacts = (await db.prepare(`SELECT u.id, u.email, u.display_name, u.swish_phone FROM contacts c JOIN users u ON u.id = c.contact_user_id WHERE c.owner_user_id = ? ORDER BY lower(u.display_name)`).all<any>(user.id)).map(publicUser);
    return json(response, 200, { contacts });
  }
  if (request.method === "GET" && url.pathname === "/api/users/search") {
    const query = String(url.searchParams.get("q") || "").trim();
    if (query.length < 2) return json(response, 200, { users: [] });
    const users = (await db.prepare(`
      SELECT u.id, u.email, u.display_name, u.swish_phone,
        EXISTS(SELECT 1 FROM contacts c WHERE c.owner_user_id = ? AND c.contact_user_id = u.id) is_contact
      FROM users u WHERE u.id != ? AND (u.display_name ILIKE ? ESCAPE '\\' OR u.email ILIKE ? ESCAPE '\\')
      ORDER BY is_contact DESC, lower(u.display_name) LIMIT 12
    `).all<any>(user.id, user.id, `%${query.replace(/[\\%_]/g, "\\$&")}%`, `%${query.replace(/[\\%_]/g, "\\$&")}%`)).map((item) => ({ ...publicUser(item), isContact: Boolean(item.is_contact) }));
    return json(response, 200, { users });
  }
  if (request.method === "POST" && url.pathname === "/api/contacts") {
    const body = await readJson(request);
    const contactId = Number(body.userId);
    if (!await db.prepare("SELECT id FROM users WHERE id = ?").get(contactId) || contactId === user.id) throw new Error("Ogiltig kontakt");
    await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(user.id, contactId);
    return json(response, 201, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/trips") {
    const body = await readJson(request);
    return db.transaction(async () => {
      const result = await db.prepare("INSERT INTO trips (name, start_date, end_date, created_by) VALUES (?, ?, ?, ?) RETURNING id")
        .run(cleanText(body.name, "Resans namn", 80), validDate(body.startDate), validDate(body.endDate), user.id);
      const tripId = Number(result.lastInsertRowid);
      await db.prepare("INSERT INTO trip_access (trip_id, user_id, role) VALUES (?, ?, 'owner')").run(tripId, user.id);
      await db.prepare("INSERT INTO participants (trip_id, name, swish_phone, user_id) VALUES (?, ?, ?, ?)").run(tripId, user.display_name, user.swish_phone, user.id);
      await audit(user.id, tripId, "trip.created", "trip", tripId);
      return json(response, 201, { trip: await loadTrip(tripId, user.id) });
    });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)$/);
  if (request.method === "GET" && match) {
    const trip = await loadTrip(Number(match[1]), user.id);
    return trip ? json(response, 200, { trip }) : json(response, 404, { error: "Resan finns inte" });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/archive$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]); await requireAccess(tripId, user.id, ["owner", "admin"]);
    const body = await readJson(request);
    await db.prepare("UPDATE trips SET archived_at = ? WHERE id = ?").run(body.archived === false ? null : new Date().toISOString(), tripId);
    await audit(user.id, tripId, body.archived === false ? "trip.restored" : "trip.archived", "trip", tripId);
    return json(response, 200, { trip: await loadTrip(tripId, user.id) });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/invitations$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]); await requireAccess(tripId, user.id, ["owner", "admin"]); await requireActiveTrip(tripId);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    const result = await db.prepare("INSERT INTO invitations (trip_id, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?) RETURNING id").run(tripId, sha256(token), user.id, expiresAt);
    await audit(user.id, tripId, "invitation.created", "invitation", Number(result.lastInsertRowid));
    return json(response, 201, { invitation: { token, path: `/#invite=${token}`, expiresAt } });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/participants$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]); await requireAccess(tripId, user.id, ["owner", "admin"]); await requireActiveTrip(tripId);
    const body = await readJson(request);
    if (body.userId) {
      const account = await db.prepare("SELECT * FROM users WHERE id = ?").get<any>(Number(body.userId));
      if (!account) throw new Error("Användaren finns inte");
      await db.prepare("INSERT INTO trip_access (trip_id, user_id, role) VALUES (?, ?, 'member') ON CONFLICT DO NOTHING").run(tripId, account.id);
      await db.prepare("INSERT INTO participants (trip_id, name, swish_phone, user_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").run(tripId, account.display_name, account.swish_phone, account.id);
      await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(user.id, account.id);
    } else {
      await db.prepare("INSERT INTO participants (trip_id, name, swish_phone) VALUES (?, ?, ?)").run(tripId, cleanText(body.name, "Namn", 60), normalizePhone(body.swishPhone));
    }
    await audit(user.id, tripId, "participant.added", "participant", null);
    return json(response, 201, { trip: await loadTrip(tripId, user.id) });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/expenses$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]); await requireAccess(tripId, user.id); await requireActiveTrip(tripId);
    const body = await readJson(request); const payerId = Number(body.payerId); await assertTripParticipant(tripId, payerId);
    const amountCents = parseAmount(body.amount);
    const entries: Array<{ participantId: number; value: unknown }> = Array.isArray(body.entries) ? body.entries.map((entry: any) => ({ participantId: Number(entry.participantId), value: entry.value })) : [];
    await Promise.all(entries.map((entry: any) => assertTripParticipant(tripId, entry.participantId)));
    if (new Set(entries.map((entry: { participantId: number }) => entry.participantId)).size !== entries.length) throw new Error("Varje deltagare får bara finnas en gång");
    const amounts = calculateShares(amountCents, String(body.splitMode || "equal"), entries);
    await db.transaction(async () => {
      const result = await db.prepare("INSERT INTO expenses (trip_id, payer_id, title, amount_cents, expense_date, category, split_mode, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .run(tripId, payerId, cleanText(body.title, "Beskrivning", 100), amountCents, validDate(body.expenseDate), cleanText(body.category || "other", "Kategori", 30), String(body.splitMode || "equal"), user.id);
      const expenseId = Number(result.lastInsertRowid); const insertShare = db.prepare("INSERT INTO expense_shares (expense_id, participant_id, amount_cents) VALUES (?, ?, ?)");
      for (const [index, entry] of entries.entries()) await insertShare.run(expenseId, entry.participantId, amounts[index]);
      await audit(user.id, tripId, "expense.created", "expense", expenseId, { amountCents });
    });
    return json(response, 201, { trip: await loadTrip(tripId, user.id) });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/payments$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]); await requireAccess(tripId, user.id); await requireActiveTrip(tripId); const body = await readJson(request);
    const fromId = Number(body.fromId); const toId = Number(body.toId); await assertTripParticipant(tripId, fromId); await assertTripParticipant(tripId, toId);
    if (fromId === toId) throw new Error("Betalare och mottagare måste vara olika");
    const amountCents = parseAmount(body.amount);
    const result = await db.prepare("INSERT INTO payments (trip_id, from_id, to_id, amount_cents, note, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .run(tripId, fromId, toId, amountCents, body.note ? cleanText(body.note, "Anteckning", 120) : null, user.id);
    await audit(user.id, tripId, "payment.created", "payment", Number(result.lastInsertRowid), { amountCents });
    return json(response, 201, { trip: await loadTrip(tripId, user.id) });
  }
  match = url.pathname.match(/^\/api\/expenses\/(\d+)$/);
  if (request.method === "PATCH" && match) {
    const expense = await db.prepare("SELECT * FROM expenses WHERE id = ? AND voided_at IS NULL").get<any>(Number(match[1]));
    if (!expense) return json(response, 404, { error: "Utgiften finns inte" });
    await requireRecordWriteAccess(expense.trip_id, user.id, expense.created_by);
    await requireActiveTrip(expense.trip_id);
    const body = await readJson(request);
    const payerId = Number(body.payerId);
    await assertTripParticipant(expense.trip_id, payerId);
    const amountCents = parseAmount(body.amount);
    const entries: Array<{ participantId: number; value: unknown }> = Array.isArray(body.entries)
      ? body.entries.map((entry: any) => ({ participantId: Number(entry.participantId), value: entry.value }))
      : [];
    await Promise.all(entries.map((entry) => assertTripParticipant(expense.trip_id, entry.participantId)));
    if (new Set(entries.map((entry) => entry.participantId)).size !== entries.length) throw new Error("Varje deltagare får bara finnas en gång");
    const splitMode = String(body.splitMode || "equal");
    const amounts = calculateShares(amountCents, splitMode, entries);
    const title = cleanText(body.title, "Beskrivning", 100);
    const expenseDate = validDate(body.expenseDate);
    const category = cleanText(body.category || "other", "Kategori", 30);
    const previousShares = await db.prepare("SELECT participant_id, amount_cents FROM expense_shares WHERE expense_id = ? ORDER BY participant_id").all<any>(expense.id);
    await db.transaction(async () => {
      await db.prepare(`
        UPDATE expenses SET payer_id = ?, title = ?, amount_cents = ?, expense_date = ?, category = ?, split_mode = ?
        WHERE id = ? AND voided_at IS NULL
      `).run(payerId, title, amountCents, expenseDate, category, splitMode, expense.id);
      await db.prepare("DELETE FROM expense_shares WHERE expense_id = ?").run(expense.id);
      const insertShare = db.prepare("INSERT INTO expense_shares (expense_id, participant_id, amount_cents) VALUES (?, ?, ?)");
      for (const [index, entry] of entries.entries()) await insertShare.run(expense.id, entry.participantId, amounts[index]);
      await audit(user.id, expense.trip_id, "expense.updated", "expense", expense.id, {
        previous: {
          payerId: expense.payer_id, title: expense.title, amountCents: expense.amount_cents,
          expenseDate: expense.expense_date, category: expense.category, splitMode: expense.split_mode,
          shares: previousShares.map((share) => ({ participantId: share.participant_id, amountCents: share.amount_cents })),
        },
        current: { payerId, title, amountCents, expenseDate, category, splitMode, shares: entries.map((entry, index) => ({ participantId: entry.participantId, amountCents: amounts[index] })) },
      });
    });
    return json(response, 200, { trip: await loadTrip(expense.trip_id, user.id) });
  }
  if (request.method === "DELETE" && match) {
    const expense = await db.prepare("SELECT * FROM expenses WHERE id = ? AND voided_at IS NULL").get<any>(Number(match[1]));
    if (!expense) return json(response, 404, { error: "Utgiften finns inte" }); await requireRecordWriteAccess(expense.trip_id, user.id, expense.created_by);
    await db.prepare("UPDATE expenses SET voided_at = CURRENT_TIMESTAMP, voided_by = ? WHERE id = ?").run(user.id, expense.id);
    await audit(user.id, expense.trip_id, "expense.voided", "expense", expense.id, { amountCents: expense.amount_cents }); return json(response, 200, { ok: true });
  }
  match = url.pathname.match(/^\/api\/payments\/(\d+)$/);
  if (request.method === "DELETE" && match) {
    const payment = await db.prepare("SELECT * FROM payments WHERE id = ? AND voided_at IS NULL").get<any>(Number(match[1]));
    if (!payment) return json(response, 404, { error: "Betalningen finns inte" }); await requireRecordWriteAccess(payment.trip_id, user.id, payment.created_by);
    await db.prepare("UPDATE payments SET voided_at = CURRENT_TIMESTAMP, voided_by = ? WHERE id = ?").run(user.id, payment.id);
    await audit(user.id, payment.trip_id, "payment.voided", "payment", payment.id, { amountCents: payment.amount_cents }); return json(response, 200, { ok: true });
  }
  return json(response, 404, { error: "Sidan finns inte" });
}

const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(response: ServerResponse, pathname: string) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(publicDirectory, safePath);
  try { if (!statSync(filePath).isFile()) filePath = join(publicDirectory, "index.html"); }
  catch { filePath = join(publicDirectory, "index.html"); }
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
  });
  response.end(readFileSync(filePath));
}

await db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/health") {
      if (!await databaseReady()) throw new Error("Databasen är inte tillgänglig");
      return json(response, 200, { ok: true, version: appVersion });
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (!["GET", "HEAD"].includes(request.method || "GET")) return json(response, 405, { error: "Metoden stöds inte" });
    return serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    const databaseError = Boolean(error && typeof error === "object" && "code" in error && /^\d{5}$/.test(String((error as any).code)));
    const status = error instanceof HttpError ? error.status : databaseError ? 500 : 400;
    const message = databaseError ? "Databasåtgärden misslyckades" : error instanceof Error ? error.message : "Något gick fel";
    return json(response, status, { error: message });
  }
});
server.listen(port, "0.0.0.0", () => {
  console.log(`Kompis Split körs på http://0.0.0.0:${port}`);
  if (!appPassword) console.warn("APP_PASSWORD saknas. Den första administratören kan inte skapas förrän det är konfigurerat.");
});
function shutdown() { server.close(() => { void closeDatabase().finally(() => process.exit(0)); }); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
