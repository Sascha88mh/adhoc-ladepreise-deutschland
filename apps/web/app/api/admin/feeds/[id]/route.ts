import { z, ZodError } from "zod";
import { deleteAdminFeedConfig, updateAdminFeedConfig } from "@/lib/server/admin-data";
import { cpoExistsDb, usingDatabase } from "@adhoc/shared/db";

const patchSchema = z.object({
  source: z.enum(["mobilithek"]).optional(),
  cpoId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).optional(),
  mode: z.enum(["push", "pull", "hybrid"]).optional(),
  type: z.enum(["static", "dynamic"]).optional(),
  subscriptionId: z.string().min(1).optional(),
  urlOverride: z.string().nullable().optional(),
  pollIntervalMinutes: z.number().int().positive().nullable().optional(),
  reconciliationIntervalMinutes: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
  ingestCatalog: z.boolean().optional(),
  ingestPrices: z.boolean().optional(),
  ingestStatus: z.boolean().optional(),
  credentialRef: z.string().nullable().optional(),
  webhookSecretRef: z.string().nullable().optional(),
  notes: z.string().optional(),
  lastSuccessAt: z.string().nullable().optional(),
  lastSnapshotAt: z.string().nullable().optional(),
  lastDeltaCount: z.number().int().nonnegative().optional(),
  errorRate: z.number().min(0).max(1).optional(),
  cursorState: z.record(z.string(), z.unknown()).nullable().optional(),
  lastErrorMessage: z.string().nullable().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = patchSchema.parse(await request.json());

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

    const { id } = await params;
    const updated = await updateAdminFeedConfig(id, body);

    if (!updated) {
      return Response.json({ error: "Feed not found" }, { status: 404 });
    }

    return Response.json({ data: updated });
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

    const message = error instanceof Error ? error.message : "Feed konnte nicht gespeichert werden.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const removed = await deleteAdminFeedConfig(id);
  return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
}
