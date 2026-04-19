export type AppDataSource = "demo" | "db";

export function databaseUrl() {
  return process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? null;
}

function demoDataAllowed() {
  return process.env.ALLOW_DEMO_DATA === "1";
}

function productionRuntime() {
  return process.env.NODE_ENV === "production";
}

export function getAppDataSource(): AppDataSource {
  if (process.env.APP_DATA_SOURCE === "db" && databaseUrl()) {
    return "db";
  }

  if (productionRuntime() && !demoDataAllowed()) {
    throw new Error(
      "Live runtime requires APP_DATA_SOURCE=db and DATABASE_URL or SUPABASE_DB_URL. " +
        "Demo data is disabled in production unless ALLOW_DEMO_DATA=1 is set explicitly.",
    );
  }

  return "demo";
}

export function usingDatabase() {
  return getAppDataSource() === "db";
}
