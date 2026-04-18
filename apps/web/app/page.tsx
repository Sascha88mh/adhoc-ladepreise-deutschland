import { getCpoList, findCandidatesForRoute } from "@adhoc/shared";
import { RoutePlannerShell } from "@/components/layout/route-planner-shell";
import { storeRoutePlan } from "@/lib/server/route-cache";
import { createLocationFocusRoute } from "@/lib/server/public-api";

export const dynamic = "force-dynamic";

export default async function Home() {
  const route = await createLocationFocusRoute("Berlin");
  storeRoutePlan(route);
  const results = findCandidatesForRoute(route, {});
  const cpos = getCpoList();

  return (
    <main className="h-[100dvh] w-[100vw] overflow-hidden">
      <RoutePlannerShell
        initialRoute={route}
        initialResults={{
          route,
          filters: {},
          candidates: results.candidates,
          providerList: results.providerList,
          priceBand: results.priceBand,
        }}
        initialCpos={cpos}
        defaultQuery={{ origin: "", destination: "" }}
      />
    </main>
  );
}
