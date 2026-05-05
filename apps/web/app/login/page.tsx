import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata = {
  title: "Admin Login — Adhoc Plattform",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-neutral-900">Admin-Login</h1>
        <p className="mb-6 text-sm text-neutral-500">
          Zugriff auf den Admin-Bereich.
        </p>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
