import { MapboxMvp } from "../MapboxMvp";
import { spots } from "../spots";

export const dynamic = "force-dynamic";

export default function MapboxMvpPage() {
  return (
    <MapboxMvp
      initialToken={process.env.MAPBOX_PUBLIC_ACCESS_TOKEN?.trim() ?? ""}
      spots={spots}
    />
  );
}
