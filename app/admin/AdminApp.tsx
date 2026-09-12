import { gps as readGps } from "exifr/dist/mini.esm.mjs";
import mapboxgl from "mapbox-gl";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type DragEvent,
  type FormEvent,
  type ReactElement,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  cardModels,
  collaborations,
  type CollaborationId,
  type CardModelLocation,
  type PilgrimageSpot,
} from "@/app/spots";
import {
  CommunitySubmissionReview,
  type AdminCommunitySubmission,
} from "./CommunitySubmissionReview";
import type {
  CommunityReceiverStatus,
  CommunityUsageResponse,
  CommunityUsageTotals,
} from "./community-usage-types";

export type AdminAsset = {
  id: string;
  originalName: string;
  placement: string;
  spotId: string | null;
  createdAt: string;
  imageUrl: string;
  heroCandidate?: boolean;
  creditName?: string;
  source?: string;
  submissionId?: string;
};

type Props = {
  baseSpots: PilgrimageSpot[];
  initialSpots: PilgrimageSpot[];
  overriddenSpotIds: string[];
  initialAssets: AdminAsset[];
  initialSubmissions?: AdminCommunitySubmission[];
  localToken?: string;
  localNetworkUrl?: string;
  initialSiteVersion?: string;
};

type SetState<T> = Dispatch<SetStateAction<T>>;
type AdminTab = "photos" | "spots" | "submissions" | "cards" | "usage";

type PublishStatus = {
  available: boolean;
  remoteConfigured: boolean;
  identityConfigured: boolean;
  branch: string;
  publishToken: string;
  hasLocalChanges: boolean;
  error?: string;
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
type GpsState =
  | { state: "loading" }
  | { state: "none" }
  | {
      state: "found" | "far";
      lat: number;
      lng: number;
      nearestSpotId: string;
      distanceM: number;
    };
type QueuedPhoto = {
  id: string;
  file: File;
  url: string;
  placement: Placement;
  spotId: string;
  cropX: number;
  cropY: number;
  zoom: number;
  gpsState: GpsState;
  spotManuallySelected: boolean;
};
type AdminSpotSourceFilter = "すべて" | "activity-records" | "sehas" | "with-meets";

const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const imageFileExtensionPattern = /\.(?:jpe?g|png|webp)$/i;
const automaticSpotDistanceLimitM = 500;
const watermarkText = "© Yukachiii";

function isSupportedImageFile(file: File): boolean {
  return imageTypes.has(file.type) || (!file.type && imageFileExtensionPattern.test(file.name));
}

function fileIdentity(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function distanceInMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
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

function nearestSpot(
  lat: number,
  lng: number,
  spots: PilgrimageSpot[],
): { spot: PilgrimageSpot; distanceM: number } | undefined {
  return spots
    .map((spot) => ({
      spot,
      distanceM: distanceInMeters({ lat, lng }, spot),
    }))
    .sort((a, b) => a.distanceM - b.distanceM)[0];
}

function loadImage(url: string): Promise<HTMLImageElement> {
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
): void {
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
): void {
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
): Promise<Blob> {
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

function blobToBase64(blob: Blob): Promise<string> {
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

function formatDistance(distanceM: number): string {
  return distanceM < 1000
    ? `約${Math.round(distanceM / 10) * 10}m`
    : `約${(distanceM / 1000).toFixed(1)}km`;
}

type PublishControls = {
  status: PublishStatus | null;
  publishing: boolean;
  message: string;
  setMessage: SetState<string>;
  publish(): Promise<void>;
  reloadStatus(): Promise<void>;
  markLocalChanges(): void;
};

async function requestPublish(publishToken: string): Promise<{ revision?: string }> {
  const response = await fetch("/api/admin/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publishToken }),
  });
  const result = (await response.json()) as { revision?: string; error?: string };
  if (!response.ok) throw new Error(result.error ?? "GitHubへ公開できませんでした。");
  return result;
}

function usePublishControls(): PublishControls {
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState("");
  async function reloadStatus(): Promise<void> {
    setStatus(await loadPublishStatus());
  }
  useEffect(() => {
    let cancelled = false;
    void loadPublishStatus().then((result) => {
      if (!cancelled) setStatus(result);
    });
    return () => { cancelled = true; };
  }, []);
  async function publish(): Promise<void> {
    if (!status?.publishToken || publishing) return;
    if (!window.confirm("ローカルファイルへ保存した変更をコミットし、GitHub Pagesへ公開しますか？")) return;
    setPublishing(true);
    setMessage("");
    try {
      const result = await requestPublish(status.publishToken);
      setMessage(result.revision
        ? `GitHubへ公開しました（${result.revision}）。Actions完了後に反映されます。`
        : "公開対象の変更はありません。");
      await reloadStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "GitHubへ公開できませんでした。");
    } finally {
      setPublishing(false);
    }
  }
  function markLocalChanges(): void {
    setStatus((current) => current ? { ...current, hasLocalChanges: true } : current);
  }
  return { status, publishing, message, setMessage, publish, reloadStatus, markLocalChanges };
}

type ShutdownControls = {
  shuttingDown: boolean;
  serverStopped: boolean;
  shutdown(): Promise<void>;
};

function useShutdownControls(localToken: string, setMessage: SetState<string>): ShutdownControls {
  const [shuttingDown, setShuttingDown] = useState(false);
  const [serverStopped, setServerStopped] = useState(false);
  async function shutdown(): Promise<void> {
    if (!localToken || shuttingDown || serverStopped) return;
    if (!window.confirm("管理サーバーを終了しますか？まだ保存していない入力内容は失われます。")) return;
    setShuttingDown(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/shutdown", {
        method: "POST",
        headers: { "x-local-admin-token": localToken },
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "管理サーバーを終了できませんでした。");
      setServerStopped(true);
      setMessage("管理サーバーを終了しました。このタブは閉じてかまいません。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "管理サーバーを終了できませんでした。");
      setShuttingDown(false);
    }
  }
  return { shuttingDown, serverStopped, shutdown };
}

type VersionControls = {
  version: string;
  draft: string;
  setDraft: SetState<string>;
  saving: boolean;
  message: string;
  save(event: FormEvent): Promise<void>;
};

async function requestVersionSave(localToken: string, version: string): Promise<string> {
  const response = await fetch("/api/admin/site-version", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-local-admin-token": localToken },
    body: JSON.stringify({ version }),
  });
  const result = (await response.json().catch(() => ({}))) as { version?: string; error?: string };
  if (!response.ok || !result.version) {
    throw new Error(result.error ?? "バージョン表記を保存できませんでした。");
  }
  return result.version;
}

function useVersionControls(
  localToken: string,
  initialVersion: string,
  reloadPublishStatus: () => Promise<void>,
): VersionControls {
  const [version, setVersion] = useState(initialVersion);
  const [draft, setDraft] = useState(initialVersion);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!localToken || saving) return;
    const normalized = draft.trim().replace(/^ver\.\s*/i, "");
    if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
      setMessage("3桁の形式（例：3.1.0）で入力してください。");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const savedVersion = await requestVersionSave(localToken, normalized);
      setVersion(savedVersion);
      setDraft(savedVersion);
      setMessage(`Ver. ${savedVersion} を保存しました。公開すると反映されます。`);
      await reloadPublishStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "バージョン表記を保存できませんでした。");
    } finally {
      setSaving(false);
    }
  }
  return { version, draft, setDraft, saving, message, save };
}

function useNetworkCopy(localNetworkUrl: string): { message: string; copy(): Promise<void> } {
  const [message, setMessage] = useState("");
  async function copy(): Promise<void> {
    if (!localNetworkUrl) return;
    try {
      await navigator.clipboard.writeText(localNetworkUrl);
      setMessage("コピーしました");
    } catch {
      setMessage("URLを長押ししてコピーしてください");
    }
  }
  return { message, copy };
}

function AdminHeader({
  publish, shutdown,
}: { publish: PublishControls; shutdown: ShutdownControls }): ReactElement {
  const publishDisabled = publish.publishing || shutdown.shuttingDown || shutdown.serverStopped ||
    !publish.status?.available || !publish.status.remoteConfigured || !publish.status.identityConfigured;
  return (
    <header className="admin-header">
      <a className="admin-brand" href="https://yukachiii.github.io/hasunosora-pilgrimage/">
        <span>蓮</span>
        <div><strong>蓮ノ旅 管理室</strong><small>CONTENT MANAGEMENT</small></div>
      </a>
      <div className="admin-account">
        <span>{publish.status?.hasLocalChanges ? "未公開の変更あり" : "ローカル専用"}</span>
        <div className="admin-account__actions">
          <button className="admin-publish admin-publish--compact" type="button"
            disabled={publishDisabled} onClick={publish.publish}>
            {publish.publishing ? "公開中…" : "GitHub Pagesへ公開"}
          </button>
          <button className="admin-shutdown" type="button"
            disabled={shutdown.shuttingDown || shutdown.serverStopped} onClick={shutdown.shutdown}>
            {shutdown.serverStopped ? "終了済み" : shutdown.shuttingDown ? "終了中…" : "サーバーを終了"}
          </button>
        </div>
      </div>
    </header>
  );
}

function AdminIntroCover(): ReactElement {
  return (
    <div className="admin-intro__cover">
      <div className="admin-intro__grid" aria-hidden="true" />
      <div className="admin-intro__number" aria-hidden="true">A</div>
      <div className="admin-intro__copy">
        <p>ADMIN / CONTENT MANAGEMENT</p>
        <h1>写真とスポット情報を、<br />落ち着いて整える場所。</h1>
        <div className="admin-intro__rule" aria-label="5つの管理項目">
          <span>05 SECTIONS</span><span>LOCAL / PRIVATE</span>
        </div>
        <p>変更はこのPC内の公開用ファイルへ保存されます。GitHub Pagesへ反映するまでは外部公開されません。</p>
      </div>
      <div className="admin-intro__side" aria-hidden="true">HASUNOSORA PILGRIMAGE · ADMIN</div>
    </div>
  );
}

function NetworkAccessPanel({
  localNetworkUrl, copyMessage, onCopy,
}: { localNetworkUrl: string; copyMessage: string; onCopy(): Promise<void> }): ReactElement {
  return (
    <div className="admin-lan-access">
      <div>
        <small>SAME WI-FI ACCESS</small><strong>スマホから管理画面を開く</strong>
        {localNetworkUrl ? <a href={localNetworkUrl}>{localNetworkUrl}</a>
          : <span>接続用のローカルIPを取得できませんでした。</span>}
      </div>
      {localNetworkUrl ? <button type="button" onClick={onCopy}>URLをコピー</button> : null}
      <p>
        PCとスマホを同じ信頼できるWi-Fiへ接続してください。作業後はサーバーを終了してください。
        {copyMessage ? <b>{copyMessage}</b> : null}
      </p>
    </div>
  );
}

function SiteVersionControl({ controls }: { controls: VersionControls }): ReactElement {
  return (
    <form className="admin-version-control" onSubmit={controls.save}>
      <div>
        <small>PUBLIC VERSION</small><strong>公開ページのバージョン表記</strong>
        <span>現在 Ver. {controls.version}</span>
      </div>
      <label>
        <span>Ver.</span>
        <input value={controls.draft} inputMode="decimal" pattern="\d+\.\d+\.\d+"
          aria-label="公開ページのバージョン" onChange={(event) => controls.setDraft(event.target.value)} />
      </label>
      <button type="submit" disabled={controls.saving || controls.draft.trim() === controls.version}>
        {controls.saving ? "保存中…" : "表記を保存"}
      </button>
      {controls.message ? <p role="status">{controls.message}</p> : null}
    </form>
  );
}

function AdminIntro({
  localNetworkUrl, network, version, publish,
}: {
  localNetworkUrl: string;
  network: ReturnType<typeof useNetworkCopy>;
  version: VersionControls;
  publish: PublishControls;
}): ReactElement {
  return (
    <section className="admin-intro">
      <AdminIntroCover />
      <NetworkAccessPanel localNetworkUrl={localNetworkUrl} copyMessage={network.message} onCopy={network.copy} />
      <SiteVersionControl controls={version} />
      {publish.message && <p className="admin-message" role="status">{publish.message}</p>}
      {publish.status?.error && <p className="admin-message" role="status">{publish.status.error}</p>}
    </section>
  );
}

function AdminTabs({
  tab, setTab, submissionPendingCount,
}: { tab: AdminTab; setTab: SetState<AdminTab>; submissionPendingCount: number }): ReactElement {
  return (
    <nav className="admin-tabs admin-tabs--local" aria-label="管理項目">
      <button type="button" className={tab === "photos" ? "is-active" : ""} onClick={() => setTab("photos")}>
        <span>01</span>写真を配置
      </button>
      <button type="button" className={tab === "spots" ? "is-active" : ""} onClick={() => setTab("spots")}>
        <span>02</span>スポットを編集
      </button>
      <button type="button" className={tab === "submissions" ? "is-active" : ""} onClick={() => setTab("submissions")}>
        <span>03</span>投稿を審査{submissionPendingCount ? <b>{submissionPendingCount}</b> : null}
      </button>
      <button type="button" className={tab === "cards" ? "is-active" : ""} onClick={() => setTab("cards")}>
        <span>04</span>カードを確認
      </button>
      <button type="button" className={tab === "usage" ? "is-active" : ""} onClick={() => setTab("usage")}>
        <span>05</span>API使用状況
      </button>
    </nav>
  );
}

type AdminTabContentProps = {
  tab: AdminTab;
  baseSpots: PilgrimageSpot[];
  spots: PilgrimageSpot[];
  setSpots: SetState<PilgrimageSpot[]>;
  assets: AdminAsset[];
  setAssets: SetState<AdminAsset[]>;
  overrideIds: Set<string>;
  setOverrideIds: SetState<Set<string>>;
  submissions: AdminCommunitySubmission[];
  setSubmissionPendingCount: SetState<number>;
  localToken: string;
  markLocalChanges(): void;
};

function AdminTabContent(props: AdminTabContentProps): ReactElement {
  if (props.tab === "photos") {
    return <PhotoManager spots={props.spots} assets={props.assets} setAssets={props.setAssets} localToken={props.localToken} />;
  }
  if (props.tab === "spots") {
    return <SpotManager spots={props.spots} setSpots={props.setSpots} baseSpots={props.baseSpots}
      overrideIds={props.overrideIds} setOverrideIds={props.setOverrideIds} localToken={props.localToken} />;
  }
  if (props.tab === "cards") return <CardModelDashboard cards={cardModels} />;
  if (props.tab === "usage") return <ApiUsageDashboard />;
  return (
    <CommunitySubmissionReview initialSubmissions={props.submissions} spots={props.spots}
      localToken={props.localToken} onPendingCountChange={props.setSubmissionPendingCount}
      onSpotImported={(spot) => { props.setSpots((current) => [...current, spot]); props.markLocalChanges(); }}
      onAssetImported={(asset) => { props.setAssets((current) => [asset, ...current]); props.markLocalChanges(); }} />
  );
}

export function AdminApp({
  baseSpots, initialSpots, overriddenSpotIds, initialAssets, initialSubmissions = [],
  localToken = "", localNetworkUrl = "", initialSiteVersion = "3.0.0",
}: Props): ReactElement {
  const [tab, setTab] = useState<AdminTab>("photos");
  const [managedSpots, setManagedSpots] = useState(initialSpots);
  const [overrideIds, setOverrideIds] = useState(new Set(overriddenSpotIds));
  const [assets, setAssets] = useState(initialAssets);
  const [submissionPendingCount, setSubmissionPendingCount] = useState(
    initialSubmissions.filter((submission) => submission.status === "pending").length,
  );
  const publish = usePublishControls();
  const shutdown = useShutdownControls(localToken, publish.setMessage);
  const network = useNetworkCopy(localNetworkUrl);
  const version = useVersionControls(localToken, initialSiteVersion, publish.reloadStatus);
  return (
    <main className="admin-shell">
      <AdminHeader publish={publish} shutdown={shutdown} />
      <AdminIntro localNetworkUrl={localNetworkUrl} network={network} version={version} publish={publish} />
      <AdminTabs tab={tab} setTab={setTab} submissionPendingCount={submissionPendingCount} />
      <AdminTabContent tab={tab} baseSpots={baseSpots} spots={managedSpots} setSpots={setManagedSpots}
        assets={assets} setAssets={setAssets} overrideIds={overrideIds} setOverrideIds={setOverrideIds}
        submissions={initialSubmissions} setSubmissionPendingCount={setSubmissionPendingCount}
        localToken={localToken} markLocalChanges={publish.markLocalChanges} />
    </main>
  );
}

const confidenceDescriptions: Record<CardModelLocation["confidence"], string> = {
  A: "複数資料、公式に近い資料、または現地比較で十分に確認できた地点",
  B: "有力な候補だが、公式明記や複数の独立資料までは確認できていない地点",
  C: "調査中。手掛かりとして保存している段階で、公開追加には再確認が必要な地点",
};

type CardConfidenceFilter = CardModelLocation["confidence"] | "すべて";

function filterCardModels(
  cards: CardModelLocation[],
  query: string,
  confidence: CardConfidenceFilter,
): CardModelLocation[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("ja");
  return cards.filter((card) => {
    const matchesConfidence = confidence === "すべて" || card.confidence === confidence;
    const matchesQuery = !normalizedQuery || [card.card, card.model, card.address, card.note]
      .join(" ").toLocaleLowerCase("ja").includes(normalizedQuery);
    return matchesConfidence && matchesQuery;
  });
}

function cardConfidenceTotals(
  cards: CardModelLocation[],
): Record<CardModelLocation["confidence"], number> {
  return cards.reduce<Record<CardModelLocation["confidence"], number>>(
    (result, card) => ({ ...result, [card.confidence]: result[card.confidence] + 1 }),
    { A: 0, B: 0, C: 0 },
  );
}

function CardConfidenceGuide({ cards }: { cards: CardModelLocation[] }): ReactElement {
  const totals = cardConfidenceTotals(cards);
  return (
    <div className="admin-confidence-guide" aria-label="信頼度の基準">
      {(["A", "B", "C"] as const).map((rank) => (
        <div key={rank}>
          <b className={`admin-confidence admin-confidence--${rank.toLocaleLowerCase()}`}>{rank}</b>
          <span>{confidenceDescriptions[rank]}</span><small>{totals[rank]}件</small>
        </div>
      ))}
    </div>
  );
}

function CardModelFilters({
  query, setQuery, confidence, setConfidence,
}: {
  query: string;
  setQuery: SetState<string>;
  confidence: CardConfidenceFilter;
  setConfidence: SetState<CardConfidenceFilter>;
}): ReactElement {
  return (
    <div className="admin-card-filters">
      <label className="admin-field">
        <span>カード・場所を検索</span>
        <input type="search" value={query} placeholder="カード名、メンバー、施設名"
          onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label className="admin-field">
        <span>信頼度</span>
        <select value={confidence} onChange={(event) => setConfidence(event.target.value as CardConfidenceFilter)}>
          <option value="すべて">すべて</option><option value="A">Aのみ</option>
          <option value="B">Bのみ</option><option value="C">Cのみ</option>
        </select>
      </label>
    </div>
  );
}

function CardModelList({
  cards, filteredCards,
}: { cards: CardModelLocation[]; filteredCards: CardModelLocation[] }): ReactElement {
  return (
    <div className="admin-card-list">
      {filteredCards.map((card) => (
        <article key={card.id}>
          <div className="admin-card-list__topline">
            <span>C{String(cards.indexOf(card) + 1).padStart(2, "0")}</span>
            <b className={`admin-confidence admin-confidence--${card.confidence.toLocaleLowerCase()}`}>
              信頼度 {card.confidence}
            </b>
          </div>
          <h3>{card.card}</h3><strong>{card.model}</strong><p>{card.address}</p>
          {card.note ? <small>{card.note}</small> : null}
          <a href={card.sourceUrl} target="_blank" rel="noreferrer">出典を確認 <span aria-hidden="true">↗</span></a>
        </article>
      ))}
      {!filteredCards.length ? <p className="admin-card-empty">条件に合うカードがありません。</p> : null}
    </div>
  );
}

function CardModelDashboard({ cards }: { cards: CardModelLocation[] }): ReactElement {
  const [query, setQuery] = useState("");
  const [confidence, setConfidence] = useState<CardConfidenceFilter>("すべて");
  const filteredCards = filterCardModels(cards, query, confidence);

  return (
    <section className="admin-cards admin-panel">
      <div className="admin-panel__heading">
        <div><span>CARD SOURCES</span><h2>カードモデル地の確認</h2></div>
        <small>{cards.length}件</small>
      </div>
      <p className="admin-cards__intro">
        信頼度は管理用です。公開ページには表示しません。出典を開き、追加・修正時の判断材料にしてください。
      </p>
      <CardConfidenceGuide cards={cards} />
      <CardModelFilters query={query} setQuery={setQuery} confidence={confidence} setConfidence={setConfidence} />
      <p className="admin-card-count"><strong>{filteredCards.length}</strong> / {cards.length}件</p>
      <CardModelList cards={cards} filteredCards={filteredCards} />
    </section>
  );
}

type CommunityUsageState = {
  usage: CommunityUsageResponse | null;
  error: string;
  loading: boolean;
  refresh(): void;
};

async function requestCommunityUsage(): Promise<CommunityUsageResponse> {
  const response = await fetch("/api/admin/community-usage", { cache: "no-store" });
  const result = (await response.json()) as CommunityUsageResponse & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "API使用状況を読み込めませんでした。");
  return result;
}

function useCommunityUsage(): CommunityUsageState {
  const [communityUsage, setCommunityUsage] = useState<CommunityUsageResponse | null>(null);
  const [communityError, setCommunityError] = useState("");
  const [communityLoading, setCommunityLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  function refresh(): void {
    setCommunityLoading(true);
    setCommunityError("");
    setRefreshKey((value) => value + 1);
  }
  useEffect(() => {
    let cancelled = false;
    void requestCommunityUsage()
      .then((usage) => { if (!cancelled) setCommunityUsage(usage); })
      .catch((reason) => {
        if (!cancelled) setCommunityError(reason instanceof Error
          ? reason.message : "API使用状況を読み込めませんでした。");
      })
      .finally(() => { if (!cancelled) setCommunityLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);
  return { usage: communityUsage, error: communityError, loading: communityLoading, refresh };
}

function ApiUsageDashboard(): ReactElement {
  const community = useCommunityUsage();
  if (community.loading && !community.usage) {
    return (
      <section className="admin-usage admin-panel">
        <p className="admin-loading">API使用状況を集計しています…</p>
      </section>
    );
  }

  return (
    <section className="admin-usage">
      <div className="admin-panel usage-dashboard-heading">
        <div className="admin-panel__heading usage-heading">
          <div><span>API &amp; RECEIVER</span><h2>外部サービスと投稿受付の状況</h2></div>
          <div className="usage-heading__actions">
            <button
              type="button"
              className="usage-refresh"
              disabled={community.loading}
              onClick={community.refresh}
            >
              {community.loading ? "更新中…" : "更新"}
            </button>
          </div>
        </div>
        <p className="usage-note">サービスごとに計測方法が異なります。請求額の確認には、各サービスの公式画面をご利用ください。</p>
      </div>

      <CommunityUsagePanel
        usage={community.usage}
        error={community.error}
        loading={community.loading}
      />

      <MapboxUsagePanel />
    </section>
  );
}

function formattedUsageTime(value: string, timeZone = "Asia/Tokyo"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時刻不明";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function receiverStatusLabel(status: CommunityReceiverStatus["status"]): string {
  if (status === "ok") return "稼働中";
  if (status === "unreachable") return "応答なし";
  return "確認できません";
}

type CommunityUsagePanelProps = {
  usage: CommunityUsageResponse | null;
  error: string;
  loading: boolean;
};
type AvailableCommunityUsage = Extract<CommunityUsageResponse, { available: true }>;
type UnavailableCommunityUsage = Extract<CommunityUsageResponse, { available: false }>;

function CommunityUsageLoading(): ReactElement {
  return <div className="admin-panel usage-service-panel"><p className="admin-loading">投稿受付の使用状況を集計しています…</p></div>;
}

function CommunityUsageError({ error }: { error: string }): ReactElement {
  return (
    <div className="admin-panel usage-service-panel">
      <div className="admin-panel__heading">
        <div><span>COMMUNITY &amp; TURNSTILE</span><h2>投稿受付の状況を読み込めませんでした</h2></div>
      </div>
      <p className="admin-message" role="alert">{error}</p>
    </div>
  );
}

function CommunityUsageUnavailable({ usage }: { usage: UnavailableCommunityUsage | null }): ReactElement {
  return (
    <div className="admin-panel usage-service-panel">
      <div className="admin-panel__heading">
        <div><span>COMMUNITY &amp; TURNSTILE</span><h2>投稿受付の使用状況</h2></div>
      </div>
      {usage?.receiver ? <ReceiverStatus status={usage.receiver} /> : null}
      <p className="usage-unavailable">{usage?.message ?? "集計データはまだありません。"}</p>
    </div>
  );
}

function CommunityUsageFooter({ usage }: { usage: AvailableCommunityUsage }): ReactElement {
  return (
    <div className="usage-community-footer">
      <section className="usage-retained" aria-labelledby="retained-submissions-title">
        <div><span>RETAINED SUBMISSIONS</span><h3 id="retained-submissions-title">現在保持している投稿</h3></div>
        <dl>
          <div><dt>受付待ち <small>pending</small></dt><dd>{usage.retained.pending.toLocaleString("ja-JP")}</dd></div>
          <div><dt>掲載へ取り込み済み <small>accepted</small></dt><dd>{usage.retained.accepted.toLocaleString("ja-JP")}</dd></div>
          <div><dt>見送り <small>rejected</small></dt><dd>{usage.retained.rejected.toLocaleString("ja-JP")}</dd></div>
        </dl>
      </section>
      <p className="usage-tracking-start">
        <span>計測開始</span>
        <strong>{usage.trackingStartedAt ? formattedUsageTime(usage.trackingStartedAt, usage.timeZone) : "まだ記録がありません"}</strong>
      </p>
    </div>
  );
}

function AvailableCommunityUsagePanel({ usage }: { usage: AvailableCommunityUsage }): ReactElement {
  return (
    <div className="admin-panel usage-service-panel">
      <div className="admin-panel__heading usage-heading">
        <div><span>COMMUNITY &amp; TURNSTILE</span><h2>投稿受付と認証</h2></div>
        <small>{formattedUsageTime(usage.generatedAt, usage.timeZone)} 更新</small>
      </div>
      <ReceiverStatus status={usage.receiver} />
      <p className="usage-note">投稿受付サーバーが記録した件数です。Turnstileの「実呼出」は、再試行を含めCloudflareへ送ったリクエスト数です。</p>
      <div className="usage-periods usage-periods--three">
        <CommunityUsagePeriod title="今日" totals={usage.today} />
        <CommunityUsagePeriod title="今月" totals={usage.currentMonth} />
        <CommunityUsagePeriod title="計測開始から" totals={usage.allTime} />
      </div>
      <CommunityUsageFooter usage={usage} />
    </div>
  );
}

function CommunityUsagePanel({ usage, error, loading }: CommunityUsagePanelProps): ReactElement {
  if (loading && !usage) return <CommunityUsageLoading />;
  if (error) return <CommunityUsageError error={error} />;
  if (!usage?.available) return <CommunityUsageUnavailable usage={usage} />;
  return <AvailableCommunityUsagePanel usage={usage} />;
}

function ReceiverStatus({ status }: { status: CommunityReceiverStatus }): ReactElement {
  return (
    <div className={`usage-receiver-status usage-receiver-status--${status.status}`} role="status">
      <i aria-hidden="true" />
      <div>
        <strong>投稿受付サーバー：{receiverStatusLabel(status.status)}</strong>
        <small>{formattedUsageTime(status.checkedAt)} 確認{status.message ? ` · ${status.message}` : ""}</small>
      </div>
    </div>
  );
}

function CommunityUsagePeriod({
  title,
  totals,
}: {
  title: string;
  totals: CommunityUsageTotals;
}): ReactElement {
  return (
    <article className="usage-period usage-period--community">
      <span>{title}</span>
      <strong>{totals.submissionsAccepted.toLocaleString("ja-JP")}</strong>
      <small>件を受付</small>
      <dl>
        <div><dt>受付試行</dt><dd>{totals.submissionAttempts.toLocaleString("ja-JP")}回</dd></div>
        <div><dt>受付失敗</dt><dd className={totals.submissionsFailed ? "has-error" : ""}>{totals.submissionsFailed.toLocaleString("ja-JP")}回</dd></div>
        <div><dt>Turnstile実呼出</dt><dd>{totals.turnstileRequests.toLocaleString("ja-JP")}回</dd></div>
        <div><dt>認証成功</dt><dd>{totals.turnstileSuccessful.toLocaleString("ja-JP")}回</dd></div>
        <div><dt>認証失敗</dt><dd className={totals.turnstileFailed ? "has-error" : ""}>{totals.turnstileFailed.toLocaleString("ja-JP")}回</dd></div>
        <div><dt>再試行</dt><dd>{totals.turnstileRetries.toLocaleString("ja-JP")}回</dd></div>
      </dl>
    </article>
  );
}

function MapboxUsagePanel(): ReactElement {
  return (
    <div className="admin-panel usage-service-panel usage-service-panel--mapbox">
      <div className="admin-panel__heading">
        <div><span>MAPBOX</span><h2>地図と経路検索</h2></div>
        <a
          className="usage-external-link"
          href="https://console.mapbox.com/account/statistics/"
          target="_blank"
          rel="noreferrer"
          aria-label="Mapbox公式Statisticsを新しいタブで開く"
        >
          公式Statisticsを開く <span aria-hidden="true">↗</span>
        </a>
      </div>
      <p className="usage-note">
        Mapboxは公開ページのブラウザから直接利用しています。このサーバーでは正確な使用数を把握できないため、請求対象の使用量はMapbox公式Statisticsで確認してください。
      </p>
    </div>
  );
}

type PhotoManagerProps = {
  spots: PilgrimageSpot[];
  assets: AdminAsset[];
  setAssets: SetState<AdminAsset[]>;
  localToken: string;
};

type QueuedUrlRegistry = { current: Set<string> };
type LocatedGpsState = Extract<GpsState, { state: "found" | "far" }>;

function hasGpsLocation(gpsState: GpsState): gpsState is LocatedGpsState {
  return gpsState.state === "found" || gpsState.state === "far";
}

function updateQueuedPhotoState(
  setQueue: SetState<QueuedPhoto[]>,
  id: string,
  update: Partial<QueuedPhoto>,
): void {
  setQueue((current) => current.map((photo) => photo.id === id ? { ...photo, ...update } : photo));
}

async function detectPhotoLocation(
  photoId: string,
  file: File,
  spots: PilgrimageSpot[],
  setQueue: SetState<QueuedPhoto[]>,
): Promise<void> {
  try {
    const gps = await readGps(file);
    if (!gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) {
      updateQueuedPhotoState(setQueue, photoId, { gpsState: { state: "none" } });
      return;
    }
    const nearest = nearestSpot(gps.latitude, gps.longitude, spots);
    if (!nearest) {
      updateQueuedPhotoState(setQueue, photoId, { gpsState: { state: "none" } });
      return;
    }
    const gpsState: GpsState = {
      state: nearest.distanceM <= automaticSpotDistanceLimitM ? "found" : "far",
      lat: gps.latitude, lng: gps.longitude,
      nearestSpotId: nearest.spot.id, distanceM: nearest.distanceM,
    };
    setQueue((current) => current.map((photo) => photo.id === photoId ? {
      ...photo,
      spotId: gpsState.state === "found" && !photo.spotManuallySelected ? nearest.spot.id : photo.spotId,
      gpsState,
    } : photo));
  } catch {
    updateQueuedPhotoState(setQueue, photoId, { gpsState: { state: "none" } });
  }
}

type QueueFileSelection = {
  selected: QueuedPhoto[];
  invalidCount: number;
  duplicateCount: number;
};

function selectQueueFiles(
  files: File[],
  queue: QueuedPhoto[],
  spots: PilgrimageSpot[],
  queuedUrls: QueuedUrlRegistry,
): QueueFileSelection {
  const validFiles = files.filter((file) => isSupportedImageFile(file) && file.size <= 25 * 1024 * 1024);
  const existingFiles = new Set(queue.map((photo) => fileIdentity(photo.file)));
  const acceptedFiles = validFiles.filter((file) => {
    const identity = fileIdentity(file);
    if (existingFiles.has(identity)) return false;
    existingFiles.add(identity);
    return true;
  });
  const selected = acceptedFiles.map((file, index): QueuedPhoto => {
    const url = URL.createObjectURL(file);
    queuedUrls.current.add(url);
    return {
      id: `queued-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      file, url, placement: "spot", spotId: spots[0]?.id ?? "",
      cropX: 50, cropY: 50, zoom: 1,
      gpsState: { state: "loading" }, spotManuallySelected: false,
    };
  });
  return {
    selected,
    invalidCount: files.length - validFiles.length,
    duplicateCount: validFiles.length - acceptedFiles.length,
  };
}

type EnqueuePhotoContext = {
  queue: QueuedPhoto[];
  setQueue: SetState<QueuedPhoto[]>;
  setSelectedPhotoId: SetState<string>;
  queuedUrls: QueuedUrlRegistry;
  spots: PilgrimageSpot[];
  setMessage: SetState<string>;
};

function enqueuePhotoFiles(files: File[], context: EnqueuePhotoContext): void {
  const { selected, invalidCount, duplicateCount } = selectQueueFiles(
    files, context.queue, context.spots, context.queuedUrls,
  );
  if (selected.length) {
    if (!context.queue.length) context.setSelectedPhotoId(selected[0].id);
    context.setQueue((current) => [...current, ...selected]);
    for (const photo of selected) {
      void detectPhotoLocation(photo.id, photo.file, context.spots, context.setQueue);
    }
    context.setMessage("");
  }
  if (!invalidCount && !duplicateCount) return;
  const notices = [
    invalidCount ? `${invalidCount}枚は形式または容量が対象外` : "",
    duplicateCount ? `${duplicateCount}枚は選択済み` : "",
  ].filter(Boolean);
  context.setMessage(`${notices.join("、")}のため除外しました。`);
}

function removePhotoFromQueue(photoId: string, context: EnqueuePhotoContext): void {
  const index = context.queue.findIndex((photo) => photo.id === photoId);
  const target = context.queue[index];
  if (!target) return;
  URL.revokeObjectURL(target.url);
  context.queuedUrls.current.delete(target.url);
  const next = context.queue.filter((photo) => photo.id !== photoId);
  context.setQueue(next);
  context.setSelectedPhotoId((selectedId) => selectedId === photoId
    ? next[Math.min(index, next.length - 1)]?.id ?? ""
    : selectedId);
}

function useQueuedUrlCleanup(queuedUrls: QueuedUrlRegistry): void {
  useEffect(() => {
    const urls = queuedUrls.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, [queuedUrls]);
}

type PhotoQueueController = {
  queue: QueuedPhoto[];
  setQueue: SetState<QueuedPhoto[]>;
  currentPhoto: QueuedPhoto | null;
  selectedPhotoId: string;
  setSelectedPhotoId: SetState<string>;
  isDraggingFiles: boolean;
  queuedUrls: QueuedUrlRegistry;
  beginFileDrag(): void;
  leaveFileDrag(): void;
  dropFiles(files: File[]): void;
  updateQueuedPhoto(id: string, update: Partial<QueuedPhoto>): void;
  queueFiles(files: File[]): void;
  removeQueuedPhoto(photoId: string): void;
};

function usePhotoQueue(spots: PilgrimageSpot[], setMessage: SetState<string>): PhotoQueueController {
  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  const [selectedPhotoId, setSelectedPhotoId] = useState("");
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const queuedUrls = useRef(new Set<string>());
  const dragDepth = useRef(0);
  useQueuedUrlCleanup(queuedUrls);
  const context: EnqueuePhotoContext = {
    queue, setQueue, setSelectedPhotoId, queuedUrls, spots, setMessage,
  };
  return {
    queue, setQueue, selectedPhotoId, setSelectedPhotoId, isDraggingFiles,
    queuedUrls,
    currentPhoto: queue.find((photo) => photo.id === selectedPhotoId) ?? queue[0] ?? null,
    beginFileDrag: () => { dragDepth.current += 1; setIsDraggingFiles(true); },
    leaveFileDrag: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setIsDraggingFiles(false);
    },
    dropFiles: (files) => {
      dragDepth.current = 0;
      setIsDraggingFiles(false);
      enqueuePhotoFiles(files, context);
    },
    updateQueuedPhoto: (id, update) => updateQueuedPhotoState(setQueue, id, update),
    queueFiles: (files) => enqueuePhotoFiles(files, context),
    removeQueuedPhoto: (photoId) => removePhotoFromQueue(photoId, context),
  };
}

function usePhotoPreview(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  photo: QueuedPhoto | null,
  setMessage: SetState<string>,
): void {
  const previewUrl = photo?.url ?? "";
  const placement = photo?.placement ?? "spot";
  const cropX = photo?.cropX ?? 50;
  const cropY = photo?.cropY ?? 50;
  const zoom = photo?.zoom ?? 1;
  useEffect(() => {
    if (!previewUrl || !canvasRef.current) return;
    let cancelled = false;
    loadImage(previewUrl).then((image) => {
      if (!cancelled && canvasRef.current) {
        drawCroppedImage(canvasRef.current, image, placement, cropX, cropY, zoom);
      }
    }).catch(() => setMessage("プレビューを表示できませんでした。"));
    return () => { cancelled = true; };
  }, [canvasRef, cropX, cropY, placement, previewUrl, setMessage, zoom]);
}

async function uploadPhoto(photo: QueuedPhoto, localToken: string): Promise<AdminAsset> {
  const derivative = await makePublicDerivative(
    photo.url, photo.placement, photo.cropX, photo.cropY, photo.zoom,
  );
  const gpsState = photo.gpsState;
  const gpsMetadata = hasGpsLocation(gpsState) ? {
    gpsLat: gpsState.lat, gpsLng: gpsState.lng, nearestSpotId: gpsState.nearestSpotId,
  } : { gpsLat: null, gpsLng: null, nearestSpotId: null };
  const metadata = {
    placement: photo.placement,
    spotId: photo.placement === "spot" ? photo.spotId : null,
    cropX: photo.cropX, cropY: photo.cropY, zoom: photo.zoom,
    ...gpsMetadata,
  };
  const response = await fetch("/api/admin/media", {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-admin-token": localToken },
    body: JSON.stringify({
      derivativeBase64: await blobToBase64(derivative),
      contentType: derivative.type,
      metadata,
    }),
  });
  const result = (await response.json()) as { asset?: AdminAsset; error?: string };
  if (!response.ok || !result.asset) throw new Error(result.error ?? "画像を公開できませんでした。");
  return result.asset;
}

type PhotoPublishingContext = {
  photos: PhotoQueueController;
  assets: SetState<AdminAsset[]>;
  localToken: string;
  saving: boolean;
  setSaving: SetState<boolean>;
  setBatchProgress: SetState<{ current: number; total: number } | null>;
  setMessage: SetState<string>;
};

async function publishCurrentPhoto(context: PhotoPublishingContext): Promise<void> {
  const photo = context.photos.currentPhoto;
  if (!photo || context.saving) return;
  context.setSaving(true);
  context.setMessage("");
  try {
    const asset = await uploadPhoto(photo, context.localToken);
    context.assets((current) => [asset, ...current]);
    context.photos.removeQueuedPhoto(photo.id);
    context.setMessage("透かし済み画像をローカルファイルへ保存しました。GitHub Pagesへはまだ公開されていません。");
  } catch (error) {
    context.setMessage(error instanceof Error ? error.message : "画像を公開できませんでした。");
  } finally {
    context.setSaving(false);
  }
}

async function publishAllPhotos(context: PhotoPublishingContext): Promise<void> {
  if (!context.photos.queue.length || context.saving) return;
  context.setSaving(true);
  context.setMessage("");
  const pending = [...context.photos.queue];
  const uploaded: AdminAsset[] = [];
  const successfulIds = new Set<string>();
  const failures: string[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const photo = pending[index];
    context.setBatchProgress({ current: index + 1, total: pending.length });
    try {
      const asset = await uploadPhoto(photo, context.localToken);
      uploaded.push(asset);
      successfulIds.add(photo.id);
    } catch (error) {
      failures.push(`${photo.file.name}：${error instanceof Error ? error.message : "保存できませんでした。"}`);
    }
  }
  if (uploaded.length) {
    context.assets((current) => [...[...uploaded].reverse(), ...current]);
    for (const photo of pending) {
      if (!successfulIds.has(photo.id)) continue;
      URL.revokeObjectURL(photo.url);
      context.photos.queuedUrls.current.delete(photo.url);
    }
    const remaining = context.photos.queue.filter((photo) => !successfulIds.has(photo.id));
    context.photos.setQueue(remaining);
    context.photos.setSelectedPhotoId(remaining[0]?.id ?? "");
  }
  context.setMessage(failures.length
    ? `${uploaded.length}枚を保存、${failures.length}枚を未処理のまま残しました。${failures.join(" / ")}`
    : `${uploaded.length}枚をローカルファイルへ一括保存しました。GitHub Pagesへはまだ公開されていません。`);
  context.setBatchProgress(null);
  context.setSaving(false);
}

type PhotoPublishing = {
  saving: boolean;
  batchProgress: { current: number; total: number } | null;
  publishCurrent(): Promise<void>;
  publishAll(): Promise<void>;
};

function usePhotoPublishing(
  photos: PhotoQueueController,
  setAssets: SetState<AdminAsset[]>,
  localToken: string,
  setMessage: SetState<string>,
): PhotoPublishing {
  const [saving, setSaving] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const context = { photos, assets: setAssets, localToken, saving, setSaving, setBatchProgress, setMessage };
  return {
    saving, batchProgress,
    publishCurrent: () => publishCurrentPhoto(context),
    publishAll: () => publishAllPhotos(context),
  };
}

type AssetActionContext = {
  localToken: string;
  changingId: string;
  setChangingId: SetState<string>;
  setAssets: SetState<AdminAsset[]>;
  setMessage: SetState<string>;
};

async function deletePublishedAsset(asset: AdminAsset, context: AssetActionContext): Promise<void> {
  const heroWarning = (asset.heroCandidate ?? asset.placement === "hero")
    ? "\nこの画像は現在トップ画像候補にも使われています。" : "";
  if (!window.confirm(`「${asset.originalName}」をローカルの公開用ファイルから削除しますか？${heroWarning}`)) return;
  const response = await fetch(`/api/admin/media/${asset.id}`, {
    method: "DELETE", headers: { "x-local-admin-token": context.localToken },
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    context.setMessage(result.error ?? "画像を削除できませんでした。");
    return;
  }
  context.setAssets((current) => current.filter((item) => item.id !== asset.id));
  context.setMessage("画像を削除しました。");
}

async function changePublishedHeroCandidate(
  asset: AdminAsset,
  enabled: boolean,
  context: AssetActionContext,
): Promise<void> {
  if (context.changingId) return;
  context.setChangingId(asset.id);
  context.setMessage("");
  try {
    const response = await fetch(`/api/admin/media/${asset.id}/hero-candidate`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-local-admin-token": context.localToken },
      body: JSON.stringify({ enabled }),
    });
    const result = (await response.json().catch(() => ({}))) as { asset?: AdminAsset; error?: string };
    if (!response.ok || !result.asset) {
      throw new Error(result.error ?? "トップ画像候補を変更できませんでした。");
    }
    context.setAssets((current) => current.map((item) => item.id === result.asset!.id ? result.asset! : item));
    context.setMessage(enabled ? "トップ画像候補に追加しました。" : "トップ画像候補から外しました。");
  } catch (error) {
    context.setMessage(error instanceof Error ? error.message : "トップ画像候補を変更できませんでした。");
  } finally {
    context.setChangingId("");
  }
}

type AssetActions = {
  changingId: string;
  deleteAsset(asset: AdminAsset): Promise<void>;
  changeHeroCandidate(asset: AdminAsset, enabled: boolean): Promise<void>;
};

function useAssetActions(
  setAssets: SetState<AdminAsset[]>,
  localToken: string,
  setMessage: SetState<string>,
): AssetActions {
  const [changingId, setChangingId] = useState("");
  const context = { localToken, changingId, setChangingId, setAssets, setMessage };
  return {
    changingId,
    deleteAsset: (asset) => deletePublishedAsset(asset, context),
    changeHeroCandidate: (asset, enabled) => changePublishedHeroCandidate(asset, enabled, context),
  };
}

function PhotoDropzone({ photos }: { photos: PhotoQueueController }): ReactElement {
  function addFiles(event: ChangeEvent<HTMLInputElement>): void {
    photos.queueFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }
  function handleDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    photos.dropFiles(Array.from(event.dataTransfer.files));
  }
  return (
    <label className={`upload-dropzone${photos.isDraggingFiles ? " is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        photos.beginFileDrag();
      }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(event) => {
        event.preventDefault();
        photos.leaveFileDrag();
      }}
      onDrop={handleDrop}>
      <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={addFiles} />
      <strong>{photos.isDraggingFiles ? "ここへドロップ" : "写真を選択"}</strong>
      <span>クリックまたはD&amp;D・複数枚対応（1枚25MBまで）</span>
    </label>
  );
}

function QueuedPhotoSummary({ photos }: { photos: PhotoQueueController }): ReactElement {
  const photo = photos.currentPhoto;
  if (!photo) return <p className="empty-note">写真を選ぶと、ここから配置と切り抜きを調整できます。</p>;
  return (
    <div className="file-summary">
      <div><small>編集中</small><strong>{photo.file.name}</strong></div>
      <button type="button" onClick={() => photos.removeQueuedPhoto(photo.id)}>この写真を外す</button>
    </div>
  );
}

function queuedPhotoGpsLabel(photo: QueuedPhoto, spots: PilgrimageSpot[]): string {
  const assignedSpot = spots.find((spot) => spot.id === photo.spotId);
  const gps = photo.gpsState;
  if (gps.state === "loading") return "位置情報を確認中…";
  if (gps.state === "found") {
    return `GPSから自動選択：${assignedSpot?.name ?? "候補なし"}（${formatDistance(gps.distanceM)}）`;
  }
  if (gps.state === "far") {
    const nearest = spots.find((spot) => spot.id === gps.nearestSpotId);
    return `GPS候補が遠いため手動選択：${nearest?.name ?? "候補なし"}（${formatDistance(gps.distanceM)}）`;
  }
  return "GPSなし・手動選択";
}

function PhotoAssignmentItem({
  photo, index, spots, photos,
}: { photo: QueuedPhoto; index: number; spots: PilgrimageSpot[]; photos: PhotoQueueController }): ReactElement {
  return (
    <article className={photo.id === photos.currentPhoto?.id ? "is-current" : undefined}>
      <button type="button" className="photo-assignment-list__preview"
        aria-label={`${photo.file.name}を編集`} onClick={() => photos.setSelectedPhotoId(photo.id)}>
        <img src={photo.url} alt="" /><span>{String(index + 1).padStart(2, "0")}</span>
      </button>
      <div className="photo-assignment-list__copy">
        <button type="button" onClick={() => photos.setSelectedPhotoId(photo.id)}>{photo.file.name}</button>
        {photo.placement === "spot" ? (
          <select value={photo.spotId} aria-label={`${photo.file.name}の配置先スポット`}
            onChange={(event) => photos.updateQueuedPhoto(photo.id, {
              spotId: event.target.value, spotManuallySelected: true,
            })}>
            {spots.map((spot) => <option value={spot.id} key={spot.id}>{spot.name}</option>)}
          </select>
        ) : <strong>トップ画像候補</strong>}
        <small className={`is-${photo.gpsState.state}`}>{queuedPhotoGpsLabel(photo, spots)}</small>
      </div>
      <button type="button" className="photo-assignment-list__remove"
        onClick={() => photos.removeQueuedPhoto(photo.id)} aria-label={`${photo.file.name}を外す`}>×</button>
    </article>
  );
}

function PhotoAssignmentList({
  photos, spots,
}: { photos: PhotoQueueController; spots: PilgrimageSpot[] }): ReactElement | null {
  if (!photos.queue.length) return null;
  return (
    <section className="photo-assignment-list" aria-label="画像ごとの配置先">
      <div className="photo-assignment-list__heading"><strong>画像ごとの配置先</strong><span>{photos.queue.length}枚</span></div>
      <div>{photos.queue.map((photo, index) => (
        <PhotoAssignmentItem key={photo.id} photo={photo} index={index} spots={spots} photos={photos} />
      ))}</div>
    </section>
  );
}

function PhotoUploadPanel({
  photos, spots,
}: { photos: PhotoQueueController; spots: PilgrimageSpot[] }): ReactElement {
  return (
    <div className="admin-panel admin-panel--upload">
      <div className="admin-panel__heading">
        <div><span>STEP 1</span><h2>写真を選ぶ</h2></div>
        {photos.queue.length > 0 && <small>残り {photos.queue.length}枚</small>}
      </div>
      <PhotoDropzone photos={photos} />
      <QueuedPhotoSummary photos={photos} />
      <PhotoAssignmentList photos={photos} spots={spots} />
    </div>
  );
}

function GpsPlacementNote({ gps, nearest }: {
  gps: GpsState;
  nearest: PilgrimageSpot | null | undefined;
}): ReactElement {
  return (
    <div className={`gps-note gps-note--${gps.state}`}>
      {gps.state === "loading" && "EXIFの位置情報を確認しています…"}
      {gps.state === "none" && "GPS情報は見つかりませんでした。配置先を手動で選んでください。"}
      {gps.state === "found" && nearest && (
        <>最寄り候補は <strong>{nearest.name}</strong>（{formatDistance(gps.distanceM)}）です。必要なら変更してください。</>
      )}
      {gps.state === "far" && nearest && (
        <>最寄りの <strong>{nearest.name}</strong> まで{formatDistance(gps.distanceM)}あるため、自動選択せず手動指定にしています。</>
      )}
    </div>
  );
}

function PhotoPlacementPanel({
  photo, photos, spots,
}: { photo: QueuedPhoto; photos: PhotoQueueController; spots: PilgrimageSpot[] }): ReactElement {
  const gps = photo.gpsState;
  const nearest = hasGpsLocation(gps)
    ? spots.find((spot) => spot.id === gps.nearestSpotId) : null;
  return (
    <div className="admin-panel">
      <div className="admin-panel__heading"><div><span>STEP 2</span><h2>配置先を決める</h2></div></div>
      <div className="placement-switch">
        <label><input type="radio" checked={photo.placement === "spot"}
          onChange={() => photos.updateQueuedPhoto(photo.id, { placement: "spot" })} />スポットカード</label>
        <label><input type="radio" checked={photo.placement === "hero"}
          onChange={() => photos.updateQueuedPhoto(photo.id, { placement: "hero" })} />トップ画像候補</label>
      </div>
      {photo.placement === "spot" && (
        <label className="admin-field">
          <span>配置するスポット</span>
          <select value={photo.spotId} onChange={(event) => photos.updateQueuedPhoto(photo.id, {
            spotId: event.target.value, spotManuallySelected: true,
          })}>{spots.map((spot) => <option value={spot.id} key={spot.id}>{spot.name}</option>)}</select>
        </label>
      )}
      {photo.placement === "spot" ? <GpsPlacementNote gps={photo.gpsState} nearest={nearest} /> : (
        <div className="hero-placement-note">
          <strong>トップ画像のランダム候補へ追加します</strong>
          <span>ページを開くたびに候補から1枚が選ばれます。公開中に自動で切り替わることはありません。</span>
        </div>
      )}
    </div>
  );
}

function photoPublishLabel(photo: QueuedPhoto, queueLength: number, saving: boolean): string {
  if (saving) return "公開用画像を作成中…";
  if (queueLength > 1) return `${queueLength}枚をまとめて追加する`;
  return photo.placement === "hero" ? "トップ画像候補に追加する" : "この内容で公開する";
}

function PhotoCropPanel({
  photo, photos, currentSpot, canvasRef, publishing,
}: {
  photo: QueuedPhoto;
  photos: PhotoQueueController;
  currentSpot: PilgrimageSpot | undefined;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  publishing: PhotoPublishing;
}): ReactElement {
  const label = publishing.batchProgress
    ? `${publishing.batchProgress.current} / ${publishing.batchProgress.total}枚を保存中…`
    : photoPublishLabel(photo, photos.queue.length, publishing.saving);
  return (
    <div className="admin-panel admin-panel--preview">
      <div className="admin-panel__heading">
        <div><span>STEP 3</span><h2>見せる範囲を整える</h2></div>
        <small>{photo.placement === "hero" ? "16:9" : "4:3"}・{watermarkText}</small>
      </div>
      <div className={`crop-preview crop-preview--${photo.placement}`}>
        <canvas ref={canvasRef} /><div className="crop-preview__shade" />
        <div className="crop-preview__copy">
          <small>{photo.placement === "hero" ? "RANDOM HERO CANDIDATE" : currentSpot?.area}</small>
          <strong>{photo.placement === "hero" ? "蓮ノ旅" : currentSpot?.name}</strong>
        </div>
      </div>
      <div className="crop-controls">
        <label><span>左右位置</span><input type="range" min="0" max="100" value={photo.cropX} onChange={(event) => photos.updateQueuedPhoto(photo.id, { cropX: Number(event.target.value) })} /></label>
        <label><span>上下位置</span><input type="range" min="0" max="100" value={photo.cropY} onChange={(event) => photos.updateQueuedPhoto(photo.id, { cropY: Number(event.target.value) })} /></label>
        <label><span>拡大</span><input type="range" min="1" max="2.5" step="0.05" value={photo.zoom} onChange={(event) => photos.updateQueuedPhoto(photo.id, { zoom: Number(event.target.value) })} /></label>
      </div>
      <PhotoPublishActions photos={photos} publishing={publishing} label={label} />
      <p className="privacy-note">
        公開用画像はWebP/JPEGへ再生成され、{watermarkText}の透かしを焼き込みます。
        GPS・端末名・ISO・撮影日時などのEXIFは含まれず、
        選択した元写真はプロジェクト内へ保存しません。
      </p>
    </div>
  );
}

function PhotoPublishActions({
  photos, publishing, label,
}: { photos: PhotoQueueController; publishing: PhotoPublishing; label: string }): ReactElement {
  return (
    <div className="photo-publish-actions">
      {photos.queue.length > 1 ? (
        <button className="admin-publish admin-publish--secondary" type="button"
          disabled={publishing.saving} onClick={publishing.publishCurrent}>
          この1枚だけ追加する<span>→</span>
        </button>
      ) : null}
      <button className="admin-publish" type="button" disabled={publishing.saving}
        onClick={photos.queue.length > 1 ? publishing.publishAll : publishing.publishCurrent}>
        {label}<span>→</span>
      </button>
    </div>
  );
}

function HeroCandidateSummary({ assets }: { assets: AdminAsset[] }): ReactElement {
  return (
    <section className="hero-candidate-summary" aria-label="トップ画像候補">
      <div><span>RANDOM HERO</span><strong>トップ画像候補</strong><small>{assets.length}枚</small></div>
      <p>ページを開くたび、この中から前回とは違う1枚を表示します。</p>
      {assets.length ? (
        <div className="hero-candidate-thumbnails">
          {assets.map((asset) => <img key={asset.id} src={asset.imageUrl} alt={asset.originalName} />)}
        </div>
      ) : <p className="empty-note">トップ画像候補がありません。</p>}
    </section>
  );
}

function PublishedAssetItem({
  asset, spots, actions,
}: { asset: AdminAsset; spots: PilgrimageSpot[]; actions: AssetActions }): ReactElement {
  const spot = spots.find((item) => item.id === asset.spotId);
  const isHeroCandidate = asset.heroCandidate ?? asset.placement === "hero";
  return (
    <article className={isHeroCandidate ? "is-hero-candidate" : undefined}>
      <img src={asset.imageUrl} alt="" />
      <div className="published-list__copy">
        <div>{isHeroCandidate ? <small>トップ候補</small> : null}<strong>{asset.placement === "hero" ? "トップ画像" : spot?.name ?? "未設定"}</strong></div>
        <span>{asset.originalName}</span>
      </div>
      <div className="published-list__actions">
        <button type="button" aria-pressed={isHeroCandidate} disabled={actions.changingId === asset.id}
          onClick={() => actions.changeHeroCandidate(asset, !isHeroCandidate)}>
          {actions.changingId === asset.id ? "変更中…" : isHeroCandidate ? "候補から外す" : "候補に追加"}
        </button>
        <button type="button" onClick={() => actions.deleteAsset(asset)}>削除</button>
      </div>
    </article>
  );
}

function PublishedAssetsPanel({
  assets, spots, actions,
}: { assets: AdminAsset[]; spots: PilgrimageSpot[]; actions: AssetActions }): ReactElement {
  const heroAssets = assets.filter((asset) => asset.heroCandidate ?? asset.placement === "hero");
  return (
    <aside className="admin-panel published-panel">
      <div className="admin-panel__heading"><div><span>LIVE ASSETS</span><h2>公開済み</h2></div><small>{assets.length}枚</small></div>
      <HeroCandidateSummary assets={heroAssets} />
      {assets.length ? (
        <div className="published-list">{assets.map((asset) => (
          <PublishedAssetItem key={asset.id} asset={asset} spots={spots} actions={actions} />
        ))}</div>
      ) : <p className="empty-note">管理画面から公開した写真はまだありません。</p>}
    </aside>
  );
}

function PhotoManager({
  spots, assets, setAssets, localToken,
}: PhotoManagerProps): ReactElement {
  const [message, setMessage] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const photos = usePhotoQueue(spots, setMessage);
  usePhotoPreview(canvasRef, photos.currentPhoto, setMessage);
  const publishing = usePhotoPublishing(photos, setAssets, localToken, setMessage);
  const assetActions = useAssetActions(setAssets, localToken, setMessage);
  const currentSpot = spots.find((spot) => spot.id === photos.currentPhoto?.spotId);

  return (
    <section className="admin-workspace">
      <div className="photo-editor">
        <PhotoUploadPanel photos={photos} spots={spots} />
        {photos.currentPhoto ? (
          <>
            <PhotoPlacementPanel photo={photos.currentPhoto} photos={photos} spots={spots} />
            <PhotoCropPanel photo={photos.currentPhoto} photos={photos} currentSpot={currentSpot}
              canvasRef={canvasRef} publishing={publishing} />
          </>
        ) : null}
        {message && <p className="admin-message" role="status">{message}</p>}
      </div>
      <PublishedAssetsPanel assets={assets} spots={spots} actions={assetActions} />
    </section>
  );
}

type SpotManagerProps = {
  spots: PilgrimageSpot[];
  setSpots: SetState<PilgrimageSpot[]>;
  baseSpots: PilgrimageSpot[];
  overrideIds: Set<string>;
  setOverrideIds: SetState<Set<string>>;
  localToken: string;
};

type SpotFilters = {
  query: string;
  setQuery: SetState<string>;
  area: string;
  setArea: SetState<string>;
  collaboration: CollaborationId | "すべて";
  setCollaboration: SetState<CollaborationId | "すべて">;
  source: AdminSpotSourceFilter;
  setSource: SetState<AdminSpotSourceFilter>;
  areas: string[];
  categories: PilgrimageSpot["category"][];
  filteredSpots: PilgrimageSpot[];
};

function matchesSpotFilter(
  spot: PilgrimageSpot,
  query: string,
  area: string,
  collaboration: CollaborationId | "すべて",
  source: AdminSpotSourceFilter,
): boolean {
  if (area !== "すべて" && spot.area !== area) return false;
  if (collaboration !== "すべて" && !spot.collaborationIds?.includes(collaboration)) return false;
  if (source === "activity-records" && !spot.activityRecords?.length) return false;
  if (source === "sehas" && !spot.sehasEpisodes?.length) return false;
  if (source === "with-meets" && !spot.withMeetsEpisodes?.length) return false;
  if (!query) return true;
  const collaborationLabels = (spot.collaborationIds ?? []).flatMap((id) => {
    const item = collaborations.find((candidate) => candidate.id === id);
    return item ? [item.name, item.subtitle] : [];
  });
  return [
    spot.name, spot.shortName, spot.address, spot.area, spot.category,
    ...(spot.activityRecords ?? []), ...(spot.sehasEpisodes ?? []),
    ...(spot.withMeetsEpisodes ?? []), ...(spot.appearances ?? []),
    ...collaborationLabels,
  ].some((value) => value.toLocaleLowerCase("ja").includes(query));
}

function useSpotFilters(spots: PilgrimageSpot[], baseSpots: PilgrimageSpot[]): SpotFilters {
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("すべて");
  const [collaboration, setCollaboration] = useState<CollaborationId | "すべて">("すべて");
  const [source, setSource] = useState<AdminSpotSourceFilter>("すべて");
  const categories = useMemo(
    () => Array.from(new Set(baseSpots.map((spot) => spot.category))), [baseSpots],
  );
  const areas = useMemo(() => Array.from(new Set(spots.map((spot) => spot.area))), [spots]);
  const filteredSpots = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("ja");
    return spots.filter((spot) => matchesSpotFilter(
      spot, normalizedQuery, area, collaboration, source,
    ));
  }, [area, collaboration, query, source, spots]);
  return {
    query, setQuery, area, setArea, collaboration, setCollaboration,
    source, setSource, areas, categories, filteredSpots,
  };
}

type SpotActionContext = {
  draft: PilgrimageSpot;
  baseSpots: PilgrimageSpot[];
  setDraft: SetState<PilgrimageSpot>;
  setSpots: SetState<PilgrimageSpot[]>;
  setOverrideIds: SetState<Set<string>>;
  localToken: string;
  setSaving: SetState<boolean>;
  setMessage: SetState<string>;
};

async function saveSpot(event: FormEvent, context: SpotActionContext): Promise<void> {
  event.preventDefault();
  context.setSaving(true);
  context.setMessage("");
  try {
    const response = await fetch(`/api/admin/spots/${context.draft.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-local-admin-token": context.localToken },
      body: JSON.stringify(context.draft),
    });
    const result = (await response.json()) as { spot?: PilgrimageSpot; error?: string };
    if (!response.ok || !result.spot) throw new Error(result.error ?? "保存できませんでした。");
    const savedSpot = result.spot;
    context.setSpots((current) => current.map((spot) => spot.id === context.draft.id ? savedSpot : spot));
    context.setOverrideIds((current) => new Set(current).add(context.draft.id));
    context.setMessage("ローカルファイルへ保存しました。GitHub Pagesへはまだ公開されていません。");
  } catch (error) {
    context.setMessage(error instanceof Error ? error.message : "保存できませんでした。");
  } finally {
    context.setSaving(false);
  }
}

async function resetSpot(context: SpotActionContext): Promise<void> {
  if (!window.confirm("このスポットの修正を取り消し、登録時の情報へ戻しますか？")) return;
  const response = await fetch(`/api/admin/spots/${context.draft.id}`, {
    method: "DELETE", headers: { "x-local-admin-token": context.localToken },
  });
  if (!response.ok) {
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    context.setMessage(result.error ?? "元に戻せませんでした。");
    return;
  }
  const base = context.baseSpots.find((spot) => spot.id === context.draft.id);
  if (base) {
    context.setDraft(base);
    context.setSpots((current) => current.map((spot) => spot.id === base.id ? base : spot));
  }
  context.setOverrideIds((current) => {
    const next = new Set(current);
    next.delete(context.draft.id);
    return next;
  });
  context.setMessage("サーバー起動時の内容へ戻し、ローカルファイルへ保存しました。");
}

type UpdateSpot = <K extends keyof PilgrimageSpot>(key: K, value: PilgrimageSpot[K]) => void;

function parseLineList(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function SpotFilterControls({ filters }: { filters: SpotFilters }): ReactElement {
  return (
    <div className="spot-selector__filters" aria-label="スポットの絞り込み">
      <label className="admin-field admin-field--wide">
        <span>キーワード</span>
        <input type="search" value={filters.query} placeholder="施設名・住所・登場回で検索"
          onChange={(event) => filters.setQuery(event.target.value)} />
      </label>
      <label className="admin-field">
        <span>エリア</span>
        <select value={filters.area} onChange={(event) => filters.setArea(event.target.value)}>
          <option>すべて</option>{filters.areas.map((area) => <option key={area}>{area}</option>)}
        </select>
      </label>
      <label className="admin-field">
        <span>コラボ</span>
        <select value={filters.collaboration} onChange={(event) => filters.setCollaboration(event.target.value as CollaborationId | "すべて")}>
          <option value="すべて">すべて</option>
          {collaborations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label className="admin-field admin-field--wide">
        <span>出典</span>
        <select value={filters.source} onChange={(event) => filters.setSource(event.target.value as AdminSpotSourceFilter)}>
          <option value="すべて">すべて</option><option value="sehas">せーはす！</option>
          <option value="activity-records">活動記録</option><option value="with-meets">With×MEETS</option>
        </select>
      </label>
    </div>
  );
}

function SpotSelectorList({
  spots, filteredSpots, selectedId, overrideIds, onSelect,
}: {
  spots: PilgrimageSpot[];
  filteredSpots: PilgrimageSpot[];
  selectedId: string;
  overrideIds: Set<string>;
  onSelect(spot: PilgrimageSpot): void;
}): ReactElement {
  return (
    <div className="spot-selector__list">
      {filteredSpots.map((spot) => (
        <button type="button" className={spot.id === selectedId ? "is-active" : ""} key={spot.id}
          onClick={() => onSelect(spot)}>
          <span>{String(spots.findIndex((item) => item.id === spot.id) + 1).padStart(2, "0")}</span>
          <strong>{spot.name}</strong>{overrideIds.has(spot.id) && <small>修正済み</small>}
        </button>
      ))}
      {!filteredSpots.length ? <p className="empty-note">条件に合うスポットがありません。</p> : null}
    </div>
  );
}

function SpotSelector({
  spots, filters, selectedId, overrideIds, onSelect,
}: {
  spots: PilgrimageSpot[];
  filters: SpotFilters;
  selectedId: string;
  overrideIds: Set<string>;
  onSelect(spot: PilgrimageSpot): void;
}): ReactElement {
  return (
    <aside className="admin-panel spot-selector">
      <div className="admin-panel__heading"><div><span>SPOTS</span><h2>編集する場所</h2></div><small>{filters.filteredSpots.length} / {spots.length}</small></div>
      <SpotFilterControls filters={filters} />
      <SpotSelectorList spots={spots} filteredSpots={filters.filteredSpots} selectedId={selectedId}
        overrideIds={overrideIds} onSelect={onSelect} />
    </aside>
  );
}

function SpotBasicFields({
  draft, categories, update, onCoordinates,
}: {
  draft: PilgrimageSpot;
  categories: PilgrimageSpot["category"][];
  update: UpdateSpot;
  onCoordinates(lat: number, lng: number): void;
}): ReactElement {
  return (
    <>
      <label className="admin-field admin-field--wide"><span>正式名称</span><input value={draft.name} maxLength={100} onChange={(event) => update("name", event.target.value)} /><small>お店・施設の公式表記に合わせてください。</small></label>
      <label className="admin-field"><span>短縮名</span><input value={draft.shortName} maxLength={60} onChange={(event) => update("shortName", event.target.value)} /></label>
      <label className="admin-field"><span>エリア</span><input value={draft.area} maxLength={40} onChange={(event) => update("area", event.target.value)} /></label>
      <label className="admin-field"><span>カテゴリ</span><select value={draft.category} onChange={(event) => update("category", event.target.value as PilgrimageSpot["category"])}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
      <label className="admin-field admin-field--wide"><span>住所</span><input value={draft.address} maxLength={160} onChange={(event) => update("address", event.target.value)} /></label>
      <label className="admin-field"><span>緯度</span><input type="number" step="any" value={draft.lat} onChange={(event) => update("lat", Number(event.target.value))} /></label>
      <label className="admin-field"><span>経度</span><input type="number" step="any" value={draft.lng} onChange={(event) => update("lng", Number(event.target.value))} /></label>
      <AdminCoordinatePicker name={draft.name} lat={draft.lat} lng={draft.lng}
        onChange={onCoordinates} />
    </>
  );
}

function ClosedWeekdaysField({ draft, update }: { draft: PilgrimageSpot; update: UpdateSpot }): ReactElement {
  return (
    <fieldset className="admin-field admin-field--wide admin-weekdays">
      <legend>通常の休業曜日</legend>
      <div>{["日", "月", "火", "水", "木", "金", "土"].map((label, day) => (
        <label key={label}>
          <input type="checkbox" checked={draft.closedWeekdays?.includes(day) ?? false}
            onChange={(event) => {
              const current = draft.closedWeekdays ?? [];
              update("closedWeekdays", event.target.checked
                ? Array.from(new Set([...current, day])).sort() : current.filter((value) => value !== day));
            }} />
          <span>{label}</span>
        </label>
      ))}</div>
      <small>祝日・臨時休業・季節営業は補足欄へ記載してください。</small>
    </fieldset>
  );
}

function SpotHoursFields({ draft, update }: { draft: PilgrimageSpot; update: UpdateSpot }): ReactElement {
  return (
    <>
      <label className="admin-field"><span>推奨滞在時間（分）</span><input type="number" min="0" max="480" step="5" value={draft.recommendedStayMinutes ?? ""} placeholder="カテゴリ既定値" onChange={(event) => update("recommendedStayMinutes", event.target.value === "" ? undefined : Number(event.target.value))} /><small>未入力の場合はカテゴリごとの既定値を使います。</small></label>
      <label className="admin-field"><span>営業・開館時刻</span><input type="time" value={draft.openingTime ?? ""} onChange={(event) => update("openingTime", event.target.value || undefined)} /><small>公式情報を確認できた場合だけ入力してください。</small></label>
      <label className="admin-field"><span>営業・閉館時刻</span><input type="time" value={draft.closingTime ?? ""} onChange={(event) => update("closingTime", event.target.value || undefined)} /><small>最終入場は下の補足欄へ記載してください。</small></label>
      <ClosedWeekdaysField draft={draft} update={update} />
      <label className="admin-field admin-field--wide"><span>営業時間の補足</span><textarea rows={3} maxLength={300} value={draft.openingHoursNote ?? ""} placeholder="例：最終入館16:30。祝日の場合は翌日休館。" onChange={(event) => update("openingHoursNote", event.target.value || undefined)} /></label>
      <label className="admin-field"><span>営業時間の確認日</span><input type="date" value={draft.openingHoursCheckedAt ?? ""} onChange={(event) => update("openingHoursCheckedAt", event.target.value || undefined)} /><small>公式サイト等を最後に確認した日です。</small></label>
    </>
  );
}

function SpotSourceFields({ draft, update }: { draft: PilgrimageSpot; update: UpdateSpot }): ReactElement {
  return (
    <>
      <label className="admin-field admin-field--wide"><span>説明</span><textarea rows={5} maxLength={500} value={draft.description} onChange={(event) => update("description", event.target.value)} /></label>
      <label className="admin-field admin-field--wide"><span>活動記録</span><textarea rows={3} value={(draft.activityRecords ?? []).join("\n")} onChange={(event) => update("activityRecords", parseLineList(event.target.value))} /><small>例：103期 第5話。1行につき1件で入力してください。</small></label>
      <label className="admin-field admin-field--wide"><span>せーはす！放送回</span><textarea rows={3} value={(draft.sehasEpisodes ?? []).join("\n")} onChange={(event) => update("sehasEpisodes", parseLineList(event.target.value))} /><small>例：103期 #28。1行につき1件で入力してください。</small></label>
      <label className="admin-field admin-field--wide"><span>With×MEETS配信回</span><textarea rows={3} value={(draft.withMeetsEpisodes ?? []).join("\n")} onChange={(event) => update("withMeetsEpisodes", parseLineList(event.target.value))} /><small>例：103期 2023/7/24『蓮ノ空1年生の会！』。1行につき1件で入力してください。</small></label>
      <label className="admin-field admin-field--wide"><span>カード・その他の登場情報</span><textarea rows={4} value={(draft.appearances ?? []).join("\n")} onChange={(event) => update("appearances", parseLineList(event.target.value))} /><small>カード背景などを1行につき1件で入力してください。</small></label>
      <label className="admin-field admin-field--wide"><span>アクセス案内</span><input value={draft.accessNote} maxLength={160} onChange={(event) => update("accessNote", event.target.value)} /></label>
      <label className="admin-field admin-field--wide"><span>場所・公式情報URL</span><input type="url" value={draft.sourceUrl} maxLength={500} onChange={(event) => update("sourceUrl", event.target.value)} /></label>
    </>
  );
}

type SpotEditFormProps = {
  draft: PilgrimageSpot;
  categories: PilgrimageSpot["category"][];
  overrideIds: Set<string>;
  saving: boolean;
  message: string;
  update: UpdateSpot;
  onCoordinates(lat: number, lng: number): void;
  onSave(event: FormEvent): Promise<void>;
  onReset(): Promise<void>;
};

function SpotEditForm(props: SpotEditFormProps): ReactElement {
  return (
    <form className="admin-panel spot-form" onSubmit={props.onSave}>
      <div className="admin-panel__heading">
        <div><span>EDIT</span><h2>{props.draft.name}</h2></div>
        {props.overrideIds.has(props.draft.id) && <small>差分を保存中</small>}
      </div>
      <div className="spot-form__grid">
        <SpotBasicFields draft={props.draft} categories={props.categories} update={props.update}
          onCoordinates={props.onCoordinates} />
        <SpotHoursFields draft={props.draft} update={props.update} />
        <SpotSourceFields draft={props.draft} update={props.update} />
      </div>
      <div className="spot-form__actions">
        <button className="admin-publish" type="submit" disabled={props.saving}>{props.saving ? "保存中…" : "修正を保存する"}<span>→</span></button>
        {props.overrideIds.has(props.draft.id) && <button className="admin-reset" type="button" onClick={props.onReset}>登録時の情報に戻す</button>}
      </div>
      {props.message && <p className="admin-message" role="status">{props.message}</p>}
    </form>
  );
}
function SpotManager(props: SpotManagerProps): ReactElement | null {
  const [selectedId, setSelectedId] = useState(props.spots[0]?.id ?? "");
  const selected = props.spots.find((spot) => spot.id === selectedId) ?? props.spots[0];
  const [draft, setDraft] = useState<PilgrimageSpot>(selected);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const filters = useSpotFilters(props.spots, props.baseSpots);
  if (!draft) return null;

  const actionContext: SpotActionContext = {
    draft, baseSpots: props.baseSpots, setDraft, setSpots: props.setSpots,
    setOverrideIds: props.setOverrideIds, localToken: props.localToken,
    setSaving, setMessage,
  };
  const update: UpdateSpot = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  function selectSpot(spot: PilgrimageSpot): void {
    setSelectedId(spot.id);
    setDraft(spot);
    setMessage("");
  }

  return (
    <section className="spot-editor-layout">
      <SpotSelector spots={props.spots} filters={filters} selectedId={selectedId}
        overrideIds={props.overrideIds} onSelect={selectSpot} />
      <SpotEditForm draft={draft} categories={filters.categories} overrideIds={props.overrideIds}
        saving={saving} message={message} update={update}
        onCoordinates={(lat, lng) => setDraft((current) => ({ ...current, lat, lng }))}
        onSave={(event) => saveSpot(event, actionContext)}
        onReset={() => resetSpot(actionContext)} />
    </section>
  );
}

type CoordinatePickerProps = {
  name: string;
  lat: number;
  lng: number;
  onChange(lat: number, lng: number): void;
};

function coordinateMapStyle(): mapboxgl.StyleSpecification {
  return {
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
  };
}

type CoordinateMapRefs = {
  map: RefObject<mapboxgl.Map | null>;
  marker: RefObject<mapboxgl.Marker | null>;
};

function useCoordinateMap(
  container: RefObject<HTMLDivElement | null>,
  lat: number,
  lng: number,
  onChange: (lat: number, lng: number) => void,
): CoordinateMapRefs {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const initialPositionRef = useRef({ lat, lng });
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!container.current) return;
    const map = new mapboxgl.Map({
      container: container.current, style: coordinateMapStyle(),
      center: [initialPositionRef.current.lng, initialPositionRef.current.lat],
      zoom: 16, attributionControl: true,
    });
    const marker = new mapboxgl.Marker({ color: "#7f6084", draggable: true })
      .setLngLat([initialPositionRef.current.lng, initialPositionRef.current.lat]).addTo(map);
    const applyPosition = (nextLng: number, nextLat: number): void => {
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
      marker.remove(); map.remove(); markerRef.current = null; mapRef.current = null;
    };
  }, [container]);
  return { map: mapRef, marker: markerRef };
}

function useCoordinatePosition(
  refs: CoordinateMapRefs,
  lat: number,
  lng: number,
): void {
  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    refs.marker.current?.setLngLat([lng, lat]);
    refs.map.current?.easeTo({ center: [lng, lat], duration: 280 });
  }, [lat, lng, refs.map, refs.marker]);
}
function AdminCoordinatePicker({
  name, lat, lng, onChange,
}: CoordinatePickerProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRefs = useCoordinateMap(containerRef, lat, lng, onChange);
  useCoordinatePosition(mapRefs, lat, lng);
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
