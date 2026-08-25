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
    if (compact.v !== 2 && compact.v !== 3) return null;
    const transitLegProgress = Object.fromEntries(
      Array.isArray(compact.p)
        ? compact.p.flatMap((entry) => Array.isArray(entry) && entry.length === 4
          ? [[entry[0], { date: entry[1], time: entry[2], confirmed: entry[3] === 1 }]]
          : [])
        : [],
    );
    const plannerDays = compact.v === 3 && Array.isArray(compact.q)
      ? compact.q.map((day) => ({
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
      }))
      : undefined;
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
      plannerDays,
      activeDayIndex: compact.a,
    }, validSpotIds);
  } catch {
    return null;
  }
}

function sanitizePlannerAppointment(value: unknown, index: number): PlannerAppointment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<PlannerAppointment>;
  const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 80) : "";
  if (!title || typeof candidate.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(candidate.time)) {
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
  const visitDate = typeof candidate.visitDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.visitDate)
    ? candidate.visitDate
    : "";
  if (!visitDate) return null;
  return {
    id: typeof candidate.id === "string" && candidate.id.length <= 80
      ? candidate.id
      : `day-${index + 1}`,
    visitDate,
    startTime: typeof candidate.startTime === "string" && /^\d{2}:\d{2}$/.test(candidate.startTime)
      ? candidate.startTime
      : "09:00",
    endTime: typeof candidate.endTime === "string" && /^\d{2}:\d{2}$/.test(candidate.endTime)
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
  const plannerDays = Array.isArray(candidate.plannerDays)
    ? candidate.plannerDays
      .slice(0, 7)
      .map((day, index) => sanitizePlannerDay(day, validSpotIds, index))
      .filter((day): day is PlannerDaySnapshot => Boolean(day))
    : [];
  const fallbackVisitDate = typeof candidate.visitDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.visitDate)
    ? candidate.visitDate
    : "";
  const normalizedDays = plannerDays.length
    ? plannerDays
    : fallbackVisitDate
      ? [{
        id: "day-1",
        visitDate: fallbackVisitDate,
        startTime: typeof candidate.startTime === "string" && /^\d{2}:\d{2}$/.test(candidate.startTime)
          ? candidate.startTime
          : "09:00",
        endTime: "18:00",
        itineraryIds,
        hotelName: "",
        appointments: [],
      }]
      : [];
  if (!normalizedDays.length) return null;
  const activeDayIndex = Number.isInteger(candidate.activeDayIndex)
    ? Math.max(0, Math.min(normalizedDays.length - 1, Number(candidate.activeDayIndex)))
    : 0;
  const activeDay = normalizedDays[activeDayIndex];
  const allItineraryIds = new Set(normalizedDays.flatMap((day) => day.itineraryIds));

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
    itineraryIds: activeDay.itineraryIds,
    stayMinutes,
    travelMode,
    optimizeOrder: candidate.optimizeOrder !== false,
    sourceStationId: typeof candidate.sourceStationId === "string" ? candidate.sourceStationId : "",
    visitDate: activeDay.visitDate,
    startTime: activeDay.startTime,
    itineraryCollaborationId: typeof candidate.itineraryCollaborationId === "string"
      ? candidate.itineraryCollaborationId
      : "",
    completedSpotIds: Array.isArray(candidate.completedSpotIds)
      ? candidate.completedSpotIds.filter((id): id is string => typeof id === "string" && allItineraryIds.has(id))
      : [],
    todayOffsetMinutes: Number.isFinite(candidate.todayOffsetMinutes)
      ? Math.max(-1440, Math.min(1440, Math.round(Number(candidate.todayOffsetMinutes))))
      : 0,
    transitLegProgress: sanitizeTransitLegProgress(candidate.transitLegProgress),
    plannerDays: normalizedDays,
    activeDayIndex,
  };
}
