"use client";

import { gps as readGps } from "exifr/dist/mini.esm.mjs";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import type { PilgrimageSpot } from "@/app/spots";

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
}: Props) {
  const [tab, setTab] = useState<"photos" | "spots">("photos");
  const [managedSpots, setManagedSpots] = useState(initialSpots);
  const [overrideIds, setOverrideIds] = useState(new Set(overriddenSpotIds));
  const [assets, setAssets] = useState(initialAssets);
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  const [shuttingDown, setShuttingDown] = useState(false);
  const [serverStopped, setServerStopped] = useState(false);

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
      </nav>

      {tab === "photos" ? (
        <PhotoManager
          spots={managedSpots}
          assets={assets}
          setAssets={setAssets}
          localMode={localMode}
          localToken={localToken}
        />
      ) : (
        <SpotManager
          spots={managedSpots}
          setSpots={setManagedSpots}
          baseSpots={baseSpots}
          overrideIds={overrideIds}
          setOverrideIds={setOverrideIds}
          localMode={localMode}
          localToken={localToken}
        />
      )}
    </main>
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
                  <strong>{placement === "hero" ? "好きな物語と、同じ景色を歩こう。" : currentSpot?.name}</strong>
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
          <label className="admin-field admin-field--wide"><span>説明</span><textarea rows={5} maxLength={500} value={draft.description} onChange={(event) => update("description", event.target.value)} /></label>
          <label className="admin-field admin-field--wide"><span>活動記録</span><textarea rows={3} value={(draft.activityRecords ?? []).join("\n")} onChange={(event) => update("activityRecords", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} /><small>例：103期 第5話。1行につき1件で入力してください。</small></label>
          <label className="admin-field admin-field--wide"><span>せーはす！放送回</span><textarea rows={3} value={(draft.sehasEpisodes ?? []).join("\n")} onChange={(event) => update("sehasEpisodes", event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} /><small>例：103期 #28。1行につき1件で入力してください。</small></label>
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
