import { z } from "zod";
import { removeStationOverride, saveStationOverride } from "@/lib/server/admin-data";

const patchSchema = z.object({
  displayName: z.string().nullable(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  postalCode: z.string().nullable(),
  maxPowerKw: z.number().nullable(),
  isHidden: z.boolean(),
  adminNote: z.string().nullable(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const payload = patchSchema.parse(await request.json());
    const { id } = await params;
    const record = await saveStationOverride(id, payload);
    return Response.json({ data: record });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Override could not be saved";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const removed = await removeStationOverride(id);
    return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Override could not be removed";
    return Response.json({ error: message }, { status: 500 });
  }
}
