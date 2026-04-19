import { Pool } from "pg";
import { databaseUrl } from "./source";

declare global {
  // eslint-disable-next-line no-var
  var __adhocPgPool: Pool | undefined;
}

export function resetPool() {
  const pool = globalThis.__adhocPgPool;
  globalThis.__adhocPgPool = undefined;
  return pool?.end().catch(() => undefined);
}

export function isRetryableDbError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = "code" in error ? String((error as { code?: string }).code ?? "") : "";
  return (
    code === "XX000" ||
    error.message.includes("EDBHANDLEREXITED") ||
    error.message.includes("Connection terminated unexpectedly")
  );
}

export function getPool() {
  if (!globalThis.__adhocPgPool) {
    const connectionString = databaseUrl();

    if (!connectionString) {
      throw new Error("DATABASE_URL or SUPABASE_DB_URL is required for APP_DATA_SOURCE=db");
    }

    const pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      keepAlive: true,
      ssl: connectionString.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
    });

    pool.on("error", (error) => {
      console.error("[db] pool error:", error);
      void resetPool();
    });

    globalThis.__adhocPgPool = pool;
  }

  return globalThis.__adhocPgPool;
}
