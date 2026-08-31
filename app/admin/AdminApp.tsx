"use client";

import { gps as readGps } from "exifr/dist/mini.esm.mjs";
import mapboxgl from "mapbox-gl";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  cardModels,
  type CardModelLocation,
  type PilgrimageSpot,
} from "@/app/spots";
import type { TravelMode } from "@/app/route-planner";
import type { RouteUsageResponse } from "./route-usage-types";

export type AdminAsset = {
  id: string;
  originalName: string;
  placement: string;
  spotId: string | null;
  createdAt: string;
  imageUrl: string;
};

type Props = {
  userName: string;
  signOutPath: string;
  baseSpots: PilgrimageSpot[];
  initialSpots: PilgrimageSpot[];
  overriddenSpotIds: string[];
  initialAssets: AdminAsset[];
  localMode?: boolean;
  localToken?: string;
  localNetworkUrl?: string;
};

type PublishStatus = {
  available: boolean;
  remoteConfigured: boolean;
  identityConfigured: boolean;
  branch: string;
  publishToken: string;
  hasLocalChanges: boolean;
  error?: string;
};

const travelModeLabels: Record<TravelMode, string> = {
  WALKING: "徒歩",
  DRIVING: "車",
  TRANSIT: "公共交通",
  BICYCLING: "自転車",
};

async function loadPublishStatus(): Promise<PublishStatus> {
  try {
    const response = await fetch("/api/admin/publish-status", { cache: "no-store" });
    const result = (await response.json()) as PublishStatus;
    if (!response.ok) throw new Error(result.error ?? "GitHubの状態を確認できませんでした。");
    return result;
  } catch (error) {
    return {
      available: false,
      remoteConfigured: false,
      identityConfigured: false,
      branch: "",
      publishToken: "",
      hasLocalChanges: false,
      error: error instanceof Error ? error.message : "ローカルサーバーへ接続できません。",
    };
  }
}

type Placement = "spot" | "hero";
type QueuedPhoto = { file: File; url: string };
type GpsState =
  | { state: "loading" }
  | { state: "none" }
  | {
      state: "found";
      lat: number;
      lng: number;
      nearestSpotId: string;
      distanceM: number;
    };

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const watermarkText = "© Yukachiii";

function distanceInMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const latDelta = radians(b.lat - a.lat);
  const lngDelta = radians(b.lng - a.lng);
  const aLat = radians(a.lat);
  const bLat = radians(b.lat);
  const value =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * Math.sin(lngDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function nearestSpot(lat: number, lng: number, spots: PilgrimageSpot[]) {
  return spots
    .map((spot) => ({
      spot,
      distanceM: distanceInMeters({ lat, lng }, spot),
    }))
    .sort((a, b) => a.distanceM - b.distanceM)[0];
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    image.src = url;
  });
}

function drawCroppedImage(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  placement: Placement,
  cropX: number,
  cropY: number,
  zoom: number,
  fullSize = false,
) {
  const width = fullSize ? (placement === "hero" ? 1600 : 1200) : placement === "hero" ? 800 : 600;
  const height = fullSize ? 900 : 450;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("画像編集を開始できませんでした。");
  const coverScale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const scale = coverScale * zoom;
  const scaledWidth = image.naturalWidth * scale;
  const scaledHeight = image.naturalHeight * scale;
  const overflowX = Math.max(0, scaledWidth - width);
  const overflowY = Math.max(0, scaledHeight - height);
  const offsetX = -(overflowX * cropX) / 100;
  const offsetY = -(overflowY * cropY) / 100;

  context.clearRect(0, 0, width, height);
  context.drawImage(image, offsetX, offsetY, scaledWidth, scaledHeight);
  drawWatermark(context, width, height);
}

function drawWatermark(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const labelSize = Math.max(16, Math.round(width * 0.031));
  const centerSize = Math.max(30, Math.round(width * 0.06));
  const padding = Math.max(16, Math.round(width * 0.025));

  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(-Math.PI / 12);
  context.font = `700 ${centerSize}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "rgba(255, 255, 255, 0.2)";
  context.strokeStyle = "rgba(15, 23, 42, 0.16)";
  context.lineWidth = Math.max(2, Math.round(centerSize * 0.055));
  context.strokeText(watermarkText, 0, 0);
  context.fillText(watermarkText, 0, 0);
  context.restore();

  context.save();
  context.font = `700 ${labelSize}px system-ui, sans-serif`;
  context.textAlign = "right";
  context.textBaseline = "alphabetic";
  const metrics = context.measureText(watermarkText);
  const boxPaddingX = Math.round(labelSize * 0.55);
  const boxPaddingY = Math.round(labelSize * 0.38);
  const boxWidth = Math.ceil(metrics.width + boxPaddingX * 2);
  const boxHeight = Math.ceil(labelSize + boxPaddingY * 2);
  const boxX = width - padding - boxWidth;
  const boxY = height - padding - boxHeight;

  context.fillStyle = "rgba(15, 23, 42, 0.58)";
  context.beginPath();
  context.roundRect(boxX, boxY, boxWidth, boxHeight, boxHeight / 2);
  context.fill();
  context.fillStyle = "rgba(255, 255, 255, 0.94)";
  context.fillText(
    watermarkText,
    width - padding - boxPaddingX,
    height - padding - boxPaddingY,
  );
  context.restore();
}

async function makePublicDerivative(
  imageUrl: string,
  placement: Placement,
  cropX: number,
  cropY: number,
  zoom: number,
) {
  const image = await loadImage(imageUrl);
  const canvas = document.createElement("canvas");
  drawCroppedImage(canvas, image, placement, cropX, cropY, zoom, true);

  const createBlob = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  const webp = await createBlob("image/webp", 0.86);
  if (webp?.type === "image/webp") return webp;
  const jpeg = await createBlob("image/jpeg", 0.88);
  if (!jpeg) throw new Error("公開用画像を生成できませんでした。");
  return jpeg;
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("公開用画像を読み込めませんでした。"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error("公開用画像を変換できませんでした。"));
      else resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function formatDistance(distanceM: number) {
  return distanceM < 1000
    ? `約${Math.round(distanceM / 10) * 10}m`
    : `約${(distanceM / 1000).toFixed(1)}km`;
}

export function AdminApp({
  userName,
  signOutPath,
  baseSpots,
  initialSpots,
  overriddenSpotIds,
  initialAssets,
  localMode = false,
  localToken = "",
  localNetworkUrl = "",
}: Props) {
  const [tab, setTab] = useState<"photos" | "spots" | "cards" | "usage">("photos");
  const [managedSpots, setManagedSpots] = useState(initialSpots);
  const [overrideIds, setOverrideIds] = useState(new Set(overriddenSpotIds));
  const [assets, setAssets] = useState(initialAssets);
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  const [shuttingDown, setShuttingDown] = useState(false);
  const [serverStopped, setServerStopped] = useState(false);
  const [networkCopyMessage, setNetworkCopyMessage] = useState("");

  useEffect(() => {
    if (!localMode) return;
    let cancelled = false;
    void loadPublishStatus().then((result) => {
      if (!cancelled) setPublishStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, [localMode]);

  async function publishToGitHub() {
    if (!publishStatus?.publishToken || publishing) return;
    if (!window.confirm(
      "ローカルファイルへ保存した変更をコミットし、GitHub Pagesへ公開しますか？",
    )) return;

    setPublishing(true);
    setPublishMessage("");
    try {
      const response = await fetch("/api/admin/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publishToken: publishStatus.publishToken }),
      });
      const result = (await response.json()) as { revision?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "GitHubへ公開できませんでした。");
      setPublishMessage(
        result.revision
          ? `GitHubへ公開しました（${result.revision}）。Actions完了後に反映されます。`
          : "公開対象の変更はありません。",
      );
      setPublishStatus(await loadPublishStatus());
    } catch (error) {
      setPublishMessage(error instanceof Error ? error.message : "GitHubへ公開できませんでした。");
    } finally {
      setPublishing(false);
    }
  }

  async function shutdownServer() {
    if (!localMode || !localToken || shuttingDown || serverStopped) return;
    if (!window.confirm(
      "管理サーバーを終了しますか？まだ保存していない入力内容は失われます。",
    )) return;

    setShuttingDown(true);
    setPublishMessage("");
    try {
      const response = await fetch("/api/admin/shutdown", {
        method: "POST",
        headers: { "x-local-admin-token": localToken },
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "管理サーバーを終了できませんでした。");
      setServerStopped(true);
      setPublishMessage("管理サーバーを終了しました。このタブは閉じてかまいません。");
    } catch (error) {
      setPublishMessage(error instanceof Error ? error.message : "管理サーバーを終了できませんでした。");
      setShuttingDown(false);
    }
  }

  async function copyNetworkUrl() {
    if (!localNetworkUrl) return;
    try {
      await navigator.clipboard.writeText(localNetworkUrl);
      setNetworkCopyMessage("コピーしました");
    } catch {
      setNetworkCopyMessage("URLを長押ししてコピーしてください");
    }
  }

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <a
          className="admin-brand"
          href={localMode ? "https://yukachiii.github.io/hasunosora-pilgrimage/" : "/"}
        >
          <span>蓮</span>
          <div>
            <strong>蓮ノ旅 管理室</strong>
            <small>CONTENT MANAGEMENT</small>
          </div>
        </a>
        <div className="admin-account">
          {localMode ? (
            <>
              <span>{publishStatus?.hasLocalChanges ? "未公開の変更あり" : "ローカル専用"}</span>
              <div className="admin-account__actions">
                <button
                  className="admin-publish admin-publish--compact"
                  type="button"
                  disabled={
                    publishing ||
                    shuttingDown ||
                    serverStopped ||
                    !publishStatus?.available ||
                    !publishStatus.remoteConfigured ||
                    !publishStatus.identityConfigured
                  }
                  onClick={publishToGitHub}
                >
                  {publishing ? "公開中…" : "GitHub Pagesへ公開"}
                </button>
                <button
                  className="admin-shutdown"
                  type="button"
                  disabled={shuttingDown || serverStopped}
                  onClick={shutdownServer}
                >
                  {serverStopped ? "終了済み" : shuttingDown ? "終了中…" : "サーバーを終了"}
                </button>
              </div>
            </>
          ) : (
            <>
              <span>{userName}</span>
              <a href={signOutPath}>ログアウト</a>
            </>
          )}
        </div>
      </header>

      <section className="admin-intro">
        <p>ADMIN MVP</p>
        <h1>写真とスポット情報を、<br />落ち着いて整える場所。</h1>
        <p>
          {localMode
            ? "変更はこのPC内の公開用ファイルへ保存されます。GitHub Pagesへ反映するまでは外部公開されません。"
            : "元写真は非公開で保管し、公開用画像からはEXIFを除去して透かしを入れます。スポット名などの修正は公開画面へすぐ反映されます。"}
        </p>
        {localMode ? (
          <div className="admin-lan-access">
            <div>
              <small>SAME WI-FI ACCESS</small>
              <strong>スマホから管理画面を開く</strong>
              {localNetworkUrl ? (
                <a href={localNetworkUrl}>{localNetworkUrl}</a>
              ) : (
                <span>接続用のローカルIPを取得できませんでした。</span>
              )}
            </div>
            {localNetworkUrl ? (
              <button type="button" onClick={copyNetworkUrl}>URLをコピー</button>
            ) : null}
            <p>
              PCとスマホを同じ信頼できるWi-Fiへ接続してください。作業後はサーバーを終了してください。
              {networkCopyMessage ? <b>{networkCopyMessage}</b> : null}
            </p>
          </div>
        ) : null}
        {localMode && publishMessage && <p className="admin-message" role="status">{publishMessage}</p>}
        {localMode && publishStatus?.error && <p className="admin-message" role="status">{publishStatus.error}</p>}
      </section>

      <nav className="admin-tabs" aria-label="管理項目">
        <button
          type="button"
          className={tab === "photos" ? "is-active" : ""}
          onClick={() => setTab("photos")}
        >
          <span>01</span>写真を配置
        </button>
        <button
          type="button"
          className={tab === "spots" ? "is-active" : ""}
          onClick={() => setTab("spots")}
        >
          <span>02</span>スポットを編集
        </button>
        <button
          type="button"
          className={tab === "cards" ? "is-active" : ""}
          onClick={() => setTab("cards")}
        >
          <span>03</span>カードを確認
        </button>
        <button
          type="button"
          className={tab === "usage" ? "is-active" : ""}
          onClick={() => setTab("usage")}
        >
          <span>04</span>API使用状況
        </button>
      </nav>

      {tab === "photos" ? (
        <PhotoManager
          spots={managedSpots}
          assets={assets}
          setAssets={setAssets}
          localMode={localMode}
          localToken={localToken}
        />
      ) : tab === "spots" ? (
        <SpotManager
          spots={managedSpots}
          setSpots={setManagedSpots}
          baseSpots={baseSpots}
          overrideIds={overrideIds}
          setOverrideIds={setOverrideIds}
          localMode={localMode}
          localToken={localToken}
        />
      ) : tab === "cards" ? (
        <CardModelDashboard cards={cardModels} />
      ) : (
        <ApiUsageDashboard localMode={localMode} />
      )}
    </main>
  );
}

const confidenceDescriptions: Record<CardModelLocation["confidence"], string> = {
  A: "複数資料、公式に近い資料、または現地比較で十分に確認できた地点",
  B: "有力な候補だが、公式明記や複数の独立資料までは確認できていない地点",
  C: "調査中。手掛かりとして保存している段階で、公開追加には再確認が必要な地点",
};

function CardModelDashboard({ cards }: { cards: CardModelLocation[] }) {
  const [query, setQuery] = useState("");
  const [confidence, setConfidence] = useState<CardModelLocation["confidence"] | "すべて">("すべて");
  const normalizedQuery = query.trim().toLocaleLowerCase("ja");
  const filteredCards = cards.filter((card) => {
    const matchesConfidence = confidence === "すべて" || card.confidence === confidence;
    const matchesQuery = !normalizedQuery || [card.card, card.model, card.address, card.note]
      .join(" ")
      .toLocaleLowerCase("ja")
      .includes(normalizedQuery);
    return matchesConfidence && matchesQuery;
  });
  const totals = cards.reduce<Record<CardModelLocation["confidence"], number>>(
    (result, card) => ({ ...result, [card.confidence]: result[card.confidence] + 1 }),
    { A: 0, B: 0, C: 0 },
  );

  return (
    <section className="admin-cards admin-panel">
      <div className="admin-panel__heading">
        <div><span>CARD SOURCES</span><h2>カードモデル地の確認</h2></div>
        <small>{cards.length}件</small>
      </div>
      <p className="admin-cards__intro">
        信頼度は管理用です。公開ページには表示しません。出典を開き、追加・修正時の判断材料にしてください。
      </p>
      <div className="admin-confidence-guide" aria-label="信頼度の基準">
        {(["A", "B", "C"] as const).map((rank) => (
          <div key={rank}>
            <b className={`admin-confidence admin-confidence--${rank.toLocaleLowerCase()}`}>{rank}</b>
            <span>{confidenceDescriptions[rank]}</span>
            <small>{totals[rank]}件</small>
          </div>
        ))}
      </div>
      <div className="admin-card-filters">
        <label className="admin-field">
          <span>カード・場所を検索</span>
          <input
            type="search"
            value={query}
            placeholder="カード名、メンバー、施設名"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="admin-field">
          <span>信頼度</span>
          <select
            value={confidence}
            onChange={(event) => setConfidence(event.target.value as CardModelLocation["confidence"] | "すべて")}
          >
            <option value="すべて">すべて</option>
            <option value="A">Aのみ</option>
            <option value="B">Bのみ</option>
            <option value="C">Cのみ</option>
          </select>
        </label>
      </div>
      <p className="admin-card-count"><strong>{filteredCards.length}</strong> / {cards.length}件</p>
      <div className="admin-card-list">
        {filteredCards.map((card) => (
          <article key={card.id}>
            <div className="admin-card-list__topline">
              <span>C{String(cards.indexOf(card) + 1).padStart(2, "0")}</span>
              <b className={`admin-confidence admin-confidence--${card.confidence.toLocaleLowerCase()}`}>
                信頼度 {card.confidence}
              </b>
            </div>
            <h3>{card.card}</h3>
            <strong>{card.model}</strong>
            <p>{card.address}</p>
            {card.note ? <small>{card.note}</small> : null}
            <a href={card.sourceUrl} target="_blank" rel="noreferrer">
              出典を確認 <span aria-hidden="true">↗</span>
            </a>
          </article>
        ))}
        {!filteredCards.length ? <p className="admin-card-empty">条件に合うカードがありません。</p> : null}
      </div>
    </section>
  );
}

function ApiUsageDashboard({ localMode }: { localMode: boolean }) {
  const [usage, setUsage] = useState<RouteUsageResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  function refreshUsage() {
    setLoading(true);
    setError("");
    setRefreshKey((value) => value + 1);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/route-usage", { cache: "no-store" })
      .then(async (response) => {
        const result = (await response.json()) as RouteUsageResponse & { error?: string };
        if (!response.ok) {
          throw new Error(result.error ?? "API使用状況を読み込めませんでした。");
        }
        if (!cancelled) setUsage(result);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "API使用状況を読み込めませんでした。",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (loading && !usage) {
    return (
      <section className="admin-usage admin-panel">
        <p className="admin-loading">API使用状況を集計しています…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-usage admin-panel">
        <div className="admin-panel__heading">
          <div><span>ROUTES API</span><h2>使用状況を読み込めませんでした</h2></div>
          <button type="button" className="usage-refresh" onClick={refreshUsage}>再読み込み</button>
        </div>
        <p className="admin-message" role="alert">{error}</p>
      </section>
    );
  }

  if (!usage?.available) {
    return (
      <section className="admin-usage admin-panel">
        <div className="admin-panel__heading">
          <div><span>ROUTES API</span><h2>使用状況の接続設定</h2></div>
        </div>
        <p className="usage-unavailable">{usage?.message}</p>
        {localMode && (
          <p className="usage-note">
            ローカル管理画面は公開サーバーのデータベースを直接読めないため、共有トークンを使って集計APIだけを取得します。トークンはブラウザやGitHub Pagesへ配信されません。
          </p>
        )}
      </section>
    );
  }

  const maximumDailyRequests = Math.max(
    1,
    ...usage.daily.map((day) => day.apiRequests),
  );
  const generatedAt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: usage.timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(usage.generatedAt));

  return (
    <section className="admin-usage">
      <div className="admin-panel usage-overview">
        <div className="admin-panel__heading usage-heading">
          <div><span>ROUTES API</span><h2>サーバーから送ったリクエスト</h2></div>
          <div className="usage-heading__actions">
            <small>{generatedAt} 更新</small>
            <button
              type="button"
              className="usage-refresh"
              disabled={loading}
              onClick={refreshUsage}
            >
              {loading ? "更新中…" : "更新"}
            </button>
          </div>
        </div>
        <p className="usage-note">
          このサイトのサーバーがGoogle Routes APIへ実際に送った回数です。Google Cloud側の請求確定値やクォータ表示とは、集計時刻などにより差が出る場合があります。
        </p>

        <div className="usage-periods">
          <UsagePeriod title="今日" totals={usage.today} />
          <UsagePeriod title="今月" totals={usage.currentMonth} />
        </div>
      </div>

      <div className="usage-grid">
        <div className="admin-panel">
          <div className="admin-panel__heading">
            <div><span>LAST 14 DAYS</span><h2>日別リクエスト数</h2></div>
          </div>
          <div className="usage-chart" aria-label="直近14日間のAPIリクエスト数">
            {usage.daily.map((day) => (
              <div className="usage-chart__day" key={day.date}>
                <span>{day.apiRequests}</span>
                <div className="usage-chart__track">
                  <i
                    className={day.failed ? "has-error" : ""}
                    style={{ height: `${Math.max(3, (day.apiRequests / maximumDailyRequests) * 100)}%` }}
                  />
                </div>
                <small>{day.date.slice(5).replace("-", "/")}</small>
              </div>
            ))}
          </div>
          <p className="usage-chart__caption">赤い棒は、その日に失敗したルート計算が含まれることを示します。</p>
        </div>

        <div className="admin-panel">
          <div className="admin-panel__heading">
            <div><span>THIS MONTH</span><h2>移動手段別</h2></div>
          </div>
          {usage.byMode.length ? (
            <div className="usage-mode-list">
              {usage.byMode.map((mode) => (
                <div key={mode.travelMode}>
                  <strong>{travelModeLabels[mode.travelMode] ?? mode.travelMode}</strong>
                  <span>{mode.apiRequests.toLocaleString("ja-JP")} リクエスト</span>
                  <small>計算 {mode.calculations.toLocaleString("ja-JP")}回・失敗 {mode.failed.toLocaleString("ja-JP")}回</small>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-note">今月のサーバー経由ルート検索はまだありません。</p>
          )}
        </div>
      </div>
    </section>
  );
}

function UsagePeriod({
  title,
  totals,
}: {
  title: string;
  totals: {
    calculations: number;
    apiRequests: number;
    failed: number;
    averageResponseTimeMs: number;
  };
}) {
  return (
    <article className="usage-period">
      <span>{title}</span>
      <strong>{totals.apiRequests.toLocaleString("ja-JP")}</strong>
      <small>Google APIリクエスト</small>
      <dl>
        <div><dt>ルート計算</dt><dd>{totals.calculations.toLocaleString("ja-JP")}回</dd></div>
        <div><dt>失敗</dt><dd className={totals.failed ? "has-error" : ""}>{totals.failed.toLocaleString("ja-JP")}回</dd></div>
        <div><dt>平均応答</dt><dd>{(totals.averageResponseTimeMs / 1000).toFixed(1)}秒</dd></div>
      </dl>
    </article>
  );
}

function PhotoManager({
  spots,
  assets,
  setAssets,
  localMode,
  localToken,
}: {
  spots: PilgrimageSpot[];
  assets: AdminAsset[];
  setAssets: React.Dispatch<React.SetStateAction<AdminAsset[]>>;
  localMode: boolean;
  localToken: string;
}) {
  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  const [placement, setPlacement] = useState<Placement>("spot");
  const [spotId, setSpotId] = useState(spots[0]?.id ?? "");
  const [cropX, setCropX] = useState(50);
  const [cropY, setCropY] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [gpsState, setGpsState] = useState<GpsState>({ state: "none" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const queuedUrlsRef = useRef(new Set<string>());
  const currentPhoto = queue[0] ?? null;
  const currentFile = currentPhoto?.file ?? null;
  const previewUrl = currentPhoto?.url ?? "";

  useEffect(() => {
    const urls = queuedUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (!currentFile) return;

    let cancelled = false;
    readGps(currentFile)
      .then((gps) => {
        if (cancelled || !gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) {
          if (!cancelled) setGpsState({ state: "none" });
          return;
        }
        const nearest = nearestSpot(gps.latitude, gps.longitude, spots);
        if (!nearest) {
          setGpsState({ state: "none" });
          return;
        }
        setSpotId(nearest.spot.id);
        setGpsState({
          state: "found",
          lat: gps.latitude,
          lng: gps.longitude,
          nearestSpotId: nearest.spot.id,
          distanceM: nearest.distanceM,
        });
      })
      .catch(() => {
        if (!cancelled) setGpsState({ state: "none" });
      });

    return () => {
      cancelled = true;
    };
  }, [currentFile, spots]);

  useEffect(() => {
    if (!previewUrl || !canvasRef.current) return;
    let cancelled = false;
    loadImage(previewUrl)
      .then((image) => {
        if (!cancelled && canvasRef.current) {
          drawCroppedImage(canvasRef.current, image, placement, cropX, cropY, zoom);
        }
      })
      .catch(() => setMessage("プレビューを表示できませんでした。"));
    return () => {
      cancelled = true;
    };
  }, [previewUrl, placement, cropX, cropY, zoom]);

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []).filter((file) => imageTypes.has(file.type));
    const selected = selectedFiles.map((file) => {
      const url = URL.createObjectURL(file);
      queuedUrlsRef.current.add(url);
      return { file, url };
    });
    if (selected.length) {
      if (!queue.length) resetPhotoEditor();
      setQueue((current) => [...current, ...selected]);
    }
    if ((event.target.files?.length ?? 0) !== selectedFiles.length) {
      setMessage("JPEG、PNG、WebP以外のファイルは除外しました。");
    }
    event.target.value = "";
  }

  function resetPhotoEditor() {
    setCropX(50);
    setCropY(50);
    setZoom(1);
    setPlacement("spot");
    setGpsState({ state: "loading" });
    setMessage("");
  }

  function advanceQueue() {
    if (currentPhoto) {
      URL.revokeObjectURL(currentPhoto.url);
      queuedUrlsRef.current.delete(currentPhoto.url);
    }
    setQueue((current) => current.slice(1));
    if (queue.length > 1) resetPhotoEditor();
    else setGpsState({ state: "none" });
  }

  async function publishCurrent() {
    if (!currentFile || !previewUrl || saving) return;
    setSaving(true);
    setMessage("");

    try {
      const derivative = await makePublicDerivative(
        previewUrl,
        placement,
        cropX,
        cropY,
        zoom,
      );
      const metadata = {
        placement,
        spotId: placement === "spot" ? spotId : null,
        cropX,
        cropY,
        zoom,
        gpsLat: gpsState.state === "found" ? gpsState.lat : null,
        gpsLng: gpsState.state === "found" ? gpsState.lng : null,
        nearestSpotId:
          gpsState.state === "found" ? gpsState.nearestSpotId : null,
      };

      let response: Response;
      if (localMode) {
        response = await fetch("/api/admin/media", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-local-admin-token": localToken,
          },
          body: JSON.stringify({
            derivativeBase64: await blobToBase64(derivative),
            contentType: derivative.type,
            metadata,
          }),
        });
      } else {
        const formData = new FormData();
        formData.append("original", currentFile);
        formData.append(
          "derivative",
          new File(
            [derivative],
            derivative.type === "image/webp" ? "public.webp" : "public.jpg",
            { type: derivative.type },
          ),
        );
        formData.append("metadata", JSON.stringify(metadata));
        response = await fetch("/api/admin/media", {
          method: "POST",
          body: formData,
        });
      }
      const result = (await response.json()) as { asset?: AdminAsset; error?: string };
      if (!response.ok || !result.asset) {
        throw new Error(result.error ?? "画像を公開できませんでした。");
      }

      setAssets((current) => [result.asset!, ...current]);
      advanceQueue();
      setMessage(
        localMode
          ? "透かし済み画像をローカルファイルへ保存しました。GitHub Pagesへはまだ公開されていません。"
          : "公開しました。次の写真があれば続けて調整できます。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "画像を公開できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  async function deleteAsset(asset: AdminAsset) {
    if (!window.confirm(
      localMode
        ? `「${asset.originalName}」をローカルの公開用ファイルから削除しますか？`
        : `「${asset.originalName}」を公開一覧と非公開保管領域から削除しますか？`,
    )) return;
    const response = await fetch(`/api/admin/media/${asset.id}`, {
      method: "DELETE",
      headers: localMode ? { "x-local-admin-token": localToken } : undefined,
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(result.error ?? "画像を削除できませんでした。");
      return;
    }
    setAssets((current) => current.filter((item) => item.id !== asset.id));
    setMessage("画像を削除しました。");
  }

  const currentSpot = spots.find((spot) => spot.id === spotId);
  const nearest =
    gpsState.state === "found"
      ? spots.find((spot) => spot.id === gpsState.nearestSpotId)
      : null;

  return (
    <section className="admin-workspace">
      <div className="photo-editor">
        <div className="admin-panel admin-panel--upload">
          <div className="admin-panel__heading">
            <div><span>STEP 1</span><h2>写真を選ぶ</h2></div>
            {queue.length > 0 && <small>残り {queue.length}枚</small>}
          </div>
          <label className="upload-dropzone">
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addFiles} />
            <strong>写真を選択</strong>
            <span>複数枚まとめて選べます（1枚25MBまで）</span>
          </label>
          {currentFile ? (
            <div className="file-summary">
              <div><small>編集中</small><strong>{currentFile.name}</strong></div>
              <button type="button" onClick={advanceQueue}>この写真を飛ばす</button>
            </div>
          ) : (
            <p className="empty-note">写真を選ぶと、ここから配置と切り抜きを調整できます。</p>
          )}
        </div>

        {currentFile && (
          <>
            <div className="admin-panel">
              <div className="admin-panel__heading">
                <div><span>STEP 2</span><h2>配置先を決める</h2></div>
              </div>
              <div className="placement-switch">
                <label><input type="radio" checked={placement === "spot"} onChange={() => setPlacement("spot")} />スポットカード</label>
                <label><input type="radio" checked={placement === "hero"} onChange={() => setPlacement("hero")} />タイトル背景</label>
              </div>
              {placement === "spot" && (
                <label className="admin-field">
                  <span>配置するスポット</span>
                  <select value={spotId} onChange={(event) => setSpotId(event.target.value)}>
                    {spots.map((spot) => <option value={spot.id} key={spot.id}>{spot.name}</option>)}
                  </select>
                </label>
              )}
              <div className={`gps-note gps-note--${gpsState.state}`}>
                {gpsState.state === "loading" && "EXIFの位置情報を確認しています…"}
                {gpsState.state === "none" && "GPS情報は見つかりませんでした。配置先を手動で選んでください。"}
                {gpsState.state === "found" && nearest && (
                  <>最寄り候補は <strong>{nearest.name}</strong>（{formatDistance(gpsState.distanceM)}）です。必要なら変更してください。</>
                )}
              </div>
            </div>

            <div className="admin-panel admin-panel--preview">
              <div className="admin-panel__heading">
                <div><span>STEP 3</span><h2>見せる範囲を整える</h2></div>
                <small>{placement === "hero" ? "16:9" : "4:3"}・{watermarkText}</small>
              </div>
              <div className={`crop-preview crop-preview--${placement}`}>
                <canvas ref={canvasRef} />
                <div className="crop-preview__shade" />
                <div className="crop-preview__copy">
                  <small>{placement === "hero" ? "TITLE BACKGROUND" : currentSpot?.area}</small>
                  <strong>{placement === "hero" ? "蓮ノ旅" : currentSpot?.name}</strong>
                </div>
              </div>
              <div className="crop-controls">
                <label><span>左右位置</span><input type="range" min="0" max="100" value={cropX} onChange={(event) => setCropX(Number(event.target.value))} /></label>
                <label><span>上下位置</span><input type="range" min="0" max="100" value={cropY} onChange={(event) => setCropY(Number(event.target.value))} /></label>
                <label><span>拡大</span><input type="range" min="1" max="2.5" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
              </div>
              <button className="admin-publish" type="button" disabled={saving} onClick={publishCurrent}>
                {saving ? "公開用画像を作成中…" : "この内容で公開する"}<span>→</span>
              </button>
              <p className="privacy-note">
                公開用画像はWebP/JPEGへ再生成され、{watermarkText}の透かしを焼き込みます。
                GPS・端末名・ISO・撮影日時などのEXIFは含まれず、
                {localMode ? "選択した元写真はプロジェクト内へ保存しません。" : "元写真は非公開で保管します。"}
              </p>
            </div>
          </>
        )}
        {message && <p className="admin-message" role="status">{message}</p>}
      </div>

      <aside className="admin-panel published-panel">
        <div className="admin-panel__heading"><div><span>LIVE</span><h2>公開済み</h2></div><small>{assets.length}枚</small></div>
        {assets.length ? (
          <div className="published-list">
            {assets.map((asset) => {
              const spot = spots.find((item) => item.id === asset.spotId);
              return (
                <article key={asset.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={asset.imageUrl} alt="" />
                  <div><strong>{asset.placement === "hero" ? "タイトル背景" : spot?.name ?? "未設定"}</strong><span>{asset.originalName}</span></div>
                  <button type="button" onClick={() => deleteAsset(asset)}>削除</button>
                </article>
              );
            })}
          </div>
        ) : <p className="empty-note">管理画面から公開した写真はまだありません。</p>}
      </aside>
    </section>
  );
}

function SpotManager({
  spots,
  setSpots,
  baseSpots,
  overrideIds,
  setOverrideIds,
  localMode,
  localToken,
}: {
  spots: PilgrimageSpot[];
  setSpots: React.Dispatch<React.SetStateAction<PilgrimageSpot[]>>;
  baseSpots: PilgrimageSpot[];
  overrideIds: Set<string>;
  setOverrideIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  localMode: boolean;
  localToken: string;
}) {
  const [selectedId, setSelectedId] = useState(spots[0]?.id ?? "");
  const selected = spots.find((spot) => spot.id === selectedId) ?? spots[0];
  const [draft, setDraft] = useState<PilgrimageSpot>(selected);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const categories = useMemo(
    () => Array.from(new Set(baseSpots.map((spot) => spot.category))),
    [baseSpots],
  );

  if (!draft) return null;

  function update<K extends keyof PilgrimageSpot>(key: K, value: PilgrimageSpot[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/spots/${draft.id}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(localMode ? { "x-local-admin-token": localToken } : {}),
        },
        body: JSON.stringify(draft),
      });
      const result = (await response.json()) as { spot?: PilgrimageSpot; error?: string };
      if (!response.ok || !result.spot) throw new Error(result.error ?? "保存できませんでした。");
      setSpots((current) => current.map((spot) => spot.id === draft.id ? result.spot! : spot));
      setOverrideIds((current) => new Set(current).add(draft.id));
      setMessage(
        localMode
          ? "ローカルファイルへ保存しました。GitHub Pagesへはまだ公開されていません。"
          : "保存しました。公開画面にも反映されています。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!window.confirm("このスポットの修正を取り消し、登録時の情報へ戻しますか？")) return;
    const response = await fetch(`/api/admin/spots/${draft.id}`, {
      method: "DELETE",
      headers: localMode ? { "x-local-admin-token": localToken } : undefined,
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      setMessage(result.error ?? "元に戻せませんでした。");
      return;
    }
    const base = baseSpots.find((spot) => spot.id === draft.id);
    if (base) {
      setDraft(base);
      setSpots((current) => current.map((spot) => spot.id === base.id ? base : spot));
    }
    setOverrideIds((current) => {
      const next = new Set(current);
      next.delete(draft.id);
      return next;
    });
    setMessage(
      localMode
        ? "サーバー起動時の内容へ戻し、ローカルファイルへ保存しました。"
        : "登録時の情報へ戻しました。",
    );
  }

  return (
    <section className="spot-editor-layout">
      <aside className="admin-panel spot-selector">
        <div className="admin-panel__heading"><div><span>SPOTS</span><h2>編集する場所</h2></div></div>
        <div>
          {spots.map((spot, index) => (
            <button type="button" className={spot.id === selectedId ? "is-active" : ""} key={spot.id} onClick={() => { setSelectedId(spot.id); setDraft(spot); setMessage(""); }}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{spot.name}</strong>
              {overrideIds.has(spot.id) && <small>修正済み</small>}
            </button>
          ))}
        </div>
      </aside>

      <form className="admin-panel spot-form" onSubmit={save}>
        <div className="admin-panel__heading">
          <div><span>EDIT</span><h2>{draft.name}</h2></div>
          {overrideIds.has(draft.id) && <small>差分を保存中</small>}
        </div>
        <div className="spot-form__grid">
          <label className="admin-field admin-field--wide"><span>正式名称</span><input value={draft.name} maxLength={100} onChange={(event) => update("name", event.target.value)} /><small>お店・施設の公式表記に合わせてください。</small></label>
          <label className="admin-field"><span>短縮名</span><input value={draft.shortName} maxLength={60} onChange={(event) => update("shortName", event.target.value)} /></label>
          <label className="admin-field"><span>エリア</span><input value={draft.area} maxLength={40} onChange={(event) => update("area", event.target.value)} /></label>
          <label className="admin-field"><span>カテゴリ</span><select value={draft.category} onChange={(event) => update("category", event.target.value as PilgrimageSpot["category"])}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
          <label className="admin-field admin-field--wide"><span>住所</span><input value={draft.address} maxLength={160} onChange={(event) => update("address", event.target.value)} /></label>
          <label className="admin-field"><span>緯度</span><input type="number" step="any" value={draft.lat} onChange={(event) => update("lat", Number(event.target.value))} /></label>
          <label className="admin-field"><span>経度</span><input type="number" step="any" value={draft.lng} onChange={(event) => update("lng", Number(event.target.value))} /></label>
          <AdminCoordinatePicker
            name={draft.name}
            lat={draft.lat}
            lng={draft.lng}
            onChange={(lat, lng) => setDraft((current) => ({ ...current, lat, lng }))}
          />
          <label className="admin-field"><span>推奨滞在時間（分）</span><input type="number" min="0" max="480" step="5" value={draft.recommendedStayMinutes ?? ""} placeholder="カテゴリ既定値" onChange={(event) => update("recommendedStayMinutes", event.target.value === "" ? undefined : Number(event.target.value))} /><small>未入力の場合はカテゴリごとの既定値を使います。</small></label>
          <label className="admin-field"><span>営業・開館時刻</span><input type="time" value={draft.openingTime ?? ""} onChange={(event) => update("openingTime", event.target.value || undefined)} /><small>公式情報を確認できた場合だけ入力してください。</small></label>
          <label className="admin-field"><span>営業・閉館時刻</span><input type="time" value={draft.closingTime ?? ""} onChange={(event) => update("closingTime", event.target.value || undefined)} /><small>最終入場は下の補足欄へ記載してください。</small></label>
          <fieldset className="admin-field admin-field--wide admin-weekdays">
            <legend>通常の休業曜日</legend>
            <div>
              {["日", "月", "火", "水", "木", "金", "土"].map((label, day) => (
                <label key={label}>
                  <input
                    type="checkbox"
                    checked={draft.closedWeekdays?.includes(day) ?? false}
                    onChange={(event) => {
                      const current = draft.closedWeekdays ?? [];
                      update("closedWeekdays", event.target.checked
                        ? Array.from(new Set([...current, day])).sort()
                        : current.filter((value) => value !== day));
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <small>祝日・臨時休業・季節営業は補足欄へ記載してください。</small>
          </fieldset>
          <label className="admin-field admin-field--wide"><span>営業時間の補足</span><textarea rows={3} maxLength={300} value={draft.openingHoursNote ?? ""} placeholder="例：最終入館16:30。祝日の場合は翌日休館。" onChange={(event) => update("openingHoursNote", event.target.value || undefined)} /></label>
          <label className="admin-field"><span>営業時間の確認日</span><input type="date" value={draft.openingHoursCheckedAt ?? ""} onChange={(event) => update("openingHoursCheckedAt", event.target.value || undefined)} /><small>公式サイト等を最後に確認した日です。</small></label>
          <label className="admin-field admin-field--wide"><span>説明</span><textarea rows={5} maxLength={500} value={draft.description} onChange={(event) => update("description", event.target.value)} /></label>
          <label className="admin-field admin-field--wide"><span>活動記録</span><textarea rows={3} value={(draft.activityRecords ?? []).join("\n")} onChange={(event) => update("activityRecords", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} /><small>例：103期 第5話。1行につき1件で入力してください。</small></label>
          <label className="admin-field admin-field--wide"><span>せーはす！放送回</span><textarea rows={3} value={(draft.sehasEpisodes ?? []).join("\n")} onChange={(event) => update("sehasEpisodes", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} /><small>例：103期 #28。1行につき1件で入力してください。</small></label>
          <label className="admin-field admin-field--wide"><span>With×MEETS配信回</span><textarea rows={3} value={(draft.withMeetsEpisodes ?? []).join("\n")} onChange={(event) => update("withMeetsEpisodes", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} /><small>例：103期 2023/7/24『蓮ノ空1年生の会！』。1行につき1件で入力してください。</small></label>
          <label className="admin-field admin-field--wide"><span>カード・その他の登場情報</span><textarea rows={4} value={(draft.appearances ?? []).join("\n")} onChange={(event) => update("appearances", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} /><small>カード背景などを1行につき1件で入力してください。</small></label>
          <label className="admin-field admin-field--wide"><span>アクセス案内</span><input value={draft.accessNote} maxLength={160} onChange={(event) => update("accessNote", event.target.value)} /></label>
          <label className="admin-field admin-field--wide"><span>場所・公式情報URL</span><input type="url" value={draft.sourceUrl} maxLength={500} onChange={(event) => update("sourceUrl", event.target.value)} /></label>
        </div>
        <div className="spot-form__actions">
          <button className="admin-publish" type="submit" disabled={saving}>{saving ? "保存中…" : "修正を保存する"}<span>→</span></button>
          {overrideIds.has(draft.id) && <button className="admin-reset" type="button" onClick={reset}>登録時の情報に戻す</button>}
        </div>
        {message && <p className="admin-message" role="status">{message}</p>}
      </form>
    </section>
  );
}

function AdminCoordinatePicker({
  name,
  lat,
  lng,
  onChange,
}: {
  name: string;
  lat: number;
  lng: number;
  onChange: (lat: number, lng: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const initialPositionRef = useRef({ lat, lng });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [initialPositionRef.current.lng, initialPositionRef.current.lat],
      zoom: 16,
      attributionControl: true,
    });
    const marker = new mapboxgl.Marker({ color: "#7f6084", draggable: true })
      .setLngLat([initialPositionRef.current.lng, initialPositionRef.current.lat])
      .addTo(map);

    const applyPosition = (nextLng: number, nextLat: number) => {
      const roundedLat = Number(nextLat.toFixed(7));
      const roundedLng = Number(nextLng.toFixed(7));
      marker.setLngLat([roundedLng, roundedLat]);
      onChangeRef.current(roundedLat, roundedLng);
    };
    marker.on("dragend", () => {
      const position = marker.getLngLat();
      applyPosition(position.lng, position.lat);
    });
    map.on("click", (event) => applyPosition(event.lngLat.lng, event.lngLat.lat));
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      marker.remove();
      map.remove();
      markerRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    markerRef.current?.setLngLat([lng, lat]);
    mapRef.current?.easeTo({ center: [lng, lat], duration: 280 });
  }, [lat, lng]);

  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`;

  return (
    <section className="admin-coordinate-picker admin-field--wide" aria-label={`${name}のピン位置`}>
      <div className="admin-coordinate-picker__heading">
        <div>
          <strong>地図でピン位置を修正</strong>
          <small>地図をクリックするか、紫のピンをドラッグしてください。</small>
        </div>
        <a href={googleMapsUrl} target="_blank" rel="noreferrer">Googleマップで確認 ↗</a>
      </div>
      <div ref={containerRef} className="admin-coordinate-picker__map" />
      <p>保存される座標：{lat.toFixed(7)}, {lng.toFixed(7)}</p>
    </section>
  );
}
