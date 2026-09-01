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

const publicSpots = spots.map((spot) => ({
  ...spot,
  imageUrl: resolvePhotoUrl(spot.imageUrl),
}));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PilgrimageApp
      mapboxConfig={{
        accessToken: import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim() ?? "",
      }}
      spots={publicSpots}
      spotImages={{}}
      heroImage={resolvePhotoUrl(siteSettings.heroImage) ?? null}
    />
  </StrictMode>,
);
