import { PilgrimageApp } from "./PilgrimageApp";
import { spots as baseSpots } from "./spots";
import {
  applySpotOverrides,
  listPublishedMedia,
  listSpotOverrides,
} from "@/db/content";

export const dynamic = "force-dynamic";

export default async function Home() {
  const mapboxConfig = {
    accessToken: process.env.MAPBOX_PUBLIC_ACCESS_TOKEN?.trim() ?? "",
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

  heroImage ??= "/photos/hero/20260806-074048-78b958e5201d8916-watermarked.webp";

  return (
    <PilgrimageApp
      mapboxConfig={mapboxConfig}
      routeServiceUrl="/api/routes/plan"
      spots={spots}
      spotImages={spotImages}
      heroImage={heroImage}
    />
  );
}
