import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

function assertUniqueIds(records, label) {
  assert.ok(records.length > 0, `${label} is empty`);
  const ids = records.map((record) => record.id);
  assert.ok(ids.every((id) => typeof id === "string" && id.trim()), `${label} has an empty id`);
  assert.equal(new Set(ids).size, records.length, `${label} has a duplicate id`);
}

function publicAssetUrl(assetPath) {
  const relativePath = assetPath.replace(/^\.\//, "").replace(/^\//, "");
  return new URL(`../public/${relativePath}`, import.meta.url);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

function hasTextFields(record, fields) {
  return fields.every((field) => typeof record[field] === "string" && record[field].trim());
}

test("public location records have valid ids, coordinates, and references", async () => {
  const [spots, cardModels, collaborations] = await Promise.all([
    readJson("../content/spots.json"),
    readJson("../content/card-models.json"),
    readJson("../content/collaborations.json"),
  ]);
  assertUniqueIds(spots, "spots");
  assertUniqueIds(cardModels, "card models");
  assertUniqueIds(collaborations, "collaborations");

  const spotIds = new Set(spots.map((spot) => spot.id));
  const collaborationIds = new Set(collaborations.map((collaboration) => collaboration.id));

  assert.ok(spots.every((spot) => hasTextFields(spot, [
    "name", "shortName", "area", "category", "address", "description", "accessNote", "sourceUrl",
  ])), "a spot is missing required text");
  assert.ok(spots.every((spot) => (
    Number.isFinite(spot.lat)
    && spot.lat >= -90
    && spot.lat <= 90
    && Number.isFinite(spot.lng)
    && spot.lng >= -180
    && spot.lng <= 180
  )), "a spot has invalid coordinates");
  assert.ok(cardModels.every((card) => hasTextFields(card, [
    "card", "model", "address", "confidence", "sourceUrl",
  ])), "a card model is missing required text");
  assert.ok(cardModels.every((card) => card.spotId === null || spotIds.has(card.spotId)),
    "a card model refers to an unknown spot");
  assert.ok(collaborations.every((collaboration) => (
    hasTextFields(collaboration, ["name", "startDate", "endDate", "description", "sourceUrl"])
    && Array.isArray(collaboration.locations)
  )), "a collaboration is missing required content");
  assert.ok(collaborations.every((collaboration) =>
    collaboration.locations.every((location) => spotIds.has(location.spotId))),
  "a collaboration refers to an unknown spot");
  assert.ok(spots.every((spot) =>
    (spot.collaborationIds ?? []).every((id) => collaborationIds.has(id))),
  "a spot refers to an unknown collaboration");
});

test("content records refer only to existing public image files", async () => {
  const [spots, cardModels, media] = await Promise.all([
    readJson("../content/spots.json"),
    readJson("../content/card-models.json"),
    readJson("../content/media.json"),
  ]);
  assertUniqueIds(media, "media");

  const spotIds = new Set(spots.map((spot) => spot.id));
  assert.ok(media.every((asset) => (
    asset.placement === "hero"
      ? asset.spotId === null
      : asset.placement === "spot" && spotIds.has(asset.spotId)
  )), "a media record has an invalid placement or spot reference");

  const imagePaths = new Set([
    ...spots.map((spot) => spot.imageUrl).filter(Boolean),
    ...cardModels.map((card) => card.imageUrl).filter(Boolean),
    ...media.map((asset) => asset.imageUrl).filter(Boolean),
  ]);
  assert.ok(imagePaths.size > 0, "no public images are referenced");
  await Promise.all([...imagePaths].map((imagePath) => access(publicAssetUrl(imagePath))));
});
