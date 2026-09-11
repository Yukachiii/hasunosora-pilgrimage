import assert from "node:assert/strict";
import test from "node:test";

import { reorderIdsForInsertion, sameIdOrder } from "../app/itinerary-order.ts";

test("itinerary ids move to a requested insertion point", () => {
  const original = ["station", "market", "park", "museum"];

  assert.deepEqual(
    reorderIdsForInsertion(original, "station", 2),
    ["market", "park", "station", "museum"],
  );
  assert.deepEqual(
    reorderIdsForInsertion(original, "museum", 0),
    ["museum", "station", "market", "park"],
  );
  assert.deepEqual(
    reorderIdsForInsertion(original, "market", 99),
    ["station", "park", "museum", "market"],
  );
  assert.deepEqual(reorderIdsForInsertion(original, "missing", 0), original);
  assert.equal(sameIdOrder(reorderIdsForInsertion(original, "market", 1), original), true);
  assert.equal(sameIdOrder(reorderIdsForInsertion(original, "market", 3), original), false);
});
