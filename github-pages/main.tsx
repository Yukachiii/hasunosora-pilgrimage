import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "mapbox-gl/dist/mapbox-gl.css";
import { PilgrimageApp } from "../app/PilgrimageApp";
import { spots } from "../app/spots";
import mediaAssets from "../content/media.json";
import siteSettings from "../content/site.json";
import "../app/globals.css";

type PublicMediaAsset = {
  placement: string;
  spotId?: string | null;
  imageUrl?: string | null;
  creditName?: string;
};

const publicMediaAssets = mediaAssets as PublicMediaAsset[];

const photoModules = import.meta.glob(
  "../public/photos/**/*.{jpg,jpeg,png,webp}",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

function resolvePhotoUrl(source?: string | null) {
  if (!source?.startsWith("/photos/")) return undefined;
  return photoModules[`../public${source}`];
}

function uniquePhotoUrls(sources: Array<string | undefined>) {
  return Array.from(new Set(sources.filter((source): source is string => Boolean(source))));
}

function chooseHeroIndex(heroImages: string[]) {
  if (heroImages.length < 2) return 0;

  const storageKey = "hasunosora-pilgrimage.hero-image.v1";
  let previousImage = "";
  try {
    previousImage = window.localStorage.getItem(storageKey) ?? "";
  } catch {
    // Browsers can block storage while still allowing the page to render.
  }

  const candidateIndexes = heroImages.flatMap((image, index) =>
    image === previousImage ? [] : [index],
  );
  const index = candidateIndexes[Math.floor(Math.random() * candidateIndexes.length)] ?? 0;

  try {
    window.localStorage.setItem(storageKey, heroImages[index]);
  } catch {
    // Random selection itself does not depend on storage being available.
  }
  return index;
}

const publicSpots = spots.map((spot) => ({
  ...spot,
  imageUrl: resolvePhotoUrl(spot.imageUrl),
}));

const spotPhotoGroups = publicMediaAssets.reduce<Record<string, string[]>>((groups, asset) => {
  if (asset.placement !== "spot" || !asset.spotId) return groups;
  const imageUrl = resolvePhotoUrl(asset.imageUrl);
  if (!imageUrl) return groups;
  groups[asset.spotId] ??= [];
  if (!groups[asset.spotId].includes(imageUrl)) groups[asset.spotId].push(imageUrl);
  return groups;
}, {});

const photoCredits = publicMediaAssets.reduce<Record<string, string>>((credits, asset) => {
  const imageUrl = resolvePhotoUrl(asset.imageUrl);
  if (imageUrl && asset.creditName?.trim()) credits[imageUrl] = asset.creditName.trim();
  return credits;
}, {});

const heroImages = uniquePhotoUrls([
  resolvePhotoUrl(siteSettings.heroImage),
  ...siteSettings.heroImages.map(resolvePhotoUrl),
]);
const initialHeroIndex = chooseHeroIndex(heroImages);
const communityApiUrl = import.meta.env.VITE_COMMUNITY_API_URL?.trim() ?? "";
const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PilgrimageApp
      mapboxConfig={{
        accessToken: import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim() ?? "",
      }}
      spots={publicSpots}
      spotPhotoGroups={spotPhotoGroups}
      photoCredits={photoCredits}
      heroImages={heroImages}
      initialHeroIndex={initialHeroIndex}
      siteVersion={siteSettings.version}
      communityApiUrl={communityApiUrl}
      turnstileSiteKey={turnstileSiteKey}
      communitySubmissionsEnabled={Boolean(communityApiUrl)}
    />
  </StrictMode>,
);
