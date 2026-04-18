import { Pool } from "pg";
import { databaseUrl } from "./source";

declare global {
  // eslint-disable-next-line no-var
  var __adhocPgPool: Pool | undefined;
}

export function getPool() {
  if (!globalThis.__adhocPgPool) {
    const connectionString = databaseUrl();

    if (!connectionString) {
      throw new Error("DATABASE_URL or SUPABASE_DB_URL is required for APP_DATA_SOURCE=db");
    }

    globalThis.__adhocPgPool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      ssl: connectionString.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
    });
  }

  return globalThis.__adhocPgPool;
}
