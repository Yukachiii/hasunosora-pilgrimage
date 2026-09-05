import assert from "node:assert/strict";
import test from "node:test";

import {
  createSharedPlanSnapshot,
  decodeSharedPlanSnapshot,
  encodeSharedPlanSnapshot,
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

test("shared plan round-trips UTF-8 data and omits dates by default", () => {
  const shared = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds);
  assert.ok(shared);
  assert.deepEqual(shared.days.map((day) => day.itineraryIds), [
    ["kanazawa-station", "ohmicho-market"],
    ["兼六園"],
  ]);
  assert.equal(shared.days[0].visitDate, undefined);
  assert.equal(shared.days[1].visitDate, undefined);

  const token = encodeSharedPlanSnapshot(shared, validSpotIds);
  assert.ok(token);
  assert.ok(token.length <= SHARED_PLAN_MAX_TOKEN_LENGTH);
  assert.deepEqual(decodeSharedPlanSnapshot(token, validSpotIds), shared);
});

test("shared plan includes dates only when explicitly requested", () => {
  const withoutDates = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds);
  const withDates = createSharedPlanSnapshot(plannerSnapshot(), validSpotIds, {
    includeDates: true,
  });
  assert.ok(withoutDates);
  assert.ok(withDates);
  assert.equal("visitDate" in withoutDates.days[0], false);
  assert.deepEqual(withDates.days.map((day) => day.visitDate), [
    "2026-09-12",
    "2026-09-13",
  ]);
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

test("shared plan rejects corrupted, oversized, and unknown-version tokens", () => {
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

  const enormousSpotId = `spot-${"x".repeat(7_000)}`;
  const enormousSnapshot = plannerSnapshot();
  enormousSnapshot.plannerDays = [{
    ...enormousSnapshot.plannerDays[0],
    itineraryIds: [enormousSpotId],
  }];
  enormousSnapshot.itineraryIds = [enormousSpotId];
  enormousSnapshot.stayMinutes = { [enormousSpotId]: 30 };
  const enormousShared = createSharedPlanSnapshot(
    enormousSnapshot,
    new Set([enormousSpotId]),
  );
  assert.ok(enormousShared);
  assert.equal(encodeSharedPlanSnapshot(enormousShared, new Set([enormousSpotId])), null);

  const unknownVersionPayload = Buffer.from(JSON.stringify({
    v: 2,
    d: [["09:00", "18:00", ["kanazawa-station"]]],
    s: [],
    m: "WALKING",
    o: 0,
    a: 0,
  }), "utf8").toString("base64url");
  assert.equal(decodeSharedPlanSnapshot(unknownVersionPayload, validSpotIds), null);
});
