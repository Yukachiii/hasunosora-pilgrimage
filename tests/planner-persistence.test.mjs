import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  restorePastProductionPlan,
  serializeStoredPlanner,
} from "../github-pages/ui-test/planner-persistence.ts";
import { matchingDayRoute, mergeCachedStayMinutes } from "../github-pages/ui-test/route-cache.ts";

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
  snapshot.plannerDays.forEach((day) => {
    day.transitLegProgress = Object.fromEntries(day.itineraryIds.map((id, index) => [
      `leg:${id}`,
      { date: day.visitDate, time: `10:${String(index).padStart(2, "0")}`, confirmed: true },
    ]));
  });
  snapshot.transitLegProgress = snapshot.plannerDays[0].transitLegProgress;
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
  assert.deepEqual(
    restored.plannerDays.map((day) => day.transitLegProgress),
    snapshot.plannerDays.map((day) => day.transitLegProgress),
  );
});

test("the production storage migration keeps the existing planner cookie readable", () => {
  const { snapshot, allSpotIds } = maximumPlannerSnapshot();
  const days = snapshot.plannerDays.slice(0, 2).map((day, index) => ({
    ...day,
    itineraryIds: day.itineraryIds.slice(0, 2),
    transitLegProgress: { "same-leg": { date: day.visitDate, time: index ? "13:45" : "11:23", confirmed: true } },
  }));
  const firstDay = days[0];
  const compactSnapshot = {
    ...snapshot,
    itineraryIds: firstDay.itineraryIds,
    stayMinutes: Object.fromEntries(firstDay.itineraryIds.map((id) => [id, snapshot.stayMinutes[id]])),
    transitLegProgress: firstDay.transitLegProgress,
    plannerDays: days,
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
  assert.deepEqual(restored.plannerDays.map((day) => day.transitLegProgress), days.map((day) => day.transitLegProgress));

  const legacySnapshot = {
    ...compactSnapshot,
    activeDayIndex: 1,
    itineraryIds: days[1].itineraryIds,
    visitDate: days[1].visitDate,
    transitLegProgress: days[1].transitLegProgress,
    plannerDays: days.map((day) => {
      const legacyDay = { ...day };
      delete legacyDay.transitLegProgress;
      return legacyDay;
    }),
  };
  const legacyRestored = parsePlannerDraftCookie(
    `${PLANNER_DRAFT_COOKIE_KEY}=${serializePlannerDraftCookie(legacySnapshot)}`,
    new Set(allSpotIds),
  );
  assert.ok(legacyRestored);
  assert.equal(legacyRestored.plannerDays[0].transitLegProgress, undefined);
  assert.deepEqual(legacyRestored.plannerDays[1].transitLegProgress, legacySnapshot.transitLegProgress);
  assert.deepEqual(legacyRestored.transitLegProgress, legacySnapshot.transitLegProgress);
});

test("planner cookie compaction keeps a moderate multi-day itinerary when optional transit progress overflows", async () => {
  const publicSpots = JSON.parse(await readFile(new URL("../content/spots.json", import.meta.url), "utf8"));
  const plannerDays = [0, 1].map((dayIndex) => {
    const itineraryIds = publicSpots.slice(dayIndex * 12, (dayIndex + 1) * 12).map((spot) => spot.id);
    const visitDate = `2026-09-${dayIndex + 15}`;
    return {
      id: `cookie-day-${dayIndex + 1}`,
      visitDate,
      startTime: "09:00",
      endTime: "18:00",
      itineraryIds,
      hotelName: `宿泊先 ${dayIndex + 1}`,
      appointments: [],
      transitLegProgress: Object.fromEntries(itineraryIds.slice(0, -1).map((id, index) => [
        `spot:${id}>spot:${itineraryIds[index + 1]}`,
        { date: visitDate, time: "10:30", confirmed: true },
      ])),
    };
  });
  const snapshot = {
    ...maximumPlannerSnapshot().snapshot,
    itineraryIds: plannerDays[0].itineraryIds,
    visitDate: plannerDays[0].visitDate,
    travelMode: "TRANSIT",
    stayMinutes: Object.fromEntries(plannerDays.flatMap((day) => day.itineraryIds).map((id) => [id, 15])),
    transitLegProgress: plannerDays[0].transitLegProgress,
    plannerDays,
  };
  const coreSnapshot = {
    ...snapshot,
    transitLegProgress: {},
    plannerDays: plannerDays.map((day) => {
      const coreDay = { ...day };
      delete coreDay.transitLegProgress;
      return coreDay;
    }),
  };
  assert.ok(serializePlannerDraftCookie(coreSnapshot).length <= 3_800);

  const encoded = serializePlannerDraftCookie(snapshot);
  assert.ok(encoded.length <= 3_800);
  const validSpotIds = new Set(publicSpots.map((spot) => spot.id));
  const restored = parsePlannerDraftCookie(`${PLANNER_DRAFT_COOKIE_KEY}=${encoded}`, validSpotIds);
  const restoredCore = parsePlannerDraftCookie(
    `${PLANNER_DRAFT_COOKIE_KEY}=${serializePlannerDraftCookie(coreSnapshot)}`,
    validSpotIds,
  );
  assert.deepEqual(restored, restoredCore);
  assert.deepEqual(restored.transitLegProgress, {});
  assert.ok(restored.plannerDays.every((day) => day.transitLegProgress === undefined));
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

test("restoring a trip keeps dates and progress until every travel day is past", () => {
  const { snapshot } = maximumPlannerSnapshot();
  snapshot.plannerDays = snapshot.plannerDays.slice(0, 2);
  snapshot.activeDayIndex = 1;
  snapshot.itineraryIds = snapshot.plannerDays[1].itineraryIds;
  snapshot.visitDate = snapshot.plannerDays[1].visitDate;
  snapshot.completedSpotIds = [snapshot.plannerDays[0].itineraryIds[0]];
  snapshot.todayOffsetMinutes = 30;

  assert.deepEqual(restorePastProductionPlan(snapshot, "2026-09-13"), snapshot);

  const freshPlan = restorePastProductionPlan(snapshot, "2026-09-15");
  assert.deepEqual(freshPlan.plannerDays.map((day) => day.visitDate), ["2026-09-15", "2026-09-16"]);
  assert.equal(freshPlan.visitDate, "2026-09-16");
  assert.deepEqual(freshPlan.completedSpotIds, []);
  assert.equal(freshPlan.todayOffsetMinutes, 0);
  assert.deepEqual(freshPlan.transitLegProgress, {});
  assert.ok(freshPlan.plannerDays.every((day) => Object.keys(day.transitLegProgress).length === 0));
});

test("day route reuse rejects an old travel mode but keeps a current request", () => {
  const spots = ["a", "b"].map((id) => ({ id, category: "交通", recommendedStayMinutes: 15 }));
  const day = { visitDate: "2026-09-13", startTime: "09:00", endTime: "18:00", itineraryIds: ["a", "b"] };
  const settings = { stayMinutes: {}, travelMode: "DRIVING", optimizeOrder: false, sourceStationId: "" };
  const walkingRoute = {
    request: { requestId: 1, stops: spots, travelMode: "WALKING", optimizeWaypointOrder: false, stayMinutes: {}, departureTime: "" },
    result: { state: "success", orderedStopIds: ["a", "b"], legDurationMinutes: [10] },
  };
  const drivingRoute = { ...walkingRoute, request: { ...walkingRoute.request, travelMode: "DRIVING" } };

  assert.equal(matchingDayRoute(walkingRoute, day, spots, settings), null);
  assert.deepEqual(matchingDayRoute(drivingRoute, day, spots, settings), drivingRoute);
});
