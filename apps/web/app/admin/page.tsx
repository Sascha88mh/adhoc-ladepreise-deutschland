import { listFeedConfigs, listSyncRuns } from "@adhoc/shared/store";
import { AdminConsole } from "@/components/layout/admin-console";

export default function AdminPage() {
  return (
    <main className="min-h-screen px-4 py-4 sm:px-6 lg:px-8">
      <AdminConsole
        initialFeeds={listFeedConfigs()}
        initialSyncRuns={listSyncRuns()}
      />
    </main>
  );
}
