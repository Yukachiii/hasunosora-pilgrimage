import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp, type AdminAsset } from "../app/admin/AdminApp";
import type { PilgrimageSpot } from "../app/spots";
import "../app/globals.css";

type AdminState = {
  spots: PilgrimageSpot[];
  assets: AdminAsset[];
  writeToken: string;
  lanUrl: string;
};

function LocalAdminRoot() {
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/state", { cache: "no-store" })
      .then(async (response) => {
        const result = (await response.json()) as AdminState & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "管理データを読み込めませんでした。");
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

  if (error) {
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

  if (!state) {
    return (
      <main className="admin-shell admin-shell--centered">
        <p className="admin-loading">ローカル管理画面を準備しています…</p>
      </main>
    );
  }

  return (
    <AdminApp
      userName="ローカル管理"
      signOutPath="/admin/"
      baseSpots={state.spots}
      initialSpots={state.spots}
      overriddenSpotIds={[]}
      initialAssets={state.assets}
      localMode
      localToken={state.writeToken}
      localNetworkUrl={state.lanUrl}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocalAdminRoot />
  </StrictMode>,
);
