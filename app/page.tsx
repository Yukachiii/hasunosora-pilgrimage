import { randomInt } from "node:crypto";
import { PilgrimageApp } from "./PilgrimageApp";
import { spots as baseSpots } from "./spots";
import siteSettings from "../content/site.json";
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
  const heroImages: string[] = [];

  try {
    const [overrides, media] = await Promise.all([
      listSpotOverrides(),
      listPublishedMedia(),
    ]);
    spots = applySpotOverrides(baseSpots, overrides);

    for (const asset of media) {
      const imageUrl = `/api/media/${asset.id}`;
      if (asset.placement === "hero") {
        heroImages.push(imageUrl);
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

  for (const imageUrl of [siteSettings.heroImage, ...siteSettings.heroImages]) {
    if (!heroImages.includes(imageUrl)) heroImages.push(imageUrl);
  }
  const initialHeroIndex = heroImages.length ? randomInt(heroImages.length) : 0;

  return (
    <PilgrimageApp
      mapboxConfig={mapboxConfig}
      routeServiceUrl="/api/routes/plan"
      spots={spots}
      spotImages={spotImages}
      heroImages={heroImages}
      initialHeroIndex={initialHeroIndex}
    />
  );
}
