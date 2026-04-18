import { listCpos } from "@/lib/server/public-api";

export async function GET() {
  return Response.json({ data: listCpos() });
}
