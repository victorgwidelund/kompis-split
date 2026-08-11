import { pool } from "./database.js";

export const migrationVersions = [1, 2, 3, 4, 5] as const;

const schema = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE CHECK(email = lower(email)),
    display_name TEXT NOT NULL CHECK(char_length(display_name) BETWEEN 1 AND 60),
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    swish_phone TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS trips (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80),
    start_date DATE,
    end_date DATE,
    created_by BIGINT REFERENCES users(id),
    archived_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    deleted_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
  );
  CREATE TABLE IF NOT EXISTS participants (
    id BIGSERIAL PRIMARY KEY,
    trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 60),
    swish_phone TEXT,
    user_id BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id BIGSERIAL PRIMARY KEY,
    trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    payer_id BIGINT NOT NULL REFERENCES participants(id),
    title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 100),
    amount_cents BIGINT NOT NULL CHECK(amount_cents > 0),
    expense_date DATE,
    category TEXT NOT NULL DEFAULT 'other',
    split_mode TEXT NOT NULL CHECK(split_mode IN ('equal','shares','percentage','exact')),
    created_by BIGINT REFERENCES users(id),
    voided_at TIMESTAMPTZ,
    voided_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expense_categories (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE CHECK(char_length(slug) BETWEEN 1 AND 40),
    name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 40),
    emoji TEXT NOT NULL CHECK(char_length(emoji) BETWEEN 1 AND 16),
    is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
    created_by BIGINT REFERENCES users(id),
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expense_receipts (
    id BIGSERIAL PRIMARY KEY,
    expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL CHECK(char_length(file_name) BETWEEN 1 AND 180),
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK(byte_size > 0),
    content BYTEA NOT NULL,
    created_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id BIGINT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    participant_id BIGINT NOT NULL REFERENCES participants(id),
    amount_cents BIGINT NOT NULL CHECK(amount_cents >= 0),
    PRIMARY KEY (expense_id, participant_id)
  );
  CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    from_id BIGINT NOT NULL REFERENCES participants(id),
    to_id BIGINT NOT NULL REFERENCES participants(id),
    amount_cents BIGINT NOT NULL CHECK(amount_cents > 0),
    note TEXT,
    created_by BIGINT REFERENCES users(id),
    voided_at TIMESTAMPTZ,
    voided_by BIGINT REFERENCES users(id),
    paid_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(from_id <> to_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS trip_access (
    trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (trip_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS contacts (
    owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_user_id, contact_user_id),
    CHECK(owner_user_id <> contact_user_id)
  );
  CREATE TABLE IF NOT EXISTS invitations (
    id BIGSERIAL PRIMARY KEY,
    trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by BIGINT NOT NULL REFERENCES users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 20 CHECK(max_uses BETWEEN 1 AND 100),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0 AND use_count <= max_uses),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS friend_invitations (
    id BIGSERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by BIGINT NOT NULL REFERENCES users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count BETWEEN 0 AND 1),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id BIGINT REFERENCES users(id),
    trip_id BIGINT REFERENCES trips(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id BIGINT,
    payload_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_participants_trip ON participants(trip_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_trip_user ON participants(trip_id, user_id) WHERE user_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_expenses_trip_date ON expenses(trip_id, expense_date) WHERE voided_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_receipts_expense ON expense_receipts(expense_id, id);
  CREATE INDEX IF NOT EXISTS idx_receipts_trip ON expense_receipts(trip_id);
  CREATE INDEX IF NOT EXISTS idx_payments_trip ON payments(trip_id) WHERE voided_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_trip_access_user ON trip_access(user_id, trip_id);
  CREATE INDEX IF NOT EXISTS idx_users_name ON users(lower(display_name));
  CREATE INDEX IF NOT EXISTS idx_invites_hash ON invitations(token_hash);
  CREATE INDEX IF NOT EXISTS idx_friend_invites_hash ON friend_invitations(token_hash);
  CREATE INDEX IF NOT EXISTS idx_audit_trip ON audit_log(trip_id, created_at);
`;

export async function applyMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [837_451_902]);
    await client.query("BEGIN");
    await client.query(schema);
    await client.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [1, "initial-postgresql-schema"],
    );
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE");
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE");
    await client.query("ALTER TABLE expenses ALTER COLUMN expense_date DROP NOT NULL");
    await client.query(`
      UPDATE users SET is_admin = TRUE
      WHERE id = (SELECT MIN(id) FROM users)
        AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = TRUE)
    `);
    await client.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [2, "global-admin-and-optional-expense-date"],
    );
    await client.query("ALTER TABLE trips ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
    await client.query("ALTER TABLE trips ADD COLUMN IF NOT EXISTS deleted_by BIGINT REFERENCES users(id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_trips_visible ON trips(id) WHERE deleted_at IS NULL");
    await client.query(`
      INSERT INTO expense_categories (slug, name, emoji, is_builtin)
      VALUES
        ('food', 'Mat och dryck', '🍝', TRUE),
        ('travel', 'Resa', '🚆', TRUE),
        ('stay', 'Boende', '🏡', TRUE),
        ('fun', 'Aktiviteter', '🎟️', TRUE),
        ('other', 'Övrigt', '🧾', TRUE)
      ON CONFLICT (slug) DO NOTHING
    `);
    await client.query(`
      INSERT INTO expense_categories (slug, name, emoji, is_builtin)
      SELECT DISTINCT category, category, '🧾', FALSE FROM expenses
      WHERE category IS NOT NULL AND category <> ''
      ON CONFLICT (slug) DO NOTHING
    `);
    await client.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [3, "trip-trash-categories-receipts-and-friend-invites"],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS quick_tabs (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
        merchant TEXT CHECK(merchant IS NULL OR char_length(merchant) <= 100),
        receipt_date DATE,
        total_cents BIGINT NOT NULL CHECK(total_cents > 0),
        receipt_mime_type TEXT,
        receipt_content BYTEA,
        created_by BIGINT NOT NULL REFERENCES users(id),
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS quick_tab_access (
        quick_tab_id BIGINT NOT NULL REFERENCES quick_tabs(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
        joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (quick_tab_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS quick_tab_items (
        id BIGSERIAL PRIMARY KEY,
        quick_tab_id BIGINT NOT NULL REFERENCES quick_tabs(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
        amount_cents BIGINT NOT NULL CHECK(amount_cents > 0),
        position INTEGER NOT NULL CHECK(position >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS quick_tab_claims (
        item_id BIGINT NOT NULL REFERENCES quick_tab_items(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (item_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS quick_tab_invitations (
        id BIGSERIAL PRIMARY KEY,
        quick_tab_id BIGINT NOT NULL REFERENCES quick_tabs(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        invited_by BIGINT NOT NULL REFERENCES users(id),
        expires_at TIMESTAMPTZ NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 30 CHECK(max_uses BETWEEN 1 AND 100),
        use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0 AND use_count <= max_uses),
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_quick_tab_access_user ON quick_tab_access(user_id, quick_tab_id);
      CREATE INDEX IF NOT EXISTS idx_quick_tab_items_tab ON quick_tab_items(quick_tab_id, position, id);
      CREATE INDEX IF NOT EXISTS idx_quick_tab_claims_user ON quick_tab_claims(user_id, item_id);
      CREATE INDEX IF NOT EXISTS idx_quick_tab_invites_hash ON quick_tab_invitations(token_hash);
    `);
    await client.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [4, "standalone-realtime-quick-tabs"],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS quick_tab_guests (
        id BIGSERIAL PRIMARY KEY,
        quick_tab_id BIGINT NOT NULL REFERENCES quick_tabs(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL CHECK(char_length(display_name) BETWEEN 1 AND 60),
        swish_phone TEXT NOT NULL CHECK(char_length(swish_phone) BETWEEN 8 AND 24),
        session_id TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE quick_tab_claims ADD COLUMN IF NOT EXISTS guest_id BIGINT REFERENCES quick_tab_guests(id) ON DELETE CASCADE;
      ALTER TABLE quick_tab_claims DROP CONSTRAINT IF EXISTS quick_tab_claims_pkey;
      ALTER TABLE quick_tab_claims ALTER COLUMN user_id DROP NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_tab_claims_user_unique ON quick_tab_claims(item_id, user_id) WHERE user_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_tab_claims_guest_unique ON quick_tab_claims(item_id, guest_id) WHERE guest_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_quick_tab_guests_tab ON quick_tab_guests(quick_tab_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_quick_tab_guests_session ON quick_tab_guests(session_id, expires_at);
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quick_tab_claims_one_identity') THEN
          ALTER TABLE quick_tab_claims ADD CONSTRAINT quick_tab_claims_one_identity
            CHECK ((user_id IS NOT NULL)::integer + (guest_id IS NOT NULL)::integer = 1);
        END IF;
      END $$
    `);
    await client.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [5, "accountless-quick-tab-guests"],
    );
    await client.query(`
      ALTER TABLE quick_tab_items
        ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 20);
      ALTER TABLE quick_tab_claims
        ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 20);
    `);
    await client.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [6, "quick-tab-item-and-claim-quantities"],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [837_451_902]).catch(() => undefined);
    client.release();
  }
}
