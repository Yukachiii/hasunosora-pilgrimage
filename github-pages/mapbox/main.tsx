import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "mapbox-gl/dist/mapbox-gl.css";
import { MapboxMvp } from "../../app/MapboxMvp";
import { spots } from "../../app/spots";
import "../../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MapboxMvp
      initialToken={import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim() ?? ""}
      spots={spots}
    />
  </StrictMode>,
);
