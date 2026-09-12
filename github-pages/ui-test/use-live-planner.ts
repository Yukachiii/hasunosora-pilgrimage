import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { RouteRequest, RouteResult } from "../../app/MapboxPilgrimageMap";
import { sameIdOrder } from "../../app/itinerary-order";
import {
  majorStations,
  maximumItineraryStops,
  recommendedStayMinutes,
  type TravelMode,
} from "../../app/route-planner";
import {
  PLANNER_DRAFT_COOKIE_KEY,
  sanitizePlannerSnapshot,
  serializePlannerDraftCookie,
  type PlannerAppointment,
  type PlannerDaySnapshot,
  type PlannerSnapshot,
  type TransitLegProgress,
} from "../../app/planner-storage";
import {
  createPlannerSnapshotFromSharedPlan,
  createSharedPlanSnapshot,
  encodeSharedPlanSnapshot,
  type SharedPlanSnapshot,
} from "../../app/planner-share";
import type { PilgrimageSpot } from "../../app/spots";
import { createYahooTransitLegs } from "../../app/yahoo-transit";
import {
  hasValidTimeWindow,
  hasValidVisitDate,
  mergeItineraryIds,
  orderItemsByIds,
  retainCompletedSpotIds,
} from "./trial-utils";
import {
  DEFAULT_TRANSIT_ROUTE_MESSAGE,
  mergeCachedStayMinutes,
  restoreRouteCache,
  routeCacheAfterDayRemoval,
  routeResultAfterMapUpdate,
  type DayRouteCache,
} from "./route-cache";
import {
  LEGACY_PLANNER_DRAFT_STORAGE_KEY,
  normalizePlannerSourceStation,
  PLANNER_STORAGE_MAX_AGE_SECONDS,
  PRODUCTION_PLANNER_STORAGE_KEY,
  productionPlannerStorageValues,
  resolveProductionPlannerSnapshot,
} from "./planner-persistence";

const TEST_PLANNER_STORAGE_KEY = "hasunosora-pilgrimage.ui-test-planner.v1";
const TEST_ROUTE_STORAGE_KEY = "hasunosora-pilgrimage.ui-test-route-cache.v1";
const PRODUCTION_ROUTE_STORAGE_KEY = "hasunosora-pilgrimage.route-cache.v1";
const PLANNER_DRAFT_COOKIE_VALUE_LIMIT = 3_800;
const TRANSIT_ROUTE_RESULT: RouteResult = {
  state: "external",
  message: DEFAULT_TRANSIT_ROUTE_MESSAGE,
};

export type PlannerRuntime = "production" | "test";

export type ScheduleEntry = {
  spot: PilgrimageSpot;
  arrival: number;
  departure: number;
  stay: number;
};

export type PlannerSchedule = {
  entries: ScheduleEntry[];
  start: number;
  finish: number;
};

type PlannerDayField = "visitDate" | "startTime" | "endTime";

type PlannerSnapshotValues = {
  activeDay: PlannerDaySnapshot;
  activeDayIndex: number;
  completedSpotIds: string[];
  itineraryCollaborationId: string;
  itineraryIds: string[];
  optimizeOrder: boolean;
  plannerDays: PlannerDaySnapshot[];
  sourceStationId: string;
  stayMinutes: Record<string, number>;
  todayOffsetMinutes: number;
  transitLegProgress: TransitLegProgress;
  travelMode: TravelMode;
};

type TransitLeg = ReturnType<typeof createYahooTransitLegs>[number] & TransitLegProgress[string];

export type LivePlanner = {
  restored: boolean;
  activeDay: PlannerDaySnapshot | undefined;
  plannerDays: PlannerDaySnapshot[];
  activeDayIndex: number;
  selectDay: (index: number) => void;
  addDay: () => void;
  removeActiveDay: () => void;
  itineraryIds: string[];
  itinerarySpots: PilgrimageSpot[];
  plannedSpots: PilgrimageSpot[];
  stayMinutes: Record<string, number>;
  travelMode: TravelMode;
  optimizeOrder: boolean;
  sourceStationId: string;
  completedSpotIds: string[];
  todayOffsetMinutes: number;
  routeRequest: RouteRequest | null;
  routeResult: RouteResult;
  routeIsCurrent: boolean;
  currentRouteSignature: string;
  requestedRouteSignature: string;
  schedule: PlannerSchedule | null;
  transitLegs: TransitLeg[];
  transitLegProgress: TransitLegProgress;
  toggleSpot: (spotId: string) => void;
  replaceActiveItinerary: (ids: string[]) => void;
  addToActiveItinerary: (ids: string[]) => void;
  updateDayField: (field: PlannerDayField, value: string) => void;
  updateDayDetails: (update: Partial<Pick<PlannerDaySnapshot, "hotelName" | "endTime">>) => void;
  addAppointment: () => void;
  updateAppointment: (id: string, update: Partial<PlannerAppointment>) => void;
  removeAppointment: (id: string) => void;
  updateStayMinutes: (spotId: string, value: number) => void;
  setTravelMode: (value: TravelMode) => void;
  setOptimizeOrder: (value: boolean) => void;
  setSourceStationId: (value: string) => void;
  calculateRoute: () => void;
  handleRouteResult: (result: RouteResult) => void;
  toggleCompleted: (spotId: string) => void;
  updateTransitLeg: (id: string, update: Partial<TransitLegProgress[string]>) => void;
  alignScheduleToNow: () => void;
  resetTodayOffset: () => void;
  resetCompleted: () => void;
  createShareUrl: (includeDates: boolean) => string;
  importSharedPlan: (shared: SharedPlanSnapshot) => boolean;
};

type PlannerState = {
  plannerDays: PlannerDaySnapshot[];
  setPlannerDays: Dispatch<SetStateAction<PlannerDaySnapshot[]>>;
  activeDayIndex: number;
  setActiveDayIndex: Dispatch<SetStateAction<number>>;
  stayMinutes: Record<string, number>;
  setStayMinutes: Dispatch<SetStateAction<Record<string, number>>>;
  travelMode: TravelMode;
  setTravelModeState: Dispatch<SetStateAction<TravelMode>>;
  optimizeOrder: boolean;
  setOptimizeOrderState: Dispatch<SetStateAction<boolean>>;
  sourceStationId: string;
  setSourceStationIdState: Dispatch<SetStateAction<string>>;
  itineraryCollaborationId: string;
  setItineraryCollaborationId: Dispatch<SetStateAction<string>>;
  completedSpotIds: string[];
  setCompletedSpotIds: Dispatch<SetStateAction<string[]>>;
  todayOffsetMinutes: number;
  setTodayOffsetMinutes: Dispatch<SetStateAction<number>>;
  transitLegProgress: TransitLegProgress;
  setTransitLegProgress: Dispatch<SetStateAction<TransitLegProgress>>;
  routeRequest: RouteRequest | null;
  setRouteRequest: Dispatch<SetStateAction<RouteRequest | null>>;
  routeResult: RouteResult;
  setRouteResult: Dispatch<SetStateAction<RouteResult>>;
  dayRouteCache: DayRouteCache;
  setDayRouteCache: Dispatch<SetStateAction<DayRouteCache>>;
  restored: boolean;
  setRestored: Dispatch<SetStateAction<boolean>>;
};

type PlannerCoreDerived = {
  validSpotIds: ReadonlySet<string>;
  activeDay: PlannerDaySnapshot | undefined;
  activeDayId: string;
  itineraryIds: string[];
  itinerarySpots: PilgrimageSpot[];
  plannerSnapshot: PlannerSnapshot | null;
};

type PlannerRouteDerived = Pick<LivePlanner,
  "currentRouteSignature" | "requestedRouteSignature" | "routeIsCurrent" | "plannedSpots" | "schedule" | "transitLegs"
>;

type PlannerMutators = {
  updateActiveDay: (update: (day: PlannerDaySnapshot) => PlannerDaySnapshot) => void;
  invalidateRoute: () => void;
};

type ItineraryActions = Pick<LivePlanner, "toggleSpot" | "replaceActiveItinerary" | "addToActiveItinerary">;
type DayLifecycleActions = Pick<LivePlanner, "selectDay" | "addDay" | "removeActiveDay">;
type DayEditingActions = Pick<LivePlanner, "updateDayField" | "updateDayDetails" | "updateStayMinutes">;
type AppointmentActions = Pick<LivePlanner, "addAppointment" | "updateAppointment" | "removeAppointment">;
type RouteSettingActions = Pick<LivePlanner, "setTravelMode" | "setOptimizeOrder" | "setSourceStationId">;
type RouteCalculationActions = Pick<LivePlanner, "calculateRoute" | "handleRouteResult">;
type TodayActions = Pick<LivePlanner, "toggleCompleted" | "updateTransitLeg" | "alignScheduleToNow" | "resetTodayOffset" | "resetCompleted">;
type ShareActions = Pick<LivePlanner, "createShareUrl" | "importSharedPlan">;

function formatJapanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function japanDate(daysFromToday = 0): string {
  return formatJapanDate(new Date(Date.now() + daysFromToday * 86_400_000));
}

export function departureIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

export function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 9) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

export function displayClock(totalMinutes: number): string {
  const day = Math.floor(totalMinutes / 1440);
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${day > 0 ? `翌${day > 1 ? day : ""}日 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function dateAfter(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatJapanDate(date);
}

function createPlannerDay(index = 0, visitDate = japanDate()): PlannerDaySnapshot {
  return {
    id: `ui-test-day-${Date.now()}-${index}`,
    visitDate,
    startTime: "09:00",
    endTime: "18:00",
    itineraryIds: [],
    hotelName: "",
    appointments: [],
  };
}

function requestSignature(request: RouteRequest | null): string {
  if (!request) return "";
  return JSON.stringify({
    stops: request.stops.map((spot) => spot.id),
    stay: request.travelMode === "TRANSIT"
      ? request.stops.map((spot) => request.stayMinutes[spot.id] ?? recommendedStayMinutes(spot))
      : [],
    travelMode: request.travelMode,
    optimizeWaypointOrder: request.optimizeWaypointOrder,
    accessOriginId: request.travelMode === "TRANSIT" ? request.accessOrigin?.id ?? "" : "",
    departureTime: request.travelMode === "TRANSIT" ? request.departureTime : "",
  });
}

type RestoredPlannerState = {
  snapshot: PlannerSnapshot;
  routes: DayRouteCache;
};

function restorePastProductionPlan(snapshot: PlannerSnapshot): PlannerSnapshot {
  const today = japanDate();
  const firstDate = snapshot.plannerDays[0]?.visitDate ?? today;
  if (firstDate >= today) return snapshot;

  const plannerDays = snapshot.plannerDays.map((day, index) => ({
    ...day,
    visitDate: dateAfter(today, index),
  }));
  const activeDay = plannerDays[snapshot.activeDayIndex] ?? plannerDays[0];
  return {
    ...snapshot,
    visitDate: activeDay?.visitDate ?? today,
    plannerDays,
    completedSpotIds: [],
    todayOffsetMinutes: 0,
  };
}

function loadPlannerSnapshot(
  runtime: PlannerRuntime,
  validSpotIds: ReadonlySet<string>,
): PlannerSnapshot | null {
  const allowedSpotIds = new Set(validSpotIds);
  const validStationIds = new Set(majorStations.map((station) => station.id));
  const prepareSnapshot = (snapshot: PlannerSnapshot): PlannerSnapshot => {
    const normalized = normalizePlannerSourceStation(snapshot, validStationIds);
    return runtime === "production" ? restorePastProductionPlan(normalized) : normalized;
  };
  if (runtime === "production") {
    let primaryValue: string | null = null;
    let legacyValue: string | null = null;
    try {
      primaryValue = window.localStorage.getItem(PRODUCTION_PLANNER_STORAGE_KEY);
      legacyValue = window.localStorage.getItem(LEGACY_PLANNER_DRAFT_STORAGE_KEY);
    } catch {
      // Cookie migration remains available when local storage cannot be read.
    }
    const restored = resolveProductionPlannerSnapshot(
      primaryValue,
      document.cookie,
      legacyValue,
      allowedSpotIds,
    );
    if (restored.discardFallbacks) {
      try {
        window.localStorage.removeItem(PRODUCTION_PLANNER_STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_PLANNER_DRAFT_STORAGE_KEY);
      } catch {
        // The invalid primary value still prevents a stale fallback from loading.
      }
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${PLANNER_DRAFT_COOKIE_KEY}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
      return null;
    }
    return restored.snapshot ? prepareSnapshot(restored.snapshot) : null;
  }

  try {
    const stored = window.localStorage.getItem(TEST_PLANNER_STORAGE_KEY);
    const snapshot = stored
      ? sanitizePlannerSnapshot(JSON.parse(stored) as unknown, allowedSpotIds)
      : null;
    return snapshot ? prepareSnapshot(snapshot) : null;
  } catch {
    return null;
  }
}

function routeStorageKey(runtime: PlannerRuntime): string {
  return runtime === "production" ? PRODUCTION_ROUTE_STORAGE_KEY : TEST_ROUTE_STORAGE_KEY;
}

function loadStoredPlannerState(
  allSpots: PilgrimageSpot[],
  validSpotIds: ReadonlySet<string>,
  runtime: PlannerRuntime,
): RestoredPlannerState | null {
  const snapshot = loadPlannerSnapshot(runtime, validSpotIds);
  if (!snapshot) return null;

  try {
    const storedRoutes = window.localStorage.getItem(routeStorageKey(runtime));
    const validDayIds = new Set(snapshot.plannerDays
      .filter((day) => hasValidVisitDate(day.visitDate) && hasValidTimeWindow(day.startTime, day.endTime))
      .map((day) => day.id));
    const routes = restoreRouteCache(
      storedRoutes ? JSON.parse(storedRoutes) : null,
      allSpots,
      validDayIds,
      majorStations,
    );
    return {
      snapshot: {
        ...snapshot,
        stayMinutes: mergeCachedStayMinutes(snapshot.stayMinutes, routes),
      },
      routes,
    };
  } catch {
    return { snapshot, routes: {} };
  }
}

function buildPlannerSnapshot(values: PlannerSnapshotValues): PlannerSnapshot {
  return {
    itineraryIds: values.itineraryIds,
    stayMinutes: values.stayMinutes,
    travelMode: values.travelMode,
    optimizeOrder: values.optimizeOrder,
    sourceStationId: values.sourceStationId,
    visitDate: values.activeDay.visitDate,
    startTime: values.activeDay.startTime,
    itineraryCollaborationId: values.itineraryCollaborationId,
    completedSpotIds: values.completedSpotIds,
    todayOffsetMinutes: values.todayOffsetMinutes,
    transitLegProgress: values.transitLegProgress,
    plannerDays: values.plannerDays,
    activeDayIndex: values.activeDayIndex,
  };
}

function createCurrentRouteSignature(
  activeDay: PlannerDaySnapshot | undefined,
  allSpots: PilgrimageSpot[],
  itineraryIds: string[],
  optimizeOrder: boolean,
  sourceStationId: string,
  stayMinutes: Record<string, number>,
  travelMode: TravelMode,
): string {
  return JSON.stringify({
    stops: itineraryIds,
    stay: travelMode === "TRANSIT" ? itineraryIds.map((id) => {
      const spot = allSpots.find((item) => item.id === id);
      return stayMinutes[id] ?? (spot ? recommendedStayMinutes(spot) : 0);
    }) : [],
    travelMode,
    optimizeWaypointOrder: travelMode !== "TRANSIT" && optimizeOrder,
    accessOriginId: travelMode === "TRANSIT" ? sourceStationId : "",
    departureTime: travelMode === "TRANSIT" && activeDay
      ? departureIso(activeDay.visitDate, activeDay.startTime)
      : "",
  });
}

function createSchedule(
  activeDay: PlannerDaySnapshot | undefined,
  currentRouteSignature: string,
  plannedSpots: PilgrimageSpot[],
  requestedRouteSignature: string,
  routeResult: RouteResult,
  stayMinutes: Record<string, number>,
): PlannerSchedule | null {
  if (!activeDay || routeResult.state !== "success") return null;
  if (requestedRouteSignature !== currentRouteSignature || !routeResult.legDurationMinutes) return null;
  const calculated = plannedSpots.reduce<{ entries: ScheduleEntry[]; cursor: number }>((current, spot, index) => {
    const arrival = current.cursor;
    const stay = stayMinutes[spot.id] ?? recommendedStayMinutes(spot);
    const departure = arrival + stay;
    return {
      entries: [...current.entries, { spot, arrival, departure, stay }],
      cursor: departure + (routeResult.legDurationMinutes?.[index] ?? 0),
    };
  }, { entries: [], cursor: timeToMinutes(activeDay.startTime) + (routeResult.accessDurationMinutes ?? 0) });
  return {
    entries: calculated.entries,
    start: timeToMinutes(activeDay.startTime),
    finish: calculated.entries.at(-1)?.departure ?? timeToMinutes(activeDay.startTime),
  };
}

function usePlannerState(allSpots: PilgrimageSpot[]): PlannerState {
  const [plannerDays, setPlannerDays] = useState<PlannerDaySnapshot[]>(() => [createPlannerDay()]);
  const [activeDayIndex, setActiveDayIndex] = useState(0);
  const [stayMinutes, setStayMinutes] = useState<Record<string, number>>(() =>
    Object.fromEntries(allSpots.map((spot) => [spot.id, recommendedStayMinutes(spot)])),
  );
  const [travelMode, setTravelModeState] = useState<TravelMode>("WALKING");
  const [optimizeOrder, setOptimizeOrderState] = useState(false);
  const [sourceStationId, setSourceStationIdState] = useState("");
  const [itineraryCollaborationId, setItineraryCollaborationId] = useState("");
  const [completedSpotIds, setCompletedSpotIds] = useState<string[]>([]);
  const [todayOffsetMinutes, setTodayOffsetMinutes] = useState(0);
  const [transitLegProgress, setTransitLegProgress] = useState<TransitLegProgress>({});
  const [routeRequest, setRouteRequest] = useState<RouteRequest | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult>({ state: "idle" });
  const [dayRouteCache, setDayRouteCache] = useState<DayRouteCache>({});
  const [restored, setRestored] = useState(false);
  return {
    plannerDays, setPlannerDays, activeDayIndex, setActiveDayIndex, stayMinutes, setStayMinutes,
    travelMode, setTravelModeState, optimizeOrder, setOptimizeOrderState,
    sourceStationId, setSourceStationIdState, itineraryCollaborationId, setItineraryCollaborationId,
    completedSpotIds, setCompletedSpotIds,
    todayOffsetMinutes, setTodayOffsetMinutes, transitLegProgress, setTransitLegProgress,
    routeRequest, setRouteRequest, routeResult, setRouteResult,
    dayRouteCache, setDayRouteCache, restored, setRestored,
  };
}

function usePlannerCoreDerived(allSpots: PilgrimageSpot[], state: PlannerState): PlannerCoreDerived {
  const { activeDayIndex, completedSpotIds, itineraryCollaborationId, optimizeOrder, plannerDays, sourceStationId, stayMinutes, todayOffsetMinutes, transitLegProgress, travelMode } = state;
  const validSpotIds = useMemo(() => new Set(allSpots.map((spot) => spot.id)), [allSpots]);
  const activeDay = plannerDays[activeDayIndex] ?? plannerDays[0];
  const activeDayId = activeDay?.id ?? "";
  const itineraryIds = useMemo(() => activeDay?.itineraryIds ?? [], [activeDay]);
  const itinerarySpots = useMemo(
    () => itineraryIds
      .map((id) => allSpots.find((spot) => spot.id === id))
      .filter((spot): spot is PilgrimageSpot => Boolean(spot)),
    [allSpots, itineraryIds],
  );
  const plannerSnapshot = useMemo(() => activeDay ? buildPlannerSnapshot({
    activeDay, activeDayIndex, completedSpotIds, itineraryCollaborationId, itineraryIds, optimizeOrder, plannerDays,
    sourceStationId, stayMinutes, todayOffsetMinutes, transitLegProgress, travelMode,
  }) : null, [activeDay, activeDayIndex, completedSpotIds, itineraryCollaborationId, itineraryIds, optimizeOrder, plannerDays, sourceStationId, stayMinutes, todayOffsetMinutes, transitLegProgress, travelMode]);
  return { validSpotIds, activeDay, activeDayId, itineraryIds, itinerarySpots, plannerSnapshot };
}

function createTransitLegs(
  activeDay: PlannerDaySnapshot | undefined,
  routeIsCurrent: boolean,
  routeRequest: RouteRequest | null,
  progressById: TransitLegProgress,
): TransitLeg[] {
  if (!activeDay || routeRequest?.travelMode !== "TRANSIT" || !routeIsCurrent) return [];
  return createYahooTransitLegs(
    routeRequest.stops,
    routeRequest.accessOrigin,
    activeDay.visitDate,
    activeDay.startTime,
    routeRequest.stayMinutes,
  ).map((leg) => {
    const progress = progressById[leg.id];
    return {
      ...leg,
      date: progress?.date ?? leg.date,
      time: progress?.time ?? leg.time,
      confirmed: progress?.confirmed ?? false,
    };
  });
}

function usePlannerRouteDerived(allSpots: PilgrimageSpot[], state: PlannerState, core: PlannerCoreDerived): PlannerRouteDerived {
  const { optimizeOrder, routeRequest, routeResult, sourceStationId, stayMinutes, transitLegProgress, travelMode } = state;
  const { activeDay, itineraryIds, itinerarySpots } = core;
  const currentRouteSignature = useMemo(
    () => createCurrentRouteSignature(activeDay, allSpots, itineraryIds, optimizeOrder, sourceStationId, stayMinutes, travelMode),
    [activeDay, allSpots, itineraryIds, optimizeOrder, sourceStationId, stayMinutes, travelMode],
  );
  const requestedRouteSignature = useMemo(() => requestSignature(routeRequest), [routeRequest]);
  const routeIsCurrent = requestedRouteSignature === currentRouteSignature
    && (routeResult.state === "success" || routeResult.state === "external");
  const plannedSpots = useMemo(() => {
    if (routeResult.state !== "success" || !routeResult.orderedStopIds?.length) return itinerarySpots;
    return orderItemsByIds(itinerarySpots, routeResult.orderedStopIds);
  }, [itinerarySpots, routeResult]);
  const schedule = useMemo(
    () => createSchedule(activeDay, currentRouteSignature, plannedSpots, requestedRouteSignature, routeResult, stayMinutes),
    [activeDay, currentRouteSignature, plannedSpots, requestedRouteSignature, routeResult, stayMinutes],
  );
  const transitLegs = useMemo(
    () => createTransitLegs(activeDay, routeIsCurrent, routeRequest, transitLegProgress),
    [activeDay, routeIsCurrent, routeRequest, transitLegProgress],
  );
  return { currentRouteSignature, requestedRouteSignature, routeIsCurrent, plannedSpots, schedule, transitLegs };
}

function usePlannerMutators(state: PlannerState, core: PlannerCoreDerived): PlannerMutators {
  const { activeDayIndex, setDayRouteCache, setPlannerDays, setRouteRequest, setRouteResult, setTodayOffsetMinutes } = state;
  const { activeDayId } = core;
  const updateActiveDay = useCallback((update: (day: PlannerDaySnapshot) => PlannerDaySnapshot): void => {
    setPlannerDays((current) => current.map((day, index) => index === activeDayIndex ? update(day) : day));
  }, [activeDayIndex, setPlannerDays]);
  const invalidateRoute = useCallback((): void => {
    setRouteRequest(null);
    setRouteResult({ state: "idle" });
    setDayRouteCache((current) => {
      if (!activeDayId || !current[activeDayId]) return current;
      const next = { ...current };
      delete next[activeDayId];
      return next;
    });
    setTodayOffsetMinutes(0);
  }, [activeDayId, setDayRouteCache, setRouteRequest, setRouteResult, setTodayOffsetMinutes]);
  return { updateActiveDay, invalidateRoute };
}

function usePlannerRestoration(allSpots: PilgrimageSpot[], validSpotIds: ReadonlySet<string>, state: PlannerState, runtime: PlannerRuntime): void {
  const { setActiveDayIndex, setCompletedSpotIds, setDayRouteCache, setItineraryCollaborationId, setOptimizeOrderState, setPlannerDays, setRestored, setRouteRequest, setRouteResult, setSourceStationIdState, setStayMinutes, setTodayOffsetMinutes, setTransitLegProgress, setTravelModeState } = state;
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = loadStoredPlannerState(allSpots, validSpotIds, runtime);
      if (stored) {
        const { snapshot, routes } = stored;
        const activeRoute = routes[snapshot.plannerDays[snapshot.activeDayIndex]?.id ?? ""];
        setPlannerDays(snapshot.plannerDays);
        setActiveDayIndex(snapshot.activeDayIndex);
        setStayMinutes((current) => ({ ...current, ...snapshot.stayMinutes }));
        setTravelModeState(snapshot.travelMode);
        setOptimizeOrderState(snapshot.optimizeOrder);
        setSourceStationIdState(snapshot.sourceStationId);
        setItineraryCollaborationId(snapshot.itineraryCollaborationId);
        setCompletedSpotIds(snapshot.completedSpotIds);
        setTodayOffsetMinutes(snapshot.todayOffsetMinutes);
        setTransitLegProgress(snapshot.transitLegProgress);
        setDayRouteCache(routes);
        setRouteRequest(activeRoute?.request ?? null);
        setRouteResult(activeRoute?.result ?? { state: "idle" });
      }
      setRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [allSpots, runtime, setActiveDayIndex, setCompletedSpotIds, setDayRouteCache, setItineraryCollaborationId, setOptimizeOrderState, setPlannerDays, setRestored, setRouteRequest, setRouteResult, setSourceStationIdState, setStayMinutes, setTodayOffsetMinutes, setTransitLegProgress, setTravelModeState, validSpotIds]);
}

function usePlannerStorage(plannerSnapshot: PlannerSnapshot | null, dayRouteCache: DayRouteCache, restored: boolean, runtime: PlannerRuntime): void {
  useEffect(() => {
    if (!restored || !plannerSnapshot) return;
    if (runtime === "production") {
      let persistedPrimary = false;
      let persistedLegacy = false;
      const storageValues = productionPlannerStorageValues(plannerSnapshot);
      try {
        window.localStorage.setItem(
          PRODUCTION_PLANNER_STORAGE_KEY,
          storageValues.primary,
        );
        persistedPrimary = true;
      } catch {
        // The compatibility cookie below can still preserve smaller plans.
      }
      try {
        window.localStorage.setItem(
          LEGACY_PLANNER_DRAFT_STORAGE_KEY,
          storageValues.legacy,
        );
        persistedLegacy = true;
      } catch {
        // Older production builds can still use the compatibility cookie below.
      }
      try {
        const encoded = serializePlannerDraftCookie(plannerSnapshot);
        const secure = window.location.protocol === "https:" ? "; Secure" : "";
        if (encoded.length <= PLANNER_DRAFT_COOKIE_VALUE_LIMIT) {
          document.cookie = `${PLANNER_DRAFT_COOKIE_KEY}=${encoded}; Max-Age=${PLANNER_STORAGE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
        } else if (persistedPrimary && persistedLegacy) {
          document.cookie = `${PLANNER_DRAFT_COOKIE_KEY}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
        }
      } catch {
        // Local storage remains the production source of truth.
      }
      return;
    }
    try {
      window.localStorage.setItem(TEST_PLANNER_STORAGE_KEY, JSON.stringify(plannerSnapshot));
    } catch {
      // Keep the in-memory test session usable when storage is unavailable.
    }
  }, [plannerSnapshot, restored, runtime]);
  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(routeStorageKey(runtime), JSON.stringify(dayRouteCache));
    } catch {
      // Route calculation still works when storage is unavailable.
    }
  }, [dayRouteCache, restored, runtime]);
}

function useItineraryActions(state: PlannerState, core: PlannerCoreDerived, mutators: PlannerMutators): ItineraryActions {
  const { activeDayIndex, plannerDays, setCompletedSpotIds, setItineraryCollaborationId } = state;
  const { itineraryIds, validSpotIds } = core;
  const { invalidateRoute, updateActiveDay } = mutators;
  const replaceItineraryIds = useCallback((ids: string[]): void => {
    updateActiveDay((day) => ({ ...day, itineraryIds: ids }));
    setItineraryCollaborationId("");
    const otherDayIds = plannerDays.flatMap((day, index) => index === activeDayIndex ? [] : day.itineraryIds);
    setCompletedSpotIds((current) => retainCompletedSpotIds(current, ids, otherDayIds));
    invalidateRoute();
  }, [activeDayIndex, invalidateRoute, plannerDays, setCompletedSpotIds, setItineraryCollaborationId, updateActiveDay]);
  const replaceActiveItinerary = useCallback((ids: string[]): void => {
    const sanitizedIds = Array.from(new Set(ids.filter((id) => validSpotIds.has(id))));
    replaceItineraryIds(sanitizedIds.slice(0, maximumItineraryStops));
  }, [replaceItineraryIds, validSpotIds]);
  const addToActiveItinerary = useCallback((ids: string[]): void => {
    const nextIds = mergeItineraryIds(itineraryIds, ids, validSpotIds, maximumItineraryStops);
    if (sameIdOrder(nextIds, itineraryIds)) return;
    updateActiveDay((day) => ({ ...day, itineraryIds: nextIds }));
    setItineraryCollaborationId("");
    invalidateRoute();
  }, [invalidateRoute, itineraryIds, setItineraryCollaborationId, updateActiveDay, validSpotIds]);
  const toggleSpot = useCallback((spotId: string): void => {
    if (!validSpotIds.has(spotId)) return;
    const next = itineraryIds.includes(spotId)
      ? itineraryIds.filter((id) => id !== spotId)
      : [...itineraryIds, spotId].slice(0, maximumItineraryStops);
    replaceItineraryIds(next);
  }, [itineraryIds, replaceItineraryIds, validSpotIds]);
  return { toggleSpot, replaceActiveItinerary, addToActiveItinerary };
}

function useDayLifecycleActions(state: PlannerState): DayLifecycleActions {
  const { activeDayIndex, dayRouteCache, plannerDays, setActiveDayIndex, setCompletedSpotIds, setDayRouteCache, setPlannerDays, setRouteRequest, setRouteResult, setTodayOffsetMinutes, setTransitLegProgress } = state;
  const selectDay = useCallback((index: number): void => {
    if (index < 0 || index >= plannerDays.length || index === activeDayIndex) return;
    const cachedRoute = dayRouteCache[plannerDays[index].id];
    setActiveDayIndex(index);
    setRouteRequest(cachedRoute?.request ?? null);
    setRouteResult(cachedRoute?.result ?? { state: "idle" });
    setTodayOffsetMinutes(0);
    setTransitLegProgress({});
  }, [activeDayIndex, dayRouteCache, plannerDays, setActiveDayIndex, setRouteRequest, setRouteResult, setTodayOffsetMinutes, setTransitLegProgress]);
  const addDay = useCallback((): void => {
    if (plannerDays.length >= 7) return;
    const storedPreviousDate = plannerDays.at(-1)?.visitDate ?? "";
    const previousDate = hasValidVisitDate(storedPreviousDate) ? storedPreviousDate : japanDate();
    setPlannerDays((current) => [...current, createPlannerDay(current.length, dateAfter(previousDate, 1))]);
    setActiveDayIndex(plannerDays.length);
    setRouteRequest(null); setRouteResult({ state: "idle" });
    setTodayOffsetMinutes(0); setTransitLegProgress({});
  }, [plannerDays, setActiveDayIndex, setPlannerDays, setRouteRequest, setRouteResult, setTodayOffsetMinutes, setTransitLegProgress]);
  const removeActiveDay = useCallback((): void => {
    if (plannerDays.length <= 1) return;
    const removedDayId = plannerDays[activeDayIndex]?.id;
    const removedIds = new Set(plannerDays[activeDayIndex]?.itineraryIds ?? []);
    const next = plannerDays.filter((_, index) => index !== activeDayIndex);
    const nextActiveDayIndex = Math.max(0, Math.min(activeDayIndex, next.length - 1));
    const routeTransition = routeCacheAfterDayRemoval(
      dayRouteCache,
      removedDayId,
      next[nextActiveDayIndex]?.id,
    );
    setPlannerDays(next);
    setDayRouteCache(routeTransition.routes);
    setActiveDayIndex(nextActiveDayIndex);
    setRouteRequest(routeTransition.activeRoute?.request ?? null);
    setRouteResult(routeTransition.activeRoute?.result ?? { state: "idle" });
    setTodayOffsetMinutes(0);
    const remainingIds = new Set(next.flatMap((day) => day.itineraryIds));
    setCompletedSpotIds((current) => current.filter((id) => !removedIds.has(id) || remainingIds.has(id)));
  }, [activeDayIndex, dayRouteCache, plannerDays, setActiveDayIndex, setCompletedSpotIds, setDayRouteCache, setPlannerDays, setRouteRequest, setRouteResult, setTodayOffsetMinutes]);
  return { selectDay, addDay, removeActiveDay };
}

function useDayEditingActions(state: PlannerState, core: PlannerCoreDerived, mutators: PlannerMutators): DayEditingActions {
  const { setStayMinutes, travelMode } = state;
  const { activeDay } = core;
  const { invalidateRoute, updateActiveDay } = mutators;
  const updateDayField = useCallback((field: PlannerDayField, value: string): void => {
    const currentTimeWindowValid = Boolean(activeDay && hasValidTimeWindow(activeDay.startTime, activeDay.endTime));
    const nextTimeWindowValid = Boolean(activeDay && hasValidTimeWindow(
      field === "startTime" ? value : activeDay.startTime,
      field === "endTime" ? value : activeDay.endTime,
    ));
    updateActiveDay((day) => ({ ...day, [field]: value }));
    if (field === "endTime") {
      if (currentTimeWindowValid !== nextTimeWindowValid) invalidateRoute();
      return;
    }
    if (travelMode === "TRANSIT") invalidateRoute();
  }, [activeDay, invalidateRoute, travelMode, updateActiveDay]);
  const updateDayDetails = useCallback((update: Partial<Pick<PlannerDaySnapshot, "hotelName" | "endTime">>): void => {
    updateActiveDay((day) => ({ ...day, ...update }));
  }, [updateActiveDay]);
  const updateStayMinutes = useCallback((spotId: string, value: number): void => {
    setStayMinutes((current) => ({ ...current, [spotId]: Math.max(0, Math.min(480, Math.round(value))) }));
    if (travelMode === "TRANSIT") invalidateRoute();
  }, [invalidateRoute, setStayMinutes, travelMode]);
  return { updateDayField, updateDayDetails, updateStayMinutes };
}

function useAppointmentActions(mutators: PlannerMutators): AppointmentActions {
  const { updateActiveDay } = mutators;
  const addAppointment = useCallback((): void => {
    updateActiveDay((day) => {
      if (day.appointments.length >= 12) return day;
      const appointment: PlannerAppointment = {
        id: `appointment-${Date.now()}-${day.appointments.length}`,
        title: "予定を入力",
        time: "12:00",
        durationMinutes: 60,
      };
      return { ...day, appointments: [...day.appointments, appointment] };
    });
  }, [updateActiveDay]);
  const updateAppointment = useCallback((id: string, update: Partial<PlannerAppointment>): void => {
    updateActiveDay((day) => ({
      ...day,
      appointments: day.appointments.map((appointment) => appointment.id === id
        ? { ...appointment, ...update }
        : appointment),
    }));
  }, [updateActiveDay]);
  const removeAppointment = useCallback((id: string): void => {
    updateActiveDay((day) => ({
      ...day,
      appointments: day.appointments.filter((appointment) => appointment.id !== id),
    }));
  }, [updateActiveDay]);
  return { addAppointment, updateAppointment, removeAppointment };
}

function useRouteSettingActions(state: PlannerState, mutators: PlannerMutators): RouteSettingActions {
  const { setOptimizeOrderState, setSourceStationIdState, setTravelModeState } = state;
  const { invalidateRoute } = mutators;
  const setTravelMode = useCallback((value: TravelMode): void => {
    setTravelModeState(value);
    invalidateRoute();
  }, [invalidateRoute, setTravelModeState]);
  const setOptimizeOrder = useCallback((value: boolean): void => {
    setOptimizeOrderState(value);
    invalidateRoute();
  }, [invalidateRoute, setOptimizeOrderState]);
  const setSourceStationId = useCallback((value: string): void => {
    setSourceStationIdState(value);
    invalidateRoute();
  }, [invalidateRoute, setSourceStationIdState]);
  return { setTravelMode, setOptimizeOrder, setSourceStationId };
}

function routeValidationError(activeDay: PlannerDaySnapshot | undefined, itinerarySpots: PilgrimageSpot[]): RouteResult | null {
  if (!activeDay || itinerarySpots.length < 2) {
    return { state: "error", message: "予定には2か所以上のスポットを追加してください。" };
  }
  if (!hasValidTimeWindow(activeDay.startTime, activeDay.endTime)) {
    return { state: "error", message: "終了目安は出発時刻より後に設定してください。" };
  }
  if (!hasValidVisitDate(activeDay.visitDate)) {
    return { state: "error", message: "訪問日を設定してください。" };
  }
  return null;
}

function createRouteRequest(
  activeDay: PlannerDaySnapshot,
  itinerarySpots: PilgrimageSpot[],
  optimizeOrder: boolean,
  sourceStationId: string,
  stayMinutes: Record<string, number>,
  travelMode: TravelMode,
): RouteRequest {
  return {
    requestId: Date.now(),
    stops: itinerarySpots,
    travelMode,
    optimizeWaypointOrder: travelMode !== "TRANSIT" && optimizeOrder,
    stayMinutes: { ...stayMinutes },
    accessOrigin: travelMode === "TRANSIT"
      ? majorStations.find((station) => station.id === sourceStationId)
      : undefined,
    departureTime: departureIso(activeDay.visitDate, activeDay.startTime),
  };
}

function useRouteCalculationActions(
  state: PlannerState,
  core: PlannerCoreDerived,
  route: PlannerRouteDerived,
): RouteCalculationActions {
  const { optimizeOrder, routeRequest, setDayRouteCache, setRouteRequest, setRouteResult, sourceStationId, stayMinutes, travelMode } = state;
  const { activeDay, activeDayId, itinerarySpots } = core;
  const requestMatchesCurrentPlan = route.requestedRouteSignature === route.currentRouteSignature;
  const calculateRoute = useCallback((): void => {
    const validationError = routeValidationError(activeDay, itinerarySpots);
    if (validationError) {
      setRouteResult(validationError);
      return;
    }
    const request = createRouteRequest(activeDay!, itinerarySpots, optimizeOrder, sourceStationId, stayMinutes, travelMode);
    setRouteRequest(request);
    setRouteResult(travelMode === "TRANSIT" ? TRANSIT_ROUTE_RESULT : { state: "loading" });
    if (travelMode !== "TRANSIT") return;
    setDayRouteCache((current) => ({
      ...current,
      [activeDay!.id]: { request, result: TRANSIT_ROUTE_RESULT },
    }));
  }, [activeDay, itinerarySpots, optimizeOrder, setDayRouteCache, setRouteRequest, setRouteResult, sourceStationId, stayMinutes, travelMode]);
  const handleRouteResult = useCallback((result: RouteResult): void => {
    setRouteResult((current) => routeResultAfterMapUpdate(current, result, requestMatchesCurrentPlan));
    if (!activeDayId || !routeRequest || result.state !== "success") return;
    setDayRouteCache((current) => ({
      ...current,
      [activeDayId]: { request: routeRequest, result },
    }));
  }, [activeDayId, requestMatchesCurrentPlan, routeRequest, setDayRouteCache, setRouteResult]);
  return { calculateRoute, handleRouteResult };
}

function japanClockMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hours = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minutes = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hours * 60 + minutes;
}

function useTodayActions(state: PlannerState, route: PlannerRouteDerived): TodayActions {
  const { completedSpotIds, setCompletedSpotIds, setTodayOffsetMinutes, setTransitLegProgress } = state;
  const { schedule } = route;
  const updateTransitLeg = useCallback((id: string, update: Partial<TransitLegProgress[string]>): void => {
    setTransitLegProgress((current) => ({
      ...current,
      [id]: {
        date: update.date ?? current[id]?.date ?? japanDate(),
        time: update.time ?? current[id]?.time ?? "09:00",
        confirmed: update.confirmed ?? current[id]?.confirmed ?? false,
      },
    }));
  }, [setTransitLegProgress]);
  const toggleCompleted = useCallback((spotId: string): void => {
    setCompletedSpotIds((current) => current.includes(spotId)
      ? current.filter((id) => id !== spotId)
      : [...current, spotId]);
  }, [setCompletedSpotIds]);
  const alignScheduleToNow = useCallback((): void => {
    const next = schedule?.entries.find((entry) => !completedSpotIds.includes(entry.spot.id));
    if (!next) return;
    setTodayOffsetMinutes(japanClockMinutes() - next.arrival);
  }, [completedSpotIds, schedule, setTodayOffsetMinutes]);
  const resetTodayOffset = useCallback((): void => setTodayOffsetMinutes(0), [setTodayOffsetMinutes]);
  const resetCompleted = useCallback((): void => setCompletedSpotIds([]), [setCompletedSpotIds]);
  return { updateTransitLeg, toggleCompleted, alignScheduleToNow, resetTodayOffset, resetCompleted };
}

function createPlannerShareUrl(plannerSnapshot: PlannerSnapshot | null, validSpotIds: ReadonlySet<string>, includeDates: boolean): string {
  if (!plannerSnapshot) return "";
  const shared = createSharedPlanSnapshot(plannerSnapshot, validSpotIds, { includeDates });
  if (!shared) return "";
  const token = encodeSharedPlanSnapshot(shared, validSpotIds);
  if (!token) return "";
  const url = new URL(window.location.href);
  url.hash = `#/shared/${token}`;
  return url.toString();
}

function useShareActions(state: PlannerState, core: PlannerCoreDerived): ShareActions {
  const { setActiveDayIndex, setCompletedSpotIds, setDayRouteCache, setItineraryCollaborationId, setOptimizeOrderState, setPlannerDays, setRouteRequest, setRouteResult, setSourceStationIdState, setStayMinutes, setTodayOffsetMinutes, setTransitLegProgress, setTravelModeState } = state;
  const { plannerSnapshot, validSpotIds } = core;
  const createShareUrl = useCallback((includeDates: boolean): string => (
    createPlannerShareUrl(plannerSnapshot, validSpotIds, includeDates)
  ), [plannerSnapshot, validSpotIds]);
  const importSharedPlan = useCallback((shared: SharedPlanSnapshot): boolean => {
    const imported = createPlannerSnapshotFromSharedPlan(shared, validSpotIds, japanDate());
    if (!imported) return false;
    setPlannerDays(imported.plannerDays);
    setActiveDayIndex(imported.activeDayIndex);
    setStayMinutes((current) => ({ ...current, ...imported.stayMinutes }));
    setTravelModeState(imported.travelMode);
    setOptimizeOrderState(imported.optimizeOrder);
    setSourceStationIdState(imported.sourceStationId);
    setItineraryCollaborationId(imported.itineraryCollaborationId);
    setCompletedSpotIds([]); setTodayOffsetMinutes(0); setTransitLegProgress({});
    setRouteRequest(null); setRouteResult({ state: "idle" }); setDayRouteCache({});
    return true;
  }, [setActiveDayIndex, setCompletedSpotIds, setDayRouteCache, setItineraryCollaborationId, setOptimizeOrderState, setPlannerDays, setRouteRequest, setRouteResult, setSourceStationIdState, setStayMinutes, setTodayOffsetMinutes, setTransitLegProgress, setTravelModeState, validSpotIds]);
  return { createShareUrl, importSharedPlan };
}

export function useLivePlanner(allSpots: PilgrimageSpot[], runtime: PlannerRuntime = "test"): LivePlanner {
  const state = usePlannerState(allSpots);
  const core = usePlannerCoreDerived(allSpots, state);
  const mutators = usePlannerMutators(state, core);
  usePlannerRestoration(allSpots, core.validSpotIds, state, runtime);
  usePlannerStorage(core.plannerSnapshot, state.dayRouteCache, state.restored, runtime);
  const route = usePlannerRouteDerived(allSpots, state, core);
  const itineraryActions = useItineraryActions(state, core, mutators);
  const dayLifecycleActions = useDayLifecycleActions(state);
  const dayEditingActions = useDayEditingActions(state, core, mutators);
  const appointmentActions = useAppointmentActions(mutators);
  const routeSettingActions = useRouteSettingActions(state, mutators);
  const routeCalculationActions = useRouteCalculationActions(state, core, route);
  const todayActions = useTodayActions(state, route);
  const shareActions = useShareActions(state, core);
  return {
    restored: state.restored,
    activeDay: core.activeDay,
    plannerDays: state.plannerDays,
    activeDayIndex: state.activeDayIndex,
    itineraryIds: core.itineraryIds,
    itinerarySpots: core.itinerarySpots,
    plannedSpots: route.plannedSpots,
    stayMinutes: state.stayMinutes,
    travelMode: state.travelMode,
    optimizeOrder: state.optimizeOrder,
    sourceStationId: state.sourceStationId,
    completedSpotIds: state.completedSpotIds,
    todayOffsetMinutes: state.todayOffsetMinutes,
    routeRequest: state.routeRequest,
    routeResult: state.routeResult,
    routeIsCurrent: route.routeIsCurrent,
    currentRouteSignature: route.currentRouteSignature,
    requestedRouteSignature: route.requestedRouteSignature,
    schedule: route.schedule,
    transitLegs: route.transitLegs,
    transitLegProgress: state.transitLegProgress,
    ...itineraryActions,
    ...dayLifecycleActions,
    ...dayEditingActions,
    ...appointmentActions,
    ...routeSettingActions,
    ...routeCalculationActions,
    ...todayActions,
    ...shareActions,
  };
}
