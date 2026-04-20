import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AppDataSource = "db";

type ResolvedEnv = {
  APP_DATA_SOURCE?: string;
  DATABASE_URL?: string;
  SUPABASE_DB_URL?: string;
};

function workspaceRoot() {
  let current = process.cwd();

  while (current !== dirname(current)) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    current = dirname(current);
  }

  return process.cwd();
}

function parseEnvFile(path: string): ResolvedEnv {
  const parsed: ResolvedEnv = {};

  if (!existsSync(path)) {
    return parsed;
  }

  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (
      key === "APP_DATA_SOURCE" ||
      key === "DATABASE_URL" ||
      key === "SUPABASE_DB_URL"
    ) {
      parsed[key] = value;
    }
  }

  return parsed;
}

function mergedEnv(): ResolvedEnv {
  const root = workspaceRoot();
  const candidates = [
    join(root, ".env.local"),
    join(root, ".env"),
    join(root, "apps", "web", ".env.local"),
    join(root, "apps", "web", ".env"),
  ];

  const fileEnv = candidates.reduce<ResolvedEnv>(
    (acc, path) => ({ ...acc, ...parseEnvFile(path) }),
    {},
  );

  return {
    ...fileEnv,
    APP_DATA_SOURCE: process.env.APP_DATA_SOURCE ?? fileEnv.APP_DATA_SOURCE,
    DATABASE_URL: process.env.DATABASE_URL ?? fileEnv.DATABASE_URL,
    SUPABASE_DB_URL: process.env.SUPABASE_DB_URL ?? fileEnv.SUPABASE_DB_URL,
  };
}

export function databaseUrl() {
  const env = mergedEnv();
  return env.DATABASE_URL ?? env.SUPABASE_DB_URL ?? null;
}

export function getAppDataSource(): AppDataSource {
  const env = mergedEnv();

  if (env.APP_DATA_SOURCE === "db" && databaseUrl()) {
    return "db";
  }

  throw new Error(
    "APP_DATA_SOURCE=db und DATABASE_URL oder SUPABASE_DB_URL sind erforderlich. " +
      "Lege sie in apps/web/.env.local oder im Repo-Root in .env.local ab, " +
      "oder exportiere sie im Shell-Prozess.",
  );
}

export function usingDatabase() {
  getAppDataSource();
  return true;
}
