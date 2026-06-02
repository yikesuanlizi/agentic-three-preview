import pg from "pg";

const { Pool } = pg;

export const ragDatabaseUrl =
  process.env.RAG_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://agentic_three:agentic_three_dev@127.0.0.1:54329/agentic_three";

let pool: pg.Pool | undefined;

export function getRagPool(): pg.Pool {
  pool ??= new Pool({
    connectionString: ragDatabaseUrl,
    max: 4,
    connectionTimeoutMillis: 1500,
  });
  return pool;
}

export async function isRagDatabaseReady(): Promise<boolean> {
  try {
    await getRagPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
