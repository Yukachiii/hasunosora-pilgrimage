import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePlannerDraftCookie,
  PLANNER_DRAFT_COOKIE_KEY,
  sanitizePlannerSnapshot,
  serializePlannerDraftCookie,
} from "../app/planner-storage.ts";
import { maximumItineraryStops } from "../app/route-planner.ts";
import {
  LEGACY_PLANNER_DRAFT_STORAGE_KEY,
  normalizePlannerSourceStation,
  parseStoredPlanner,
  productionPlannerStorageValues,
  PRODUCTION_PLANNER_STORAGE_KEY,
  resolveProductionPlannerSnapshot,
  serializeStoredPlanner,
} from "../github-pages/ui-test/planner-persistence.ts";
import { mergeCachedStayMinutes } from "../github-pages/ui-test/route-cache.ts";

function maximumPlannerSnapshot() {
  const plannerDays = Array.from({ length: 7 }, (_, dayIndex) => ({
    id: `day-${dayIndex + 1}`,
    visitDate: `2026-09-${String(dayIndex + 12).padStart(2, "0")}`,
    startTime: "09:00",
    endTime: "18:00",
    itineraryIds: Array.from({ length: maximumItineraryStops }, (_, spotIndex) => (
      `spot-${dayIndex}-${String(spotIndex).padStart(2, "0")}-${"x".repeat(50)}`
    )),
    hotelName: `宿泊先 ${dayIndex + 1}`,
    appointments: [],
  }));
  const allSpotIds = plannerDays.flatMap((day) => day.itineraryIds);
  return {
    snapshot: {
      itineraryIds: plannerDays[0].itineraryIds,
      stayMinutes: Object.fromEntries(allSpotIds.map((id, index) => [id, 15 + index % 60])),
      travelMode: "WALKING",
      optimizeOrder: false,
      sourceStationId: "tokyo",
      visitDate: plannerDays[0].visitDate,
      startTime: plannerDays[0].startTime,
      itineraryCollaborationId: "",
      completedSpotIds: [],
      todayOffsetMinutes: 0,
      transitLegProgress: {},
      plannerDays,
      activeDayIndex: 0,
    },
    allSpotIds,
  };
}

test("production planner storage retains a maximum multi-day plan beyond the cookie limit", () => {
  const { snapshot, allSpotIds } = maximumPlannerSnapshot();
  const now = Date.UTC(2026, 8, 12);

  assert.ok(serializePlannerDraftCookie(snapshot).length > 3_800);
  const restored = parseStoredPlanner(
    serializeStoredPlanner(snapshot, now),
    new Set(allSpotIds),
    now,
  );

  assert.ok(restored);
  assert.equal(restored.plannerDays.length, 7);
  assert.ok(restored.plannerDays.every((day) => day.itineraryIds.length === maximumItineraryStops));
  assert.equal(Object.keys(restored.stayMinutes).length, 7 * maximumItineraryStops);
  const finalSpotId = restored.plannerDays[6].itineraryIds[24];
  assert.equal(restored.stayMinutes[finalSpotId], snapshot.stayMinutes[finalSpotId]);
});

test("the production storage migration keeps the existing planner cookie readable", () => {
  const { snapshot, allSpotIds } = maximumPlannerSnapshot();
  const firstDay = { ...snapshot.plannerDays[0], itineraryIds: snapshot.plannerDays[0].itineraryIds.slice(0, 2) };
  const compactSnapshot = {
    ...snapshot,
    itineraryIds: firstDay.itineraryIds,
    stayMinutes: Object.fromEntries(firstDay.itineraryIds.map((id) => [id, snapshot.stayMinutes[id]])),
    plannerDays: [firstDay],
  };
  const encoded = serializePlannerDraftCookie(compactSnapshot);

  assert.ok(encoded.length <= 3_800);
  const restored = parsePlannerDraftCookie(
    `unrelated=value; ${PLANNER_DRAFT_COOKIE_KEY}=${encoded}`,
    new Set(allSpotIds),
  );
  assert.ok(restored);
  assert.deepEqual(restored.itineraryIds, firstDay.itineraryIds);
  assert.deepEqual(restored.stayMinutes, compactSnapshot.stayMinutes);
});

test("production storage synchronizes a full legacy snapshot for a safe rollback", () => {
  const { snapshot, allSpotIds } = maximumPlannerSnapshot();
  const now = Date.UTC(2026, 8, 12);
  const values = productionPlannerStorageValues(snapshot, now);

  assert.notEqual(PRODUCTION_PLANNER_STORAGE_KEY, LEGACY_PLANNER_DRAFT_STORAGE_KEY);
  assert.deepEqual(parseStoredPlanner(values.primary, new Set(allSpotIds), now), snapshot);
  assert.deepEqual(
    sanitizePlannerSnapshot(JSON.parse(values.legacy), new Set(allSpotIds)),
    snapshot,
  );
});

test("an expired primary planner record cannot resurrect a stale cookie or legacy draft", () => {
  const { snapshot, allSpotIds } = maximumPlannerSnapshot();
  const now = Date.UTC(2026, 8, 12);
  const smallSnapshot = {
    ...snapshot,
    itineraryIds: snapshot.itineraryIds.slice(0, 2),
    plannerDays: [{ ...snapshot.plannerDays[0], itineraryIds: snapshot.itineraryIds.slice(0, 2) }],
  };
  const cookie = `${PLANNER_DRAFT_COOKIE_KEY}=${serializePlannerDraftCookie(smallSnapshot)}`;
  const expiredPrimary = serializeStoredPlanner(snapshot, now - 31 * 86_400_000);
  const restored = resolveProductionPlannerSnapshot(
    expiredPrimary,
    cookie,
    JSON.stringify(snapshot),
    new Set(allSpotIds),
    now,
  );

  assert.equal(restored.snapshot, null);
  assert.equal(restored.discardFallbacks, true);
});

test("the first production migration prefers the cookie, then accepts the legacy draft", () => {
  const { snapshot, allSpotIds } = maximumPlannerSnapshot();
  const cookieSnapshot = {
    ...snapshot,
    itineraryIds: snapshot.itineraryIds.slice(0, 2),
    plannerDays: [{ ...snapshot.plannerDays[0], itineraryIds: snapshot.itineraryIds.slice(0, 2) }],
  };
  const cookie = `${PLANNER_DRAFT_COOKIE_KEY}=${serializePlannerDraftCookie(cookieSnapshot)}`;
  const validSpotIds = new Set(allSpotIds);

  const fromCookie = resolveProductionPlannerSnapshot(null, cookie, JSON.stringify(snapshot), validSpotIds);
  assert.deepEqual(fromCookie.snapshot?.itineraryIds, cookieSnapshot.itineraryIds);
  assert.equal(fromCookie.discardFallbacks, false);

  const fromLegacy = resolveProductionPlannerSnapshot(null, "", JSON.stringify(snapshot), validSpotIds);
  assert.deepEqual(fromLegacy.snapshot, snapshot);
  assert.equal(fromLegacy.discardFallbacks, false);
});

test("cached routes recover missing non-active-day stay durations without replacing snapshot values", () => {
  const snapshotStayMinutes = { "spot-0": 20 };
  const routes = {
    "day-1": { request: { stayMinutes: { "spot-0": 15, "spot-1": 35 } } },
    "day-2": { request: { stayMinutes: { "spot-1": 45, "spot-2": 60 } } },
  };

  assert.deepEqual(mergeCachedStayMinutes(snapshotStayMinutes, routes), {
    "spot-0": 20,
    "spot-1": 45,
    "spot-2": 60,
  });
});

test("production planner storage rejects expired and malformed envelopes", () => {
  const { snapshot, allSpotIds } = maximumPlannerSnapshot();
  const now = Date.UTC(2026, 8, 12);
  const validSpotIds = new Set(allSpotIds);

  assert.equal(parseStoredPlanner(serializeStoredPlanner(snapshot, now), validSpotIds, now + 31 * 86_400_000), null);
  assert.equal(parseStoredPlanner("not-json", validSpotIds, now), null);
  assert.equal(parseStoredPlanner(JSON.stringify({ version: 2, expiresAt: now + 1, snapshot }), validSpotIds, now), null);
});

test("restored planner source station is kept only while it exists in the station catalog", () => {
  const { snapshot } = maximumPlannerSnapshot();

  assert.equal(normalizePlannerSourceStation(snapshot, new Set(["tokyo"])), snapshot);
  assert.equal(normalizePlannerSourceStation(snapshot, new Set(["kanazawa"])).sourceStationId, "");
});

test("planner snapshots deduplicate and cap current and legacy itineraries at the routing limit", () => {
  const spotIds = Array.from({ length: maximumItineraryStops + 3 }, (_, index) => `spot-${index}`);
  const candidate = {
    ...maximumPlannerSnapshot().snapshot,
    itineraryIds: [spotIds[0], spotIds[0], ...spotIds.slice(1)],
    plannerDays: [{
      id: "day-1",
      visitDate: "2026-09-12",
      startTime: "09:00",
      endTime: "18:00",
      itineraryIds: [spotIds[0], spotIds[0], ...spotIds.slice(1)],
      hotelName: "",
      appointments: [],
    }],
    activeDayIndex: 0,
  };

  const current = sanitizePlannerSnapshot(candidate, new Set(spotIds));
  assert.ok(current);
  assert.deepEqual(current.itineraryIds, spotIds.slice(0, maximumItineraryStops));
  assert.deepEqual(current.plannerDays[0].itineraryIds, spotIds.slice(0, maximumItineraryStops));

  const legacyCandidate = { ...candidate };
  delete legacyCandidate.plannerDays;
  delete legacyCandidate.activeDayIndex;
  const legacy = sanitizePlannerSnapshot(legacyCandidate, new Set(spotIds));
  assert.ok(legacy);
  assert.deepEqual(legacy.itineraryIds, spotIds.slice(0, maximumItineraryStops));
  assert.deepEqual(legacy.plannerDays[0].itineraryIds, spotIds.slice(0, maximumItineraryStops));
});
