import { after } from "next/server";
import { triggerAdminFeedAction } from "@/lib/server/admin-data";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const startedAt = new Date().toISOString();

    after(async () => {
      try {
        await triggerAdminFeedAction(id, "sync");
      } catch (error) {
        console.error(`[admin-sync] ${id} failed:`, error);
      }
    });

    return Response.json(
      {
        data: {
          id: `pending-${id}-${Date.now()}`,
          feedId: id,
          kind: "manual",
          status: "running",
          startedAt,
          finishedAt: null,
          message: "Feed-Sync gestartet",
          deltaCount: 0,
        },
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feed sync failed";
    return Response.json({ error: message }, { status: message === "Feed not found" ? 404 : 500 });
  }
}
