import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PilgrimageApp } from "../app/PilgrimageApp";
import { spots } from "../app/spots";
import kanazawaStationPhoto from "../public/photos/kanazawa-station/20260724-230203-watermarked.webp";
import "../app/globals.css";

const staticSpotImages: Record<string, string> = {
  "kanazawa-station": kanazawaStationPhoto,
};

const publicSpots = spots.map((spot) => ({
  ...spot,
  imageUrl: staticSpotImages[spot.id],
}));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PilgrimageApp
      googleMapsConfig={{
        apiKey: import.meta.env.VITE_GOOGLE_MAPS_BROWSER_API_KEY?.trim() ?? "",
        mapId:
          import.meta.env.VITE_GOOGLE_MAPS_MAP_ID?.trim() || "DEMO_MAP_ID",
      }}
      spots={publicSpots}
      spotImages={{}}
      heroImage={null}
    />
  </StrictMode>,
);
