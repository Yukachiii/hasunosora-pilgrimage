import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  filterTrialCards,
  hasValidTimeWindow,
  hasValidVisitDate,
  isItineraryComplete,
  mergeItineraryIds,
  orderItemsByIds,
  retainCompletedSpotIds,
} from "../github-pages/ui-test/trial-utils.ts";
import {
  restoreRouteCache,
  routeCacheAfterDayRemoval,
  routeResultAfterMapUpdate,
} from "../github-pages/ui-test/route-cache.ts";

test("the default trial card list includes every content record", async () => {
  const [cards, spots] = await Promise.all([
    readFile(new URL("../content/card-models.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../content/spots.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const trialCards = cards.map((card) => ({ ...card, characters: [] }));

  assert.deepEqual(
    filterTrialCards(trialCards, spots, { query: "", area: "all", category: "all", character: "all" })
      .map((card) => card.id),
    cards.map((card) => card.id),
  );
});

test("trial card filters keep cards whose spot is not registered", () => {
  const cards = [
    {
      id: "registered",
      card: "金沢のカード",
      model: "金沢駅",
      address: "石川県金沢市",
      note: "",
      spotId: "station",
      characters: ["村野さやか"],
    },
    {
      id: "unregistered",
      card: "東京のカード",
      model: "神田明神",
      address: "東京都千代田区",
      note: "",
      spotId: null,
      characters: ["村野さやか"],
    },
  ];
  const spots = [{ id: "station", name: "金沢駅・鼓門", area: "金沢駅周辺", category: "交通" }];

  assert.deepEqual(
    filterTrialCards(cards, spots, { query: "", area: "all", category: "all", character: "all" })
      .map((card) => card.id),
    ["registered", "unregistered"],
  );
  assert.deepEqual(
    filterTrialCards(cards, spots, { query: "神田", area: "all", category: "all", character: "all" })
      .map((card) => card.id),
    ["unregistered"],
  );
  assert.deepEqual(
    filterTrialCards(cards, spots, { query: "", area: "金沢駅周辺", category: "all", character: "all" })
      .map((card) => card.id),
    ["registered"],
  );
});

test("collaboration spots append without replacing the current itinerary", () => {
  assert.deepEqual(
    mergeItineraryIds(
      ["station", "market"],
      ["market", "park", "unknown"],
      new Set(["station", "market", "park"]),
      25,
    ),
    ["station", "market", "park"],
  );
  assert.deepEqual(
    mergeItineraryIds(["station"], ["market", "park"], new Set(["station", "market", "park"]), 2),
    ["station", "market"],
  );
});

test("reordering one day keeps completed spots from every remaining day", () => {
  assert.deepEqual(
    retainCompletedSpotIds(
      ["active-stop", "other-day-stop", "removed-stop"],
      ["active-stop"],
      ["other-day-stop"],
    ),
    ["active-stop", "other-day-stop"],
  );
});

test("an itinerary is complete only when it has stops and every stop is completed", () => {
  assert.equal(isItineraryComplete([], []), false);
  assert.equal(isItineraryComplete(["station"], []), false);
  assert.equal(isItineraryComplete(["station"], ["station"]), true);
  assert.equal(isItineraryComplete(["station", "market"], ["station"]), false);
  assert.equal(isItineraryComplete(["station", "market"], ["market", "station", "other-day-stop"]), true);
});

test("optimized route ids control the displayed stop order", () => {
  const items = [{ id: "station" }, { id: "market" }, { id: "park" }];
  assert.deepEqual(
    orderItemsByIds(items, ["park", "station", "market"]).map((item) => item.id),
    ["park", "station", "market"],
  );
  assert.deepEqual(
    orderItemsByIds(items, ["park", "station"]).map((item) => item.id),
    ["park", "station", "market"],
  );
});

test("route calculation requires an end time after the start time", () => {
  assert.equal(hasValidTimeWindow("09:00", "18:00"), true);
  assert.equal(hasValidTimeWindow("18:00", "09:00"), false);
  assert.equal(hasValidTimeWindow("09:00", "09:00"), false);
  assert.equal(hasValidTimeWindow("invalid", "18:00"), false);
  assert.equal(hasValidTimeWindow("24:00", "25:00"), false);
  assert.equal(hasValidTimeWindow("09:60", "18:00"), false);
  assert.equal(hasValidTimeWindow("09:00:extra", "18:00"), false);
});

test("route calculation requires a real visit date", () => {
  assert.equal(hasValidVisitDate("2026-09-11"), true);
  assert.equal(hasValidVisitDate(""), false);
  assert.equal(hasValidVisitDate("2026-02-30"), false);
  assert.equal(hasValidVisitDate("2026-13-01"), false);
});

test("stored routes reject malformed result fields instead of restoring unsafe data", () => {
  const spots = [{ id: "station" }, { id: "market" }];
  const request = {
    stops: [{ id: "station" }, { id: "market" }],
    travelMode: "WALKING",
    optimizeWaypointOrder: false,
    stayMinutes: { station: 15, market: 35 },
    departureTime: "2026-09-12T00:00:00.000Z",
  };
  const validResult = {
    state: "success",
    distance: "1 km",
    duration: "12分",
    travelDurationMinutes: 12,
    accessDurationMinutes: 0,
    legDurationMinutes: [12],
    orderedStopIds: ["station", "market"],
  };

  assert.equal(
    restoreRouteCache({ day: { request, result: validResult } }, spots, new Set(["day"]))
      .day.result.state,
    "success",
  );
  assert.deepEqual(
    restoreRouteCache({ day: { request, result: { ...validResult, legDurationMinutes: ["12"] } } }, spots),
    {},
  );
  assert.deepEqual(
    restoreRouteCache({ day: { request, result: { ...validResult, orderedStopIds: ["station", "station"] } } }, spots),
    {},
  );
  assert.deepEqual(
    restoreRouteCache({ day: { request, result: { state: "external" } } }, spots),
    {},
  );
});

test("a cached usable route survives a background map refresh failure", () => {
  const cached = {
    state: "success",
    distance: "1 km",
    duration: "12分",
    legDurationMinutes: [12],
    orderedStopIds: ["station", "market"],
  };

  assert.equal(routeResultAfterMapUpdate(cached, { state: "loading" }, true), cached);
  assert.equal(routeResultAfterMapUpdate(cached, { state: "error", message: "offline" }, true), cached);
  assert.equal(routeResultAfterMapUpdate(cached, { state: "fallback", message: "offline" }, true), cached);

  const refreshed = { ...cached, duration: "10分", legDurationMinutes: [10] };
  assert.equal(routeResultAfterMapUpdate(cached, refreshed, true), refreshed);
  assert.deepEqual(
    routeResultAfterMapUpdate({ state: "loading" }, { state: "error", message: "offline" }, true),
    { state: "error", message: "offline" },
  );
  assert.deepEqual(
    routeResultAfterMapUpdate(cached, { state: "error", message: "stale route" }, false),
    { state: "error", message: "stale route" },
  );
});

test("removing a day restores the remaining active day's cached route", () => {
  const dayOne = { request: { requestId: 1 }, result: { state: "success", duration: "10分" } };
  const dayTwo = { request: { requestId: 2 }, result: { state: "success", duration: "20分" } };

  const transition = routeCacheAfterDayRemoval(
    { "day-1": dayOne, "day-2": dayTwo },
    "day-1",
    "day-2",
  );

  assert.deepEqual(transition.routes, { "day-2": dayTwo });
  assert.equal(transition.activeRoute, dayTwo);
});
