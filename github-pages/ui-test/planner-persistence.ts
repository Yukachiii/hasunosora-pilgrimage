import {
  parsePlannerDraftCookie,
  sanitizePlannerSnapshot,
  type PlannerSnapshot,
} from "../../app/planner-storage.ts";

export const PRODUCTION_PLANNER_STORAGE_KEY = "hasunosora-pilgrimage.planner.v4";
export const LEGACY_PLANNER_DRAFT_STORAGE_KEY = "hasunosora-pilgrimage.planner-draft.v1";
export const PLANNER_STORAGE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type StoredPlannerEnvelope = {
  version: 1;
  expiresAt: number;
  snapshot: PlannerSnapshot;
};

export type ProductionPlannerStorageValues = {
  primary: string;
  legacy: string;
};

export type ProductionPlannerRestore = {
  snapshot: PlannerSnapshot | null;
  discardFallbacks: boolean;
};

export function formatJapanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function dateAfter(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatJapanDate(date);
}

export function restorePastProductionPlan(snapshot: PlannerSnapshot, today: string): PlannerSnapshot {
  const firstDate = snapshot.plannerDays[0]?.visitDate ?? today;
  // A trip already in progress must keep its original dates when revisited.
  if (firstDate >= today || snapshot.plannerDays.some((day) => day.visitDate >= today)) return snapshot;

  const plannerDays = snapshot.plannerDays.map((day, index) => ({
    ...day,
    visitDate: dateAfter(today, index),
    transitLegProgress: {},
  }));
  const activeDay = plannerDays[snapshot.activeDayIndex] ?? plannerDays[0];
  return {
    ...snapshot,
    visitDate: activeDay?.visitDate ?? today,
    plannerDays,
    completedSpotIds: [],
    todayOffsetMinutes: 0,
    transitLegProgress: {},
  };
}

export function serializeStoredPlanner(
  snapshot: PlannerSnapshot,
  now = Date.now(),
): string {
  const envelope: StoredPlannerEnvelope = {
    version: 1,
    expiresAt: now + PLANNER_STORAGE_MAX_AGE_SECONDS * 1_000,
    snapshot,
  };
  return JSON.stringify(envelope);
}

export function parseStoredPlanner(
  value: string | null,
  validSpotIds: ReadonlySet<string>,
  now = Date.now(),
): PlannerSnapshot | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<StoredPlannerEnvelope>;
    if (
      candidate.version !== 1
      || !Number.isFinite(candidate.expiresAt)
      || Number(candidate.expiresAt) <= now
    ) return null;
    return sanitizePlannerSnapshot(candidate.snapshot, new Set(validSpotIds));
  } catch {
    return null;
  }
}

export function productionPlannerStorageValues(
  snapshot: PlannerSnapshot,
  now = Date.now(),
): ProductionPlannerStorageValues {
  return {
    primary: serializeStoredPlanner(snapshot, now),
    legacy: JSON.stringify(snapshot),
  };
}

export function resolveProductionPlannerSnapshot(
  primaryValue: string | null,
  cookieHeader: string,
  legacyValue: string | null,
  validSpotIds: ReadonlySet<string>,
  now = Date.now(),
): ProductionPlannerRestore {
  const allowedSpotIds = new Set(validSpotIds);
  if (primaryValue !== null) {
    const snapshot = parseStoredPlanner(primaryValue, allowedSpotIds, now);
    return { snapshot, discardFallbacks: !snapshot };
  }

  const cookieDraft = parsePlannerDraftCookie(cookieHeader, allowedSpotIds);
  if (cookieDraft) return { snapshot: cookieDraft, discardFallbacks: false };
  if (!legacyValue) return { snapshot: null, discardFallbacks: false };
  try {
    return {
      snapshot: sanitizePlannerSnapshot(JSON.parse(legacyValue) as unknown, allowedSpotIds),
      discardFallbacks: false,
    };
  } catch {
    return { snapshot: null, discardFallbacks: false };
  }
}

export function normalizePlannerSourceStation(
  snapshot: PlannerSnapshot,
  validStationIds: ReadonlySet<string>,
): PlannerSnapshot {
  if (!snapshot.sourceStationId || validStationIds.has(snapshot.sourceStationId)) return snapshot;
  return { ...snapshot, sourceStationId: "" };
}
