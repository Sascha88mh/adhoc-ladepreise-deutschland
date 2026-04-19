import axios from "axios";
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import type { FeedConfig } from "../domain/types";
import { getAppSecret } from "../db/admin";
import { usingDatabase } from "../db/source";

type PullResult = {
  payload: string;
  lastModified: string | null;
};

/**
 * Mobilithek endpoints can return payloads up to ~80 MB (Vaylens static AFIR).
 * axios defaults to 10 MB which silently truncates big responses, producing
 * "Unexpected end of JSON" errors downstream. We size generously.
 */
const MAX_RESPONSE_BYTES = 200 * 1024 * 1024;

function normalizeRef(ref: string | null) {
  return ref?.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase() ?? null;
}

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

function fixturePath(filename: string) {
  return join(workspaceRoot(), "db", "fixtures", filename);
}

function readFixture(type: FeedConfig["type"]) {
  return readFileSync(
    fixturePath(type === "static" ? "mobilithek-static.sample.json" : "mobilithek-dynamic.sample.json"),
    "utf8",
  );
}

function envValue(ref: string | null, suffix: string) {
  const normalized = normalizeRef(ref);
  if (normalized && process.env[`${normalized}_${suffix}`]) {
    return process.env[`${normalized}_${suffix}`] ?? null;
  }

  return process.env[`MOBILITHEK_${suffix}`] ?? null;
}

/** Resolve a credential value: env var first, then `app_secrets` row (ref-specific → MOBILITHEK_ fallback). */
async function resolveCredentialValue(ref: string | null, suffix: string): Promise<string | null> {
  const fromEnv = envValue(ref, suffix);
  if (fromEnv) return fromEnv;

  if (usingDatabase()) {
    const normalized = normalizeRef(ref);
    if (normalized) {
      const fromDb = await getAppSecret(`${normalized}_${suffix}`);
      if (fromDb) return fromDb;
    }
    return getAppSecret(`MOBILITHEK_${suffix}`);
  }

  return null;
}

async function buildAgent(feed: FeedConfig): Promise<https.Agent> {
  const credentialRef = feed.credentialRef;
  const cert = await resolveCredentialValue(credentialRef, "CLIENT_CERT");
  const key = await resolveCredentialValue(credentialRef, "CLIENT_KEY");
  const p12 = await resolveCredentialValue(credentialRef, "CERT_P12_BASE64");
  const password = (await resolveCredentialValue(credentialRef, "CERT_PASSWORD")) ?? "";

  if (cert && key) {
    return new https.Agent({
      cert: cert.replace(/\\n/g, "\n"),
      key: key.replace(/\\n/g, "\n"),
      keepAlive: true,
    });
  }

  if (p12) {
    return new https.Agent({
      pfx: Buffer.from(p12, "base64"),
      passphrase: password,
      keepAlive: true,
    });
  }

  // No cert configured. Mobilithek m2m endpoints enforce mTLS at the Azure
  // gateway and reject cert-less requests with "400 No required SSL certificate
  // was sent". Fail fast with an actionable message instead of producing that
  // cryptic error at request time.
  const refHint = normalizeRef(credentialRef) ?? "MOBILITHEK";
  throw new Error(
    `Kein Mobilithek-Client-Zertifikat für Feed "${feed.name}" konfiguriert. ` +
      `Erwartet: env var ${refHint}_CERT_P12_BASE64 (+ ${refHint}_CERT_PASSWORD) ` +
      `oder ${refHint}_CLIENT_CERT + ${refHint}_CLIENT_KEY, ` +
      `oder global MOBILITHEK_CERT_P12_BASE64, ` +
      `oder ein gleichnamiger Eintrag in der Tabelle app_secrets.`,
  );
}

function baseUrl() {
  return process.env.MOBILITHEK_BASE_URL ?? "https://m2m.mobilithek.info";
}

function shouldUseFixtures() {
  return process.env.MOBILITHEK_USE_FIXTURES === "1";
}

export function resolveSecretRef(ref: string | null) {
  if (!ref) {
    return null;
  }

  return envValue(ref, "WEBHOOK_SECRET");
}

async function createHttpClient(feed: FeedConfig) {
  return axios.create({
    baseURL: baseUrl(),
    httpsAgent: await buildAgent(feed),
    headers: {
      accept: "application/json",
      // Per OpenAPI_Spec_982312651690225664.yaml: Accept-Encoding: gzip is REQUIRED
      // by Mobilithek. Responses are always gzip-compressed; axios/node auto-decompresses.
      "accept-encoding": "gzip",
      "user-agent": process.env.MOBILITHEK_USER_AGENT ?? "AdhocPlattform/1.0",
    },
    timeout: Number(process.env.MOBILITHEK_TIMEOUT_MS ?? 60_000),
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    decompress: true,
  });
}

function mobilithekRequestError(
  error: unknown,
  target: string,
  feed: FeedConfig,
) {
  if (!axios.isAxiosError(error)) {
    return error;
  }

  const status = error.response?.status;
  const statusText = error.response?.statusText;
  const body =
    typeof error.response?.data === "string"
      ? error.response.data.slice(0, 300)
      : error.response?.data != null
        ? JSON.stringify(error.response.data).slice(0, 300)
        : null;

  const details = [
    `Mobilithek request failed for feed "${feed.name}"`,
    status ? `status=${status}` : null,
    statusText ? `statusText=${statusText}` : null,
    `target=${target}`,
    body ? `body=${body}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  return new Error(details, { cause: error });
}

export async function fetchStaticMobilithekPayload(feed: FeedConfig): Promise<string> {
  if (shouldUseFixtures()) {
    return readFixture("static");
  }

  const http = await createHttpClient(feed);
  const target = feed.urlOverride ?? `/mobilithek/api/v1.0/publication/${feed.subscriptionId}`;
  try {
    const response = await http.get<string>(target, {
      responseType: "text",
      transitional: { forcedJSONParsing: false },
    });

    return typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  } catch (error) {
    throw mobilithekRequestError(error, target, feed);
  }
}

export async function pullDynamicMobilithekPayload(
  feed: FeedConfig,
  lastModified?: string | null,
): Promise<PullResult | null> {
  if (shouldUseFixtures()) {
    return {
      payload: readFixture("dynamic"),
      lastModified: new Date().toUTCString(),
    };
  }

  const http = await createHttpClient(feed);
  const target = feed.urlOverride ?? `/mobilithek/api/v1.0/subscription?subscriptionID=${feed.subscriptionId}`;
  try {
    const response = await http.get<string>(target, {
      headers: lastModified ? { "if-modified-since": lastModified } : undefined,
      responseType: "text",
      transitional: { forcedJSONParsing: false },
      // 204 (no packet) and 304 (not modified) must NOT throw.
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
    });

    // 204 No Content — buffer empty right now, treat same as "no change".
    if (response.status === 204 || !response.data) {
      return null;
    }

    return {
      payload: typeof response.data === "string" ? response.data : JSON.stringify(response.data),
      lastModified: response.headers["last-modified"] ?? null,
    };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 304) {
      return null;
    }

    throw mobilithekRequestError(error, target, feed);
  }
}
