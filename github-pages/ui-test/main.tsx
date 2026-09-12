import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "mapbox-gl/dist/mapbox-gl.css";
import { spots } from "../../app/spots";
import mediaAssets from "../../content/media.json";
import siteSettings from "../../content/site.json";
import { UiTrialApp } from "./UiTrialApp";
import "./ui-test.css";

type PublicMediaAsset = {
  placement: string;
  spotId?: string | null;
  imageUrl?: string | null;
  creditName?: string;
};

const publicMediaAssets = mediaAssets as PublicMediaAsset[];
const photoModules = import.meta.glob(
  "../../public/photos/**/*.{jpg,jpeg,png,webp}",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

function resolvePhotoUrl(source?: string | null) {
  if (!source?.startsWith("/photos/")) return undefined;
  return photoModules[`../../public${source}`];
}

const publicSpots = spots.map((spot) => ({ ...spot, imageUrl: resolvePhotoUrl(spot.imageUrl) }));
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
const communityApiUrl = import.meta.env.VITE_COMMUNITY_API_URL?.trim() ?? "";
const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? "";

class TrialAppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI trial rendering failed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="ui-trial__error" role="alert">
        <span aria-hidden="true">蓮</span>
        <small>DISPLAY RECOVERY</small>
        <h1>画面を表示できませんでした</h1>
        <p>テスト版の予定はこの端末に残っています。再読み込みしてください。</p>
        <button type="button" onClick={() => window.location.reload()}>再読み込み</button>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TrialAppErrorBoundary>
      <UiTrialApp
        spots={publicSpots}
        spotPhotoGroups={spotPhotoGroups}
        photoCredits={photoCredits}
        siteVersion={siteSettings.version}
        communityApiUrl={communityApiUrl}
        turnstileSiteKey={turnstileSiteKey}
        communitySubmissionsEnabled={Boolean(communityApiUrl)}
      />
    </TrialAppErrorBoundary>
  </StrictMode>,
);
