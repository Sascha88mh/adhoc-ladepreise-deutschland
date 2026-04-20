import { terminateAdminFeedRun } from "@/lib/server/admin-data";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await terminateAdminFeedRun(id);
    return Response.json({ data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feed termination failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
