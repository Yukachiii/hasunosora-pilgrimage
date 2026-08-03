import { PilgrimageApp } from "./PilgrimageApp";
import { spots as baseSpots } from "./spots";
import {
  applySpotOverrides,
  listPublishedMedia,
  listSpotOverrides,
} from "@/db/content";

export const dynamic = "force-dynamic";

export default async function Home() {
  const googleMapsConfig = {
    apiKey: process.env.GOOGLE_MAPS_BROWSER_API_KEY?.trim() ?? "",
    mapId: process.env.GOOGLE_MAPS_MAP_ID?.trim() || "DEMO_MAP_ID",
  };

  let spots = baseSpots;
  const spotImages: Record<string, string> = {};
  let heroImage: string | null = null;

  try {
    const [overrides, media] = await Promise.all([
      listSpotOverrides(),
      listPublishedMedia(),
    ]);
    spots = applySpotOverrides(baseSpots, overrides);

    for (const asset of media) {
      const imageUrl = `/api/media/${asset.id}`;
      if (asset.placement === "hero" && !heroImage) {
        heroImage = imageUrl;
      }
      if (
        asset.placement === "spot" &&
        asset.spotId &&
        !spotImages[asset.spotId]
      ) {
        spotImages[asset.spotId] = imageUrl;
      }
    }
  } catch {
    // Local tests and the first deployment can run before D1 is available.
  }

  return (
    <PilgrimageApp
      googleMapsConfig={googleMapsConfig}
      spots={spots}
      spotImages={spotImages}
      heroImage={heroImage}
    />
  );
}
