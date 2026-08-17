import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { applyMigrations } from "./migrations.js";
import { closeDatabase, databaseReady, db } from "./database.js";
import { EmailError, emailSettingsStatus, saveEmailSettings, sendMail } from "./email.js";
import { closeReceiptOcr, maxReceiptInputPixels, normalizeReceiptImage, recognizeReceipt } from "./receipt-ocr.js";
import { allocateItemQuantities, calculateShares, simplifyDebts } from "./split.js";

const scrypt = promisify(scryptCallback);
function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
const here = dirname(fileURLToPath(import.meta.url));
const builtFrontendDirectory = join(here, "..", "frontend", "dist");
const publicDirectory = existsSync(builtFrontendDirectory) ? builtFrontendDirectory : join(here, "..", "public");
const port = Number(process.env.PORT || 8787);
const appPassword = process.env.APP_PASSWORD || "";
const cookieSecure = process.env.COOKIE_SECURE === "true";
const cookieSecret = process.env.COOKIE_SECRET || createHash("sha256").update(appPassword || "local-development-only").digest("hex");
const trustProxy = process.env.TRUST_PROXY === "true";
const sessionDays = integerEnvironment("SESSION_DAYS", 30, 1, 365);
const appVersion = String(process.env.APP_VERSION || "dev").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "dev";
// Client-side compression normally shrinks images well below this before they ever reach the
// server; this is the hard backend cap (also covers PDFs, which aren't compressed client-side).
// See DEPLOYMENT.md for the matching Nginx/Cloudflare body-size note.
const receiptMaximumBytes = 20 * 1024 * 1024;
const receiptMaximumCount = 5;
const receiptMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const receiptImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
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
  // Accepts "249.50" or the Swedish "249,50" -- the frontend's amount fields are plain text inputs
  // (not type="number", which silently rejects a comma decimal separator), so this is the actual
  // system boundary where a user-typed amount first becomes a number.
  const amount = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw new Error("Ange ett giltigt belopp");
  return Math.round(amount * 100);
}

function formatSek(cents: number) {
  return `${(cents / 100).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
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

function requestOrigin(request: IncomingMessage) {
  const forwardedHost = trustProxy ? String(request.headers["x-forwarded-host"] || "").split(",")[0]?.trim() : "";
  const forwardedProtocol = trustProxy ? String(request.headers["x-forwarded-proto"] || "").split(",")[0]?.trim().toLowerCase() : "";
  const protocol = forwardedProtocol === "https" ? "https" : forwardedProtocol === "http" ? "http" : cookieSecure ? "https" : "http";
  const host = forwardedHost || String(request.headers.host || "localhost");
  try { return new URL(`${protocol}://${host}`).origin; }
  catch { throw new HttpError(400, "Ogiltig värdadress"); }
}

async function invitationPayload(request: IncomingMessage, token: string, expiresAt: string) {
  const path = `/#invite=${encodeURIComponent(token)}`;
  const link = new URL(path, requestOrigin(request)).href;
  const qrDataUrl = await QRCode.toDataURL(link, { errorCorrectionLevel: "M", margin: 1, width: 320, color: { dark: "#17201cff", light: "#fffdf8ff" } });
  return { token, path, expiresAt, qrDataUrl };
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), geolocation=(), microphone=()",
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

async function readBytes(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new HttpError(413, `Kvittofilen får vara högst ${Math.floor(maximumBytes / 1024 / 1024)} MB`);
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error("Kvittofilen är tom");
  return Buffer.concat(chunks);
}

function receiptContentMatches(mimeType: string, content: Buffer) {
  if (mimeType === "image/png") return content.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mimeType === "image/jpeg") return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (mimeType === "image/webp") return content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP";
  if (mimeType === "application/pdf") return content.subarray(0, 5).toString("ascii") === "%PDF-";
  return false;
}

function jpegDimensions(content: Buffer) {
  let offset = 2;
  while (offset + 9 < content.length) {
    if (content[offset] !== 0xff) { offset += 1; continue; }
    const marker = content[offset + 1];
    if (marker === undefined || marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = content.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > content.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: content.readUInt16BE(offset + 7), height: content.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(content: Buffer) {
  const kind = content.subarray(12, 16).toString("ascii");
  if (kind === "VP8X" && content.length >= 30) return { width: 1 + content.readUIntLE(24, 3), height: 1 + content.readUIntLE(27, 3) };
  if (kind === "VP8 " && content.length >= 30) return { width: content.readUInt16LE(26) & 0x3fff, height: content.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L" && content.length >= 25 && content[20] === 0x2f) {
    const bits = content.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

function safeReceiptImageDimensions(mimeType: string, content: Buffer) {
  const dimensions = mimeType === "image/png" && content.length >= 24
    ? { width: content.readUInt32BE(16), height: content.readUInt32BE(20) }
    : mimeType === "image/jpeg" ? jpegDimensions(content)
      : mimeType === "image/webp" ? webpDimensions(content) : null;
  if (!dimensions || dimensions.width < 20 || dimensions.height < 20) throw new HttpError(415, "Kvittofilens bildmått kunde inte läsas");
  if (dimensions.width > 14_000 || dimensions.height > 14_000 || dimensions.width * dimensions.height > maxReceiptInputPixels) {
    throw new HttpError(413, `Kvittofotot är för stort. Välj en bild på högst ${Math.round(maxReceiptInputPixels / 1_000_000)} megapixlar.`);
  }
}

function safeReceiptName(value: unknown) {
  let decoded = String(value || "kvitto");
  try { decoded = decodeURIComponent(decoded); } catch { /* Behåll rubriken som den är. */ }
  return cleanText(decoded.replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 180), "Filnamn", 180);
}

async function activeCategorySlug(value: unknown) {
  const slug = cleanText(value || "other", "Kategori", 40);
  const category = await db.prepare("SELECT slug FROM expense_categories WHERE slug = ? AND archived_at IS NULL").get<any>(slug);
  if (!category) throw new Error("Välj en aktiv kategori");
  return slug;
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

function quickGuestCookie(quickTabId: number, token: string) {
  return `kompis_quick_guest_${quickTabId}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${14 * 86400}${cookieSecure ? "; Secure" : ""}`;
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
    SELECT u.id, u.email, u.display_name, u.swish_phone, u.is_admin, u.is_disabled, s.demo_mode, s.demo_batch_id
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.is_disabled = FALSE
  `).get(sessionId(token)) || null;
}

// Demo mode is bound to the server-side session record, never a client-supplied flag. It is carried
// through request-scoped AsyncLocalStorage (the same pattern src/database.ts uses for transactions)
// so every data-access function can enforce it without threading a parameter through every call site.
const demoContext = new AsyncLocalStorage<boolean>();
function inDemoMode(): boolean {
  return demoContext.getStore() || false;
}

type QuickTabViewer = { kind: "user" | "guest"; id: number; key: string; role: "owner" | "member" };

async function quickTabViewer(request: IncomingMessage, quickTabId: number, user: any): Promise<QuickTabViewer> {
  if (user) {
    const role = await quickTabAccess(quickTabId, Number(user.id));
    return { kind: "user", id: Number(user.id), key: `u:${user.id}`, role: role === "owner" ? "owner" : "member" };
  }
  const token = cookieValue(request, `kompis_quick_guest_${quickTabId}`);
  if (!token) throw new HttpError(401, "Ange namn och nummer för att öppna snabbnotan");
  const guest = await db.prepare(`
    SELECT id FROM quick_tab_guests
    WHERE quick_tab_id = ? AND session_id = ? AND expires_at > CURRENT_TIMESTAMP
  `).get<any>(quickTabId, sessionId(token));
  if (!guest) throw new HttpError(401, "Gäståtkomsten har gått ut. Öppna inbjudningslänken igen.");
  await db.prepare("UPDATE quick_tab_guests SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(guest.id);
  return { kind: "guest", id: Number(guest.id), key: `g:${guest.id}`, role: "member" };
}

function publicUser(user: any) {
  return { id: user.id, email: user.email, name: user.display_name, swishPhone: user.swish_phone, isAdmin: Boolean(user.is_admin) };
}

function requireAdmin(user: any) {
  if (!user?.is_admin) throw new HttpError(403, "Endast appadministratörer har tillgång till detta");
}

async function requireAccess(tripId: number, userId: number, roles: string[] | null = null) {
  // A demo session must never reach a real trip, and a normal session must never reach a demo trip —
  // checked before the global-admin bypass below, which would otherwise ignore the boundary entirely.
  const trip = await db.prepare("SELECT is_demo FROM trips WHERE id = ?").get<any>(tripId);
  if (!trip || Boolean(trip.is_demo) !== inDemoMode()) throw new HttpError(403, "Du har inte tillgång till den här gruppen");
  const globalAdmin = await db.prepare("SELECT is_admin FROM users WHERE id = ? AND is_disabled = FALSE").get<any>(userId);
  if (globalAdmin?.is_admin) return "admin";
  const access = await db.prepare("SELECT role FROM trip_access WHERE trip_id = ? AND user_id = ?").get<any>(tripId, userId);
  if (!access) throw new HttpError(403, "Du har inte tillgång till den här gruppen");
  if (roles && !roles.includes(access.role)) throw new HttpError(403, "Du saknar behörighet för detta");
  return access.role;
}

async function requireActiveTrip(tripId: number) {
  const trip = await db.prepare("SELECT * FROM trips WHERE id = ?").get<any>(tripId);
  if (!trip) throw new HttpError(404, "Gruppen finns inte");
  if (trip.deleted_at) throw new HttpError(404, "Gruppen finns inte");
  if (trip.archived_at) throw new HttpError(409, "Återställ gruppen innan du gör ändringar");
}

async function requireRecordWriteAccess(tripId: number, userId: number, createdBy: number) {
  const role = await requireAccess(tripId, userId);
  if (!['owner', 'admin'].includes(role) && Number(createdBy) !== Number(userId)) {
    throw new HttpError(403, "Du kan bara ändra poster som du själv har lagt till");
  }
}

async function assertTripParticipant(tripId: number, participantId: number) {
  const person = await db.prepare("SELECT id FROM participants WHERE id = ? AND trip_id = ?").get(participantId, tripId);
  if (!person) throw new Error("En vald deltagare tillhör inte gruppen");
}

async function loadTrip(id: number, userId: number) {
  const trip = await db.prepare("SELECT * FROM trips WHERE id = ?").get<any>(id);
  if (!trip || trip.deleted_at || Boolean(trip.is_demo) !== inDemoMode()) return null;
  const role = await requireAccess(id, userId);
  const participantRows = await db.prepare("SELECT * FROM participants WHERE trip_id = ? ORDER BY id").all<any>(id);
  const participants = participantRows.map((person) => ({
    id: person.id, name: person.name, swishPhone: person.swish_phone, userId: person.user_id,
  }));
  const expenseRows = await db.prepare("SELECT * FROM expenses WHERE trip_id = ? AND voided_at IS NULL ORDER BY expense_date DESC NULLS LAST, id DESC").all<any>(id);
  // Fetch shares and receipts for the whole trip in two queries instead of two-per-expense (N+1).
  const shareRows = expenseRows.length
    ? await db.prepare(`SELECT expense_id, participant_id, amount_cents FROM expense_shares WHERE expense_id = ANY(?) ORDER BY expense_id, participant_id`).all<any>(expenseRows.map((expense) => expense.id))
    : [];
  const receiptRows = expenseRows.length
    ? await db.prepare(`SELECT id, expense_id, file_name, mime_type, byte_size, created_by, created_at FROM expense_receipts WHERE expense_id = ANY(?) ORDER BY expense_id, id`).all<any>(expenseRows.map((expense) => expense.id))
    : [];
  const sharesByExpense = new Map<number, any[]>();
  for (const share of shareRows) { const list = sharesByExpense.get(share.expense_id) || []; list.push(share); sharesByExpense.set(share.expense_id, list); }
  const receiptsByExpense = new Map<number, any[]>();
  for (const receipt of receiptRows) { const list = receiptsByExpense.get(receipt.expense_id) || []; list.push(receipt); receiptsByExpense.set(receipt.expense_id, list); }
  const expenses = expenseRows.map((expense) => ({
    id: expense.id, payerId: expense.payer_id, title: expense.title, amountCents: expense.amount_cents,
    expenseDate: expense.expense_date, category: expense.category, splitMode: expense.split_mode,
    createdBy: expense.created_by,
    shares: (sharesByExpense.get(expense.id) || []).map((share) => ({ participantId: share.participant_id, amountCents: share.amount_cents })),
    receipts: (receiptsByExpense.get(expense.id) || []).map((receipt) => ({
      id: receipt.id, fileName: receipt.file_name, mimeType: receipt.mime_type, byteSize: receipt.byte_size,
      createdBy: receipt.created_by, createdAt: receipt.created_at,
    })),
  }));
  const paymentRows = await db.prepare("SELECT * FROM payments WHERE trip_id = ? AND voided_at IS NULL ORDER BY paid_at DESC, id DESC").all<any>(id);
  const payments = paymentRows.map((payment) => ({
    id: payment.id, fromId: payment.from_id, toId: payment.to_id, amountCents: payment.amount_cents,
    note: payment.note, paidAt: payment.paid_at, createdBy: payment.created_by,
  }));
  const totals = simplifyDebts(participants, expenses, payments);
  return {
    id: trip.id, name: trip.name, startDate: trip.start_date, endDate: trip.end_date,
    createdAt: trip.created_at, archivedAt: trip.archived_at, deletedAt: trip.deleted_at, role, participants, expenses, payments,
    balances: totals.balances, settlements: totals.settlements,
    totalCents: expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
  };
}

async function dashboard(userId: number) {
  const demoMode = inDemoMode();
  const rows = await db.prepare(`
    SELECT t.*, ta.role,
      (SELECT COUNT(*) FROM participants p WHERE p.trip_id = t.id) participant_count,
      (SELECT COALESCE(SUM(e.amount_cents), 0) FROM expenses e WHERE e.trip_id = t.id AND e.voided_at IS NULL) total_cents
    FROM trip_access ta JOIN trips t ON t.id = ta.trip_id
    WHERE ta.user_id = ? AND t.deleted_at IS NULL AND t.is_demo = ?
    ORDER BY (t.archived_at IS NOT NULL), COALESCE(t.start_date, t.created_at::date) DESC, t.id DESC
  `).all<any>(userId, demoMode);
  const trips = await Promise.all(rows.map(async (row) => {
    const full = await loadTrip(row.id, userId);
    if (!full) throw new Error("Gruppen försvann under laddningen");
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
    WHERE e.voided_at IS NULL AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.is_demo = ?
    ORDER BY e.expense_date DESC NULLS LAST, e.id DESC LIMIT 12
  `).all<any>(userId, demoMode)).map((item) => ({
    id: item.id, tripId: item.trip_id, tripName: item.trip_name, title: item.title,
    amountCents: item.amount_cents, expenseDate: item.expense_date, category: item.category, payerName: item.payer_name,
  }));
  // Real contacts (names, emails, Swish numbers) must never surface inside the demo context.
  const contacts = demoMode ? [] : (await db.prepare(`
    SELECT u.id, u.email, u.display_name, u.swish_phone, u.is_admin
    FROM contacts c JOIN users u ON u.id = c.contact_user_id
    WHERE c.owner_user_id = ? AND u.is_disabled = FALSE
    ORDER BY lower(u.display_name)
  `).all<any>(userId)).map(publicUser);
  return { trips, recentExpenses, contacts };
}

async function statistics(userId: number) {
  const demoMode = inDemoMode();
  const visibleExpense = `
    FROM expenses e
    JOIN trips t ON t.id = e.trip_id
    JOIN trip_access ta ON ta.trip_id = t.id AND ta.user_id = ?
  `;
  const visibleFilter = "WHERE e.voided_at IS NULL AND t.deleted_at IS NULL AND t.is_demo = ?";
  const summary = await db.prepare(`
    SELECT COUNT(*) expense_count, COUNT(DISTINCT e.trip_id) trip_count,
      COALESCE(SUM(e.amount_cents), 0) total_cents,
      COALESCE(ROUND(AVG(e.amount_cents)), 0) average_cents
    ${visibleExpense} ${visibleFilter}
  `).get<any>(userId, demoMode);
  const categoryRows = await db.prepare(`
    SELECT e.category slug, COALESCE(c.name, e.category) name, COALESCE(c.emoji, '🧾') emoji,
      COUNT(*) expense_count, SUM(e.amount_cents) total_cents
    ${visibleExpense}
    LEFT JOIN expense_categories c ON c.slug = e.category
    ${visibleFilter}
    GROUP BY e.category, c.name, c.emoji
    ORDER BY total_cents DESC, lower(COALESCE(c.name, e.category))
  `).all<any>(userId, demoMode);
  const merchantRows = await db.prepare(`
    SELECT MIN(e.title) name, COUNT(*) expense_count, SUM(e.amount_cents) total_cents
    ${visibleExpense} ${visibleFilter}
    GROUP BY lower(trim(e.title))
    ORDER BY total_cents DESC, lower(MIN(e.title))
    LIMIT 12
  `).all<any>(userId, demoMode);
  const payerRows = await db.prepare(`
    SELECT p.user_id, p.name, COUNT(*) expense_count, SUM(e.amount_cents) total_cents
    ${visibleExpense}
    JOIN participants p ON p.id = e.payer_id
    ${visibleFilter}
    GROUP BY p.user_id, p.name
    ORDER BY total_cents DESC, lower(p.name)
    LIMIT 12
  `).all<any>(userId, demoMode);
  const trendRows = await db.prepare(`
    SELECT month_key, expense_count, total_cents FROM (
      SELECT to_char(date_trunc('month', COALESCE(e.expense_date, e.created_at::date)), 'YYYY-MM') AS month_key,
        COUNT(*) expense_count, SUM(e.amount_cents) total_cents
      ${visibleExpense} ${visibleFilter}
      GROUP BY date_trunc('month', COALESCE(e.expense_date, e.created_at::date))
      ORDER BY date_trunc('month', COALESCE(e.expense_date, e.created_at::date)) DESC
      LIMIT 12
    ) recent_months ORDER BY month_key
  `).all<any>(userId, demoMode);
  const mapTotals = (row: any) => ({
    ...row,
    expenseCount: Number(row.expense_count),
    totalCents: Number(row.total_cents),
    expense_count: undefined,
    total_cents: undefined,
  });
  return {
    summary: {
      expenseCount: Number(summary.expense_count), tripCount: Number(summary.trip_count),
      totalCents: Number(summary.total_cents), averageCents: Number(summary.average_cents),
    },
    categories: categoryRows.map(mapTotals),
    merchants: merchantRows.map(mapTotals),
    payers: payerRows.map((row) => ({ ...mapTotals(row), userId: row.user_id, user_id: undefined })),
    trend: trendRows.map((row) => ({ ...mapTotals(row), month: row.month_key, month_key: undefined })),
  };
}

async function categoryList() {
  return (await db.prepare("SELECT id, slug, name, emoji, is_builtin, created_by, archived_at FROM expense_categories ORDER BY is_builtin DESC, lower(name), id").all<any>()).map((category) => ({
    id: category.id, slug: category.slug, name: category.name, emoji: category.emoji,
    isBuiltin: Boolean(category.is_builtin), createdBy: category.created_by, archivedAt: category.archived_at,
  }));
}

async function adminOverview() {
  const stats = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) user_count,
      (SELECT COUNT(*) FROM users WHERE is_disabled = FALSE) active_user_count,
      (SELECT COUNT(*) FROM trips WHERE archived_at IS NULL AND deleted_at IS NULL) active_trip_count,
      (SELECT COUNT(*) FROM trips WHERE deleted_at IS NULL) trip_count,
      (SELECT COUNT(*) FROM trips WHERE deleted_at IS NOT NULL) deleted_trip_count,
      (SELECT COALESCE(SUM(e.amount_cents), 0) FROM expenses e JOIN trips t ON t.id = e.trip_id WHERE e.voided_at IS NULL AND t.deleted_at IS NULL) total_cents
  `).get<any>();
  const users = (await db.prepare(`
    SELECT u.id, u.email, u.display_name, u.swish_phone, u.is_admin, u.is_disabled, u.created_at,
      (SELECT COUNT(*) FROM trip_access ta JOIN trips t ON t.id = ta.trip_id WHERE ta.user_id = u.id AND t.deleted_at IS NULL) trip_count,
      (SELECT COUNT(*) FROM trips t WHERE t.created_by = u.id AND t.deleted_at IS NULL) created_trip_count
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
    archivedAt: item.archived_at, deletedAt: item.deleted_at, createdAt: item.created_at, ownerName: item.owner_name,
    memberCount: Number(item.member_count), expenseCount: Number(item.expense_count), totalCents: Number(item.total_cents),
  }));
  const quickTabs = (await db.prepare(`
    SELECT q.id, q.name, q.merchant, q.total_cents, q.closed_at, q.created_at, u.display_name owner_name,
      (SELECT COUNT(*) FROM quick_tab_access qa WHERE qa.quick_tab_id = q.id) member_count
    FROM quick_tabs q LEFT JOIN users u ON u.id = q.created_by
    WHERE q.is_demo = FALSE
    ORDER BY q.created_at DESC, q.id DESC
  `).all<any>()).map((item) => ({
    id: item.id, name: item.name, merchant: item.merchant, totalCents: Number(item.total_cents),
    closedAt: item.closed_at, createdAt: item.created_at, ownerName: item.owner_name, memberCount: Number(item.member_count),
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
  const bugReports = (await db.prepare(`
    SELECT b.id, b.description, b.page_url, b.user_agent, b.app_version, b.breadcrumbs,
      b.screenshot_mime_type IS NOT NULL has_screenshot, b.created_at, b.resolved_at,
      u.display_name reporter_name
    FROM bug_reports b JOIN users u ON u.id = b.reported_by
    ORDER BY (b.resolved_at IS NOT NULL), b.created_at DESC
  `).all<any>()).map((item) => ({
    id: Number(item.id), description: item.description, pageUrl: item.page_url, userAgent: item.user_agent,
    appVersion: item.app_version, breadcrumbs: item.breadcrumbs || [], hasScreenshot: Boolean(item.has_screenshot),
    createdAt: item.created_at, resolvedAt: item.resolved_at, reporterName: item.reporter_name,
  }));
  return {
    stats: {
      userCount: Number(stats.user_count), activeUserCount: Number(stats.active_user_count),
      activeTripCount: Number(stats.active_trip_count), tripCount: Number(stats.trip_count), deletedTripCount: Number(stats.deleted_trip_count), totalCents: Number(stats.total_cents),
    }, users, trips, quickTabs, activity, bugReports, emailSettings: await emailSettingsStatus(),
  };
}

async function unpaidRemindersFor(creditorUserId: number) {
  // Aggregates two independent debt concepts into one reminder per debtor who owes money
  // specifically to the calling user: trip settlements (simplifyDebts, the same computation
  // loadTrip uses) where they're the creditor, and unpaid quick-tab shares (loadQuickTab's
  // personTotals) for quick tabs they own. Only registered debtors with a linked account are
  // reminded -- guests and unlinked participants have no email on file to send to. This is a
  // per-user action (any account can remind their own debtors), not an admin broadcast.
  const perUser = new Map<number, { name: string; email: string; items: Array<{ label: string; amountCents: number }> }>();
  const addItem = async (userId: number | null, label: string, amountCents: number) => {
    if (!userId || userId === creditorUserId || amountCents <= 0) return;
    if (!perUser.has(userId)) {
      const account = await db.prepare("SELECT display_name, email FROM users WHERE id = ? AND is_disabled = FALSE").get<any>(userId);
      if (!account) return;
      perUser.set(userId, { name: account.display_name, email: account.email, items: [] });
    }
    perUser.get(userId)!.items.push({ label, amountCents });
  };

  const trips = await db.prepare(`
    SELECT DISTINCT t.id, t.name FROM trips t
    JOIN participants p ON p.trip_id = t.id
    WHERE t.deleted_at IS NULL AND t.is_demo = FALSE AND p.user_id = ?
  `).all<any>(creditorUserId);
  for (const trip of trips) {
    const participantRows = await db.prepare("SELECT id, name, user_id FROM participants WHERE trip_id = ?").all<any>(trip.id);
    const expenseRows = await db.prepare("SELECT id, payer_id, amount_cents FROM expenses WHERE trip_id = ? AND voided_at IS NULL").all<any>(trip.id);
    const shareRows = expenseRows.length
      ? await db.prepare("SELECT expense_id, participant_id, amount_cents FROM expense_shares WHERE expense_id = ANY(?)").all<any>(expenseRows.map((row) => row.id))
      : [];
    const sharesByExpense = new Map<number, any[]>();
    for (const share of shareRows) { const list = sharesByExpense.get(share.expense_id) || []; list.push(share); sharesByExpense.set(share.expense_id, list); }
    const expenses = expenseRows.map((row) => ({
      payerId: row.payer_id, amountCents: row.amount_cents,
      shares: (sharesByExpense.get(row.id) || []).map((share) => ({ participantId: share.participant_id, amountCents: share.amount_cents })),
    }));
    const paymentRows = await db.prepare("SELECT from_id, to_id, amount_cents FROM payments WHERE trip_id = ? AND voided_at IS NULL").all<any>(trip.id);
    const payments = paymentRows.map((row) => ({ fromId: row.from_id, toId: row.to_id, amountCents: row.amount_cents }));
    const { settlements } = simplifyDebts(participantRows.map((row) => ({ id: row.id })), expenses, payments);
    if (!settlements.length) continue;
    const byId = new Map(participantRows.map((row) => [row.id, row]));
    for (const settlement of settlements) {
      const creditor = byId.get(settlement.toId);
      if (Number(creditor?.user_id) !== creditorUserId) continue;
      const debtor = byId.get(settlement.fromId);
      await addItem(debtor?.user_id ? Number(debtor.user_id) : null, `${trip.name} — till dig`, settlement.amountCents);
    }
  }

  const tabs = await db.prepare("SELECT id, name FROM quick_tabs WHERE is_demo = FALSE AND created_by = ?").all<any>(creditorUserId);
  for (const tab of tabs) {
    const loaded = await loadQuickTab(Number(tab.id), { kind: "user", id: creditorUserId, key: `u:${creditorUserId}`, role: "owner" });
    for (const person of loaded.personTotals) {
      if (person.role === "owner" || person.paidAt || person.amountCents <= 0) continue;
      await addItem(person.userId, `Snabbnota: ${tab.name}`, person.amountCents);
    }
  }

  return [...perUser.values()];
}

async function invitationByToken(token: string) {
  if (!token) return null;
  const tripInvitation = await db.prepare(`
    SELECT i.*, t.name trip_name, u.display_name inviter_name
    FROM invitations i JOIN trips t ON t.id = i.trip_id JOIN users u ON u.id = i.invited_by
    WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP AND i.use_count < i.max_uses AND t.deleted_at IS NULL
  `).get<any>(sha256(token));
  if (tripInvitation) return { ...tripInvitation, kind: "trip" as const };
  const friendInvitation = await db.prepare(`
    SELECT i.*, u.display_name inviter_name
    FROM friend_invitations i JOIN users u ON u.id = i.invited_by
    WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP AND i.use_count < 1
  `).get<any>(sha256(token));
  if (friendInvitation) return { ...friendInvitation, trip_id: null, trip_name: null, quick_tab_id: null, kind: "friend" as const };
  const quickTabInvitation = await db.prepare(`
    SELECT i.*, q.name quick_tab_name, u.display_name inviter_name
    FROM quick_tab_invitations i JOIN quick_tabs q ON q.id = i.quick_tab_id JOIN users u ON u.id = i.invited_by
    WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP AND i.use_count < i.max_uses
  `).get<any>(sha256(token));
  return quickTabInvitation ? { ...quickTabInvitation, trip_id: null, trip_name: null, kind: "quick_tab" as const } : null;
}

async function joinInvitationRecords(invitation: any, userId: number) {
  if (invitation.kind === "friend") {
    if (Number(invitation.invited_by) === Number(userId)) throw new HttpError(409, "Du kan inte använda din egen väninbjudan");
    if (await db.prepare("SELECT 1 FROM contacts WHERE owner_user_id = ? AND contact_user_id = ?").get(invitation.invited_by, userId)) return false;
    const changed = await db.prepare("UPDATE friend_invitations SET use_count = use_count + 1 WHERE id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND use_count < 1").run(invitation.id);
    if (!changed.changes) throw new HttpError(409, "Inbjudan har redan använts eller gått ut");
    await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(invitation.invited_by, userId);
    await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(userId, invitation.invited_by);
    await audit(userId, null, "friend_invitation.joined", "friend_invitation", invitation.id);
    return true;
  }
  if (invitation.kind === "quick_tab") {
    if (await db.prepare("SELECT role FROM quick_tab_access WHERE quick_tab_id = ? AND user_id = ?").get(invitation.quick_tab_id, userId)) return false;
    const changed = await db.prepare("UPDATE quick_tab_invitations SET use_count = use_count + 1 WHERE id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND use_count < max_uses").run(invitation.id);
    if (!changed.changes) throw new HttpError(409, "Inbjudan har redan använts fullt ut eller gått ut");
    await db.prepare("INSERT INTO quick_tab_access (quick_tab_id, user_id, role) VALUES (?, ?, 'member')").run(invitation.quick_tab_id, userId);
    await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(invitation.invited_by, userId);
    await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(userId, invitation.invited_by);
    await audit(userId, null, "quick_tab.joined", "quick_tab", invitation.quick_tab_id);
    return true;
  }
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

const quickTabStreams = new Map<number, Set<ServerResponse>>();
function broadcastQuickTab(quickTabId: number) {
  const payload = `event: update\ndata: ${JSON.stringify({ quickTabId, at: Date.now() })}\n\n`;
  for (const stream of quickTabStreams.get(quickTabId) || []) stream.write(payload);
}

async function quickTabAccess(quickTabId: number, userId: number) {
  const tab = await db.prepare("SELECT is_demo FROM quick_tabs WHERE id = ?").get<any>(quickTabId);
  if (!tab || Boolean(tab.is_demo) !== inDemoMode()) throw new HttpError(403, "Du har inte tillgång till snabbnotan");
  const access = await db.prepare("SELECT role FROM quick_tab_access WHERE quick_tab_id = ? AND user_id = ?").get<any>(quickTabId, userId);
  if (!access) throw new HttpError(403, "Du har inte tillgång till snabbnotan");
  return String(access.role) as "owner" | "member";
}

async function setQuickTabClaimQuantity(quickTabId: number, itemId: number, viewer: QuickTabViewer, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 20) throw new HttpError(400, "Antalet måste vara mellan 0 och 20");
  await db.transaction(async () => {
    const item = await db.prepare("SELECT id, quantity FROM quick_tab_items WHERE id = ? AND quick_tab_id = ? FOR UPDATE").get<any>(itemId, quickTabId);
    if (!item) throw new HttpError(404, "Kvittoraden finns inte");
    const identityColumn = viewer.kind === "user" ? "user_id" : "guest_id";
    const claimedByOthers = await db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) total FROM quick_tab_claims
      WHERE item_id = ? AND (${identityColumn} IS NULL OR ${identityColumn} <> ?)
    `).get<any>(itemId, viewer.id);
    if (quantity + Number(claimedByOthers?.total || 0) > Number(item.quantity)) {
      throw new HttpError(409, "Det finns inte så många kvar av den här raden");
    }
    await db.prepare(`DELETE FROM quick_tab_claims WHERE item_id = ? AND ${identityColumn} = ?`).run(itemId, viewer.id);
    if (quantity > 0) await db.prepare(`INSERT INTO quick_tab_claims (item_id, ${identityColumn}, quantity) VALUES (?, ?, ?)`).run(itemId, viewer.id, quantity);
    await db.prepare("UPDATE quick_tabs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(quickTabId);
  });
}

async function loadQuickTab(quickTabId: number, viewer: QuickTabViewer) {
  const tab = await db.prepare("SELECT id, name, merchant, receipt_date, total_cents, receipt_content IS NOT NULL has_receipt, created_by, closed_at, created_at FROM quick_tabs WHERE id = ?").get<any>(quickTabId);
  if (!tab) throw new HttpError(404, "Snabbnotan finns inte");
  const members = (await db.prepare(`
    SELECT CONCAT('u:', u.id) viewer_key, u.id user_id, NULL::BIGINT guest_id, u.display_name name, u.swish_phone, a.role, a.joined_at
    FROM quick_tab_access a JOIN users u ON u.id = a.user_id WHERE a.quick_tab_id = ?
    UNION ALL
    SELECT CONCAT('g:', g.id) viewer_key, NULL::BIGINT user_id, g.id guest_id, g.display_name name, g.swish_phone, 'member' role, g.created_at joined_at
    FROM quick_tab_guests g WHERE g.quick_tab_id = ?
    ORDER BY joined_at, viewer_key
  `).all<any>(quickTabId, quickTabId)).map((member) => ({
    viewerKey: member.viewer_key, userId: member.user_id ? Number(member.user_id) : null,
    guestId: member.guest_id ? Number(member.guest_id) : null, name: member.name, role: member.role,
    swishPhone: viewer.role === "owner" || member.viewer_key === viewer.key || member.role === "owner" ? member.swish_phone : null,
  }));
  const itemRows = await db.prepare("SELECT id, name, amount_cents, quantity, position FROM quick_tab_items WHERE quick_tab_id = ? ORDER BY position, id").all<any>(quickTabId);
  const claimRows = await db.prepare(`
    SELECT c.item_id, c.user_id, c.guest_id, c.quantity, COALESCE(u.display_name, g.display_name) name,
      CASE WHEN c.user_id IS NOT NULL THEN CONCAT('u:', c.user_id) ELSE CONCAT('g:', c.guest_id) END viewer_key
    FROM quick_tab_claims c
    JOIN quick_tab_items i ON i.id = c.item_id
    LEFT JOIN users u ON u.id = c.user_id LEFT JOIN quick_tab_guests g ON g.id = c.guest_id
    WHERE i.quick_tab_id = ? ORDER BY c.item_id, viewer_key
  `).all<any>(quickTabId);
  const claimsByItem = new Map<number, Array<{ viewerKey: string; name: string; quantity: number }>>();
  for (const claim of claimRows) {
    const claims = claimsByItem.get(Number(claim.item_id)) || [];
    claims.push({ viewerKey: claim.viewer_key, name: claim.name, quantity: Number(claim.quantity) });
    claimsByItem.set(Number(claim.item_id), claims);
  }
  const totals = new Map<string, number>();
  const items = itemRows.map((item) => {
    const claims = claimsByItem.get(Number(item.id)) || [];
    const quantity = Number(item.quantity);
    const allocation = allocateItemQuantities(Number(item.amount_cents), quantity, claims.map((claim) => ({ key: claim.viewerKey, quantity: claim.quantity })));
    const claimedQuantity = allocation.claimedQuantity;
    const claimedItemCents = allocation.claimedCents;
    allocation.shares.forEach((share) => totals.set(share.key, (totals.get(share.key) || 0) + share.amountCents));
    return {
      id: Number(item.id), name: item.name, amountCents: Number(item.amount_cents), quantity,
      unitAmountCents: Math.round(Number(item.amount_cents) / quantity), claimedQuantity,
      availableQuantity: quantity - claimedQuantity, claimedCents: claimedItemCents, claims,
    };
  });
  const claimedCents = items.reduce((sum, item) => sum + item.claimedCents, 0);
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const claimedQuantity = items.reduce((sum, item) => sum + item.claimedQuantity, 0);
  const paidRows = await db.prepare(`
    SELECT CASE WHEN user_id IS NOT NULL THEN CONCAT('u:', user_id) ELSE CONCAT('g:', guest_id) END viewer_key, paid_at
    FROM quick_tab_payments WHERE quick_tab_id = ?
  `).all<any>(quickTabId);
  const paidAtByViewer = new Map(paidRows.map((row) => [row.viewer_key, row.paid_at]));
  return {
    id: Number(tab.id), name: tab.name, merchant: tab.merchant, receiptDate: tab.receipt_date,
    totalCents: Number(tab.total_cents), hasReceipt: Boolean(tab.has_receipt), createdBy: Number(tab.created_by),
    closedAt: tab.closed_at, createdAt: tab.created_at, role: viewer.role, currentViewerKey: viewer.key, members, items,
    claimedCents, unclaimedCents: Math.max(0, Number(tab.total_cents) - claimedCents), totalQuantity, claimedQuantity,
    personTotals: members.map((member) => ({ ...member, amountCents: totals.get(member.viewerKey) || 0, paidAt: paidAtByViewer.get(member.viewerKey) || null })),
  };
}

async function quickTabList(userId: number) {
  return (await db.prepare(`
    SELECT q.id, q.name, q.merchant, q.total_cents, q.closed_at, q.created_at, a.role,
      (SELECT COALESCE(SUM(i.quantity), 0) FROM quick_tab_items i WHERE i.quick_tab_id = q.id) item_count,
      (SELECT COALESCE(SUM(c.quantity), 0) FROM quick_tab_claims c JOIN quick_tab_items i ON i.id = c.item_id WHERE i.quick_tab_id = q.id AND c.user_id = ?) my_claim_count
    FROM quick_tab_access a JOIN quick_tabs q ON q.id = a.quick_tab_id
    WHERE a.user_id = ? AND q.is_demo = ? ORDER BY (q.closed_at IS NOT NULL), q.created_at DESC
  `).all<any>(userId, userId, inDemoMode())).map((tab) => ({
    id: Number(tab.id), name: tab.name, merchant: tab.merchant, totalCents: Number(tab.total_cents),
    closedAt: tab.closed_at, createdAt: tab.created_at, role: tab.role,
    itemCount: Number(tab.item_count), myClaimCount: Number(tab.my_claim_count),
  }));
}

// Admin-only demo mode: a fresh, disposable batch of realistic fictional data an admin can explore
// and edit without ever touching real users/trips/expenses/contacts. Demo rows are ordinary
// trips/quick_tabs (is_demo = TRUE, demo_batch_id set) — reusing every existing table, query, and
// React component instead of a parallel demo system. requireAccess/quickTabAccess/dashboard/
// statistics/quickTabList already refuse to cross the is_demo boundary in either direction.
async function seedDemoData(adminUserId: number, batchId: string) {
  await db.transaction(async () => {
    const trip1 = await db.prepare("INSERT INTO trips (name, start_date, end_date, created_by, is_demo, demo_batch_id) VALUES (?, ?, ?, ?, TRUE, ?) RETURNING id")
      .run("Weekend i Göteborg", "2026-09-11", "2026-09-13", adminUserId, batchId);
    const trip1Id = Number(trip1.lastInsertRowid);
    await db.prepare("INSERT INTO trip_access (trip_id, user_id, role) VALUES (?, ?, 'owner')").run(trip1Id, adminUserId);
    const you = Number((await db.prepare("INSERT INTO participants (trip_id, name, user_id) VALUES (?, 'Du (demo)', ?) RETURNING id").run(trip1Id, adminUserId)).lastInsertRowid);
    const guestId: Record<string, number> = {};
    for (const name of ["Anna", "Erik", "Johan", "Sofia"]) {
      guestId[name] = Number((await db.prepare("INSERT INTO participants (trip_id, name) VALUES (?, ?) RETURNING id").run(trip1Id, name)).lastInsertRowid);
    }
    const trip1Participants = [you, guestId.Anna!, guestId.Erik!, guestId.Johan!, guestId.Sofia!];
    const addExpense = async (tripId: number, participants: number[], title: string, amountCents: number, payerId: number, category: string, date: string) => {
      const shares = calculateShares(amountCents, "equal", participants.map(() => ({ value: 1 })));
      const expenseId = Number((await db.prepare("INSERT INTO expenses (trip_id, payer_id, title, amount_cents, expense_date, category, split_mode, created_by) VALUES (?, ?, ?, ?, ?, ?, 'equal', ?) RETURNING id")
        .run(tripId, payerId, title, amountCents, date, category, adminUserId)).lastInsertRowid);
      const insertShare = db.prepare("INSERT INTO expense_shares (expense_id, participant_id, amount_cents) VALUES (?, ?, ?)");
      for (const [index, participantId] of participants.entries()) await insertShare.run(expenseId, participantId, shares[index]);
    };
    await addExpense(trip1Id, trip1Participants, "Hotell", 420000, you, "stay", "2026-09-11");
    await addExpense(trip1Id, trip1Participants, "Middag på Skeppet", 185000, guestId.Anna!, "food", "2026-09-11");
    await addExpense(trip1Id, trip1Participants, "Taxi till hotellet", 38000, guestId.Erik!, "travel", "2026-09-11");
    await addExpense(trip1Id, trip1Participants, "ICA Maxi", 64550, guestId.Johan!, "food", "2026-09-12");
    await addExpense(trip1Id, trip1Participants, "Öl på puben", 92000, guestId.Sofia!, "food", "2026-09-12");

    const trip2 = await db.prepare("INSERT INTO trips (name, start_date, end_date, created_by, is_demo, demo_batch_id) VALUES (?, ?, ?, ?, TRUE, ?) RETURNING id")
      .run("Åre 2026", "2027-02-19", "2027-02-22", adminUserId, batchId);
    const trip2Id = Number(trip2.lastInsertRowid);
    await db.prepare("INSERT INTO trip_access (trip_id, user_id, role) VALUES (?, ?, 'owner')").run(trip2Id, adminUserId);
    const trip2You = Number((await db.prepare("INSERT INTO participants (trip_id, name, user_id) VALUES (?, 'Du (demo)', ?) RETURNING id").run(trip2Id, adminUserId)).lastInsertRowid);
    const trip2Anna = Number((await db.prepare("INSERT INTO participants (trip_id, name) VALUES (?, 'Anna') RETURNING id").run(trip2Id)).lastInsertRowid);
    const trip2Participants = [trip2You, trip2Anna];
    await addExpense(trip2Id, trip2Participants, "Liftkort", 285000, trip2You, "travel", "2027-02-20");
    await addExpense(trip2Id, trip2Participants, "Fjällrestaurang", 98000, trip2Anna, "food", "2027-02-21");

    const quickTabResult = await db.prepare("INSERT INTO quick_tabs (name, merchant, receipt_date, total_cents, created_by, is_demo, demo_batch_id) VALUES (?, ?, ?, ?, ?, TRUE, ?) RETURNING id")
      .run("Fredagsmiddag", "Bistro Nord", "2026-09-05", 68600, adminUserId, batchId);
    const quickTabId = Number(quickTabResult.lastInsertRowid);
    await db.prepare("INSERT INTO quick_tab_access (quick_tab_id, user_id, role) VALUES (?, ?, 'owner')").run(quickTabId, adminUserId);
    const insertItem = db.prepare("INSERT INTO quick_tab_items (quick_tab_id, name, amount_cents, quantity, position) VALUES (?, ?, ?, ?, ?)");
    const items: Array<[string, number, number]> = [["Pasta Carbonara", 2, 29800], ["Öl", 3, 23700], ["Tiramisu", 1, 15100]];
    for (const [position, [name, quantity, amountCents]] of items.entries()) await insertItem.run(quickTabId, name, amountCents, quantity, position);
  });
}

async function clearDemoData(batchId: string) {
  await db.transaction(async () => {
    await db.prepare("DELETE FROM trips WHERE demo_batch_id = ?").run(batchId);
    await db.prepare("DELETE FROM quick_tabs WHERE demo_batch_id = ?").run(batchId);
  });
}

// Catches demo data left behind when an admin closes the tab instead of clicking "Avsluta demoläge"
// (or the session simply expires) — never grows unbounded even if exit is never explicitly called.
async function sweepOrphanedDemoData() {
  await db.prepare(`
    DELETE FROM trips WHERE demo_batch_id IS NOT NULL
      AND demo_batch_id NOT IN (SELECT demo_batch_id FROM sessions WHERE demo_batch_id IS NOT NULL AND expires_at > CURRENT_TIMESTAMP)
  `).run();
  await db.prepare(`
    DELETE FROM quick_tabs WHERE demo_batch_id IS NOT NULL
      AND demo_batch_id NOT IN (SELECT demo_batch_id FROM sessions WHERE demo_batch_id IS NOT NULL AND expires_at > CURRENT_TIMESTAMP)
  `).run();
}

const attempts = new Map<string, { count: number; resetAt: number }>();
const receiptAnalysisAttempts = new Map<number, { count: number; resetAt: number }>();
const guestJoinAttempts = new Map<string, { count: number; resetAt: number }>();
const bugReportAttempts = new Map<number, { count: number; resetAt: number }>();
const forgotPasswordAttempts = new Map<string, { count: number; resetAt: number }>();
const emailTestAttempts = new Map<number, { count: number; resetAt: number }>();
const reminderAttempts = new Map<number, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.resetAt < now) attempts.delete(key);
  for (const [key, value] of receiptAnalysisAttempts) if (value.resetAt < now) receiptAnalysisAttempts.delete(key);
  for (const [key, value] of guestJoinAttempts) if (value.resetAt < now) guestJoinAttempts.delete(key);
  for (const [key, value] of forgotPasswordAttempts) if (value.resetAt < now) forgotPasswordAttempts.delete(key);
  for (const [key, value] of emailTestAttempts) if (value.resetAt < now) emailTestAttempts.delete(key);
  for (const [key, value] of reminderAttempts) if (value.resetAt < now) reminderAttempts.delete(key);
}, 10 * 60000).unref();
function forgotPasswordAllowed(ip: string) {
  const now = Date.now();
  const item = forgotPasswordAttempts.get(ip);
  if (!item || item.resetAt < now) { forgotPasswordAttempts.set(ip, { count: 1, resetAt: now + 15 * 60000 }); return true; }
  if (item.count >= 5) return false;
  item.count += 1;
  return true;
}
function emailTestAllowed(userId: number) {
  const now = Date.now();
  const item = emailTestAttempts.get(userId);
  if (!item || item.resetAt < now) { emailTestAttempts.set(userId, { count: 1, resetAt: now + 60 * 60000 }); return true; }
  if (item.count >= 10) return false;
  item.count += 1;
  return true;
}
function reminderAllowed(userId: number) {
  const now = Date.now();
  const item = reminderAttempts.get(userId);
  if (!item || item.resetAt < now) { reminderAttempts.set(userId, { count: 1, resetAt: now + 60 * 60000 }); return true; }
  if (item.count >= 3) return false;
  item.count += 1;
  return true;
}
function guestJoinAllowed(ip: string) {
  const now = Date.now();
  const item = guestJoinAttempts.get(ip);
  if (!item || item.resetAt < now) { guestJoinAttempts.set(ip, { count: 1, resetAt: now + 15 * 60000 }); return true; }
  if (item.count >= 20) return false;
  item.count += 1;
  return true;
}
function loginAllowed(ip: string) {
  const now = Date.now();
  const item = attempts.get(ip);
  if (!item || item.resetAt < now) { attempts.set(ip, { count: 0, resetAt: now + 15 * 60000 }); return true; }
  return item.count < 8;
}
function failedLogin(ip: string) { const item = attempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60000 }; item.count += 1; attempts.set(ip, item); }

function receiptAnalysisAllowed(userId: number) {
  const now = Date.now();
  const item = receiptAnalysisAttempts.get(userId);
  if (!item || item.resetAt < now) { receiptAnalysisAttempts.set(userId, { count: 1, resetAt: now + 10 * 60000 }); return true; }
  if (item.count >= 10) return false;
  item.count += 1;
  return true;
}

function bugReportAllowed(userId: number) {
  const now = Date.now();
  const item = bugReportAttempts.get(userId);
  if (!item || item.resetAt < now) { bugReportAttempts.set(userId, { count: 1, resetAt: now + 60 * 60000 }); return true; }
  if (item.count >= 5) return false;
  item.count += 1;
  return true;
}

function clientIp(request: IncomingMessage) {
  if (trustProxy) {
    // Cloudflare sets CF-Connecting-IP from the real TCP connection and strips any client-supplied
    // value with that name, so it cannot be spoofed. X-Forwarded-For is appended-to by every hop
    // (Cloudflare, then Nginx Proxy Manager) but a client can still prepend arbitrary values of its
    // own, so its first entry must never be trusted for rate limiting. See DEPLOYMENT.md.
    const cloudflareIp = String(request.headers["cf-connecting-ip"] || "").trim();
    if (cloudflareIp) return cloudflareIp;
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
  return demoContext.run(Boolean(user?.demo_mode), routes);

  async function routes(): Promise<void> {
  // Demo mode never sends real invitations, never exposes real contacts/phone numbers, and can never
  // reach global admin data — enforced in one place rather than scattered per-endpoint checks. The
  // demo enter/exit toggle itself is deliberately not in this list.
  if (user?.demo_mode && [
    /^\/api\/users\/search$/, /^\/api\/contacts$/, /^\/api\/admin$/, /^\/api\/admin\/users\/\d+$/,
    /^\/api\/admin\/quick-tabs\/\d+$/, /^\/api\/admin\/bug-reports(\/.*)?$/,
    /^\/api\/admin\/email-settings(\/.*)?$/, /^\/api\/remind-unpaid$/,
    /^\/api\/friend-invitations$/, /^\/api\/trips\/\d+\/invitations$/, /^\/api\/quick-tabs\/\d+\/invitations$/,
  ].some((pattern) => pattern.test(url.pathname))) {
    throw new HttpError(403, "Den här funktionen är inte tillgänglig i demoläge");
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    return json(response, 200, { authenticated: Boolean(user), needsSetup: userCount === 0, version: appVersion, user: user ? publicUser(user) : null, demoMode: Boolean(user?.demo_mode) });
  }
  if (request.method === "POST" && url.pathname === "/api/invitations/preview") {
    const body = await readJson(request);
    const invitation = await invitationByToken(String(body.token || ""));
    return invitation ? json(response, 200, { invitation: { kind: invitation.kind, tripName: invitation.trip_name, quickTabName: invitation.quick_tab_name || null, inviterName: invitation.inviter_name, expiresAt: invitation.expires_at } }) : json(response, 404, { error: "Inbjudan är ogiltig eller har gått ut" });
  }
  if (request.method === "POST" && url.pathname === "/api/setup") {
    if (userCount !== 0) return json(response, 409, { error: "Appen är redan konfigurerad" });
    const body = await readJson(request);
    if (!appPassword || !safeEqualStrings(body.setupPassword || "", appPassword)) return json(response, 401, { error: "Fel installationslösenord" });
    const record = await passwordRecord(body.password);
    const setupResult = await db.transaction(async () => {
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
      return { createdUser, sessionToken: await createSession(userId) };
    });
    return json(response, 201, { user: publicUser(setupResult.createdUser) }, { "Set-Cookie": sessionCookie(setupResult.sessionToken) });
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
    return json(response, 201, { user: publicUser(await db.prepare("SELECT * FROM users WHERE id = ?").get(userId)), tripId: invitation.trip_id || null, quickTabId: invitation.quick_tab_id || null }, { "Set-Cookie": sessionCookie(await createSession(userId)) });
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
  if (request.method === "POST" && url.pathname === "/api/auth/forgot-password") {
    const ip = clientIp(request);
    if (!forgotPasswordAllowed(ip)) return json(response, 429, { error: "För många försök. Vänta en stund." });
    const body = await readJson(request);
    // Always the same response whether or not the address exists, email is configured, or the send
    // succeeds -- this endpoint must never let a caller find out which email addresses have accounts.
    const generic = { ok: true, message: "Om adressen finns skickas ett mail med instruktioner för att återställa lösenordet." };
    try {
      const email = cleanEmail(body.email);
      const account = await db.prepare("SELECT id, display_name FROM users WHERE email = ? AND is_disabled = FALSE").get<any>(email);
      if (account) {
        const token = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
        await db.prepare("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)").run(account.id, sha256(token), expiresAt);
        const resetLink = new URL(`/#reset-password=${encodeURIComponent(token)}`, requestOrigin(request)).href;
        await sendMail(email, "Återställ ditt lösenord — Kompis Split",
          `Hej ${account.display_name}!\n\nNågon (förhoppningsvis du) begärde en lösenordsåterställning för ditt Kompis Split-konto.\n\nKlicka på länken nedan för att välja ett nytt lösenord. Länken slutar gälla om 30 minuter:\n${resetLink}\n\nOm du inte begärde detta kan du ignorera det här mailet -- ditt lösenord ändras inte förrän någon öppnar länken och väljer ett nytt.`);
      }
    } catch (error) {
      console.error("Kunde inte skicka återställningsmail:", error instanceof Error ? error.message : error);
    }
    return json(response, 200, generic);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/reset-password") {
    const body = await readJson(request);
    const token = String(body.token || "");
    if (!token) return json(response, 400, { error: "Länken är ogiltig eller har gått ut" });
    const record = await db.prepare(`
      SELECT id, user_id FROM password_reset_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `).get<any>(sha256(token));
    if (!record) return json(response, 400, { error: "Länken är ogiltig eller har gått ut" });
    const account = await db.prepare("SELECT id FROM users WHERE id = ? AND is_disabled = FALSE").get<any>(record.user_id);
    if (!account) return json(response, 400, { error: "Länken är ogiltig eller har gått ut" });
    const passwordRecordValue = await passwordRecord(body.password);
    await db.transaction(async () => {
      await db.prepare("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?").run(record.id);
      await db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(passwordRecordValue.hash, passwordRecordValue.salt, account.id);
      // Force a fresh login everywhere, same as disabling an account does -- a password reset should
      // invalidate any session someone else might already hold, not just future ones.
      await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(account.id);
      await audit(account.id, null, "user.password_reset", "user", account.id);
    });
    return json(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/logout") {
    const token = cookieValue(request, "kompis_session");
    if (token) await db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId(token));
    if (user?.demo_batch_id) await clearDemoData(String(user.demo_batch_id));
    return json(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }
  if (request.method === "POST" && url.pathname === "/api/quick-tabs/guest-join") {
    if (!guestJoinAllowed(clientIp(request))) throw new HttpError(429, "För många gästanslutningar. Vänta en stund och försök igen.");
    const body = await readJson(request);
    const invitation = await invitationByToken(String(body.token || ""));
    if (!invitation || invitation.kind !== "quick_tab") return json(response, 404, { error: "Snabbnoteinbjudan är ogiltig eller har gått ut" });
    const tab = await db.prepare("SELECT closed_at FROM quick_tabs WHERE id = ?").get<any>(invitation.quick_tab_id);
    if (!tab || tab.closed_at) throw new HttpError(409, "Snabbnotan är avslutad");
    // Idempotency: reopening the same invitation link in a browser that already has a valid guest
    // session for this quick tab must reconnect, not spawn a duplicate guest with fresh claims.
    const existingGuestToken = cookieValue(request, `kompis_quick_guest_${invitation.quick_tab_id}`);
    if (existingGuestToken) {
      const existingGuest = await db.prepare(`
        SELECT id, display_name, swish_phone FROM quick_tab_guests
        WHERE quick_tab_id = ? AND session_id = ? AND expires_at > CURRENT_TIMESTAMP
      `).get<any>(invitation.quick_tab_id, sessionId(existingGuestToken));
      if (existingGuest) {
        const refreshedExpiresAt = new Date(Math.min(new Date(invitation.expires_at).getTime(), Date.now() + 14 * 86400000)).toISOString();
        await db.prepare("UPDATE quick_tab_guests SET expires_at = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(refreshedExpiresAt, existingGuest.id);
        return json(response, 200, {
          quickTabId: Number(invitation.quick_tab_id), guest: { id: Number(existingGuest.id), name: existingGuest.display_name, swishPhone: existingGuest.swish_phone },
        }, { "Set-Cookie": quickGuestCookie(Number(invitation.quick_tab_id), existingGuestToken) });
      }
    }
    const name = cleanText(body.name, "Namn", 60);
    const swishPhone = normalizePhone(body.swishPhone);
    if (!swishPhone) throw new Error("Mobil- eller Swish-nummer krävs");
    const guestToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Math.min(new Date(invitation.expires_at).getTime(), Date.now() + 14 * 86400000)).toISOString();
    const guestId = await db.transaction(async () => {
      const changed = await db.prepare("UPDATE quick_tab_invitations SET use_count = use_count + 1 WHERE id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP AND use_count < max_uses").run(invitation.id);
      if (!changed.changes) throw new HttpError(409, "Inbjudan har redan använts fullt ut eller gått ut");
      const result = await db.prepare(`
        INSERT INTO quick_tab_guests (quick_tab_id, display_name, swish_phone, session_id, expires_at)
        VALUES (?, ?, ?, ?, ?) RETURNING id
      `).run(invitation.quick_tab_id, name, swishPhone, sessionId(guestToken), expiresAt);
      const id = Number(result.lastInsertRowid);
      await audit(null, null, "quick_tab.guest_joined", "quick_tab_guest", id, { quickTabId: Number(invitation.quick_tab_id) });
      return id;
    });
    return json(response, 201, {
      quickTabId: Number(invitation.quick_tab_id), guest: { id: guestId, name, swishPhone },
    }, { "Set-Cookie": quickGuestCookie(Number(invitation.quick_tab_id), guestToken) });
  }

  let guestMatch = url.pathname.match(/^\/api\/quick-tabs\/(\d+)$/);
  if (request.method === "GET" && guestMatch) {
    const quickTabId = Number(guestMatch[1]);
    const viewer = await quickTabViewer(request, quickTabId, user);
    return json(response, 200, { quickTab: await loadQuickTab(quickTabId, viewer) });
  }
  guestMatch = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/events$/);
  if (request.method === "GET" && guestMatch) {
    const quickTabId = Number(guestMatch[1]);
    await quickTabViewer(request, quickTabId, user);
    if ((quickTabStreams.get(quickTabId)?.size || 0) >= 100) throw new HttpError(429, "För många samtidiga anslutningar till snabbnotan");
    response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.write(`event: ready\ndata: ${JSON.stringify({ quickTabId })}\n\n`);
    const streams = quickTabStreams.get(quickTabId) || new Set<ServerResponse>();
    streams.add(response); quickTabStreams.set(quickTabId, streams);
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);
    request.on("close", () => { clearInterval(heartbeat); streams.delete(response); if (!streams.size) quickTabStreams.delete(quickTabId); });
    return;
  }
  guestMatch = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/claims$/);
  if (request.method === "POST" && guestMatch) {
    const quickTabId = Number(guestMatch[1]);
    const viewer = await quickTabViewer(request, quickTabId, user);
    const tab = await db.prepare("SELECT closed_at FROM quick_tabs WHERE id = ?").get<any>(quickTabId);
    if (tab?.closed_at) throw new HttpError(409, "Snabbnotan är avslutad");
    const body = await readJson(request); const itemId = Number(body.itemId);
    const quantity = body.quantity === undefined ? body.claimed === false ? 0 : 1 : Number(body.quantity);
    await setQuickTabClaimQuantity(quickTabId, itemId, viewer, quantity);
    broadcastQuickTab(quickTabId);
    return json(response, 200, { quickTab: await loadQuickTab(quickTabId, viewer) });
  }
  guestMatch = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/receipt$/);
  if (request.method === "GET" && guestMatch) {
    const quickTabId = Number(guestMatch[1]); await quickTabViewer(request, quickTabId, user);
    const receipt = await db.prepare("SELECT receipt_mime_type, receipt_content FROM quick_tabs WHERE id = ?").get<any>(quickTabId);
    if (!receipt?.receipt_content) return json(response, 404, { error: "Kvittot finns inte" });
    response.writeHead(200, { ...securityHeaders(), "Content-Type": receipt.receipt_mime_type, "Cache-Control": "private, no-store", "Content-Disposition": "inline" });
    response.end(receipt.receipt_content); return;
  }
  if (!user) return json(response, 401, { error: "Logga in för att fortsätta" });

  let match;
  if (request.method === "POST" && url.pathname === "/api/admin/demo/enter") {
    requireAdmin(user);
    const token = cookieValue(request, "kompis_session");
    let batchId = user.demo_batch_id as string | null;
    if (!user.demo_mode || !batchId) {
      batchId = randomBytes(12).toString("base64url");
      await seedDemoData(user.id, batchId);
    }
    await db.prepare("UPDATE sessions SET demo_mode = TRUE, demo_batch_id = ? WHERE id = ?").run(batchId, sessionId(token));
    await audit(user.id, null, "admin.demo.entered", "session", null, null);
    return json(response, 200, { demoMode: true });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/demo/exit") {
    requireAdmin(user);
    if (user.demo_batch_id) await clearDemoData(String(user.demo_batch_id));
    const token = cookieValue(request, "kompis_session");
    await db.prepare("UPDATE sessions SET demo_mode = FALSE, demo_batch_id = NULL WHERE id = ?").run(sessionId(token));
    await audit(user.id, null, "admin.demo.exited", "session", null, null);
    return json(response, 200, { demoMode: false });
  }
  if (request.method === "GET" && url.pathname === "/api/admin") {
    requireAdmin(user);
    return json(response, 200, await adminOverview());
  }
  if (request.method === "GET" && url.pathname === "/api/admin/email-settings") {
    requireAdmin(user);
    return json(response, 200, await emailSettingsStatus());
  }
  if (request.method === "POST" && url.pathname === "/api/admin/email-settings") {
    requireAdmin(user);
    const body = await readJson(request);
    const tenantId = cleanText(body.tenantId, "Tenant-ID", 100);
    const clientId = cleanText(body.clientId, "Klient-ID", 100);
    const senderEmail = cleanEmail(body.senderEmail);
    const clientSecret = body.clientSecret ? cleanText(body.clientSecret, "Klienthemlighet", 300) : undefined;
    await saveEmailSettings({ tenantId, clientId, clientSecret, senderEmail }, user.id);
    await audit(user.id, null, "admin.email_settings.updated", "email_settings", null);
    return json(response, 200, await emailSettingsStatus());
  }
  if (request.method === "POST" && url.pathname === "/api/admin/email-settings/test") {
    requireAdmin(user);
    if (!emailTestAllowed(Number(user.id))) throw new HttpError(429, "För många testmail. Vänta en stund och försök igen.");
    const body = await readJson(request);
    const recipient = body.recipientEmail ? cleanEmail(body.recipientEmail) : user.email;
    try {
      await sendMail(recipient, "Kompis Split — testmail",
        `Hej ${user.display_name}!\n\nDet här är ett testmail som bekräftar att e-postintegrationen för Kompis Split fungerar.`);
    } catch (error) {
      if (error instanceof EmailError) throw new HttpError(502, error.message);
      throw error;
    }
    return json(response, 200, { ok: true, recipient });
  }
  if (request.method === "POST" && url.pathname === "/api/remind-unpaid") {
    // Available to any account, not just admins -- this only ever reaches people who owe money
    // to the caller specifically (unpaidRemindersFor scopes everything to creditorUserId), never
    // anyone else's debts.
    if (!reminderAllowed(Number(user.id))) throw new HttpError(429, "Vänta en stund innan du skickar fler påminnelser.");
    const summaries = await unpaidRemindersFor(Number(user.id));
    let sent = 0;
    const errors: string[] = [];
    for (const summary of summaries) {
      const totalCents = summary.items.reduce((sum, item) => sum + item.amountCents, 0);
      const lines = summary.items.map((item) => `- ${item.label}: ${formatSek(item.amountCents)}`).join("\n");
      try {
        await sendMail(summary.email, `Påminnelse från ${user.display_name} — Kompis Split`,
          `Hej ${summary.name}!\n\n${user.display_name} vill påminna om följande obetalda belopp i Kompis Split:\n\n${lines}\n\nTotalt: ${formatSek(totalCents)}\n\nLogga in på Kompis Split för att se detaljer och betala med Swish.`);
        sent += 1;
      } catch (error) {
        errors.push(`${summary.name}: ${error instanceof Error ? error.message : "okänt fel"}`);
      }
    }
    await audit(user.id, null, "reminders.sent", "user", null, { sent, total: summaries.length });
    return json(response, 200, { sent, total: summaries.length, errors });
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
    return json(response, 200, { tripId: invitation.trip_id || null, quickTabId: invitation.quick_tab_id || null });
  }
  if (request.method === "POST" && url.pathname === "/api/friend-invitations") {
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    await db.transaction(async () => {
      await db.prepare("UPDATE friend_invitations SET revoked_at = CURRENT_TIMESTAMP WHERE invited_by = ? AND revoked_at IS NULL AND use_count = 0").run(user.id);
      const result = await db.prepare("INSERT INTO friend_invitations (token_hash, invited_by, expires_at) VALUES (?, ?, ?) RETURNING id")
        .run(sha256(token), user.id, expiresAt);
      await audit(user.id, null, "friend_invitation.created", "friend_invitation", Number(result.lastInsertRowid));
    });
    return json(response, 201, { invitation: await invitationPayload(request, token, expiresAt) });
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") return json(response, 200, await dashboard(user.id));
  if (request.method === "GET" && url.pathname === "/api/statistics") return json(response, 200, await statistics(user.id));
  if (request.method === "GET" && url.pathname === "/api/quick-tabs") return json(response, 200, { quickTabs: await quickTabList(user.id) });
  if (request.method === "POST" && url.pathname === "/api/quick-tabs/analyze") {
    if (!receiptAnalysisAllowed(Number(user.id))) throw new HttpError(429, "För många kvittoanalyser. Vänta en stund och försök igen.");
    const [contentType = ""] = String(request.headers["content-type"] || "").split(";", 1);
    const mimeType = contentType.trim().toLowerCase();
    if (!receiptImageMimeTypes.has(mimeType)) throw new HttpError(415, "Automatisk avläsning stöder JPG, PNG och WebP");
    const content = await readBytes(request, receiptMaximumBytes);
    if (!receiptContentMatches(mimeType, content)) throw new HttpError(415, "Filens innehåll matchar inte det valda bildformatet");
    safeReceiptImageDimensions(mimeType, content);
    return json(response, 200, await recognizeReceipt(content));
  }
  if (request.method === "POST" && url.pathname === "/api/quick-tabs") {
    const body = await readJson(request);
    const totalCents = parseAmount(body.total);
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length || rawItems.length > 60) throw new Error("Snabbnotan måste ha mellan 1 och 60 kvittorader");
    const items: Array<{ name: string; amountCents: number; quantity: number }> = [];
    for (const raw of rawItems) {
      const name = cleanText(raw.name, "Radnamn", 100);
      const quantity = Number(raw.quantity || 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error("Antalet per rad måste vara mellan 1 och 20");
      const rowCents = parseAmount(raw.amount);
      items.push({ name, amountCents: rowCents, quantity });
    }
    if (items.reduce((sum, item) => sum + item.amountCents, 0) > totalCents) throw new Error("Kvittoradernas summa kan inte vara högre än hela notan");
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    const quickTabId = await db.transaction(async () => {
      const result = await db.prepare("INSERT INTO quick_tabs (name, merchant, receipt_date, total_cents, created_by, is_demo, demo_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .run(cleanText(body.name || body.merchant || "Snabbnota", "Namn", 100), body.merchant ? cleanText(body.merchant, "Plats", 100) : null, validDate(body.receiptDate), totalCents, user.id, Boolean(user.demo_mode), user.demo_mode ? user.demo_batch_id : null);
      const id = Number(result.lastInsertRowid);
      await db.prepare("INSERT INTO quick_tab_access (quick_tab_id, user_id, role) VALUES (?, ?, 'owner')").run(id, user.id);
      const insert = db.prepare("INSERT INTO quick_tab_items (quick_tab_id, name, amount_cents, quantity, position) VALUES (?, ?, ?, ?, ?)");
      for (const [position, item] of items.entries()) await insert.run(id, item.name, item.amountCents, item.quantity, position);
      await db.prepare("INSERT INTO quick_tab_invitations (quick_tab_id, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?)").run(id, sha256(token), user.id, expiresAt);
      await audit(user.id, null, "quick_tab.created", "quick_tab", id, { totalCents, itemCount: items.length, unitCount: items.reduce((sum, item) => sum + item.quantity, 0) });
      return id;
    });
    return json(response, 201, { quickTab: await loadQuickTab(quickTabId, { kind: "user", id: Number(user.id), key: `u:${user.id}`, role: "owner" }), invitation: await invitationPayload(request, token, expiresAt) });
  }
  match = url.pathname.match(/^\/api\/quick-tabs\/(\d+)$/);
  if (request.method === "GET" && match) return json(response, 200, { quickTab: await loadQuickTab(Number(match[1]), await quickTabViewer(request, Number(match[1]), user)) });
  match = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/invitations$/);
  if (request.method === "POST" && match) {
    const quickTabId = Number(match[1]); const role = await quickTabAccess(quickTabId, user.id);
    if (role !== "owner") throw new HttpError(403, "Bara skaparen kan bjuda in till snabbnotan");
    const token = randomBytes(24).toString("base64url"); const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    // Do not revoke earlier invitations here: a quick tab's invitation link is meant to be shared with
    // and reused by an entire group (max_uses is 30, not 1). Revoking the previous one on every click
    // broke the very first QR code the moment the owner reopened the tab and clicked "Bjud in" again —
    // anyone who hadn't joined yet with that link suddenly got "Inbjudan är ogiltig eller har gått ut".
    // Each click now just adds another valid invitation; old ones keep working until they expire.
    await db.prepare("INSERT INTO quick_tab_invitations (quick_tab_id, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?)").run(quickTabId, sha256(token), user.id, expiresAt);
    return json(response, 201, { invitation: await invitationPayload(request, token, expiresAt) });
  }
  match = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/events$/);
  if (request.method === "GET" && match) {
    const quickTabId = Number(match[1]);
    await quickTabAccess(quickTabId, user.id);
    if ((quickTabStreams.get(quickTabId)?.size || 0) >= 100) throw new HttpError(429, "För många samtidiga anslutningar till snabbnotan");
    response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.write(`event: ready\ndata: ${JSON.stringify({ quickTabId })}\n\n`);
    const streams = quickTabStreams.get(quickTabId) || new Set<ServerResponse>();
    streams.add(response); quickTabStreams.set(quickTabId, streams);
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);
    request.on("close", () => { clearInterval(heartbeat); streams.delete(response); if (!streams.size) quickTabStreams.delete(quickTabId); });
    return;
  }
  match = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/claims$/);
  if (request.method === "POST" && match) {
    const quickTabId = Number(match[1]); const role = await quickTabAccess(quickTabId, user.id);
    const tab = await db.prepare("SELECT closed_at FROM quick_tabs WHERE id = ?").get<any>(quickTabId);
    if (tab?.closed_at) throw new HttpError(409, "Snabbnotan är avslutad");
    const body = await readJson(request); const itemId = Number(body.itemId);
    const quantity = body.quantity === undefined ? body.claimed === false ? 0 : 1 : Number(body.quantity);
    await setQuickTabClaimQuantity(quickTabId, itemId, { kind: "user", id: Number(user.id), key: `u:${user.id}`, role }, quantity);
    broadcastQuickTab(quickTabId);
    return json(response, 200, { quickTab: await loadQuickTab(quickTabId, await quickTabViewer(request, quickTabId, user)) });
  }
  match = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/receipt$/);
  if (request.method === "POST" && match) {
    const quickTabId = Number(match[1]); const role = await quickTabAccess(quickTabId, user.id);
    if (role !== "owner") throw new HttpError(403, "Bara skaparen kan spara kvittot");
    const [contentType = ""] = String(request.headers["content-type"] || "").split(";", 1); const mimeType = contentType.trim().toLowerCase();
    if (!receiptImageMimeTypes.has(mimeType)) throw new HttpError(415, "Kvittot måste vara JPG, PNG eller WebP");
    const content = await readBytes(request, receiptMaximumBytes);
    if (!receiptContentMatches(mimeType, content)) throw new HttpError(415, "Filens innehåll matchar inte bildformatet");
    safeReceiptImageDimensions(mimeType, content);
    const normalized = await normalizeReceiptImage(content);
    await db.prepare("UPDATE quick_tabs SET receipt_mime_type = ?, receipt_content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(normalized.mimeType, normalized.content, quickTabId);
    return json(response, 201, { ok: true });
  }
  if (request.method === "GET" && match) {
    const quickTabId = Number(match[1]); await quickTabAccess(quickTabId, user.id);
    const receipt = await db.prepare("SELECT receipt_mime_type, receipt_content FROM quick_tabs WHERE id = ?").get<any>(quickTabId);
    if (!receipt?.receipt_content) return json(response, 404, { error: "Kvittot finns inte" });
    response.writeHead(200, { ...securityHeaders(), "Content-Type": receipt.receipt_mime_type, "Cache-Control": "private, no-store", "Content-Disposition": "inline" });
    response.end(receipt.receipt_content); return;
  }
  match = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/close$/);
  if (request.method === "POST" && match) {
    const quickTabId = Number(match[1]); const role = await quickTabAccess(quickTabId, user.id);
    if (role !== "owner") throw new HttpError(403, "Bara skaparen kan avsluta snabbnotan");
    const body = await readJson(request);
    await db.prepare("UPDATE quick_tabs SET closed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(body.closed === false ? null : new Date().toISOString(), quickTabId);
    broadcastQuickTab(quickTabId);
    return json(response, 200, { quickTab: await loadQuickTab(quickTabId, await quickTabViewer(request, quickTabId, user)) });
  }
  match = url.pathname.match(/^\/api\/quick-tabs\/(\d+)\/payments$/);
  if (request.method === "POST" && match) {
    // Swish exposes no way for a non-merchant app to verify a payment was actually sent, so this is
    // trust-based reporting by whoever receives the money -- the owner is the only one who genuinely
    // knows whether a Swish arrived, so only the owner (not the payer, not other guests) can mark it.
    const quickTabId = Number(match[1]);
    const role = await quickTabAccess(quickTabId, user.id);
    if (role !== "owner") throw new HttpError(403, "Bara skaparen kan markera betalningar");
    const body = await readJson(request);
    const [kind, rawId] = String(body.viewerKey || "").split(":");
    const targetId = Number(rawId);
    if (!Number.isInteger(targetId) || (kind !== "u" && kind !== "g")) throw new HttpError(400, "Ogiltig deltagare");
    const identityColumn = kind === "u" ? "user_id" : "guest_id";
    const memberTable = kind === "u" ? "quick_tab_access" : "quick_tab_guests";
    const memberColumn = kind === "u" ? "user_id" : "id";
    const member = await db.prepare(`SELECT 1 FROM ${memberTable} WHERE quick_tab_id = ? AND ${memberColumn} = ?`).get(quickTabId, targetId);
    if (!member) throw new HttpError(404, "Deltagaren finns inte i snabbnotan");
    await db.prepare(`DELETE FROM quick_tab_payments WHERE quick_tab_id = ? AND ${identityColumn} = ?`).run(quickTabId, targetId);
    if (body.paid !== false) {
      await db.prepare(`INSERT INTO quick_tab_payments (quick_tab_id, ${identityColumn}, marked_by) VALUES (?, ?, ?)`).run(quickTabId, targetId, user.id);
    }
    broadcastQuickTab(quickTabId);
    return json(response, 200, { quickTab: await loadQuickTab(quickTabId, await quickTabViewer(request, quickTabId, user)) });
  }
  match = url.pathname.match(/^\/api\/admin\/quick-tabs\/(\d+)$/);
  if (request.method === "DELETE" && match) {
    requireAdmin(user);
    const quickTabId = Number(match[1]);
    const existing = await db.prepare("SELECT id FROM quick_tabs WHERE id = ?").get<any>(quickTabId);
    if (!existing) return json(response, 404, { error: "Snabbnotan finns inte" });
    // Every quick_tab_* table cascades on quick_tabs deletion (access, invitations, items, guests,
    // and claims transitively via items), so a single delete is enough to remove it completely —
    // unlike trips there is no restore/trash concept for quick tabs, this is permanent.
    broadcastQuickTab(quickTabId);
    await db.transaction(async () => {
      await db.prepare("DELETE FROM quick_tabs WHERE id = ?").run(quickTabId);
      await audit(user.id, null, "quick_tab.deleted", "quick_tab", quickTabId);
    });
    return json(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/bug-reports") {
    if (!bugReportAllowed(Number(user.id))) throw new HttpError(429, "För många buggrapporter. Vänta en stund och försök igen.");
    const body = await readJson(request);
    const description = cleanText(body.description, "Beskrivning", 2000);
    // Breadcrumbs are captured client-side from the same api()/upload() helper every request already
    // goes through -- method, path and status only, never request/response bodies -- so this never
    // becomes a second place that has to be told not to log sensitive data.
    const breadcrumbs = (Array.isArray(body.breadcrumbs) ? body.breadcrumbs : []).slice(-30).map((item: unknown) => String(item).slice(0, 200));
    const result = await db.prepare(`
      INSERT INTO bug_reports (reported_by, description, page_url, user_agent, app_version, breadcrumbs)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id
    `).run(user.id, description, String(body.pageUrl || "").slice(0, 300) || null, String(body.userAgent || "").slice(0, 300) || null, String(body.appVersion || "").slice(0, 40) || null, JSON.stringify(breadcrumbs));
    const id = Number(result.lastInsertRowid);
    await audit(user.id, null, "bug_report.created", "bug_report", id);
    return json(response, 201, { id });
  }
  match = url.pathname.match(/^\/api\/bug-reports\/(\d+)\/screenshot$/);
  if (request.method === "POST" && match) {
    const reportId = Number(match[1]);
    const report = await db.prepare("SELECT reported_by FROM bug_reports WHERE id = ?").get<any>(reportId);
    if (!report) return json(response, 404, { error: "Buggrapporten finns inte" });
    if (Number(report.reported_by) !== Number(user.id)) throw new HttpError(403, "Du kan bara bifoga en skärmbild till din egen rapport");
    const [contentType = ""] = String(request.headers["content-type"] || "").split(";", 1); const mimeType = contentType.trim().toLowerCase();
    if (!receiptImageMimeTypes.has(mimeType)) throw new HttpError(415, "Skärmbilden måste vara JPG, PNG eller WebP");
    const content = await readBytes(request, receiptMaximumBytes);
    if (!receiptContentMatches(mimeType, content)) throw new HttpError(415, "Filens innehåll matchar inte bildformatet");
    safeReceiptImageDimensions(mimeType, content);
    const normalized = await normalizeReceiptImage(content);
    await db.prepare("UPDATE bug_reports SET screenshot_mime_type = ?, screenshot_content = ? WHERE id = ?").run(normalized.mimeType, normalized.content, reportId);
    return json(response, 201, { ok: true });
  }
  match = url.pathname.match(/^\/api\/admin\/bug-reports\/(\d+)\/screenshot$/);
  if (request.method === "GET" && match) {
    requireAdmin(user);
    const report = await db.prepare("SELECT screenshot_mime_type, screenshot_content FROM bug_reports WHERE id = ?").get<any>(Number(match[1]));
    if (!report?.screenshot_content) return json(response, 404, { error: "Ingen skärmbild finns" });
    response.writeHead(200, { ...securityHeaders(), "Content-Type": report.screenshot_mime_type, "Cache-Control": "private, no-store", "Content-Disposition": "inline" });
    response.end(report.screenshot_content); return;
  }
  match = url.pathname.match(/^\/api\/admin\/bug-reports\/(\d+)\/resolve$/);
  if (request.method === "POST" && match) {
    requireAdmin(user);
    const reportId = Number(match[1]);
    const body = await readJson(request);
    const resolving = body.resolved !== false;
    const changed = await db.prepare("UPDATE bug_reports SET resolved_at = ?, resolved_by = ? WHERE id = ?")
      .run(resolving ? new Date().toISOString() : null, resolving ? user.id : null, reportId);
    if (!changed.changes) return json(response, 404, { error: "Buggrapporten finns inte" });
    return json(response, 200, { ok: true });
  }
  match = url.pathname.match(/^\/api\/admin\/bug-reports\/(\d+)$/);
  if (request.method === "DELETE" && match) {
    requireAdmin(user);
    const changed = await db.prepare("DELETE FROM bug_reports WHERE id = ?").run(Number(match[1]));
    if (!changed.changes) return json(response, 404, { error: "Buggrapporten finns inte" });
    return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/categories") {
    return json(response, 200, { categories: await categoryList() });
  }
  if (request.method === "POST" && url.pathname === "/api/categories") {
    // Categories are global, not trip-scoped, so a demo session must never be able to create one —
    // unlike trips/expenses/quick tabs, there is no is_demo boundary that would contain the side effect.
    if (user.demo_mode) throw new HttpError(403, "Kategorier kan inte skapas i demoläge");
    const body = await readJson(request);
    const name = cleanText(body.name, "Kategorinamn", 40);
    const emoji = cleanText(body.emoji || "🧾", "Emoji", 16);
    const slug = `custom-${randomBytes(9).toString("base64url").toLowerCase()}`;
    const result = await db.prepare("INSERT INTO expense_categories (slug, name, emoji, created_by) VALUES (?, ?, ?, ?) RETURNING id")
      .run(slug, name, emoji, user.id);
    await audit(user.id, null, "category.created", "category", Number(result.lastInsertRowid), { slug, name });
    return json(response, 201, { categories: await categoryList(), createdSlug: slug });
  }
  match = url.pathname.match(/^\/api\/categories\/(\d+)$/);
  if (request.method === "PATCH" && match) {
    const category = await db.prepare("SELECT * FROM expense_categories WHERE id = ?").get<any>(Number(match[1]));
    if (!category) return json(response, 404, { error: "Kategorin finns inte" });
    if (category.is_builtin) throw new HttpError(409, "Standardkategorier kan inte ändras");
    if (user.demo_mode) throw new HttpError(403, "Kategorier kan inte ändras i demoläge");
    if (!user.is_admin && Number(category.created_by) !== Number(user.id)) throw new HttpError(403, "Du kan bara ändra egna kategorier");
    const body = await readJson(request);
    const name = body.name === undefined ? category.name : cleanText(body.name, "Kategorinamn", 40);
    const emoji = body.emoji === undefined ? category.emoji : cleanText(body.emoji, "Emoji", 16);
    const archivedAt = typeof body.archived === "boolean" ? (body.archived ? new Date().toISOString() : null) : category.archived_at;
    await db.prepare("UPDATE expense_categories SET name = ?, emoji = ?, archived_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(name, emoji, archivedAt, category.id);
    await audit(user.id, null, "category.updated", "category", category.id, { name, emoji, archived: Boolean(archivedAt) });
    return json(response, 200, { categories: await categoryList() });
  }
  if (request.method === "GET" && url.pathname === "/api/contacts") {
    const contacts = (await db.prepare(`SELECT u.id, u.email, u.display_name, u.swish_phone FROM contacts c JOIN users u ON u.id = c.contact_user_id WHERE c.owner_user_id = ? ORDER BY lower(u.display_name)`).all<any>(user.id)).map(publicUser);
    return json(response, 200, { contacts });
  }
  if (request.method === "GET" && url.pathname === "/api/users/search") {
    const query = String(url.searchParams.get("q") || "").trim();
    if (query.length < 2) return json(response, 200, { users: [] });
    // swish_phone is intentionally excluded: search is for finding someone by name/email to invite,
    // not for looking up a stranger's payment number. Phone numbers only become visible once two
    // users actually share a trip or quick tab (see loadTrip participants / loadQuickTab members).
    const users = (await db.prepare(`
      SELECT u.id, u.email, u.display_name,
        EXISTS(SELECT 1 FROM contacts c WHERE c.owner_user_id = ? AND c.contact_user_id = u.id) is_contact
      FROM users u WHERE u.id != ? AND (u.display_name ILIKE ? ESCAPE '\\' OR u.email ILIKE ? ESCAPE '\\')
      ORDER BY is_contact DESC, lower(u.display_name) LIMIT 12
    `).all<any>(user.id, user.id, `%${query.replace(/[\\%_]/g, "\\$&")}%`, `%${query.replace(/[\\%_]/g, "\\$&")}%`)).map((item) => ({ ...publicUser(item), swishPhone: null, isContact: Boolean(item.is_contact) }));
    return json(response, 200, { users });
  }
  if (request.method === "POST" && url.pathname === "/api/contacts") {
    const body = await readJson(request);
    const contactId = Number(body.userId);
    if (!await db.prepare("SELECT id FROM users WHERE id = ?").get(contactId) || contactId === user.id) throw new Error("Ogiltig kontakt");
    // Only allow saving someone you already share a trip or quick tab with as a contact. Without this,
    // any authenticated user could add an arbitrary numeric user ID and then read that stranger's
    // email/Swish number back via GET /api/contacts, with no relationship or consent involved.
    const related = await db.prepare(`
      SELECT 1 WHERE EXISTS (
        SELECT 1 FROM trip_access a JOIN trip_access b ON a.trip_id = b.trip_id
        WHERE a.user_id = ? AND b.user_id = ?
      ) OR EXISTS (
        SELECT 1 FROM quick_tab_access a JOIN quick_tab_access b ON a.quick_tab_id = b.quick_tab_id
        WHERE a.user_id = ? AND b.user_id = ?
      )
    `).get(user.id, contactId, user.id, contactId);
    if (!related) throw new HttpError(403, "Du kan bara spara någon som kontakt om ni redan delar en grupp eller snabbnota");
    await db.prepare("INSERT INTO contacts (owner_user_id, contact_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(user.id, contactId);
    return json(response, 201, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/trips") {
    const body = await readJson(request);
    const tripId = await db.transaction(async () => {
      const result = await db.prepare("INSERT INTO trips (name, start_date, end_date, created_by, is_demo, demo_batch_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
        .run(cleanText(body.name, "Gruppens namn", 80), validDate(body.startDate), validDate(body.endDate), user.id, Boolean(user.demo_mode), user.demo_mode ? user.demo_batch_id : null);
      const tripId = Number(result.lastInsertRowid);
      await db.prepare("INSERT INTO trip_access (trip_id, user_id, role) VALUES (?, ?, 'owner')").run(tripId, user.id);
      await db.prepare("INSERT INTO participants (trip_id, name, swish_phone, user_id) VALUES (?, ?, ?, ?)").run(tripId, user.display_name, user.swish_phone, user.id);
      await audit(user.id, tripId, "trip.created", "trip", tripId);
      return tripId;
    });
    return json(response, 201, { trip: await loadTrip(tripId, user.id) });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)$/);
  if (request.method === "GET" && match) {
    const trip = await loadTrip(Number(match[1]), user.id);
    return trip ? json(response, 200, { trip }) : json(response, 404, { error: "Gruppen finns inte" });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/archive$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]); await requireAccess(tripId, user.id, ["owner", "admin"]);
    const existing = await db.prepare("SELECT deleted_at FROM trips WHERE id = ?").get<any>(tripId);
    if (!existing || existing.deleted_at) return json(response, 404, { error: "Gruppen finns inte" });
    const body = await readJson(request);
    await db.prepare("UPDATE trips SET archived_at = ? WHERE id = ?").run(body.archived === false ? null : new Date().toISOString(), tripId);
    await audit(user.id, tripId, body.archived === false ? "trip.restored" : "trip.archived", "trip", tripId);
    return json(response, 200, { trip: await loadTrip(tripId, user.id) });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/trash$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]); await requireAccess(tripId, user.id, ["owner", "admin"]);
    const trip = await db.prepare("SELECT id, archived_at, deleted_at FROM trips WHERE id = ?").get<any>(tripId);
    if (!trip) return json(response, 404, { error: "Gruppen finns inte" });
    const body = await readJson(request);
    const restoring = body.deleted === false;
    if (!restoring && !trip.archived_at) throw new HttpError(409, "Arkivera gruppen innan du tar bort den");
    await db.transaction(async () => {
      const receiptCount = restoring ? 0 : Number((await db.prepare("SELECT COUNT(*) count FROM expense_receipts WHERE trip_id = ?").get<any>(tripId))?.count || 0);
      if (!restoring) await db.prepare("DELETE FROM expense_receipts WHERE trip_id = ?").run(tripId);
      await db.prepare("UPDATE trips SET deleted_at = ?, deleted_by = ? WHERE id = ?")
        .run(restoring ? null : new Date().toISOString(), restoring ? null : user.id, tripId);
      await db.prepare("UPDATE invitations SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE trip_id = ?").run(tripId);
      await audit(user.id, tripId, restoring ? "trip.undeleted" : "trip.deleted", "trip", tripId, { deletedReceiptCount: receiptCount });
    });
    return json(response, 200, { ok: true });
  }
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/invitations$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]); await requireAccess(tripId, user.id, ["owner", "admin"]); await requireActiveTrip(tripId);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();
    const result = await db.prepare("INSERT INTO invitations (trip_id, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?) RETURNING id").run(tripId, sha256(token), user.id, expiresAt);
    await audit(user.id, tripId, "invitation.created", "invitation", Number(result.lastInsertRowid));
    return json(response, 201, { invitation: await invitationPayload(request, token, expiresAt) });
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
    const category = await activeCategorySlug(body.category);
    const entries: Array<{ participantId: number; value: unknown }> = Array.isArray(body.entries) ? body.entries.map((entry: any) => ({ participantId: Number(entry.participantId), value: entry.value })) : [];
    await Promise.all(entries.map((entry: any) => assertTripParticipant(tripId, entry.participantId)));
    if (new Set(entries.map((entry: { participantId: number }) => entry.participantId)).size !== entries.length) throw new Error("Varje deltagare får bara finnas en gång");
    const amounts = calculateShares(amountCents, String(body.splitMode || "equal"), entries);
    const expenseId = await db.transaction(async () => {
      const result = await db.prepare("INSERT INTO expenses (trip_id, payer_id, title, amount_cents, expense_date, category, split_mode, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .run(tripId, payerId, cleanText(body.title, "Beskrivning", 100), amountCents, validDate(body.expenseDate), category, String(body.splitMode || "equal"), user.id);
      const expenseId = Number(result.lastInsertRowid); const insertShare = db.prepare("INSERT INTO expense_shares (expense_id, participant_id, amount_cents) VALUES (?, ?, ?)");
      for (const [index, entry] of entries.entries()) await insertShare.run(expenseId, entry.participantId, amounts[index]);
      await audit(user.id, tripId, "expense.created", "expense", expenseId, { amountCents });
      return expenseId;
    });
    return json(response, 201, { expenseId, trip: await loadTrip(tripId, user.id) });
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
  match = url.pathname.match(/^\/api\/trips\/(\d+)\/receipts\/analyze$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]);
    await requireAccess(tripId, user.id);
    await requireActiveTrip(tripId);
    if (!receiptAnalysisAllowed(Number(user.id))) throw new HttpError(429, "För många kvittoanalyser. Vänta en stund och försök igen.");
    const [contentType = ""] = String(request.headers["content-type"] || "").split(";", 1);
    const mimeType = contentType.trim().toLowerCase();
    if (!receiptImageMimeTypes.has(mimeType)) throw new HttpError(415, "Automatisk avläsning stöder JPG, PNG och WebP");
    const content = await readBytes(request, receiptMaximumBytes);
    if (!receiptContentMatches(mimeType, content)) throw new HttpError(415, "Filens innehåll matchar inte det valda bildformatet");
    safeReceiptImageDimensions(mimeType, content);
    const result = await recognizeReceipt(content);
    return json(response, 200, result);
  }
  match = url.pathname.match(/^\/api\/expenses\/(\d+)\/receipts$/);
  if (request.method === "POST" && match) {
    const expense = await db.prepare("SELECT * FROM expenses WHERE id = ? AND voided_at IS NULL").get<any>(Number(match[1]));
    if (!expense) return json(response, 404, { error: "Utgiften finns inte" });
    await requireAccess(expense.trip_id, user.id);
    await requireActiveTrip(expense.trip_id);
    const [contentType = ""] = String(request.headers["content-type"] || "").split(";", 1);
    const mimeType = contentType.trim().toLowerCase();
    if (!receiptMimeTypes.has(mimeType)) throw new HttpError(415, "Kvitton måste vara JPG, PNG, WebP eller PDF");
    const uploaded = await readBytes(request, receiptMaximumBytes);
    if (!receiptContentMatches(mimeType, uploaded)) throw new HttpError(415, "Filens innehåll matchar inte det valda filformatet");
    let content = uploaded;
    let storedMimeType = mimeType;
    let fileName = safeReceiptName(request.headers["x-file-name"]);
    if (receiptImageMimeTypes.has(mimeType)) {
      // Never trust client-side compression: re-validate dimensions and re-normalize with Sharp
      // before anything gets stored, regardless of what the uploader's browser already did.
      safeReceiptImageDimensions(mimeType, uploaded);
      const normalized = await normalizeReceiptImage(uploaded);
      content = normalized.content;
      storedMimeType = normalized.mimeType;
      fileName = `${fileName.replace(/\.\w+$/, "")}.jpg`;
    }
    const receiptId = await db.transaction(async () => {
      // Lock the expense row so two concurrent uploads on the same expense can't both pass the count
      // check before either insert commits and end up exceeding receiptMaximumCount.
      await db.prepare("SELECT id FROM expenses WHERE id = ? FOR UPDATE").get(expense.id);
      const receiptCount = Number((await db.prepare("SELECT COUNT(*) count FROM expense_receipts WHERE expense_id = ?").get<any>(expense.id))?.count || 0);
      if (receiptCount >= receiptMaximumCount) throw new HttpError(409, `Högst ${receiptMaximumCount} kvitton per utgift`);
      const result = await db.prepare("INSERT INTO expense_receipts (expense_id, trip_id, file_name, mime_type, byte_size, content, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .run(expense.id, expense.trip_id, fileName, storedMimeType, content.length, content, user.id);
      return Number(result.lastInsertRowid);
    });
    await audit(user.id, expense.trip_id, "receipt.created", "receipt", receiptId, { expenseId: expense.id, fileName, byteSize: content.length });
    return json(response, 201, { trip: await loadTrip(expense.trip_id, user.id) });
  }
  match = url.pathname.match(/^\/api\/receipts\/(\d+)$/);
  if (request.method === "GET" && match) {
    const receipt = await db.prepare("SELECT * FROM expense_receipts WHERE id = ?").get<any>(Number(match[1]));
    if (!receipt) return json(response, 404, { error: "Kvittot finns inte" });
    await requireAccess(receipt.trip_id, user.id);
    const content = Buffer.from(receipt.content);
    response.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": receipt.mime_type,
      "Content-Length": String(content.length),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(receipt.file_name)}`,
      "Cache-Control": "private, no-store",
    });
    response.end(content);
    return;
  }
  if (request.method === "DELETE" && match) {
    const receipt = await db.prepare("SELECT * FROM expense_receipts WHERE id = ?").get<any>(Number(match[1]));
    if (!receipt) return json(response, 404, { error: "Kvittot finns inte" });
    await requireRecordWriteAccess(receipt.trip_id, user.id, receipt.created_by);
    await requireActiveTrip(receipt.trip_id);
    await db.transaction(async () => {
      await audit(user.id, receipt.trip_id, "receipt.deleted", "receipt", receipt.id, {
        expenseId: receipt.expense_id, fileName: receipt.file_name, byteSize: receipt.byte_size,
      });
      await db.prepare("DELETE FROM expense_receipts WHERE id = ?").run(receipt.id);
    });
    return json(response, 200, { ok: true });
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
    const category = await activeCategorySlug(body.category);
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
}

const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };
function serveStatic(response: ServerResponse, pathname: string) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(publicDirectory, safePath);
  try { if (!statSync(filePath).isFile()) filePath = join(publicDirectory, "index.html"); }
  catch { filePath = join(publicDirectory, "index.html"); }
  const extension = extname(filePath);
  const isHtml = extension === ".html";
  const isVersionedAsset = [".css", ".js"].includes(extension);
  const content = isHtml
    ? readFileSync(filePath, "utf8")
      .replace('href="/styles.css"', `href="/styles.css?v=${appVersion}"`)
    : readFileSync(filePath);
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Cache-Control": isHtml ? "no-store" : isVersionedAsset ? "public, max-age=31536000, immutable" : "public, max-age=3600",
  });
  response.end(content);
}

await db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
await sweepOrphanedDemoData();
setInterval(() => { void sweepOrphanedDemoData(); }, 60 * 60000).unref();
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
    // Only plain `new Error("...")` throws are intentional, user-facing validation messages (that's
    // the convention used throughout this file). Anything else — TypeError, RangeError, or any other
    // unexpected exception — is a bug, and its message may contain internals, so never forward it.
    const isValidationError = error instanceof Error && error.constructor === Error;
    const message = error instanceof HttpError ? error.message
      : databaseError ? "Databasåtgärden misslyckades"
      : isValidationError ? error.message
      : "Något gick fel. Försök igen.";
    return json(response, status, { error: message });
  }
});
server.listen(port, "0.0.0.0", () => {
  console.log(`Kompis Split körs på http://0.0.0.0:${port}`);
  if (!appPassword) console.warn("APP_PASSWORD saknas. Den första administratören kan inte skapas förrän det är konfigurerat.");
});
function shutdown() { server.close(() => { void Promise.allSettled([closeReceiptOcr(), closeDatabase()]).finally(() => process.exit(0)); }); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
