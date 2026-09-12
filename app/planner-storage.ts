import type { TravelMode } from "./route-planner";

export const PLANNER_DRAFT_COOKIE_KEY = "hasunosora_planner_v2";

export type TransitLegProgress = Record<string, {
  date: string;
  time: string;
  confirmed: boolean;
}>;

export type PlannerAppointment = {
  id: string;
  title: string;
  time: string;
  durationMinutes: number;
};

export type PlannerDaySnapshot = {
  id: string;
  visitDate: string;
  startTime: string;
  endTime: string;
  itineraryIds: string[];
  hotelName: string;
  appointments: PlannerAppointment[];
};

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
  plannerDays: PlannerDaySnapshot[];
  activeDayIndex: number;
};

const travelModes: TravelMode[] = ["WALKING", "DRIVING", "TRANSIT", "BICYCLING"];
const plannerDraftCookieLimit = 3_800;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const strictTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const storedTimePattern = /^\d{2}:\d{2}$/;

type CompactPlannerDraft = {
  v: 2 | 3;
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
  q?: Array<[
    string,
    string,
    string,
    string,
    string[],
    string,
    Array<[string, string, string, number]>,
  ]>;
  a?: number;
};

function compactPlannerDraft(snapshot: PlannerSnapshot): CompactPlannerDraft {
  return {
    v: 3,
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
    q: snapshot.plannerDays.map((day) => [
      day.id,
      day.visitDate,
      day.startTime,
      day.endTime,
      day.itineraryIds,
      day.hotelName,
      day.appointments.map((appointment) => [
        appointment.id,
        appointment.title,
        appointment.time,
        appointment.durationMinutes,
      ]),
    ]),
    a: snapshot.activeDayIndex,
  };
}

function encodedDraft(payload: CompactPlannerDraft): string {
  return encodeURIComponent(JSON.stringify(payload));
}

export function serializePlannerDraftCookie(snapshot: PlannerSnapshot): string {
  const payload = compactPlannerDraft(snapshot);
  let encoded = encodedDraft(payload);
  if (encoded.length <= plannerDraftCookieLimit) return encoded;

  payload.p = [];
  encoded = encodedDraft(payload);
  if (encoded.length <= plannerDraftCookieLimit) return encoded;

  payload.x = [];
  encoded = encodedDraft(payload);
  if (encoded.length <= plannerDraftCookieLimit) return encoded;

  payload.s = [];
  return encodedDraft(payload);
}

function findPlannerDraftCookieValue(cookieHeader: string): string | null {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PLANNER_DRAFT_COOKIE_KEY}=`))
    ?.slice(PLANNER_DRAFT_COOKIE_KEY.length + 1) ?? null;
}

function expandTransitLegProgress(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length !== 4) return [];
    return [[entry[0], {
      date: entry[1],
      time: entry[2],
      confirmed: entry[3] === 1,
    }]];
  }));
}

function expandPlannerDays(
  compact: Partial<CompactPlannerDraft>,
): unknown[] | undefined {
  if (compact.v !== 3 || !Array.isArray(compact.q)) return undefined;
  return compact.q.map((day) => ({
    id: day?.[0],
    visitDate: day?.[1],
    startTime: day?.[2],
    endTime: day?.[3],
    itineraryIds: day?.[4],
    hotelName: day?.[5],
    appointments: Array.isArray(day?.[6])
      ? day[6].map((appointment) => ({
        id: appointment?.[0],
        title: appointment?.[1],
        time: appointment?.[2],
        durationMinutes: appointment?.[3],
      }))
      : [],
  }));
}

function expandCompactPlannerDraft(compact: Partial<CompactPlannerDraft>): unknown {
  return {
    itineraryIds: compact.i,
    stayMinutes: Object.fromEntries(Array.isArray(compact.s) ? compact.s : []),
    travelMode: compact.m,
    optimizeOrder: compact.o === 1,
    sourceStationId: compact.r,
    visitDate: compact.d,
    startTime: compact.t,
    itineraryCollaborationId: compact.c,
    completedSpotIds: compact.x,
    todayOffsetMinutes: compact.f,
    transitLegProgress: expandTransitLegProgress(compact.p),
    plannerDays: expandPlannerDays(compact),
    activeDayIndex: compact.a,
  };
}

export function parsePlannerDraftCookie(
  cookieHeader: string,
  validSpotIds: Set<string>,
): PlannerSnapshot | null {
  const encoded = findPlannerDraftCookieValue(cookieHeader);
  if (!encoded) return null;

  try {
    const compact = JSON.parse(decodeURIComponent(encoded)) as Partial<CompactPlannerDraft>;
    if (compact.v !== 2 && compact.v !== 3) return null;
    return sanitizePlannerSnapshot(expandCompactPlannerDraft(compact), validSpotIds);
  } catch {
    return null;
  }
}

function sanitizePlannerAppointment(value: unknown, index: number): PlannerAppointment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<PlannerAppointment>;
  const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 80) : "";
  if (!title || typeof candidate.time !== "string" || !strictTimePattern.test(candidate.time)) {
    return null;
  }
  return {
    id: typeof candidate.id === "string" && candidate.id.length <= 80
      ? candidate.id
      : `appointment-${index + 1}`,
    title,
    time: candidate.time,
    durationMinutes: Number.isFinite(candidate.durationMinutes)
      ? Math.max(0, Math.min(720, Math.round(Number(candidate.durationMinutes))))
      : 60,
  };
}

function sanitizePlannerDay(
  value: unknown,
  validSpotIds: Set<string>,
  index: number,
): PlannerDaySnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<PlannerDaySnapshot>;
  const visitDate = typeof candidate.visitDate === "string" && datePattern.test(candidate.visitDate)
    ? candidate.visitDate
    : "";
  if (!visitDate) return null;
  return {
    id: typeof candidate.id === "string" && candidate.id.length <= 80
      ? candidate.id
      : `day-${index + 1}`,
    visitDate,
    startTime: typeof candidate.startTime === "string" && storedTimePattern.test(candidate.startTime)
      ? candidate.startTime
      : "09:00",
    endTime: typeof candidate.endTime === "string" && storedTimePattern.test(candidate.endTime)
      ? candidate.endTime
      : "18:00",
    itineraryIds: Array.isArray(candidate.itineraryIds)
      ? Array.from(new Set(candidate.itineraryIds.filter(
        (id): id is string => typeof id === "string" && validSpotIds.has(id),
      ))).slice(0, 27)
      : [],
    hotelName: typeof candidate.hotelName === "string" ? candidate.hotelName.trim().slice(0, 120) : "",
    appointments: Array.isArray(candidate.appointments)
      ? candidate.appointments
        .slice(0, 12)
        .map((appointment, appointmentIndex) => sanitizePlannerAppointment(appointment, appointmentIndex))
        .filter((appointment): appointment is PlannerAppointment => Boolean(appointment))
      : [],
  };
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
          !datePattern.test(candidate.date) ||
          typeof candidate.time !== "string" ||
          !strictTimePattern.test(candidate.time)
        ) return [];
        return [[id, {
          date: candidate.date,
          time: candidate.time,
          confirmed: candidate.confirmed === true,
        }]];
      }),
  );
}

function sanitizeItineraryIds(value: unknown, validSpotIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && validSpotIds.has(id));
}

function sanitizedPlannerDays(
  value: unknown,
  validSpotIds: Set<string>,
): PlannerDaySnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 7)
    .map((day, index) => sanitizePlannerDay(day, validSpotIds, index))
    .filter((day): day is PlannerDaySnapshot => Boolean(day));
}

function fallbackPlannerDay(
  candidate: Partial<PlannerSnapshot>,
  itineraryIds: string[],
): PlannerDaySnapshot | null {
  const visitDate = typeof candidate.visitDate === "string" && datePattern.test(candidate.visitDate)
    ? candidate.visitDate
    : "";
  if (!visitDate) return null;

  return {
    id: "day-1",
    visitDate,
    startTime: typeof candidate.startTime === "string" && storedTimePattern.test(candidate.startTime)
      ? candidate.startTime
      : "09:00",
    endTime: "18:00",
    itineraryIds,
    hotelName: "",
    appointments: [],
  };
}

function normalizePlannerDays(
  candidate: Partial<PlannerSnapshot>,
  itineraryIds: string[],
  validSpotIds: Set<string>,
): PlannerDaySnapshot[] {
  const plannerDays = sanitizedPlannerDays(candidate.plannerDays, validSpotIds);
  if (plannerDays.length) return plannerDays;
  const fallback = fallbackPlannerDay(candidate, itineraryIds);
  return fallback ? [fallback] : [];
}

function normalizeActiveDayIndex(value: unknown, dayCount: number): number {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, Math.min(dayCount - 1, Number(value)));
}

function sanitizeStayMinutes(
  value: unknown,
  validSpotIds: ReadonlySet<string>,
): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, minutes]) => {
      if (!validSpotIds.has(id) || !Number.isFinite(minutes)) return [];
      return [[id, Math.max(0, Math.min(480, Math.round(Number(minutes))))]];
    }),
  );
}

function sanitizeTravelMode(value: unknown): TravelMode {
  return travelModes.includes(value as TravelMode) ? value as TravelMode : "WALKING";
}

function sanitizeCompletedSpotIds(
  value: unknown,
  itineraryIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && itineraryIds.has(id));
}

function sanitizeTodayOffsetMinutes(value: unknown): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1440, Math.min(1440, Math.round(Number(value))));
}

export function sanitizePlannerSnapshot(
  value: unknown,
  validSpotIds: Set<string>,
): PlannerSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PlannerSnapshot>;
  const itineraryIds = sanitizeItineraryIds(candidate.itineraryIds, validSpotIds);
  const normalizedDays = normalizePlannerDays(candidate, itineraryIds, validSpotIds);
  if (!normalizedDays.length) return null;
  const activeDayIndex = normalizeActiveDayIndex(candidate.activeDayIndex, normalizedDays.length);
  const activeDay = normalizedDays[activeDayIndex];
  const allItineraryIds = new Set(normalizedDays.flatMap((day) => day.itineraryIds));

  return {
    itineraryIds: activeDay.itineraryIds,
    stayMinutes: sanitizeStayMinutes(candidate.stayMinutes, validSpotIds),
    travelMode: sanitizeTravelMode(candidate.travelMode),
    optimizeOrder: candidate.optimizeOrder === true,
    sourceStationId: typeof candidate.sourceStationId === "string" ? candidate.sourceStationId : "",
    visitDate: activeDay.visitDate,
    startTime: activeDay.startTime,
    itineraryCollaborationId: typeof candidate.itineraryCollaborationId === "string"
      ? candidate.itineraryCollaborationId
      : "",
    completedSpotIds: sanitizeCompletedSpotIds(candidate.completedSpotIds, allItineraryIds),
    todayOffsetMinutes: sanitizeTodayOffsetMinutes(candidate.todayOffsetMinutes),
    transitLegProgress: sanitizeTransitLegProgress(candidate.transitLegProgress),
    plannerDays: normalizedDays,
    activeDayIndex,
  };
}
