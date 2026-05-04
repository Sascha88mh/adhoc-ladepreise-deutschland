import { Pool } from "pg";
import { databaseUrl } from "./source";

const DEFAULT_PG_POOL_MAX = 3;

declare global {
  // eslint-disable-next-line no-var
  var __adhocPgPool: Pool | undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

export function configuredPgPoolMax() {
  return Math.max(2, parsePositiveInteger(process.env.PG_POOL_MAX, DEFAULT_PG_POOL_MAX));
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
  const message = error.message.toLowerCase();
  return (
    code === "XX000" ||
    code === "53300" ||
    message.includes("emaxconnsession") ||
    message.includes("echeckouttimeout") ||
    message.includes("unable to check out connection") ||
    message.includes("max clients reached") ||
    message.includes("too many clients") ||
    message.includes("remaining connection slots are reserved") ||
    message.includes("edbhandlerexited") ||
    message.includes("connection terminated unexpectedly")
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
      max: configuredPgPoolMax(),
      connectionTimeoutMillis: parsePositiveInteger(process.env.PG_CONNECTION_TIMEOUT_MS, 5_000),
      idleTimeoutMillis: parsePositiveInteger(process.env.PG_IDLE_TIMEOUT_MS, 10_000),
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
