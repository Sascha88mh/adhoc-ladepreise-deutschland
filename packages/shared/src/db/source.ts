export type AppDataSource = "demo" | "db";

export function databaseUrl() {
  return process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? null;
}

export function getAppDataSource(): AppDataSource {
  if (process.env.APP_DATA_SOURCE === "db" && databaseUrl()) {
    return "db";
  }

  return "demo";
}

export function usingDatabase() {
  return getAppDataSource() === "db";
}
