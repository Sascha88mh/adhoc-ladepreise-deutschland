import { z } from "zod";
import { createFeedConfig, listFeedConfigs } from "@adhoc/shared/store";

const createSchema = z.object({
  name: z.string().min(1),
  mode: z.enum(["push", "pull", "hybrid"]),
  type: z.enum(["static", "dynamic"]),
  subscriptionId: z.string().min(1),
  urlOverride: z.string().nullable(),
  pollIntervalMinutes: z.number().int().positive(),
  reconciliationIntervalMinutes: z.number().int().positive(),
  isActive: z.boolean(),
  notes: z.string(),
});

export async function GET() {
  return Response.json({ data: listFeedConfigs() });
}

export async function POST(request: Request) {
  const body = createSchema.parse(await request.json());
  const created = createFeedConfig(body);
  return Response.json({ data: created }, { status: 201 });
}
