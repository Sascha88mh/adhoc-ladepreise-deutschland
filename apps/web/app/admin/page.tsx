import { AdminConsole } from "@/components/layout/admin-console";
import { adminDataSource, listAdminFeeds, listAdminSyncRuns } from "@/lib/server/admin-data";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  return (
    <main className="min-h-screen px-4 py-4 sm:px-6 lg:px-8">
      <AdminConsole
        dataSource={adminDataSource()}
        initialFeeds={await listAdminFeeds()}
        initialSyncRuns={await listAdminSyncRuns()}
      />
    </main>
  );
}
