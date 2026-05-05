import { createSupabaseServerClient } from "./server";
import { isAdminEmail } from "./admin-emails";

export type AdminGuardResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403 | 503; error: string };

export async function requireAdmin(): Promise<AdminGuardResult> {
  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return { ok: false, status: 503, error: "Auth not configured" };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  if (!isAdminEmail(user.email)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, userId: user.id, email: user.email! };
}

export function adminGuardResponse(result: Extract<AdminGuardResult, { ok: false }>): Response {
  return Response.json({ error: result.error }, { status: result.status });
}
