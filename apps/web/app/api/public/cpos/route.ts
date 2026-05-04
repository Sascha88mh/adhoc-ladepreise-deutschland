import { listCpos } from "@/lib/server/public-api";

const CPOS_CACHE_CONTROL = "public, max-age=300, s-maxage=900, stale-while-revalidate=1800";
const DEFAULT_CPO_LIMIT = 150;
const MAX_CPO_LIMIT = 250;

function parseLimit(value: string | null) {
  if (!value) {
    return DEFAULT_CPO_LIMIT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_CPO_LIMIT;
  }

  return Math.min(parsed, MAX_CPO_LIMIT);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const data = (await listCpos()).slice(0, limit);

  return Response.json(
    { data },
    {
      headers: {
        "cache-control": CPOS_CACHE_CONTROL,
      },
    },
  );
}
