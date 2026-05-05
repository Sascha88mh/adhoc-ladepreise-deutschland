import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAdminEmail } from "./admin-emails";

const PROTECTED_PREFIXES = ["/admin", "/api/admin"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api/admin" || pathname.startsWith("/api/admin/");
}

export async function updateAdminSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    if (isProtectedPath(request.nextUrl.pathname)) {
      console.error(
        "[middleware] Supabase ist nicht konfiguriert — Admin-Bereich blockiert.",
      );
      if (isApiPath(request.nextUrl.pathname)) {
        return new NextResponse(
          JSON.stringify({ error: "Auth not configured" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      const redirect = request.nextUrl.clone();
      redirect.pathname = "/login";
      redirect.searchParams.set("error", "auth_not_configured");
      return NextResponse.redirect(redirect);
    }
    return supabaseResponse;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const protectedPath = isProtectedPath(pathname);

  if (protectedPath) {
    const allowed = user && isAdminEmail(user.email);
    if (!allowed) {
      if (isApiPath(pathname)) {
        return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      const redirect = request.nextUrl.clone();
      redirect.pathname = "/login";
      redirect.searchParams.set("next", pathname);
      return NextResponse.redirect(redirect);
    }
  }

  if (pathname === "/login" && user && isAdminEmail(user.email)) {
    const redirect = request.nextUrl.clone();
    const next = request.nextUrl.searchParams.get("next");
    redirect.pathname = next && next.startsWith("/") ? next : "/admin";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }

  return supabaseResponse;
}
