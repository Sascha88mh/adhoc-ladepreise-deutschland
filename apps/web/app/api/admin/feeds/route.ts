import { z } from "zod";
import { createAdminFeedConfig, listAdminFeeds } from "@/lib/server/admin-data";

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
  const body = createSchema.parse(await request.json());
  const created = await createAdminFeedConfig(body);
  return Response.json({ data: created }, { status: 201 });
}
