import { z } from "zod";
import { deleteFeedConfig, updateFeedConfig } from "@adhoc/shared/store";

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  mode: z.enum(["push", "pull", "hybrid"]).optional(),
  type: z.enum(["static", "dynamic"]).optional(),
  subscriptionId: z.string().min(1).optional(),
  urlOverride: z.string().nullable().optional(),
  pollIntervalMinutes: z.number().int().positive().optional(),
  reconciliationIntervalMinutes: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const body = patchSchema.parse(await request.json());
  const { id } = await params;
  const updated = updateFeedConfig(id, body);

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
  const removed = deleteFeedConfig(id);
  return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
}
