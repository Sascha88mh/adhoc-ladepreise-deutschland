"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function AdminHeader({ email }: { email: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleLogout() {
    startTransition(async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        await supabase.auth.signOut();
      } catch {
        // ignore — proceed to redirect
      }
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <div className="mb-3 flex items-center justify-between text-sm text-neutral-600">
      <span>
        Eingeloggt als <strong className="font-medium text-neutral-900">{email}</strong>
      </span>
      <button
        type="button"
        onClick={handleLogout}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
      >
        <LogOut className="h-3.5 w-3.5" />
        {pending ? "Abmelden…" : "Abmelden"}
      </button>
    </div>
  );
}
