import type { TravelMode } from "./route-planner";

export const PLANNER_DRAFT_STORAGE_KEY = "hasunosora-pilgrimage.planner-draft.v1";
export const SAVED_ITINERARIES_STORAGE_KEY = "hasunosora-pilgrimage.saved-itineraries.v1";

export type PlannerSnapshot = {
  itineraryIds: string[];
  stayMinutes: Record<string, number>;
  travelMode: TravelMode;
  optimizeOrder: boolean;
  sourceStationId: string;
  visitDate: string;
  startTime: string;
  itineraryCollaborationId: string;
  completedSpotIds: string[];
  todayOffsetMinutes: number;
};

export type SavedItinerary = {
  id: string;
  name: string;
  savedAt: string;
  snapshot: PlannerSnapshot;
};

const travelModes: TravelMode[] = ["WALKING", "DRIVING", "TRANSIT", "BICYCLING"];

export function sanitizePlannerSnapshot(
  value: unknown,
  validSpotIds: Set<string>,
): PlannerSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PlannerSnapshot>;
  const itineraryIds = Array.isArray(candidate.itineraryIds)
    ? candidate.itineraryIds.filter((id): id is string => typeof id === "string" && validSpotIds.has(id))
    : [];
  if (itineraryIds.length < 2) return null;

  const stayMinutes = Object.fromEntries(
    Object.entries(candidate.stayMinutes ?? {}).flatMap(([id, minutes]) => {
      if (!validSpotIds.has(id) || !Number.isFinite(minutes)) return [];
      return [[id, Math.max(0, Math.min(480, Math.round(Number(minutes))))]];
    }),
  );
  const travelMode = travelModes.includes(candidate.travelMode as TravelMode)
    ? candidate.travelMode as TravelMode
    : "WALKING";

  return {
    itineraryIds,
    stayMinutes,
    travelMode,
    optimizeOrder: candidate.optimizeOrder !== false,
    sourceStationId: typeof candidate.sourceStationId === "string" ? candidate.sourceStationId : "",
    visitDate: typeof candidate.visitDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.visitDate)
      ? candidate.visitDate
      : "",
    startTime: typeof candidate.startTime === "string" && /^\d{2}:\d{2}$/.test(candidate.startTime)
      ? candidate.startTime
      : "09:00",
    itineraryCollaborationId: typeof candidate.itineraryCollaborationId === "string"
      ? candidate.itineraryCollaborationId
      : "",
    completedSpotIds: Array.isArray(candidate.completedSpotIds)
      ? candidate.completedSpotIds.filter((id): id is string => typeof id === "string" && itineraryIds.includes(id))
      : [],
    todayOffsetMinutes: Number.isFinite(candidate.todayOffsetMinutes)
      ? Math.max(-1440, Math.min(1440, Math.round(Number(candidate.todayOffsetMinutes))))
      : 0,
  };
}

export function parseSavedItineraries(raw: string | null, validSpotIds: Set<string>) {
  if (!raw) return [];
  try {
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return [];
    return values.flatMap((value): SavedItinerary[] => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<SavedItinerary>;
      const snapshot = sanitizePlannerSnapshot(candidate.snapshot, validSpotIds);
      if (!snapshot || typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
      return [{
        id: candidate.id,
        name: candidate.name.trim() || "名前のない旅程",
        savedAt: typeof candidate.savedAt === "string" ? candidate.savedAt : "",
        snapshot,
      }];
    }).slice(0, 30);
  } catch {
    return [];
  }
}
