import { AdminConsole } from "@/components/layout/admin-console";
import { listAdminFeeds, listAdminSyncRuns } from "@/lib/server/admin-data";

export const dynamic = "force-dynamic";

const ADMIN_INITIAL_LOAD_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.ADMIN_INITIAL_LOAD_TIMEOUT_MS ?? 4000),
);

function adminLoadErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[admin] initial data load failed:", message);
  return `Admin-Daten konnten gerade nicht geladen werden: ${message}`;
}

function loadWithFallback<T>(input: {
  label: string;
  promise: Promise<T>;
  fallback: T;
}) {
  const timeout = new Promise<{ data: T; error: string }>((resolve) => {
    setTimeout(() => {
      const message = `${input.label} konnten gerade nicht geladen werden.`;
      console.error("[admin] initial data load timed out:", input.label);
      resolve({ data: input.fallback, error: message });
    }, ADMIN_INITIAL_LOAD_TIMEOUT_MS);
  });

  return Promise.race([
    input.promise
      .then((data) => ({ data, error: null }))
      .catch((error) => ({
        data: input.fallback,
        error: adminLoadErrorMessage(error),
      })),
    timeout,
  ]);
}

export default async function AdminPage() {
  const [feedsResult, runsResult] = await Promise.all([
    loadWithFallback({
      label: "Feeds",
      promise: listAdminFeeds(),
      fallback: [],
    }),
    loadWithFallback({
      label: "Sync-Läufe",
      promise: listAdminSyncRuns(),
      fallback: [],
    }),
  ]);
  const loadErrors = [
    feedsResult.error,
    runsResult.error,
  ].filter((message): message is string => Boolean(message));

  return (
    <main className="min-h-screen px-4 py-4 sm:px-6 lg:px-8">
      <AdminConsole
        initialFeeds={feedsResult.data}
        initialSyncRuns={runsResult.data}
        initialLoadError={loadErrors.join(" ")}
      />
    </main>
  );
}
