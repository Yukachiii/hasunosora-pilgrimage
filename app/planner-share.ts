import type { TravelMode } from "./route-planner";
import type { PlannerSnapshot } from "./planner-storage";

export const SHARED_PLAN_VERSION = 1 as const;
export const SHARED_PLAN_MAX_TOKEN_LENGTH = 8_000;

const maximumSharedDays = 7;
const maximumSharedStopsPerDay = 27;
const maximumSharedStayMinutes = 480;
const travelModes: TravelMode[] = ["WALKING", "DRIVING", "TRANSIT", "BICYCLING"];
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export type SharedPlanDaySnapshot = {
  itineraryIds: string[];
  startTime: string;
  endTime: string;
  visitDate?: string;
};

/**
 * A public, read-only subset of a planner draft.
 *
 * Do not add free-form fields, visit progress, or a user's point of origin to
 * this type. A serialized value is intended to be placed in a shareable URL.
 */
export type SharedPlanSnapshot = {
  version: typeof SHARED_PLAN_VERSION;
  days: SharedPlanDaySnapshot[];
  stayMinutes: Record<string, number>;
  travelMode: TravelMode;
  optimizeOrder: boolean;
  activeDayIndex: number;
};

export type CreateSharedPlanOptions = {
  includeDates?: boolean;
};

type CompactSharedPlan = {
  v: typeof SHARED_PLAN_VERSION;
  d: Array<
    | [startTime: string, endTime: string, itineraryIds: string[]]
    | [startTime: string, endTime: string, itineraryIds: string[], visitDate: string]
  >;
  s: Array<[spotId: string, minutes: number]>;
  m: TravelMode;
  o: 0 | 1;
  a: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueValidSpotIds(value: unknown, validSpotIds: ReadonlySet<string>) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(
    (id): id is string => typeof id === "string" && validSpotIds.has(id),
  ))).slice(0, maximumSharedStopsPerDay);
}

/**
 * Reduces a private planner draft to fields that are safe to put in a public
 * read-only link. Dates are opt-in because they reveal when the trip is planned.
 */
export function createSharedPlanSnapshot(
  snapshot: PlannerSnapshot,
  validSpotIds: ReadonlySet<string>,
  options: CreateSharedPlanOptions = {},
): SharedPlanSnapshot | null {
  if (
    !snapshot ||
    !Array.isArray(snapshot.plannerDays) ||
    snapshot.plannerDays.length < 1 ||
    !travelModes.includes(snapshot.travelMode)
  ) return null;

  const days: SharedPlanDaySnapshot[] = [];
  for (const day of snapshot.plannerDays.slice(0, maximumSharedDays)) {
    if (
      !day ||
      !timePattern.test(day.startTime) ||
      !timePattern.test(day.endTime) ||
      (options.includeDates && !datePattern.test(day.visitDate))
    ) return null;
    days.push({
      itineraryIds: uniqueValidSpotIds(day.itineraryIds, validSpotIds),
      startTime: day.startTime,
      endTime: day.endTime,
      ...(options.includeDates ? { visitDate: day.visitDate } : {}),
    });
  }
  const includedSpotIds = new Set(days.flatMap((day) => day.itineraryIds));
  if (!includedSpotIds.size) return null;

  const stayMinutes = Object.fromEntries(
    Object.entries(snapshot.stayMinutes).flatMap(([id, minutes]) =>
      includedSpotIds.has(id) && Number.isFinite(minutes)
        ? [[id, Math.max(0, Math.min(maximumSharedStayMinutes, Math.round(minutes)))]]
        : []),
  );

  return {
    version: SHARED_PLAN_VERSION,
    days,
    stayMinutes,
    travelMode: snapshot.travelMode,
    optimizeOrder: snapshot.optimizeOrder === true,
    activeDayIndex: Number.isInteger(snapshot.activeDayIndex)
      ? Math.max(0, Math.min(days.length - 1, snapshot.activeDayIndex))
      : 0,
  };
}

/** Strictly validates data decoded from an untrusted shared URL. */
export function sanitizeSharedPlanSnapshot(
  value: unknown,
  validSpotIds: ReadonlySet<string>,
): SharedPlanSnapshot | null {
  if (!isRecord(value) || value.version !== SHARED_PLAN_VERSION) return null;
  if (!travelModes.includes(value.travelMode as TravelMode)) return null;
  if (typeof value.optimizeOrder !== "boolean") return null;
  if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > maximumSharedDays) {
    return null;
  }

  const days: SharedPlanDaySnapshot[] = [];
  for (const rawDay of value.days) {
    if (!isRecord(rawDay)) return null;
    if (
      typeof rawDay.startTime !== "string" ||
      !timePattern.test(rawDay.startTime) ||
      typeof rawDay.endTime !== "string" ||
      !timePattern.test(rawDay.endTime)
    ) return null;
    if (
      rawDay.visitDate !== undefined &&
      (typeof rawDay.visitDate !== "string" || !datePattern.test(rawDay.visitDate))
    ) return null;

    days.push({
      itineraryIds: uniqueValidSpotIds(rawDay.itineraryIds, validSpotIds),
      startTime: rawDay.startTime,
      endTime: rawDay.endTime,
      ...(typeof rawDay.visitDate === "string" ? { visitDate: rawDay.visitDate } : {}),
    });
  }

  const includedSpotIds = new Set(days.flatMap((day) => day.itineraryIds));
  if (!includedSpotIds.size) return null;

  const stayMinutes: Record<string, number> = {};
  if (isRecord(value.stayMinutes)) {
    for (const [id, rawMinutes] of Object.entries(value.stayMinutes)) {
      if (!includedSpotIds.has(id) || !Number.isFinite(rawMinutes)) continue;
      stayMinutes[id] = Math.max(
        0,
        Math.min(maximumSharedStayMinutes, Math.round(Number(rawMinutes))),
      );
    }
  }

  const activeDayIndex = Number.isInteger(value.activeDayIndex)
    ? Math.max(0, Math.min(days.length - 1, Number(value.activeDayIndex)))
    : 0;

  return {
    version: SHARED_PLAN_VERSION,
    days,
    stayMinutes,
    travelMode: value.travelMode as TravelMode,
    optimizeOrder: value.optimizeOrder,
    activeDayIndex,
  };
}

function compactSharedPlan(snapshot: SharedPlanSnapshot): CompactSharedPlan {
  return {
    v: SHARED_PLAN_VERSION,
    d: snapshot.days.map((day) => day.visitDate
      ? [day.startTime, day.endTime, day.itineraryIds, day.visitDate]
      : [day.startTime, day.endTime, day.itineraryIds]),
    s: Object.entries(snapshot.stayMinutes),
    m: snapshot.travelMode,
    o: snapshot.optimizeOrder ? 1 : 0,
    a: snapshot.activeDayIndex,
  };
}

function expandCompactSharedPlan(value: unknown): unknown {
  if (!isRecord(value) || value.v !== SHARED_PLAN_VERSION || !Array.isArray(value.d)) {
    return null;
  }
  return {
    version: value.v,
    days: value.d.map((day) => Array.isArray(day)
      ? {
          startTime: day[0],
          endTime: day[1],
          itineraryIds: day[2],
          ...(day.length > 3 ? { visitDate: day[3] } : {}),
        }
      : day),
    stayMinutes: Object.fromEntries(Array.isArray(value.s)
      ? value.s.filter((entry) => Array.isArray(entry) && entry.length === 2)
      : []),
    travelMode: value.m,
    optimizeOrder: value.o === 1,
    activeDayIndex: value.a,
  };
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// This checksum detects a damaged share token. It is not an authenticity
// signature: the shared plan contains public, strictly sanitized data only.
function tokenChecksum(bytes: Uint8Array) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const paddingLength = (4 - (value.length % 4)) % 4;
  const encoded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(paddingLength);
  try {
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Returns null when the safe URL-size budget would be exceeded. */
export function encodeSharedPlanSnapshot(
  snapshot: SharedPlanSnapshot,
  validSpotIds: ReadonlySet<string>,
) {
  const sanitized = sanitizeSharedPlanSnapshot(snapshot, validSpotIds);
  if (!sanitized) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(compactSharedPlan(sanitized)));
  const token = `${bytesToBase64Url(bytes)}.${tokenChecksum(bytes)}`;
  return token.length <= SHARED_PLAN_MAX_TOKEN_LENGTH ? token : null;
}

/** Decodes and validates an untrusted token from a shared URL. */
export function decodeSharedPlanSnapshot(
  token: string,
  validSpotIds: ReadonlySet<string>,
) {
  if (!token || token.length > SHARED_PLAN_MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[a-f0-9]{8}$/.test(parts[1])) return null;
  const bytes = base64UrlToBytes(parts[0]);
  if (!bytes) return null;
  if (tokenChecksum(bytes) !== parts[1]) return null;

  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return sanitizeSharedPlanSnapshot(
      expandCompactSharedPlan(JSON.parse(json) as unknown),
      validSpotIds,
    );
  } catch {
    return null;
  }
}
