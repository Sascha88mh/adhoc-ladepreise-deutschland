import { RoutePlannerShell } from "@/components/layout/route-planner-shell";
import { storeRoutePlan } from "@/lib/server/route-cache";
import {
  buildCandidateResponse,
  createLocationFocusRoute,
  listCpos,
} from "@/lib/server/public-api";

export const dynamic = "force-dynamic";

export default async function Home() {
  const route = await createLocationFocusRoute("Berlin");
  storeRoutePlan(route);
  const [results, cpos] = await Promise.all([
    buildCandidateResponse(route, {}),
    listCpos(),
  ]);

  return (
    <main className="h-[100dvh] w-[100vw] overflow-hidden">
      <RoutePlannerShell
        initialRoute={route}
        initialResults={results}
        initialCpos={cpos}
        defaultQuery={{ origin: "", destination: "" }}
      />
    </main>
  );
}
