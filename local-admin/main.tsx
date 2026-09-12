import { StrictMode, useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp, type AdminAsset } from "../app/admin/AdminApp";
import type { AdminCommunitySubmission } from "../app/admin/CommunitySubmissionReview";
import type { PilgrimageSpot } from "../app/spots";
import "mapbox-gl/dist/mapbox-gl.css";
import "../app/globals.css";

type AdminState = {
  spots: PilgrimageSpot[];
  assets: AdminAsset[];
  submissions: AdminCommunitySubmission[];
  siteVersion: string;
  writeToken: string;
  lanUrl: string;
};

type AdminLoadState = {
  state: AdminState | null;
  error: string;
};

async function fetchAdminState(): Promise<AdminState> {
  const response = await fetch("/api/admin/state", { cache: "no-store" });
  const result = (await response.json()) as AdminState & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "管理データを読み込めませんでした。");
  return result;
}

function useAdminState(): AdminLoadState {
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchAdminState()
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "管理データを読み込めませんでした。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { state, error };
}

function AdminLoadError({ error }: { error: string }): ReactElement {
  return (
    <main className="admin-shell admin-shell--centered">
      <section className="admin-denied">
        <span>LOCAL</span>
        <h1>管理データを読み込めませんでした</h1>
        <p>{error}</p>
        <a href="/admin/">再読み込み</a>
      </section>
    </main>
  );
}

function AdminLoading(): ReactElement {
  return (
    <main className="admin-shell admin-shell--centered">
      <p className="admin-loading">ローカル管理画面を準備しています…</p>
    </main>
  );
}

function LoadedAdmin({ state }: { state: AdminState }): ReactElement {
  return (
    <AdminApp
      baseSpots={state.spots}
      initialSpots={state.spots}
      overriddenSpotIds={[]}
      initialAssets={state.assets}
      initialSubmissions={state.submissions}
      localToken={state.writeToken}
      localNetworkUrl={state.lanUrl}
      initialSiteVersion={state.siteVersion}
    />
  );
}

function LocalAdminRoot(): ReactElement {
  const { state, error } = useAdminState();

  if (error) {
    return <AdminLoadError error={error} />;
  }

  if (!state) return <AdminLoading />;

  return <LoadedAdmin state={state} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocalAdminRoot />
  </StrictMode>,
);
