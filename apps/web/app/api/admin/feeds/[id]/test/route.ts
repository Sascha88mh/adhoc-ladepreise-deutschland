import { triggerAdminFeedAction } from "@/lib/server/admin-data";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const run = await triggerAdminFeedAction(id, "test");
    return Response.json({ data: run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feed test failed";
    return Response.json({ error: message }, { status: message === "Feed not found" ? 404 : 500 });
  }
}
