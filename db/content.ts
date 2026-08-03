import { desc, eq, sql } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { PilgrimageSpot } from "@/app/spots";
import { getDb } from ".";
import { mediaAssets, spotOverrides } from "./schema";

export type MediaAsset = InferSelectModel<typeof mediaAssets>;
export type NewMediaAsset = InferInsertModel<typeof mediaAssets>;
export type SpotOverride = InferSelectModel<typeof spotOverrides>;

export async function listPublishedMedia(): Promise<MediaAsset[]> {
  return (await getDb())
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.status, "published"))
    .orderBy(desc(mediaAssets.createdAt));
}

export async function listAdminMedia(): Promise<MediaAsset[]> {
  return (await getDb())
    .select()
    .from(mediaAssets)
    .orderBy(desc(mediaAssets.createdAt));
}

export async function findMediaAsset(id: string): Promise<MediaAsset | null> {
  const [asset] = await (await getDb())
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id))
    .limit(1);
  return asset ?? null;
}

export async function insertMediaAsset(asset: NewMediaAsset) {
  const [created] = await (await getDb())
    .insert(mediaAssets)
    .values(asset)
    .returning();
  return created;
}

export async function deleteMediaAsset(id: string) {
  const asset = await findMediaAsset(id);
  if (!asset) return null;
  await (await getDb()).delete(mediaAssets).where(eq(mediaAssets.id, id));
  return asset;
}

export async function listSpotOverrides(): Promise<SpotOverride[]> {
  return (await getDb()).select().from(spotOverrides);
}

export async function upsertSpotOverride(
  spot: PilgrimageSpot,
  updatedBy: string,
) {
  const values = {
    spotId: spot.id,
    name: spot.name,
    shortName: spot.shortName,
    area: spot.area,
    category: spot.category,
    address: spot.address,
    lat: spot.lat,
    lng: spot.lng,
    description: spot.description,
    accessNote: spot.accessNote,
    sourceUrl: spot.sourceUrl,
    updatedBy,
  };

  const [saved] = await (await getDb())
    .insert(spotOverrides)
    .values(values)
    .onConflictDoUpdate({
      target: spotOverrides.spotId,
      set: {
        ...values,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning();
  return saved;
}

export async function deleteSpotOverride(spotId: string) {
  await (await getDb())
    .delete(spotOverrides)
    .where(eq(spotOverrides.spotId, spotId));
}

export function applySpotOverrides(
  baseSpots: PilgrimageSpot[],
  overrides: SpotOverride[],
): PilgrimageSpot[] {
  const byId = new Map(overrides.map((override) => [override.spotId, override]));

  return baseSpots.map((spot) => {
    const override = byId.get(spot.id);
    if (!override) return spot;

    return {
      ...spot,
      name: override.name,
      shortName: override.shortName,
      area: override.area,
      category: override.category as PilgrimageSpot["category"],
      address: override.address,
      lat: override.lat,
      lng: override.lng,
      description: override.description,
      accessNote: override.accessNote,
      sourceUrl: override.sourceUrl,
    };
  });
}
