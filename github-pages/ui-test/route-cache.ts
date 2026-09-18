import type { RouteRequest, RouteResult } from "../../app/MapboxPilgrimageMap";
import type { PilgrimageSpot } from "../../app/spots";
import { recommendedStayMinutes, type RouteLocation, type TravelMode } from "../../app/route-planner.ts";
import type { PlannerDaySnapshot, PlannerSnapshot } from "../../app/planner-storage";
import { hasValidTimeWindow, hasValidVisitDate } from "./trial-utils.ts";

export const DEFAULT_TRANSIT_ROUTE_MESSAGE = "公共交通は各区間を外部の乗換案内で確認してください。";

export type DayRouteCache = Record<string, {
  request: RouteRequest;
  result: RouteResult;
}>;

type PlannerRouteSettings = Pick<PlannerSnapshot,
  "stayMinutes" | "travelMode" | "optimizeOrder" | "sourceStationId"
>;

function routeSignature(
  stopIds: readonly string[],
  stay: readonly number[],
  travelMode: TravelMode,
  optimizeOrder: boolean,
  sourceStationId: string,
  departureTime: string,
): string {
  return JSON.stringify({
    stops: stopIds,
    stay: travelMode === "TRANSIT" ? stay : [],
    travelMode,
    optimizeWaypointOrder: travelMode !== "TRANSIT" && optimizeOrder,
    accessOriginId: travelMode === "TRANSIT" ? sourceStationId : "",
    departureTime: travelMode === "TRANSIT" ? departureTime : "",
  });
}

export function requestedRouteSignature(request: RouteRequest | null): string {
  if (!request) return "";
  return routeSignature(
    request.stops.map((spot) => spot.id),
    request.stops.map((spot) => request.stayMinutes[spot.id] ?? recommendedStayMinutes(spot)),
    request.travelMode,
    request.optimizeWaypointOrder,
    request.accessOrigin?.id ?? "",
    request.departureTime,
  );
}

export function plannerDayRouteSignature(
  day: PlannerDaySnapshot | undefined,
  allSpots: readonly PilgrimageSpot[],
  settings: PlannerRouteSettings,
): string {
  const stopIds = day?.itineraryIds ?? [];
  const spotsById = new Map(allSpots.map((spot) => [spot.id, spot]));
  const departureTime = settings.travelMode === "TRANSIT" && day
    && hasValidVisitDate(day.visitDate) && hasValidTimeWindow(day.startTime, day.endTime)
    ? new Date(`${day.visitDate}T${day.startTime}:00+09:00`).toISOString()
    : "";
  return routeSignature(
    stopIds,
    stopIds.map((id) => {
      const spot = spotsById.get(id);
      return settings.stayMinutes[id] ?? (spot ? recommendedStayMinutes(spot) : 0);
    }),
    settings.travelMode,
    settings.optimizeOrder,
    settings.sourceStationId,
    departureTime,
  );
}

export function matchingDayRoute(
  cached: DayRouteCache[string] | undefined,
  day: PlannerDaySnapshot | undefined,
  allSpots: readonly PilgrimageSpot[],
  settings: PlannerRouteSettings,
): DayRouteCache[string] | null {
  if (!cached || !day || !hasValidVisitDate(day.visitDate) || !hasValidTimeWindow(day.startTime, day.endTime)) return null;
  return requestedRouteSignature(cached.request) === plannerDayRouteSignature(day, allSpots, settings)
    ? cached
    : null;
}

export function routeCacheAfterDayRemoval(
  routes: DayRouteCache,
  removedDayId: string | undefined,
  nextDayId: string | undefined,
): { routes: DayRouteCache; activeRoute: DayRouteCache[string] | null } {
  const remaining = removedDayId && routes[removedDayId]
    ? Object.fromEntries(Object.entries(routes).filter(([dayId]) => dayId !== removedDayId))
    : routes;
  return {
    routes: remaining,
    activeRoute: nextDayId ? remaining[nextDayId] ?? null : null,
  };
}

export function mergeCachedStayMinutes(
  snapshotStayMinutes: Readonly<Record<string, number>>,
  routes: DayRouteCache,
): Record<string, number> {
  const cachedStayMinutes: Record<string, number> = {};
  Object.values(routes).forEach(({ request }) => {
    Object.assign(cachedStayMinutes, request.stayMinutes);
  });
  return { ...cachedStayMinutes, ...snapshotStayMinutes };
}

export function routeResultAfterMapUpdate(
  current: RouteResult,
  incoming: RouteResult,
  requestMatchesCurrentPlan: boolean,
): RouteResult {
  const hasUsableCurrentResult = current.state === "success" || current.state === "external";
  const incomingIsUsable = incoming.state === "success" || incoming.state === "external";
  return requestMatchesCurrentPlan && hasUsableCurrentResult && !incomingIsUsable ? current : incoming;
}

const travelModes: readonly TravelMode[] = ["WALKING", "DRIVING", "TRANSIT", "BICYCLING"];

function restoredRouteResult(value: unknown, stopIds: readonly string[]): RouteResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<RouteResult>;
  if (candidate.state === "external") {
    return {
      state: "external",
      message: typeof candidate.message === "string" ? candidate.message : DEFAULT_TRANSIT_ROUTE_MESSAGE,
    };
  }
  if (candidate.state !== "success") return null;
  const legDurationMinutes = Array.isArray(candidate.legDurationMinutes)
    && candidate.legDurationMinutes.every((minutes) => Number.isFinite(minutes) && Number(minutes) >= 0)
    ? candidate.legDurationMinutes.map(Number)
    : null;
  const orderedStopIds = Array.isArray(candidate.orderedStopIds)
    && candidate.orderedStopIds.length === stopIds.length
    && candidate.orderedStopIds.every((id) => typeof id === "string" && stopIds.includes(id))
    && new Set(candidate.orderedStopIds).size === stopIds.length
    ? candidate.orderedStopIds
    : null;
  if (!legDurationMinutes || legDurationMinutes.length !== Math.max(0, stopIds.length - 1) || !orderedStopIds) {
    return null;
  }
  return {
    state: "success",
    distance: typeof candidate.distance === "string" ? candidate.distance : undefined,
    duration: typeof candidate.duration === "string" ? candidate.duration : undefined,
    travelDurationMinutes: Number.isFinite(candidate.travelDurationMinutes) ? Number(candidate.travelDurationMinutes) : undefined,
    accessDurationMinutes: Number.isFinite(candidate.accessDurationMinutes) ? Number(candidate.accessDurationMinutes) : 0,
    legDurationMinutes,
    orderedStopIds,
  };
}

function restoredStayMinutes(value: unknown, spotsById: ReadonlyMap<string, PilgrimageSpot>): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, minutes]) => (
    spotsById.has(id) && Number.isFinite(minutes)
      ? [[id, Math.max(0, Math.min(480, Math.round(Number(minutes))))]]
      : []
  )));
}

export function restoreRouteCache(
  value: unknown,
  allSpots: PilgrimageSpot[],
  validDayIds?: ReadonlySet<string>,
  allowedAccessOrigins: readonly RouteLocation[] = [],
): DayRouteCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const spotsById = new Map(allSpots.map((spot) => [spot.id, spot]));
  const restored: DayRouteCache = {};
  Object.entries(value).forEach(([dayId, entry]) => {
    if (validDayIds && !validDayIds.has(dayId)) return;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const candidate = entry as { request?: Partial<RouteRequest>; result?: RouteResult };
    const stopIds = Array.isArray(candidate.request?.stops)
      ? candidate.request.stops.map((spot) => spot?.id).filter((id): id is string => typeof id === "string")
      : [];
    const stops = stopIds.map((id) => spotsById.get(id)).filter((spot): spot is PilgrimageSpot => Boolean(spot));
    const travelMode = candidate.request?.travelMode;
    const result = restoredRouteResult(candidate.result, stopIds);
    if (
      stops.length < 2
      || stops.length !== stopIds.length
      || !travelMode
      || !travelModes.includes(travelMode)
      || !result
      || (travelMode === "TRANSIT") !== (result.state === "external")
    ) return;
    const accessOriginId = candidate.request?.accessOrigin?.id;
    restored[dayId] = {
      request: {
        requestId: Date.now(),
        stops,
        travelMode,
        optimizeWaypointOrder: Boolean(candidate.request?.optimizeWaypointOrder),
        stayMinutes: restoredStayMinutes(candidate.request?.stayMinutes, spotsById),
        accessOrigin: allowedAccessOrigins.find((station) => station.id === accessOriginId),
        departureTime: typeof candidate.request?.departureTime === "string" ? candidate.request.departureTime : "",
      },
      result,
    };
  });
  return restored;
}
