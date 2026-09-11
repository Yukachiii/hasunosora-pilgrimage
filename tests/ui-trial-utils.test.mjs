import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  filterTrialCards,
  hasValidTimeWindow,
  hasValidVisitDate,
  mergeItineraryIds,
  orderItemsByIds,
  retainCompletedSpotIds,
} from "../github-pages/ui-test/trial-utils.ts";

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
