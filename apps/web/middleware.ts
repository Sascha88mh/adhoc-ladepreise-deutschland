import type { NextRequest } from "next/server";
import { updateAdminSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateAdminSession(request);
}

export const config = {
  matcher: [
    "/admin/:path*",
    "/admin",
    "/api/admin/:path*",
    "/login",
  ],
};
