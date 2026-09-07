import { gps as readGps } from "exifr/dist/mini.esm.mjs";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { PilgrimageSpot } from "./spots";

const CONSENT_VERSION = "2026-09-04";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const AUTOMATIC_SPOT_DISTANCE_LIMIT_M = 500;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type ContributionKind = "photo" | "spot";
type PhotoLocationState =
  | { state: "idle" | "loading" | "none" }
  | { state: "found" | "far"; spotId: string; spotName: string; distanceM: number };
type SubmissionResponse = {
  submission?: {
    id: string;
    kind: ContributionKind;
    status: "pending";
    createdAt: string;
  };
  error?: string;
};

type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      theme: "light";
      language: "ja";
      action: "community_submission";
      callback(token: string): void;
      "expired-callback"(): void;
      "error-callback"(): void;
    },
  ): string;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

type Props = {
  spots: PilgrimageSpot[];
  apiBaseUrl?: string;
  turnstileSiteKey?: string;
  enabled?: boolean;
  hidden?: boolean;
};

function submissionEndpoint(apiBaseUrl: string) {
  const base = apiBaseUrl.trim();
  if (!base) return "/api/submissions";
  return `${base.replace(/\/+$/, "")}/api/submissions`;
}

function optionalNumber(value: FormDataEntryValue | null) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function textValue(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

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
    .sort((left, right) => left.distanceM - right.distanceM)[0];
}

function formatDistance(distanceM: number) {
  return distanceM < 1_000
    ? `約${Math.max(10, Math.round(distanceM / 10) * 10)}m`
    : `約${(distanceM / 1_000).toFixed(1)}km`;
}

export function CommunityContributionPanel({
  spots,
  apiBaseUrl = "",
  turnstileSiteKey = "",
  enabled = true,
  hidden = false,
}: Props) {
  const panelId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const imageSelectionSequenceRef = useRef(0);
  const photoSpotManuallySelectedRef = useRef(false);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);
  const [kind, setKind] = useState<ContributionKind>("photo");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [photoSpotId, setPhotoSpotId] = useState("");
  const [photoLocation, setPhotoLocation] = useState<PhotoLocationState>({ state: "idle" });
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [turnstileToken, setTurnstileToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const siteKey = turnstileSiteKey.trim();
    const container = turnstileContainerRef.current;
    if (!enabled || hidden || !siteKey || !container) return;

    function renderWidget() {
      if (!window.turnstile || !turnstileContainerRef.current || turnstileWidgetIdRef.current) return;
      turnstileWidgetIdRef.current = window.turnstile.render(turnstileContainerRef.current, {
        sitekey: siteKey,
        theme: "light",
        language: "ja",
        action: "community_submission",
        callback: (token) => setTurnstileToken(token),
        "expired-callback": () => setTurnstileToken(""),
        "error-callback": () => {
          setTurnstileToken("");
          setError("ただいま投稿前の確認ができません。少し待ってから、もう一度お試しください。");
        },
      });
    }

    const scriptId = "community-turnstile-script";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (window.turnstile) {
      renderWidget();
    } else {
      if (!script) {
        script = document.createElement("script");
        script.id = scriptId;
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", renderWidget);
    }

    return () => {
      script?.removeEventListener("load", renderWidget);
      if (turnstileWidgetIdRef.current) {
        window.turnstile?.remove(turnstileWidgetIdRef.current);
        turnstileWidgetIdRef.current = null;
      }
    };
  }, [enabled, hidden, turnstileSiteKey]);

  function selectKind(nextKind: ContributionKind) {
    if (submitting || nextKind === kind) return;
    setKind(nextKind);
    setStartedAt(Date.now());
    setSelectedFile(null);
    setPhotoSpotId("");
    setPhotoLocation({ state: "idle" });
    photoSpotManuallySelectedRef.current = false;
    imageSelectionSequenceRef.current += 1;
    setMessage("");
    setError("");
    formRef.current?.reset();
    if (turnstileWidgetIdRef.current) {
      window.turnstile?.reset(turnstileWidgetIdRef.current);
    }
    setTurnstileToken("");
  }

  async function selectImage(file: File | null, detectSpot: boolean) {
    const sequence = imageSelectionSequenceRef.current + 1;
    imageSelectionSequenceRef.current = sequence;
    setSelectedFile(file);
    if (!file || !detectSpot) {
      setPhotoLocation({ state: "idle" });
      return;
    }

    setPhotoLocation({ state: "loading" });
    try {
      const gps = await readGps(file);
      if (imageSelectionSequenceRef.current !== sequence) return;
      if (!gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) {
        setPhotoLocation({ state: "none" });
        return;
      }
      const nearest = nearestSpot(gps.latitude, gps.longitude, spots);
      if (!nearest) {
        setPhotoLocation({ state: "none" });
        return;
      }
      if (nearest.distanceM <= AUTOMATIC_SPOT_DISTANCE_LIMIT_M) {
        if (!photoSpotManuallySelectedRef.current) setPhotoSpotId(nearest.spot.id);
        setPhotoLocation({
          state: "found",
          spotId: nearest.spot.id,
          spotName: nearest.spot.name,
          distanceM: nearest.distanceM,
        });
      } else {
        setPhotoLocation({
          state: "far",
          spotId: nearest.spot.id,
          spotName: nearest.spot.name,
          distanceM: nearest.distanceM,
        });
      }
    } catch {
      if (imageSelectionSequenceRef.current === sequence) {
        setPhotoLocation({ state: "none" });
      }
    }
  }

  function validateImage(file: File | null, required: boolean) {
    if (!file) {
      if (required) throw new Error("投稿する写真を選択してください。");
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      throw new Error("JPEG、PNG、WebPの写真を選択してください。");
    }
    if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
      throw new Error("写真は15MB以下にしてください。");
    }
  }

  async function submitContribution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || submitting) return;

    setError("");
    setMessage("");
    const formData = new FormData(event.currentTarget);
    let requestStarted = false;

    try {
      validateImage(selectedFile, kind === "photo");
      if (turnstileSiteKey.trim() && !turnstileToken) {
        throw new Error("「私は人間です」の確認を完了してください。");
      }
      if (formData.get("consent") !== "accepted") {
        throw new Error("投稿内容と写真の掲載条件を確認してください。");
      }

      const creditName = textValue(formData, "creditName");

      const payload = kind === "photo"
        ? {
            spotId: textValue(formData, "spotId"),
            comment: textValue(formData, "comment"),
          }
        : {
            name: textValue(formData, "name"),
            shortName: textValue(formData, "shortName"),
            area: textValue(formData, "area"),
            category: textValue(formData, "category"),
            address: textValue(formData, "address"),
            lat: optionalNumber(formData.get("lat")),
            lng: optionalNumber(formData.get("lng")),
            description: textValue(formData, "description"),
            sourceUrl: textValue(formData, "sourceUrl"),
            accessNote: textValue(formData, "accessNote"),
            comment: textValue(formData, "comment"),
          };

      const body = new FormData();
      body.set("kind", kind);
      body.set("payload", JSON.stringify(payload));
      body.set("creditName", creditName);
      body.set("consentVersion", CONSENT_VERSION);
      body.set("consentAccepted", "true");
      body.set("turnstileToken", turnstileToken);
      body.set("startedAt", String(startedAt));
      body.set("website", textValue(formData, "website"));
      if (selectedFile) body.set("image", selectedFile, selectedFile.name);

      setSubmitting(true);
      requestStarted = true;
      const response = await fetch(submissionEndpoint(apiBaseUrl), {
        method: "POST",
        body,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const result = await response.json().catch(() => ({})) as SubmissionResponse;
      if (!response.ok || !result.submission) {
        throw new Error(result.error ?? "投稿を受け付けられませんでした。少し待ってから再度お試しください。");
      }

      formRef.current?.reset();
      setSelectedFile(null);
      setPhotoSpotId("");
      setPhotoLocation({ state: "idle" });
      photoSpotManuallySelectedRef.current = false;
      imageSelectionSequenceRef.current += 1;
      setStartedAt(Date.now());
      setMessage(`投稿を受け付けました。受付番号：${result.submission.id}`);
      if (turnstileWidgetIdRef.current) {
        window.turnstile?.reset(turnstileWidgetIdRef.current);
      }
      setTurnstileToken("");
    } catch (submissionError) {
      // Turnstile tokens are single-use. The server may consume one before a
      // later image/storage error, so a network attempt always gets a fresh
      // challenge before retrying.
      if (requestStarted && turnstileWidgetIdRef.current) {
        window.turnstile?.reset(turnstileWidgetIdRef.current);
        setTurnstileToken("");
      }
      setError(submissionError instanceof Error ? submissionError.message : "うまく送信できませんでした。もう一度お試しください。");
    } finally {
      setSubmitting(false);
    }
  }

  const categories = Array.from(new Set(spots.map((spot) => spot.category)));
  const areas = Array.from(new Set(spots.map((spot) => spot.area)));

  return (
    <section
      id="community-contribution"
      className="community-contribution"
      aria-labelledby={`${panelId}-title`}
      hidden={hidden}
      tabIndex={-1}
    >
      <header className="community-contribution__heading">
        <div>
          <span>CONTRIBUTE</span>
          <h2 id={`${panelId}-title`}>写真・スポットを送る</h2>
        </div>
        <p>
          いただいた内容は、運営者が確認してから掲載します。
        </p>
      </header>

      {!enabled ? (
        <div className="community-contribution__unavailable" role="status">
          <strong>投稿機能は準備中です</strong>
          <p>もう少しお待ちください。</p>
        </div>
      ) : (
        <div className="community-contribution__body">
          <div className="community-contribution__tabs" role="tablist" aria-label="情報提供の種類">
            <button
              type="button"
              role="tab"
              aria-selected={kind === "photo"}
              aria-controls={`${panelId}-form`}
              className={kind === "photo" ? "is-active" : undefined}
              onClick={() => selectKind("photo")}
            >
              写真を投稿
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={kind === "spot"}
              aria-controls={`${panelId}-form`}
              className={kind === "spot" ? "is-active" : undefined}
              onClick={() => selectKind("spot")}
            >
              スポットを提案
            </button>
          </div>

          <form
            ref={formRef}
            id={`${panelId}-form`}
            className="community-contribution__form"
            onSubmit={submitContribution}
          >
            <label className="community-contribution__honeypot" aria-hidden="true">
              ウェブサイト
              <input name="website" type="text" tabIndex={-1} autoComplete="off" />
            </label>

            {kind === "photo" ? (
              <>
                <label>
                  <span>撮影したスポット</span>
                  <select
                    name="spotId"
                    required
                    value={photoSpotId}
                    onChange={(event) => {
                      photoSpotManuallySelectedRef.current = true;
                      setPhotoSpotId(event.target.value);
                    }}
                  >
                    <option value="" disabled>スポットを選択</option>
                    {spots.map((spot) => <option value={spot.id} key={spot.id}>{spot.name}</option>)}
                  </select>
                </label>
                <div className="community-contribution__file-field">
                  <span>写真</span>
                  <label className="community-contribution__file-picker">
                    <input
                      name="image"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      required
                      onChange={(event) => void selectImage(event.target.files?.[0] ?? null, true)}
                    />
                    <b>写真を選ぶ</b>
                    <em>{selectedFile?.name ?? "選択されていません"}</em>
                  </label>
                  <small>JPEG・PNG・WebP、15MBまで。写真は受付時に位置情報を取り除き、公開用に変換します。</small>
                  {photoLocation.state === "loading" ? (
                    <small className="community-contribution__location-note">写真の位置情報を確認しています…</small>
                  ) : null}
                  {photoLocation.state === "found" && photoSpotId === photoLocation.spotId ? (
                    <small className="community-contribution__location-note is-found" role="status">
                      位置情報から「{photoLocation.spotName}」を選びました（{formatDistance(photoLocation.distanceM)}）。違う場合は変更してください。
                    </small>
                  ) : null}
                  {photoLocation.state === "found" && photoSpotId !== photoLocation.spotId ? (
                    <small className="community-contribution__location-note" role="status">
                      位置情報の候補は「{photoLocation.spotName}」（{formatDistance(photoLocation.distanceM)}）です。現在の選択は変更していません。
                    </small>
                  ) : null}
                  {photoLocation.state === "far" ? (
                    <small className="community-contribution__location-note" role="status">
                      最寄り候補は「{photoLocation.spotName}」ですが{formatDistance(photoLocation.distanceM)}離れているため、スポットは自動選択していません。
                    </small>
                  ) : null}
                  {photoLocation.state === "none" ? (
                    <small className="community-contribution__location-note">位置情報がない写真です。スポットを手動で選択してください。</small>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="community-contribution__grid">
                  <label>
                    <span>スポット名</span>
                    <input name="name" type="text" maxLength={100} required />
                  </label>
                  <label>
                    <span>短い名称（任意）</span>
                    <input name="shortName" type="text" maxLength={60} />
                  </label>
                </div>
                <label>
                  <span>住所</span>
                  <input name="address" type="text" maxLength={160} required />
                </label>
                <div className="community-contribution__grid">
                  <label>
                    <span>エリア（任意）</span>
                    <input name="area" type="text" maxLength={40} list={`${panelId}-areas`} />
                    <datalist id={`${panelId}-areas`}>
                      {areas.map((area) => <option value={area} key={area} />)}
                    </datalist>
                  </label>
                  <label>
                    <span>分類（任意）</span>
                    <select name="category" defaultValue="">
                      <option value="">未選択</option>
                      {categories.map((category) => <option value={category} key={category}>{category}</option>)}
                    </select>
                  </label>
                </div>
                <div className="community-contribution__grid">
                  <label>
                    <span>緯度（任意）</span>
                    <input name="lat" type="number" min={-90} max={90} step="any" inputMode="decimal" />
                  </label>
                  <label>
                    <span>経度（任意）</span>
                    <input name="lng" type="number" min={-180} max={180} step="any" inputMode="decimal" />
                  </label>
                </div>
                <label>
                  <span>参考URL</span>
                  <input name="sourceUrl" type="url" maxLength={500} placeholder="施設の公式サイトや、作品との関係が分かるページ" required />
                </label>
                <label>
                  <span>スポットの説明（任意）</span>
                  <textarea name="description" maxLength={500} rows={3} />
                </label>
                <label>
                  <span>アクセスの補足（任意）</span>
                  <input name="accessNote" type="text" maxLength={160} />
                </label>
                <div className="community-contribution__file-field">
                  <span>参考写真（任意）</span>
                  <label className="community-contribution__file-picker">
                    <input
                      name="image"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(event) => void selectImage(event.target.files?.[0] ?? null, false)}
                    />
                    <b>写真を選ぶ</b>
                    <em>{selectedFile?.name ?? "選択されていません"}</em>
                  </label>
                  <small>場所が分かる写真を添付できます。確認が終わるまでは公開されません。</small>
                </div>
              </>
            )}

            <label>
              <span>写真のクレジット名（任意・未入力は匿名）</span>
              <input name="creditName" type="text" maxLength={60} placeholder="例：Yukachiii" />
            </label>
            <label>
              <span>補足（任意）</span>
              <textarea name="comment" maxLength={500} rows={3} placeholder="登場した回、撮影位置、注意点など" />
            </label>

            <label className="community-contribution__consent">
              <input name="consent" type="checkbox" value="accepted" required />
              <span>
                {selectedFile || kind === "photo"
                  ? "自分で撮影した写真、または掲載許可を得た写真です。人物・ナンバープレート・私有地・撮影禁止のものが写っていないことを確認し、本サイトへの掲載と、掲載に必要な編集に同意します。"
                  : "内容に間違いがなく、公開して問題のない情報です。本サイトへの掲載と、掲載に必要な編集に同意します。"}
              </span>
            </label>

            {turnstileSiteKey.trim() ? (
              <div className="community-contribution__turnstile" ref={turnstileContainerRef} />
            ) : null}
            {error ? <p className="community-contribution__message is-error" role="alert">{error}</p> : null}
            {message ? <p className="community-contribution__message is-success" role="status">{message}</p> : null}

            <button className="community-contribution__submit" type="submit" disabled={submitting}>
              {submitting ? "送信中…" : "送信する"}
              <span aria-hidden="true">→</span>
            </button>
            <p className="community-contribution__privacy">
              連絡先は入力・収集しません。掲載しなかった内容は一定期間後に削除します。
            </p>
          </form>
        </div>
      )}
    </section>
  );
}
