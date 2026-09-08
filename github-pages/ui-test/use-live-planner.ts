import { useCallback, useEffect, useMemo, useState } from "react";
import type { RouteRequest, RouteResult } from "../../app/MapboxPilgrimageMap";
import {
  majorStations,
  recommendedStayMinutes,
  type TravelMode,
} from "../../app/route-planner";
import {
  sanitizePlannerSnapshot,
  type PlannerDaySnapshot,
  type PlannerSnapshot,
} from "../../app/planner-storage";
import {
  createPlannerSnapshotFromSharedPlan,
  createSharedPlanSnapshot,
  encodeSharedPlanSnapshot,
  type SharedPlanSnapshot,
} from "../../app/planner-share";
import type { PilgrimageSpot } from "../../app/spots";

const TEST_PLANNER_STORAGE_KEY = "hasunosora-pilgrimage.ui-test-planner.v1";

export type ScheduleEntry = {
  spot: PilgrimageSpot;
  arrival: number;
  departure: number;
  stay: number;
};

export function japanDate(daysFromToday = 0) {
  const date = new Date(Date.now() + daysFromToday * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function departureIso(date: string, time: string) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

export function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 9) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

export function displayClock(totalMinutes: number) {
  const day = Math.floor(totalMinutes / 1440);
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${day > 0 ? `翌${day > 1 ? day : ""}日 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function createPlannerDay(): PlannerDaySnapshot {
  return {
    id: `ui-test-day-${Date.now()}`,
    visitDate: japanDate(),
    startTime: "09:00",
    endTime: "18:00",
    itineraryIds: [],
    hotelName: "",
    appointments: [],
  };
}

function requestSignature(request: RouteRequest | null) {
  if (!request) return "";
  return JSON.stringify({
    stops: request.stops.map((spot) => spot.id),
    travelMode: request.travelMode,
    optimizeWaypointOrder: request.optimizeWaypointOrder,
    accessOriginId: request.travelMode === "TRANSIT" ? request.accessOrigin?.id ?? "" : "",
    departureTime: request.travelMode === "TRANSIT" ? request.departureTime : "",
  });
}

export function useLivePlanner(allSpots: PilgrimageSpot[]) {
  const validSpotIds = useMemo(() => new Set(allSpots.map((spot) => spot.id)), [allSpots]);
  const [plannerDays, setPlannerDays] = useState<PlannerDaySnapshot[]>(() => [createPlannerDay()]);
  const [activeDayIndex, setActiveDayIndex] = useState(0);
  const [stayMinutes, setStayMinutes] = useState<Record<string, number>>(() =>
    Object.fromEntries(allSpots.map((spot) => [spot.id, recommendedStayMinutes(spot)])),
  );
  const [travelMode, setTravelModeState] = useState<TravelMode>("WALKING");
  const [optimizeOrder, setOptimizeOrderState] = useState(false);
  const [sourceStationId, setSourceStationIdState] = useState("");
  const [completedSpotIds, setCompletedSpotIds] = useState<string[]>([]);
  const [todayOffsetMinutes, setTodayOffsetMinutes] = useState(0);
  const [routeRequest, setRouteRequest] = useState<RouteRequest | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult>({ state: "idle" });
  const [restored, setRestored] = useState(false);

  const activeDay = plannerDays[activeDayIndex] ?? plannerDays[0];
  const itineraryIds = useMemo(() => activeDay?.itineraryIds ?? [], [activeDay]);
  const itinerarySpots = useMemo(
    () => itineraryIds
      .map((id) => allSpots.find((spot) => spot.id === id))
      .filter((spot): spot is PilgrimageSpot => Boolean(spot)),
    [allSpots, itineraryIds],
  );

  const updateActiveDay = useCallback((update: (day: PlannerDaySnapshot) => PlannerDaySnapshot) => {
    setPlannerDays((current) => current.map((day, index) => index === activeDayIndex ? update(day) : day));
  }, [activeDayIndex]);

  const invalidateRoute = useCallback(() => {
    setRouteRequest(null);
    setRouteResult({ state: "idle" });
    setTodayOffsetMinutes(0);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      let draft: PlannerSnapshot | null = null;
      try {
        const stored = window.localStorage.getItem(TEST_PLANNER_STORAGE_KEY);
        draft = stored ? sanitizePlannerSnapshot(JSON.parse(stored) as unknown, validSpotIds) : null;
      } catch {
        // The test remains usable in browsers that block local storage.
      }
      if (draft) {
        setPlannerDays(draft.plannerDays);
        setActiveDayIndex(draft.activeDayIndex);
        setStayMinutes((current) => ({ ...current, ...draft.stayMinutes }));
        setTravelModeState(draft.travelMode);
        setOptimizeOrderState(draft.optimizeOrder);
        setSourceStationIdState(draft.sourceStationId);
        setCompletedSpotIds(draft.completedSpotIds);
        setTodayOffsetMinutes(draft.todayOffsetMinutes);
      }
      setRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [validSpotIds]);

  useEffect(() => {
    if (!restored || !activeDay) return;
    const snapshot: PlannerSnapshot = {
      itineraryIds,
      stayMinutes,
      travelMode,
      optimizeOrder,
      sourceStationId,
      visitDate: activeDay.visitDate,
      startTime: activeDay.startTime,
      itineraryCollaborationId: "",
      completedSpotIds,
      todayOffsetMinutes,
      transitLegProgress: {},
      plannerDays,
      activeDayIndex,
    };
    try {
      window.localStorage.setItem(TEST_PLANNER_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Keep the in-memory test session usable when storage is unavailable.
    }
  }, [activeDay, activeDayIndex, completedSpotIds, itineraryIds, optimizeOrder, plannerDays, restored, sourceStationId, stayMinutes, todayOffsetMinutes, travelMode]);

  const currentRouteSignature = useMemo(() => JSON.stringify({
    stops: itineraryIds,
    travelMode,
    optimizeWaypointOrder: travelMode !== "TRANSIT" && optimizeOrder,
    accessOriginId: travelMode === "TRANSIT" ? sourceStationId : "",
    departureTime: travelMode === "TRANSIT" && activeDay
      ? departureIso(activeDay.visitDate, activeDay.startTime)
      : "",
  }), [activeDay, itineraryIds, optimizeOrder, sourceStationId, travelMode]);
  const requestedRouteSignature = useMemo(() => requestSignature(routeRequest), [routeRequest]);
  const routeIsCurrent = requestedRouteSignature === currentRouteSignature && (
    routeResult.state === "success" || routeResult.state === "external"
  );

  const plannedSpots = useMemo(() => {
    if (routeResult.state !== "success" || !routeResult.orderedStopIds?.length) return itinerarySpots;
    const byId = new Map(itinerarySpots.map((spot) => [spot.id, spot]));
    return routeResult.orderedStopIds
      .map((id) => byId.get(id))
      .filter((spot): spot is PilgrimageSpot => Boolean(spot));
  }, [itinerarySpots, routeResult]);

  const schedule = useMemo(() => {
    if (
      !activeDay ||
      routeResult.state !== "success" ||
      requestedRouteSignature !== currentRouteSignature ||
      !routeResult.legDurationMinutes
    ) return null;
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
  }, [activeDay, currentRouteSignature, plannedSpots, requestedRouteSignature, routeResult, stayMinutes]);

  const replaceItineraryIds = useCallback((ids: string[]) => {
    updateActiveDay((day) => ({ ...day, itineraryIds: ids }));
    setCompletedSpotIds((current) => current.filter((id) => ids.includes(id)));
    invalidateRoute();
  }, [invalidateRoute, updateActiveDay]);

  const toggleSpot = useCallback((spotId: string) => {
    if (!validSpotIds.has(spotId)) return;
    const next = itineraryIds.includes(spotId)
      ? itineraryIds.filter((id) => id !== spotId)
      : [...itineraryIds, spotId].slice(0, 25);
    replaceItineraryIds(next);
  }, [itineraryIds, replaceItineraryIds, validSpotIds]);

  const reorder = useCallback((from: number, to: number) => {
    if (from === to || !itineraryIds[from] || !itineraryIds[to]) return;
    const next = [...itineraryIds];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    replaceItineraryIds(next);
  }, [itineraryIds, replaceItineraryIds]);

  const updateDayField = useCallback((field: "visitDate" | "startTime" | "endTime", value: string) => {
    updateActiveDay((day) => ({ ...day, [field]: value }));
    if (field !== "endTime") invalidateRoute();
  }, [invalidateRoute, updateActiveDay]);

  const updateStayMinutes = useCallback((spotId: string, value: number) => {
    setStayMinutes((current) => ({ ...current, [spotId]: Math.max(0, Math.min(480, Math.round(value))) }));
  }, []);

  const setTravelMode = useCallback((value: TravelMode) => {
    setTravelModeState(value);
    invalidateRoute();
  }, [invalidateRoute]);

  const setOptimizeOrder = useCallback((value: boolean) => {
    setOptimizeOrderState(value);
    invalidateRoute();
  }, [invalidateRoute]);

  const setSourceStationId = useCallback((value: string) => {
    setSourceStationIdState(value);
    invalidateRoute();
  }, [invalidateRoute]);

  const calculateRoute = useCallback(() => {
    if (!activeDay || itinerarySpots.length < 2) {
      setRouteResult({ state: "error", message: "予定には2か所以上のスポットを追加してください。" });
      return;
    }
    const request: RouteRequest = {
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
    setRouteRequest(request);
    setRouteResult(travelMode === "TRANSIT"
      ? { state: "external", message: "公共交通は各区間を外部の乗換案内で確認してください。" }
      : { state: "loading" });
  }, [activeDay, itinerarySpots, optimizeOrder, sourceStationId, stayMinutes, travelMode]);

  const handleRouteResult = useCallback((result: RouteResult) => setRouteResult(result), []);

  const toggleCompleted = useCallback((spotId: string) => {
    setCompletedSpotIds((current) => current.includes(spotId)
      ? current.filter((id) => id !== spotId)
      : [...current, spotId]);
  }, []);

  const alignScheduleToNow = useCallback(() => {
    const next = schedule?.entries.find((entry) => !completedSpotIds.includes(entry.spot.id));
    if (!next) return;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const hours = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minutes = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    setTodayOffsetMinutes(hours * 60 + minutes - next.arrival);
  }, [completedSpotIds, schedule]);

  const createShareUrl = useCallback((includeDates: boolean) => {
    if (!activeDay) return "";
    const snapshot: PlannerSnapshot = {
      itineraryIds,
      stayMinutes,
      travelMode,
      optimizeOrder,
      sourceStationId,
      visitDate: activeDay.visitDate,
      startTime: activeDay.startTime,
      itineraryCollaborationId: "",
      completedSpotIds,
      todayOffsetMinutes,
      transitLegProgress: {},
      plannerDays,
      activeDayIndex,
    };
    const shared = createSharedPlanSnapshot(snapshot, validSpotIds, { includeDates });
    if (!shared) return "";
    const token = encodeSharedPlanSnapshot(shared, validSpotIds);
    if (!token) return "";
    const url = new URL(window.location.href);
    url.hash = `#/shared/${token}`;
    return url.toString();
  }, [activeDay, activeDayIndex, completedSpotIds, itineraryIds, optimizeOrder, plannerDays, sourceStationId, stayMinutes, todayOffsetMinutes, travelMode, validSpotIds]);

  const importSharedPlan = useCallback((shared: SharedPlanSnapshot) => {
    const imported = createPlannerSnapshotFromSharedPlan(shared, validSpotIds, japanDate());
    if (!imported) return false;
    setPlannerDays(imported.plannerDays);
    setActiveDayIndex(imported.activeDayIndex);
    setStayMinutes((current) => ({ ...current, ...imported.stayMinutes }));
    setTravelModeState(imported.travelMode);
    setOptimizeOrderState(imported.optimizeOrder);
    setSourceStationIdState(imported.sourceStationId);
    setCompletedSpotIds([]);
    setTodayOffsetMinutes(0);
    setRouteRequest(null);
    setRouteResult({ state: "idle" });
    return true;
  }, [validSpotIds]);

  return {
    restored,
    activeDay,
    plannerDays,
    activeDayIndex,
    setActiveDayIndex,
    itineraryIds,
    itinerarySpots,
    plannedSpots,
    stayMinutes,
    travelMode,
    optimizeOrder,
    sourceStationId,
    completedSpotIds,
    todayOffsetMinutes,
    routeRequest,
    routeResult,
    routeIsCurrent,
    currentRouteSignature,
    requestedRouteSignature,
    schedule,
    toggleSpot,
    reorder,
    updateDayField,
    updateStayMinutes,
    setTravelMode,
    setOptimizeOrder,
    setSourceStationId,
    calculateRoute,
    handleRouteResult,
    toggleCompleted,
    alignScheduleToNow,
    createShareUrl,
    importSharedPlan,
  };
}
