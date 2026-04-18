import { getCpoList, planRoute, findCandidatesForRoute } from "@adhoc/shared";
import { RoutePlannerShell } from "@/components/layout/route-planner-shell";
import { storeRoutePlan } from "@/lib/server/route-cache";

export default async function Home() {
  const route = await planRoute("Berlin", "Hamburg", "auto");
  storeRoutePlan(route);
  const results = findCandidatesForRoute(route, {});
  const cpos = getCpoList();

  return (
    <main className="min-h-screen px-4 py-4 sm:px-6 lg:px-8">
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
        defaultQuery={{ origin: "Berlin", destination: "Hamburg", profile: "auto" }}
      />
    </main>
  );
}
