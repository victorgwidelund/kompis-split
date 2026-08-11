import { AsyncLocalStorage } from "node:async_hooks";
import pg, { type PoolClient, type QueryResultRow } from "pg";

pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

if (!process.env.DATABASE_URL && !process.env.PGHOST) throw new Error("DATABASE_URL eller PGHOST saknas");

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE || 10),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

const transactionClient = new AsyncLocalStorage<PoolClient>();

function postgresSql(sql: string): string {
  let parameter = 0;
  return sql.replace(/\?/g, () => `$${++parameter}`);
}

async function query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
  return (transactionClient.getStore() || pool).query<Row>(postgresSql(sql), values);
}

export const db = {
  prepare(sql: string) {
    return {
      async get<Row extends QueryResultRow = QueryResultRow>(...values: unknown[]): Promise<Row | undefined> {
        return (await query<Row>(sql, values)).rows[0];
      },
      async all<Row extends QueryResultRow = QueryResultRow>(...values: unknown[]): Promise<Row[]> {
        return (await query<Row>(sql, values)).rows;
      },
      async run(...values: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
        const result = await query(sql, values);
        return { changes: result.rowCount || 0, lastInsertRowid: result.rows[0]?.id === undefined ? undefined : Number(result.rows[0].id) };
      },
    };
  },
  async exec(sql: string): Promise<void> { await query(sql); },
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await transactionClient.run(client, work);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

export async function closeDatabase(): Promise<void> { await pool.end(); }
export async function databaseReady(): Promise<boolean> {
  try { await pool.query("SELECT 1"); return true; } catch { return false; }
}
