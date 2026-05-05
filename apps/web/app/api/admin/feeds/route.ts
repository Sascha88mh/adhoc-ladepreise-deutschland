import { z, ZodError } from "zod";
import { createAdminFeedConfig, listAdminFeeds } from "@/lib/server/admin-data";
import { cpoExistsDb, usingDatabase } from "@adhoc/shared/db";
import { adminGuardResponse, requireAdmin } from "@/lib/supabase/require-admin";

const ALLOWED_FEED_HOSTS = new Set(["m2m.mobilithek.info"]);

const urlOverrideSchema = z
  .string()
  .nullable()
  .refine(
    (value) => {
      if (value === null || value === "") return true;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:") return false;
        return ALLOWED_FEED_HOSTS.has(url.hostname);
      } catch {
        return false;
      }
    },
    {
      message:
        "urlOverride muss eine HTTPS-URL auf einen erlaubten Mobilithek-Host sein (z. B. https://m2m.mobilithek.info/...).",
    },
  );

const createSchema = z.object({
  source: z.enum(["mobilithek"]).default("mobilithek"),
  cpoId: z.string().min(1).nullable(),
  name: z.string().min(1),
  mode: z.enum(["push", "pull", "hybrid"]),
  type: z.enum(["static", "dynamic"]),
  subscriptionId: z.string().min(1),
  urlOverride: urlOverrideSchema,
  pollIntervalMinutes: z.number().int().positive().nullable(),
  reconciliationIntervalMinutes: z.number().int().positive().nullable(),
  isActive: z.boolean(),
  ingestCatalog: z.boolean(),
  ingestPrices: z.boolean(),
  ingestStatus: z.boolean(),
  credentialRef: z.string().nullable(),
  webhookSecretRef: z.string().nullable(),
  notes: z.string(),
});

const booleanParamSchema = z.enum(["true", "false"]).transform((value) => value === "true");
const ADMIN_FEEDS_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.ADMIN_FEEDS_TIMEOUT_MS ?? 4000),
);

const listSchema = z.object({
  query: z.string().trim().optional(),
  q: z.string().trim().optional(),
  source: z.enum(["mobilithek"]).optional(),
  cpoId: z.string().trim().min(1).optional(),
  type: z.enum(["static", "dynamic"]).optional(),
  mode: z.enum(["push", "pull", "hybrid"]).optional(),
  isActive: booleanParamSchema.optional(),
  ingestCatalog: booleanParamSchema.optional(),
  ingestPrices: booleanParamSchema.optional(),
  ingestStatus: booleanParamSchema.optional(),
  sort: z.enum(["nameAsc", "nameDesc", "createdAtAsc", "createdAtDesc"]).default("nameAsc"),
});

export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return adminGuardResponse(guard);
  try {
    const params = listSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const { q, query, ...filters } = params;

    const feedsPromise = listAdminFeeds({
        ...filters,
        query: query || q,
      })
      .then((data) => Response.json({ data }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Feeds konnten nicht geladen werden.";
        console.error("[admin/feeds] feed list load failed:", message);
        return Response.json({ error: message }, { status: 503 });
      });

    const timeout = new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(
          Response.json(
            { error: "Feeds konnten gerade nicht geladen werden." },
            { status: 503 },
          ),
        );
      }, ADMIN_FEEDS_TIMEOUT_MS);
    });

    return Promise.race([feedsPromise, timeout]);
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "Ungültige Feed-Filter." }, { status: 400 });
    }

    const message = error instanceof Error ? error.message : "Feeds konnten nicht geladen werden.";
    return Response.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return adminGuardResponse(guard);
  try {
    const body = createSchema.parse(await request.json());

    if (usingDatabase() && body.cpoId && !(await cpoExistsDb(body.cpoId))) {
      return Response.json(
        {
          error:
            `Unbekannte CPO-ID "${body.cpoId}". Erwartet wird eine vorhandene ` +
            `cpos.id wie z. B. "enbw" oder "tesla". Alternativ das Feld leer lassen.`,
        },
        { status: 400 },
      );
    }

    const created = await createAdminFeedConfig(body);
    return Response.json({ data: created }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "Ungültige Feed-Konfiguration." }, { status: 400 });
    }

    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: string }).code ?? "")
      : "";

    if (code === "23503") {
      return Response.json(
        {
          error:
            "Die angegebene CPO-ID existiert nicht in der Datenbank. Bitte eine vorhandene cpos.id verwenden oder das Feld leer lassen.",
        },
        { status: 400 },
      );
    }

    const message = error instanceof Error ? error.message : "Feed konnte nicht angelegt werden.";
    return Response.json({ error: message }, { status: 500 });
  }
}
