import assert from "node:assert/strict";
import test from "node:test";

import {
  createSharedPlanSnapshot,
  createPlannerSnapshotFromSharedPlan,
  decodeSharedPlanSnapshot,
  encodeSharedPlanSnapshot,
  sanitizeSharedPlanSnapshot,
  SHARED_PLAN_MAX_TOKEN_LENGTH,
} from "../app/planner-share.ts";

const validSpotIds = new Set(["kanazawa-station", "ohmicho-market", "兼六園"]);

function plannerSnapshot() {
  return {
    itineraryIds: ["kanazawa-station", "ohmicho-market"],
    stayMinutes: {
      "kanazawa-station": 20,
      "ohmicho-market": 60,
      "unknown-spot": 90,
    },
    travelMode: "WALKING",
    optimizeOrder: false,
    sourceStationId: "tokyo",
    visitDate: "2026-09-12",
    startTime: "09:15",
    itineraryCollaborationId: "private-collaboration",
    completedSpotIds: ["kanazawa-station"],
    todayOffsetMinutes: 45,
    transitLegProgress: {
      "kanazawa-station:ohmicho-market": {
        date: "2026-09-12",
        time: "10:00",
        confirmed: true,
      },
    },
    plannerDays: [
      {
        id: "day-private-id",
        visitDate: "2026-09-12",
        startTime: "09:15",
        endTime: "18:00",
        itineraryIds: ["kanazawa-station", "unknown-spot", "ohmicho-market"],
        hotelName: "個人用の宿泊先",
        appointments: [
          {
            id: "private-appointment",
            title: "個人的な待ち合わせ",
            time: "12:30",
            durationMinutes: 45,
          },
        ],
      },
      {
        id: "day-2",
        visitDate: "2026-09-13",
        startTime: "10:00",
        endTime: "17:00",
        itineraryIds: ["兼六園"],
        hotelName: "",
        appointments: [],
      },
    ],
    activeDayIndex: 1,
  };
}

test("shared plan round-trips UTF-8 data and shares dates only when requested", () => {
  const shared = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds);
  const sharedWithDates = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds, {
    includeDates: true,
  });
  assert.ok(shared);
  assert.ok(sharedWithDates);
  assert.equal("visitDate" in shared.days[0], false);
  assert.deepEqual(sharedWithDates.days.map((day) => day.visitDate), [
    "2026-09-12",
    "2026-09-13",
  ]);

  const token = encodeSharedPlanSnapshot(shared, validSpotIds);
  assert.ok(token);
  const decoded = decodeSharedPlanSnapshot(token, validSpotIds);
  assert.deepEqual(decoded, shared);
  assert.deepEqual(decoded?.days[1].itineraryIds, ["兼六園"]);
});

test("shared plan imports as a fresh local draft without private planner data", () => {
  const shared = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds);
  assert.ok(shared);
  const imported = createPlannerSnapshotFromSharedPlan(
    shared,
    validSpotIds,
    "2026-10-20",
  );
  assert.ok(imported);
  assert.deepEqual(imported.plannerDays.map((day) => day.visitDate), [
    "2026-10-20",
    "2026-10-21",
  ]);
  assert.deepEqual(imported.itineraryIds, ["兼六園"]);
  assert.equal(imported.travelMode, "WALKING");
  assert.equal(imported.sourceStationId, "");
  assert.equal(imported.itineraryCollaborationId, "");
  assert.deepEqual(imported.completedSpotIds, []);
  assert.deepEqual(imported.transitLegProgress, {});
  assert.ok(imported.plannerDays.every((day) => day.hotelName === "" && day.appointments.length === 0));
});

test("shared plan never serializes private planner fields", () => {
  const shared = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds, {
    includeDates: true,
  });
  assert.ok(shared);
  const token = encodeSharedPlanSnapshot(shared, validSpotIds);
  assert.ok(token);

  const compactPayload = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
  const serialized = JSON.stringify(shared) + compactPayload;
  for (const privateValue of [
    "個人用の宿泊先",
    "個人的な待ち合わせ",
    "private-appointment",
    "day-private-id",
    "private-collaboration",
    "tokyo",
    "completedSpotIds",
    "todayOffsetMinutes",
    "transitLegProgress",
    "sourceStationId",
    "hotelName",
    "appointments",
  ]) {
    assert.equal(serialized.includes(privateValue), false, `${privateValue} leaked into the share`);
  }
});

test("shared plan filters unknown spots during creation and decoding", () => {
  const shared = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds);
  assert.ok(shared);
  assert.equal(JSON.stringify(shared).includes("unknown-spot"), false);

  const encoded = encodeSharedPlanSnapshot(shared, validSpotIds);
  assert.ok(encoded);
  const decodedWithChangedCatalog = decodeSharedPlanSnapshot(
    encoded,
    new Set(["kanazawa-station", "兼六園"]),
  );
  assert.ok(decodedWithChangedCatalog);
  assert.deepEqual(decodedWithChangedCatalog.days.map((day) => day.itineraryIds), [
    ["kanazawa-station"],
    ["兼六園"],
  ]);
  assert.deepEqual(decodedWithChangedCatalog.stayMinutes, { "kanazawa-station": 20 });
});

test("shared plan rejects corrupted or oversized tokens and unknown versions", () => {
  const shared = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds);
  assert.ok(shared);
  const token = encodeSharedPlanSnapshot(shared, validSpotIds);
  assert.ok(token);

  const middle = Math.floor(token.length / 2);
  const replacement = token[middle] === "A" ? "B" : "A";
  const corrupted = `${token.slice(0, middle)}${replacement}${token.slice(middle + 1)}`;
  assert.equal(decodeSharedPlanSnapshot(corrupted, validSpotIds), null);
  assert.equal(
    decodeSharedPlanSnapshot("A".repeat(SHARED_PLAN_MAX_TOKEN_LENGTH + 1), validSpotIds),
    null,
  );

  const maximumPlanSpotIds = Array.from({ length: 7 }, (_, dayIndex) =>
    Array.from({ length: 25 }, (_, spotIndex) =>
      `spot-${dayIndex}-${String(spotIndex).padStart(2, "0")}-${"x".repeat(70)}`),
  );
  const maximumPlanSnapshot = plannerSnapshot();
  maximumPlanSnapshot.plannerDays = maximumPlanSpotIds.map((itineraryIds, dayIndex) => ({
    id: `day-${dayIndex + 1}`,
    visitDate: `2026-09-${String(dayIndex + 12).padStart(2, "0")}`,
    startTime: "09:00",
    endTime: "18:00",
    itineraryIds,
    hotelName: "",
    appointments: [],
  }));
  maximumPlanSnapshot.itineraryIds = [...maximumPlanSpotIds[0]];
  maximumPlanSnapshot.stayMinutes = Object.fromEntries(
    maximumPlanSpotIds.flat().map((spotId) => [spotId, 30]),
  );
  const maximumPlanValidSpotIds = new Set(maximumPlanSpotIds.flat());
  const maximumShared = createSharedPlanSnapshot(
    maximumPlanSnapshot,
    maximumPlanValidSpotIds,
  );
  assert.ok(maximumShared);
  assert.equal(encodeSharedPlanSnapshot(maximumShared, maximumPlanValidSpotIds), null);

  assert.equal(
    sanitizeSharedPlanSnapshot({ ...shared, version: 2 }, validSpotIds),
    null,
  );
});
