import { terminateAdminFeedRun } from "@/lib/server/admin-data";
import { adminGuardResponse, requireAdmin } from "@/lib/supabase/require-admin";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return adminGuardResponse(guard);
  const { id } = await params;
  try {
    const result = await terminateAdminFeedRun(id);
    return Response.json({ data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feed termination failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
