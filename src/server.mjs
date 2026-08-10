import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateShares, simplifyDebts } from "./split.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(here, "..", "public");
const port = Number(process.env.PORT || 8787);
const databasePath = process.env.DB_PATH || join(here, "..", "data", "kompis-split.db");
const appPassword = process.env.APP_PASSWORD || "";
const cookieSecure = process.env.COOKIE_SECURE === "true";
const cookieSecret = process.env.COOKIE_SECRET || createHmac("sha256", appPassword || "local-only").update("kompis-split").digest("hex");

mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    start_date TEXT,
    end_date TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    swish_phone TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    payer_id INTEGER NOT NULL REFERENCES participants(id),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    expense_date TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    split_mode TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL REFERENCES participants(id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    PRIMARY KEY (expense_id, participant_id)
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    from_id INTEGER NOT NULL REFERENCES participants(id),
    to_id INTEGER NOT NULL REFERENCES participants(id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    note TEXT,
    paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_participants_trip ON participants(trip_id);
  CREATE INDEX IF NOT EXISTS idx_expenses_trip_date ON expenses(trip_id, expense_date);
  CREATE INDEX IF NOT EXISTS idx_payments_trip ON payments(trip_id);
`);

const statements = {
  trips: db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM participants p WHERE p.trip_id = t.id) participant_count,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM expenses e WHERE e.trip_id = t.id) total_cents
    FROM trips t ORDER BY t.created_at DESC, t.id DESC
  `),
  trip: db.prepare("SELECT * FROM trips WHERE id = ?"),
  participants: db.prepare("SELECT * FROM participants WHERE trip_id = ? ORDER BY id"),
  expenses: db.prepare("SELECT * FROM expenses WHERE trip_id = ? ORDER BY expense_date DESC, id DESC"),
  shares: db.prepare("SELECT participant_id, amount_cents FROM expense_shares WHERE expense_id = ? ORDER BY participant_id"),
  payments: db.prepare("SELECT * FROM payments WHERE trip_id = ? ORDER BY paid_at DESC, id DESC"),
};

function cleanText(value, field, maximum = 100) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > maximum) throw new Error(`${field} is too long`);
  return text;
}

function parseAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw new Error("Enter a valid amount");
  return Math.round(amount * 100);
}

function validDate(value, fallback = null) {
  if (!value) return fallback;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("Enter a valid date");
  return text;
}

function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (digits.startsWith("0")) digits = `+46${digits.slice(1)}`;
  const compact = digits.replace(/\D/g, "");
  if (compact.length < 8 || compact.length > 15) throw new Error("Enter a valid Swish phone number");
  return digits;
}

function loadTrip(id) {
  const trip = statements.trip.get(id);
  if (!trip) return null;
  const participants = statements.participants.all(id).map((person) => ({
    id: person.id,
    name: person.name,
    swishPhone: person.swish_phone,
  }));
  const expenses = statements.expenses.all(id).map((expense) => ({
    id: expense.id,
    payerId: expense.payer_id,
    title: expense.title,
    amountCents: expense.amount_cents,
    expenseDate: expense.expense_date,
    category: expense.category,
    splitMode: expense.split_mode,
    shares: statements.shares.all(expense.id).map((share) => ({
      participantId: share.participant_id,
      amountCents: share.amount_cents,
    })),
  }));
  const payments = statements.payments.all(id).map((payment) => ({
    id: payment.id,
    fromId: payment.from_id,
    toId: payment.to_id,
    amountCents: payment.amount_cents,
    note: payment.note,
    paidAt: payment.paid_at,
  }));
  const totals = simplifyDebts(participants, expenses, payments);
  return {
    id: trip.id,
    name: trip.name,
    startDate: trip.start_date,
    endDate: trip.end_date,
    createdAt: trip.created_at,
    participants,
    expenses,
    payments,
    balances: totals.balances,
    settlements: totals.settlements,
    totalCents: expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
  };
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Invalid JSON");
  }
}

function cookieValue(request, name) {
  const pair = String(request.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : "";
}

function signature(value) {
  return createHmac("sha256", cookieSecret).update(value).digest("hex");
}

function isAuthenticated(request) {
  if (!appPassword) return true;
  const token = cookieValue(request, "kompis_session");
  const [value, supplied] = token.split(".");
  if (value !== "authenticated" || !supplied) return false;
  const expected = signature(value);
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function sessionCookie() {
  return `kompis_session=authenticated.${signature("authenticated")}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${cookieSecure ? "; Secure" : ""}`;
}

function assertTripParticipant(tripId, participantId) {
  const person = db.prepare("SELECT id FROM participants WHERE id = ? AND trip_id = ?").get(participantId, tripId);
  if (!person) throw new Error("A selected participant does not belong to this trip");
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/session") {
    return json(response, 200, { authenticated: isAuthenticated(request), passwordRequired: Boolean(appPassword) });
  }
  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(request);
    if (!appPassword || String(body.password || "") === appPassword) {
      return json(response, 200, { ok: true }, { "Set-Cookie": sessionCookie() });
    }
    return json(response, 401, { error: "Incorrect password" });
  }
  if (request.method === "POST" && url.pathname === "/api/logout") {
    return json(response, 200, { ok: true }, { "Set-Cookie": "kompis_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });
  }
  if (!isAuthenticated(request)) return json(response, 401, { error: "Sign in required" });

  if (request.method === "GET" && url.pathname === "/api/trips") {
    const trips = statements.trips.all().map((trip) => ({
      id: trip.id,
      name: trip.name,
      startDate: trip.start_date,
      endDate: trip.end_date,
      participantCount: trip.participant_count,
      totalCents: trip.total_cents,
    }));
    return json(response, 200, { trips });
  }
  if (request.method === "POST" && url.pathname === "/api/trips") {
    const body = await readJson(request);
    const result = db.prepare("INSERT INTO trips (name, start_date, end_date) VALUES (?, ?, ?)").run(
      cleanText(body.name, "Trip name", 80),
      validDate(body.startDate),
      validDate(body.endDate),
    );
    return json(response, 201, { trip: loadTrip(Number(result.lastInsertRowid)) });
  }

  let match = url.pathname.match(/^\/api\/trips\/(\d+)$/);
  if (request.method === "GET" && match) {
    const trip = loadTrip(Number(match[1]));
    return trip ? json(response, 200, { trip }) : json(response, 404, { error: "Trip not found" });
  }
  if (request.method === "DELETE" && match) {
    const result = db.prepare("DELETE FROM trips WHERE id = ?").run(Number(match[1]));
    return result.changes ? json(response, 200, { ok: true }) : json(response, 404, { error: "Trip not found" });
  }

  match = url.pathname.match(/^\/api\/trips\/(\d+)\/participants$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]);
    if (!statements.trip.get(tripId)) return json(response, 404, { error: "Trip not found" });
    const body = await readJson(request);
    db.prepare("INSERT INTO participants (trip_id, name, swish_phone) VALUES (?, ?, ?)").run(
      tripId,
      cleanText(body.name, "Name", 60),
      normalizePhone(body.swishPhone),
    );
    return json(response, 201, { trip: loadTrip(tripId) });
  }

  match = url.pathname.match(/^\/api\/trips\/(\d+)\/expenses$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]);
    const body = await readJson(request);
    const payerId = Number(body.payerId);
    assertTripParticipant(tripId, payerId);
    const amountCents = parseAmount(body.amount);
    const entries = Array.isArray(body.entries) ? body.entries.map((entry) => ({ participantId: Number(entry.participantId), value: entry.value })) : [];
    entries.forEach((entry) => assertTripParticipant(tripId, entry.participantId));
    if (new Set(entries.map((entry) => entry.participantId)).size !== entries.length) throw new Error("Each participant can only appear once in a split");
    const amounts = calculateShares(amountCents, String(body.splitMode || "equal"), entries);

    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare(`
        INSERT INTO expenses (trip_id, payer_id, title, amount_cents, expense_date, category, split_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        tripId,
        payerId,
        cleanText(body.title, "Description", 100),
        amountCents,
        validDate(body.expenseDate, new Date().toISOString().slice(0, 10)),
        cleanText(body.category || "other", "Category", 30),
        String(body.splitMode || "equal"),
      );
      const expenseId = Number(result.lastInsertRowid);
      const insertShare = db.prepare("INSERT INTO expense_shares (expense_id, participant_id, amount_cents) VALUES (?, ?, ?)");
      entries.forEach((entry, index) => insertShare.run(expenseId, entry.participantId, amounts[index]));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return json(response, 201, { trip: loadTrip(tripId) });
  }

  match = url.pathname.match(/^\/api\/trips\/(\d+)\/payments$/);
  if (request.method === "POST" && match) {
    const tripId = Number(match[1]);
    const body = await readJson(request);
    const fromId = Number(body.fromId);
    const toId = Number(body.toId);
    assertTripParticipant(tripId, fromId);
    assertTripParticipant(tripId, toId);
    if (fromId === toId) throw new Error("Sender and recipient must be different");
    db.prepare("INSERT INTO payments (trip_id, from_id, to_id, amount_cents, note) VALUES (?, ?, ?, ?, ?)").run(
      tripId,
      fromId,
      toId,
      parseAmount(body.amount),
      body.note ? cleanText(body.note, "Note", 120) : null,
    );
    return json(response, 201, { trip: loadTrip(tripId) });
  }

  match = url.pathname.match(/^\/api\/expenses\/(\d+)$/);
  if (request.method === "DELETE" && match) {
    const result = db.prepare("DELETE FROM expenses WHERE id = ?").run(Number(match[1]));
    return result.changes ? json(response, 200, { ok: true }) : json(response, 404, { error: "Expense not found" });
  }

  match = url.pathname.match(/^\/api\/payments\/(\d+)$/);
  if (request.method === "DELETE" && match) {
    const result = db.prepare("DELETE FROM payments WHERE id = ?").run(Number(match[1]));
    return result.changes ? json(response, 200, { ok: true }) : json(response, 404, { error: "Payment not found" });
  }
  return json(response, 404, { error: "Not found" });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(publicDirectory, safePath);
  try {
    if (!statSync(filePath).isFile()) filePath = join(publicDirectory, "index.html");
  } catch {
    filePath = join(publicDirectory, "index.html");
  }
  const content = readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  response.end(content);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/health") return json(response, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed" });
    return serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Something went wrong";
    return json(response, 400, { error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Kompis Split is running on http://0.0.0.0:${port}`);
  if (!appPassword) console.warn("APP_PASSWORD is empty. Anyone who can reach the app can change its data.");
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
