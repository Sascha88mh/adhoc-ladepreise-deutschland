import { z, ZodError } from "zod";
import { createAdminFeedConfig, listAdminFeeds } from "@/lib/server/admin-data";
import { cpoExistsDb, usingDatabase } from "@adhoc/shared/db";

const createSchema = z.object({
  source: z.enum(["mobilithek"]).default("mobilithek"),
  cpoId: z.string().min(1).nullable(),
  name: z.string().min(1),
  mode: z.enum(["push", "pull", "hybrid"]),
  type: z.enum(["static", "dynamic"]),
  subscriptionId: z.string().min(1),
  urlOverride: z.string().nullable(),
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

export async function GET() {
  return Response.json({ data: await listAdminFeeds() });
}

export async function POST(request: Request) {
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
