import type { RoutePlan } from "@adhoc/shared";

type RouteCacheStore = Map<string, RoutePlan>;

declare global {
  var __adhocRouteCache: RouteCacheStore | undefined;
}

function cache() {
  if (!globalThis.__adhocRouteCache) {
    globalThis.__adhocRouteCache = new Map();
  }

  return globalThis.__adhocRouteCache;
}

export function storeRoutePlan(route: RoutePlan) {
  cache().set(route.routeId, route);
}

export function getRoutePlan(routeId: string) {
  return cache().get(routeId) ?? null;
}
