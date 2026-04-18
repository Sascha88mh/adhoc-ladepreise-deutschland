import { z } from "zod";
import { deleteAdminFeedConfig, updateAdminFeedConfig } from "@/lib/server/admin-data";

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
  const body = patchSchema.parse(await request.json());
  const { id } = await params;
  const updated = await updateAdminFeedConfig(id, body);

  if (!updated) {
    return Response.json({ error: "Feed not found" }, { status: 404 });
  }

  return Response.json({ data: updated });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const removed = await deleteAdminFeedConfig(id);
  return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
}
