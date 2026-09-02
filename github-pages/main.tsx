import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "mapbox-gl/dist/mapbox-gl.css";
import { PilgrimageApp } from "../app/PilgrimageApp";
import { spots } from "../app/spots";
import siteSettings from "../content/site.json";
import "../app/globals.css";

const photoModules = import.meta.glob<string>(
  "../public/photos/**/*.{jpg,jpeg,png,webp}",
  { eager: true, query: "?url", import: "default" },
);

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

const heroImages = uniquePhotoUrls([
  resolvePhotoUrl(siteSettings.heroImage),
  ...siteSettings.heroImages.map(resolvePhotoUrl),
]);
const initialHeroIndex = chooseHeroIndex(heroImages);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PilgrimageApp
      mapboxConfig={{
        accessToken: import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim() ?? "",
      }}
      spots={publicSpots}
      spotImages={{}}
      heroImages={heroImages}
      initialHeroIndex={initialHeroIndex}
    />
  </StrictMode>,
);
