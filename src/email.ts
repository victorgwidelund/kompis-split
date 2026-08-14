import { db } from "./database.js";

export class EmailError extends Error {}

// Overridable only so the integration test suite can point at a local mock instead of real
// Microsoft endpoints -- unset in production, where these are always the real Graph hosts.
const graphTokenBase = process.env.GRAPH_TOKEN_BASE || "https://login.microsoftonline.com";
const graphApiBase = process.env.GRAPH_API_BASE || "https://graph.microsoft.com/v1.0";

interface EmailSettings {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderEmail: string;
}

// A single in-memory token cache is fine here: one process, one configured sender, and a changed
// secret always goes through saveEmailSettings() below, which clears it.
let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

async function settingsRow() {
  return db.prepare("SELECT tenant_id, client_id, client_secret, sender_email, updated_at FROM email_settings WHERE id = 1").get<any>();
}

export async function emailSettingsStatus() {
  const row = await settingsRow();
  return {
    tenantId: row?.tenant_id || "",
    clientId: row?.client_id || "",
    senderEmail: row?.sender_email || "",
    hasSecret: Boolean(row?.client_secret),
    configured: Boolean(row?.tenant_id && row?.client_id && row?.client_secret && row?.sender_email),
    updatedAt: row?.updated_at || null,
  };
}

export async function saveEmailSettings(input: { tenantId: string; clientId: string; clientSecret?: string; senderEmail: string }, updatedBy: number) {
  const existing = await settingsRow();
  const clientSecret = input.clientSecret ? input.clientSecret : (existing?.client_secret || null);
  await db.prepare(`
    INSERT INTO email_settings (id, tenant_id, client_id, client_secret, sender_email, updated_at, updated_by)
    VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT (id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id, client_id = EXCLUDED.client_id, client_secret = EXCLUDED.client_secret,
      sender_email = EXCLUDED.sender_email, updated_at = CURRENT_TIMESTAMP, updated_by = EXCLUDED.updated_by
  `).run(input.tenantId, input.clientId, clientSecret, input.senderEmail, updatedBy);
  tokenCache = null;
}

async function requireSettings(): Promise<EmailSettings> {
  const row = await settingsRow();
  if (!row?.tenant_id || !row?.client_id || !row?.client_secret || !row?.sender_email) {
    throw new EmailError("E-post är inte konfigurerad. Ställ in det under Administration.");
  }
  return { tenantId: row.tenant_id, clientId: row.client_id, clientSecret: row.client_secret, senderEmail: row.sender_email };
}

async function accessToken(settings: EmailSettings): Promise<string> {
  const cacheKey = `${settings.tenantId}:${settings.clientId}`;
  const now = Date.now();
  if (tokenCache && tokenCache.key === cacheKey && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  let response: Response;
  try {
    response = await fetch(`${graphTokenBase}/${encodeURIComponent(settings.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
  } catch {
    throw new EmailError("Kunde inte nå Microsoft för att hämta en åtkomsttoken.");
  }
  if (!response.ok) throw new EmailError("Kunde inte hämta åtkomsttoken från Microsoft Graph. Kontrollera tenant-ID, klient-ID och klienthemlighet.");
  const payload = await response.json() as { access_token?: string; expires_in?: number };
  if (!payload.access_token) throw new EmailError("Microsoft Graph returnerade ingen token.");
  tokenCache = { key: cacheKey, token: payload.access_token, expiresAt: now + Number(payload.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const settings = await requireSettings();
  const token = await accessToken(settings);
  let response: Response;
  try {
    response = await fetch(`${graphApiBase}/users/${encodeURIComponent(settings.senderEmail)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { subject, body: { contentType: "Text", content: text }, toRecipients: [{ emailAddress: { address: to } }] },
        saveToSentItems: false,
      }),
    });
  } catch {
    throw new EmailError("Kunde inte nå Microsoft Graph för att skicka mailet.");
  }
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new EmailError(`Kunde inte skicka e-post (${response.status}). ${errorBody.slice(0, 300)}`.trim());
  }
}
