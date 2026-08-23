import type { TravelMode } from "./route-planner";

export const PLANNER_DRAFT_COOKIE_KEY = "hasunosora_planner_v2";

export type TransitLegProgress = Record<string, {
  date: string;
  time: string;
  confirmed: boolean;
}>;

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
  transitLegProgress: TransitLegProgress;
};

const travelModes: TravelMode[] = ["WALKING", "DRIVING", "TRANSIT", "BICYCLING"];

type CompactPlannerDraft = {
  v: 2;
  i: string[];
  s: Array<[string, number]>;
  m: TravelMode;
  o: 0 | 1;
  r: string;
  d: string;
  t: string;
  c: string;
  x: string[];
  f: number;
  p: Array<[string, string, string, 0 | 1]>;
};

function compactPlannerDraft(snapshot: PlannerSnapshot): CompactPlannerDraft {
  return {
    v: 2,
    i: snapshot.itineraryIds,
    s: snapshot.itineraryIds.flatMap((id) => Number.isFinite(snapshot.stayMinutes[id])
      ? [[id, snapshot.stayMinutes[id]] as [string, number]]
      : []),
    m: snapshot.travelMode,
    o: snapshot.optimizeOrder ? 1 : 0,
    r: snapshot.sourceStationId,
    d: snapshot.visitDate,
    t: snapshot.startTime,
    c: snapshot.itineraryCollaborationId,
    x: snapshot.completedSpotIds,
    f: snapshot.todayOffsetMinutes,
    p: Object.entries(snapshot.transitLegProgress).map(([id, progress]) => [
      id,
      progress.date,
      progress.time,
      progress.confirmed ? 1 : 0,
    ]),
  };
}

function encodedDraft(payload: CompactPlannerDraft) {
  return encodeURIComponent(JSON.stringify(payload));
}

export function serializePlannerDraftCookie(snapshot: PlannerSnapshot) {
  const payload = compactPlannerDraft(snapshot);
  let encoded = encodedDraft(payload);
  if (encoded.length <= 3800) return encoded;

  payload.p = [];
  encoded = encodedDraft(payload);
  if (encoded.length <= 3800) return encoded;

  payload.x = [];
  encoded = encodedDraft(payload);
  if (encoded.length <= 3800) return encoded;

  payload.s = [];
  return encodedDraft(payload);
}

export function parsePlannerDraftCookie(
  cookieHeader: string,
  validSpotIds: Set<string>,
) {
  const encoded = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PLANNER_DRAFT_COOKIE_KEY}=`))
    ?.slice(PLANNER_DRAFT_COOKIE_KEY.length + 1);
  if (!encoded) return null;

  try {
    const compact = JSON.parse(decodeURIComponent(encoded)) as Partial<CompactPlannerDraft>;
    if (compact.v !== 2) return null;
    const transitLegProgress = Object.fromEntries(
      Array.isArray(compact.p)
        ? compact.p.flatMap((entry) => Array.isArray(entry) && entry.length === 4
          ? [[entry[0], { date: entry[1], time: entry[2], confirmed: entry[3] === 1 }]]
          : [])
        : [],
    );
    return sanitizePlannerSnapshot({
      itineraryIds: compact.i,
      stayMinutes: Object.fromEntries(Array.isArray(compact.s) ? compact.s : []),
      travelMode: compact.m,
      optimizeOrder: compact.o !== 0,
      sourceStationId: compact.r,
      visitDate: compact.d,
      startTime: compact.t,
      itineraryCollaborationId: compact.c,
      completedSpotIds: compact.x,
      todayOffsetMinutes: compact.f,
      transitLegProgress,
    }, validSpotIds);
  } catch {
    return null;
  }
}

function sanitizeTransitLegProgress(value: unknown): TransitLegProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .flatMap(([id, progress]) => {
        if (
          !id ||
          id.length > 180 ||
          !progress ||
          typeof progress !== "object" ||
          Array.isArray(progress)
        ) return [];
        const candidate = progress as Record<string, unknown>;
        if (
          typeof candidate.date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date) ||
          typeof candidate.time !== "string" ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(candidate.time)
        ) return [];
        return [[id, {
          date: candidate.date,
          time: candidate.time,
          confirmed: candidate.confirmed === true,
        }]];
      }),
  );
}

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
    transitLegProgress: sanitizeTransitLegProgress(candidate.transitLegProgress),
  };
}
