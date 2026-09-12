import { gps as readGps } from "exifr/dist/mini.esm.mjs";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type RefObject,
} from "react";
import type {
  CommunitySubmissionKind,
  CommunitySubmissionPayloadByKind,
  PhotoSubmissionPayload,
  SpotSubmissionPayload,
} from "./community-submissions";
import type { PilgrimageSpot } from "./spots";

const CONSENT_VERSION = "2026-09-04";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const AUTOMATIC_SPOT_DISTANCE_LIMIT_M = 500;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type ContributionKind = CommunitySubmissionKind;
type PhotoLocationState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "none" }
  | { state: "found"; spotId: string; spotName: string; distanceM: number }
  | { state: "far"; spotId: string; spotName: string; distanceM: number };
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
  submissionPath?: "/api/submissions" | "/api/ui-test-submissions";
  turnstileSiteKey?: string;
  enabled?: boolean;
  hidden?: boolean;
};

function submissionEndpoint(apiBaseUrl: string, submissionPath: Props["submissionPath"] = "/api/submissions"): string {
  const base = apiBaseUrl.trim();
  if (!base) return submissionPath;
  return `${base.replace(/\/+$/, "")}${submissionPath}`;
}

function optionalNumber(value: FormDataEntryValue | null): number | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function textValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
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

function nearestSpot(lat: number, lng: number, spots: PilgrimageSpot[]): {
  spot: PilgrimageSpot;
  distanceM: number;
} | undefined {
  return spots
    .map((spot) => ({
      spot,
      distanceM: distanceInMeters({ lat, lng }, spot),
    }))
    .sort((left, right) => left.distanceM - right.distanceM)[0];
}

function formatDistance(distanceM: number): string {
  return distanceM < 1_000
    ? `約${Math.max(10, Math.round(distanceM / 10) * 10)}m`
    : `約${(distanceM / 1_000).toFixed(1)}km`;
}

function contributionPayload(
  kind: ContributionKind,
  formData: FormData,
): CommunitySubmissionPayloadByKind[ContributionKind] {
  if (kind === "photo") {
    const payload: PhotoSubmissionPayload = {
      spotId: textValue(formData, "spotId"),
      comment: textValue(formData, "comment"),
    };
    return payload;
  }

  const payload: SpotSubmissionPayload = {
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
  return payload;
}

function submissionBody({
  kind,
  payload,
  creditName,
  turnstileToken,
  startedAt,
  website,
  selectedFile,
}: {
  kind: ContributionKind;
  payload: CommunitySubmissionPayloadByKind[ContributionKind];
  creditName: string;
  turnstileToken: string;
  startedAt: number;
  website: string;
  selectedFile: File | null;
}): FormData {
  const body = new FormData();
  body.set("kind", kind);
  body.set("payload", JSON.stringify(payload));
  body.set("creditName", creditName);
  body.set("consentVersion", CONSENT_VERSION);
  body.set("consentAccepted", "true");
  body.set("turnstileToken", turnstileToken);
  body.set("startedAt", String(startedAt));
  body.set("website", website);
  if (selectedFile) body.set("image", selectedFile, selectedFile.name);
  return body;
}

async function sendContribution(
  apiBaseUrl: string,
  submissionPath: Props["submissionPath"],
  body: FormData,
): Promise<SubmissionResponse> {
  const response = await fetch(submissionEndpoint(apiBaseUrl, submissionPath), {
    method: "POST",
    body,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const result = await response.json().catch(() => ({})) as SubmissionResponse;
  if (!response.ok || !result.submission) {
    throw new Error(result.error ?? "投稿を受け付けられませんでした。少し待ってから再度お試しください。");
  }
  return result;
}

function validateImage(file: File | null, required: boolean): void {
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

function validateSubmission(
  formData: FormData,
  selectedFile: File | null,
  kind: ContributionKind,
  turnstileSiteKey: string,
  turnstileToken: string,
): void {
  validateImage(selectedFile, kind === "photo");
  if (turnstileSiteKey.trim() && !turnstileToken) {
    throw new Error("「私は人間です」の確認を完了してください。");
  }
  if (formData.get("consent") !== "accepted") {
    throw new Error("投稿内容と写真の掲載条件を確認してください。");
  }
}

async function detectPhotoLocation(
  file: File,
  spots: PilgrimageSpot[],
): Promise<PhotoLocationState> {
  try {
    const gps = await readGps(file);
    if (!gps || !Number.isFinite(gps.latitude) || !Number.isFinite(gps.longitude)) {
      return { state: "none" };
    }
    const nearest = nearestSpot(gps.latitude, gps.longitude, spots);
    if (!nearest) return { state: "none" };
    return {
      state: nearest.distanceM <= AUTOMATIC_SPOT_DISTANCE_LIMIT_M ? "found" : "far",
      spotId: nearest.spot.id,
      spotName: nearest.spot.name,
      distanceM: nearest.distanceM,
    };
  } catch {
    return { state: "none" };
  }
}

type PhotoSelection = {
  selectedFile: File | null;
  photoSpotId: string;
  photoLocation: PhotoLocationState;
  selectImage: (file: File | null, detectSpot: boolean) => Promise<void>;
  selectSpot: (spotId: string) => void;
  reset: () => void;
};

function usePhotoSelection(spots: PilgrimageSpot[]): PhotoSelection {
  const sequenceRef = useRef(0);
  const manuallySelectedRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [photoSpotId, setPhotoSpotId] = useState("");
  const [photoLocation, setPhotoLocation] = useState<PhotoLocationState>({ state: "idle" });

  const reset = useCallback(() => {
    setSelectedFile(null);
    setPhotoSpotId("");
    setPhotoLocation({ state: "idle" });
    manuallySelectedRef.current = false;
    sequenceRef.current += 1;
  }, []);
  const selectSpot = useCallback((spotId: string) => {
    manuallySelectedRef.current = true;
    setPhotoSpotId(spotId);
  }, []);
  const selectImage = useCallback(async (file: File | null, shouldDetectSpot: boolean) => {
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    setSelectedFile(file);
    if (!file || !shouldDetectSpot) return setPhotoLocation({ state: "idle" });
    setPhotoLocation({ state: "loading" });
    const location = await detectPhotoLocation(file, spots);
    if (sequenceRef.current !== sequence) return;
    if (location.state === "found" && !manuallySelectedRef.current) setPhotoSpotId(location.spotId);
    setPhotoLocation(location);
  }, [spots]);

  return { selectedFile, photoSpotId, photoLocation, selectImage, selectSpot, reset };
}

function ensureTurnstileScript(): HTMLScriptElement {
  const scriptId = "community-turnstile-script";
  const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
  if (existing) return existing;
  const script = document.createElement("script");
  script.id = scriptId;
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
  return script;
}

type TurnstileState = {
  containerRef: RefObject<HTMLDivElement | null>;
  token: string;
  reset: () => void;
};

function renderTurnstileWidget(
  container: HTMLElement,
  siteKey: string,
  setToken: (token: string) => void,
  setError: (message: string) => void,
): string | null {
  if (!window.turnstile) return null;
  return window.turnstile.render(container, {
    sitekey: siteKey,
    theme: "light",
    language: "ja",
    action: "community_submission",
    callback: setToken,
    "expired-callback": () => setToken(""),
    "error-callback": () => {
      setToken("");
      setError("ただいま投稿前の確認ができません。少し待ってから、もう一度お試しください。");
    },
  });
}

function useTurnstile({
  enabled,
  hidden,
  siteKey,
  setError,
}: {
  enabled: boolean;
  hidden: boolean;
  siteKey: string;
  setError: (message: string) => void;
}): TurnstileState {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [token, setToken] = useState("");
  const reset = useCallback(() => {
    if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
    setToken("");
  }, []);

  useEffect(() => {
    const normalizedSiteKey = siteKey.trim();
    if (!enabled || hidden || !normalizedSiteKey || !containerRef.current) return;
    const renderWidget = () => {
      if (!window.turnstile || !containerRef.current || widgetIdRef.current) return;
      widgetIdRef.current = renderTurnstileWidget(containerRef.current, normalizedSiteKey, setToken, setError);
    };
    let script = document.getElementById("community-turnstile-script") as HTMLScriptElement | null;
    if (window.turnstile) renderWidget();
    else {
      script = script ?? ensureTurnstileScript();
      script.addEventListener("load", renderWidget);
    }
    return () => {
      script?.removeEventListener("load", renderWidget);
      if (!widgetIdRef.current) return;
      window.turnstile?.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [enabled, hidden, setError, siteKey]);

  return { containerRef, token, reset };
}

type SubmissionState = {
  startedAt: number;
  setStartedAt: (value: number) => void;
  submitting: boolean;
  setSubmitting: (value: boolean) => void;
  message: string;
  setMessage: (value: string) => void;
  error: string;
  setError: (value: string) => void;
};

function useSubmissionState(): SubmissionState {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return {
    startedAt,
    setStartedAt,
    submitting,
    setSubmitting,
    message,
    setMessage,
    error,
    setError,
  };
}

type SubmitContributionOptions = {
  enabled: boolean;
  kind: ContributionKind;
  apiBaseUrl: string;
  submissionPath: Props["submissionPath"];
  turnstileSiteKey: string;
  turnstileToken: string;
  resetTurnstile: () => void;
  photo: PhotoSelection;
  formRef: RefObject<HTMLFormElement | null>;
  status: SubmissionState;
};

function useSubmitContribution({
  enabled,
  kind,
  apiBaseUrl,
  submissionPath,
  turnstileSiteKey,
  turnstileToken,
  resetTurnstile,
  photo,
  formRef,
  status,
}: SubmitContributionOptions): (event: FormEvent<HTMLFormElement>) => Promise<void> {
  return useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || status.submitting) return;
    status.setError("");
    status.setMessage("");
    const formData = new FormData(event.currentTarget);
    let requestStarted = false;
    try {
      validateSubmission(formData, photo.selectedFile, kind, turnstileSiteKey, turnstileToken);
      const body = submissionBody({
        kind,
        payload: contributionPayload(kind, formData),
        creditName: textValue(formData, "creditName"),
        turnstileToken,
        startedAt: status.startedAt,
        website: textValue(formData, "website"),
        selectedFile: photo.selectedFile,
      });
      status.setSubmitting(true);
      requestStarted = true;
      const result = await sendContribution(apiBaseUrl, submissionPath, body);
      formRef.current?.reset();
      photo.reset();
      status.setStartedAt(Date.now());
      status.setMessage(`投稿を受け付けました。受付番号：${result.submission!.id}`);
      resetTurnstile();
    } catch (submissionError) {
      if (requestStarted) resetTurnstile();
      status.setError(submissionError instanceof Error
        ? submissionError.message
        : "うまく送信できませんでした。もう一度お試しください。");
    } finally {
      status.setSubmitting(false);
    }
  }, [apiBaseUrl, enabled, formRef, kind, photo, resetTurnstile, status, submissionPath, turnstileSiteKey, turnstileToken]);
}

function ContributionHeader({ panelId }: { panelId: string }): ReactElement {
  return (
    <header className="community-contribution__heading">
      <div><span>CONTRIBUTE</span><h2 id={`${panelId}-title`}>写真・スポットを送る</h2></div>
      <p>いただいた内容は、運営者が確認してから掲載します。</p>
    </header>
  );
}

function ContributionTabs({ panelId, kind, onSelect }: {
  panelId: string;
  kind: ContributionKind;
  onSelect: (kind: ContributionKind) => void;
}): ReactElement {
  return (
    <div className="community-contribution__tabs" role="tablist" aria-label="情報提供の種類">
      {(["photo", "spot"] as const).map((tabKind) => (
        <button
          type="button"
          role="tab"
          key={tabKind}
          aria-selected={kind === tabKind}
          aria-controls={`${panelId}-form`}
          className={kind === tabKind ? "is-active" : undefined}
          onClick={() => onSelect(tabKind)}
        >
          {tabKind === "photo" ? "写真を投稿" : "スポットを提案"}
        </button>
      ))}
    </div>
  );
}

function FilePicker({ file, required, onChange }: {
  file: File | null;
  required?: boolean;
  onChange: (file: File | null) => void;
}): ReactElement {
  return (
    <label className="community-contribution__file-picker">
      <input
        name="image"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        required={required}
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
      <b>写真を選ぶ</b>
      <em>{file?.name ?? "選択されていません"}</em>
    </label>
  );
}

function PhotoLocationNote({ location, selectedSpotId }: {
  location: PhotoLocationState;
  selectedSpotId: string;
}): ReactElement | null {
  if (location.state === "idle") return null;
  if (location.state === "loading") {
    return <small className="community-contribution__location-note">写真の位置情報を確認しています…</small>;
  }
  if (location.state === "none") {
    return <small className="community-contribution__location-note">位置情報がない写真です。スポットを手動で選択してください。</small>;
  }
  if (location.state === "far") {
    return <small className="community-contribution__location-note" role="status">最寄り候補は「{location.spotName}」ですが{formatDistance(location.distanceM)}離れているため、スポットは自動選択していません。</small>;
  }
  if (selectedSpotId !== location.spotId) {
    return <small className="community-contribution__location-note" role="status">位置情報の候補は「{location.spotName}」（{formatDistance(location.distanceM)}）です。現在の選択は変更していません。</small>;
  }
  return <small className="community-contribution__location-note is-found" role="status">位置情報から「{location.spotName}」を選びました（{formatDistance(location.distanceM)}）。違う場合は変更してください。</small>;
}

function PhotoFields({ spots, photo }: { spots: PilgrimageSpot[]; photo: PhotoSelection }): ReactElement {
  return (
    <>
      <label>
        <span>撮影したスポット</span>
        <select name="spotId" required value={photo.photoSpotId} onChange={(event) => photo.selectSpot(event.target.value)}>
          <option value="" disabled>スポットを選択</option>
          {spots.map((spot) => <option value={spot.id} key={spot.id}>{spot.name}</option>)}
        </select>
      </label>
      <div className="community-contribution__file-field">
        <span>写真</span>
        <FilePicker file={photo.selectedFile} required onChange={(file) => void photo.selectImage(file, true)} />
        <small>JPEG・PNG・WebP、15MBまで。写真は受付時に位置情報を取り除き、公開用に変換します。</small>
        <PhotoLocationNote location={photo.photoLocation} selectedSpotId={photo.photoSpotId} />
      </div>
    </>
  );
}

function SpotIdentityFields(): ReactElement {
  return (
    <>
      <div className="community-contribution__grid">
        <label><span>スポット名</span><input name="name" type="text" maxLength={100} required /></label>
        <label><span>短い名称（任意）</span><input name="shortName" type="text" maxLength={60} /></label>
      </div>
      <label><span>住所</span><input name="address" type="text" maxLength={160} required /></label>
    </>
  );
}

function SpotLocationFields({ panelId, areas, categories }: {
  panelId: string;
  areas: string[];
  categories: string[];
}): ReactElement {
  return (
    <>
      <div className="community-contribution__grid">
        <label>
          <span>エリア（任意）</span>
          <input name="area" type="text" maxLength={40} list={`${panelId}-areas`} />
          <datalist id={`${panelId}-areas`}>{areas.map((area) => <option value={area} key={area} />)}</datalist>
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
        <label><span>緯度（任意）</span><input name="lat" type="number" min={-90} max={90} step="any" inputMode="decimal" /></label>
        <label><span>経度（任意）</span><input name="lng" type="number" min={-180} max={180} step="any" inputMode="decimal" /></label>
      </div>
    </>
  );
}

function SpotDetailFields(): ReactElement {
  return (
    <>
      <label><span>参考URL</span><input name="sourceUrl" type="url" maxLength={500} placeholder="施設の公式サイトや、作品との関係が分かるページ" required /></label>
      <label><span>スポットの説明（任意）</span><textarea name="description" maxLength={500} rows={3} /></label>
      <label><span>アクセスの補足（任意）</span><input name="accessNote" type="text" maxLength={160} /></label>
    </>
  );
}

function SpotFields({ panelId, areas, categories, photo }: {
  panelId: string;
  areas: string[];
  categories: string[];
  photo: PhotoSelection;
}): ReactElement {
  return (
    <>
      <SpotIdentityFields />
      <SpotLocationFields panelId={panelId} areas={areas} categories={categories} />
      <SpotDetailFields />
      <div className="community-contribution__file-field">
        <span>参考写真（任意）</span>
        <FilePicker file={photo.selectedFile} onChange={(file) => void photo.selectImage(file, false)} />
        <small>場所が分かる写真を添付できます。確認が終わるまでは公開されません。</small>
      </div>
    </>
  );
}

function SharedContributionFields({ kind, selectedFile }: {
  kind: ContributionKind;
  selectedFile: File | null;
}): ReactElement {
  const consentText = selectedFile || kind === "photo"
    ? "自分で撮影した写真、または掲載許可を得た写真です。人物・ナンバープレート・私有地・撮影禁止のものが写っていないことを確認し、本サイトへの掲載と、掲載に必要な編集に同意します。"
    : "内容に間違いがなく、公開して問題のない情報です。本サイトへの掲載と、掲載に必要な編集に同意します。";
  return (
    <>
      <label><span>写真のクレジット名（任意・未入力は匿名）</span><input name="creditName" type="text" maxLength={60} placeholder="例：Yukachiii" /></label>
      <label><span>補足（任意）</span><textarea name="comment" maxLength={500} rows={3} placeholder="登場した回、撮影位置、注意点など" /></label>
      <label className="community-contribution__consent">
        <input name="consent" type="checkbox" value="accepted" required />
        <span>{consentText}</span>
      </label>
    </>
  );
}

type ContributionFormProps = {
  panelId: string;
  kind: ContributionKind;
  spots: PilgrimageSpot[];
  areas: string[];
  categories: string[];
  photo: PhotoSelection;
  turnstileContainerRef: RefObject<HTMLDivElement | null>;
  turnstileSiteKey: string;
  status: SubmissionState;
  formRef: RefObject<HTMLFormElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
};

function ContributionForm(props: ContributionFormProps): ReactElement {
  const { panelId, kind, spots, areas, categories, photo, turnstileContainerRef, turnstileSiteKey, status, formRef, onSubmit } = props;
  return (
    <form ref={formRef} id={`${panelId}-form`} className="community-contribution__form" onSubmit={onSubmit}>
      <label className="community-contribution__honeypot" aria-hidden="true">
        ウェブサイト<input name="website" type="text" tabIndex={-1} autoComplete="off" />
      </label>
      {kind === "photo"
        ? <PhotoFields spots={spots} photo={photo} />
        : <SpotFields panelId={panelId} areas={areas} categories={categories} photo={photo} />}
      <SharedContributionFields kind={kind} selectedFile={photo.selectedFile} />
      {turnstileSiteKey.trim() ? <div className="community-contribution__turnstile" ref={turnstileContainerRef} /> : null}
      {status.error ? <p className="community-contribution__message is-error" role="alert">{status.error}</p> : null}
      {status.message ? <p className="community-contribution__message is-success" role="status">{status.message}</p> : null}
      <button className="community-contribution__submit" type="submit" disabled={status.submitting}>
        {status.submitting ? "送信中…" : "送信する"}<span aria-hidden="true">→</span>
      </button>
      <p className="community-contribution__privacy">連絡先は入力・収集しません。掲載しなかった内容は一定期間後に削除します。</p>
    </form>
  );
}

function ContributionPanelBody(props: ContributionFormProps & {
  onSelectKind: (kind: ContributionKind) => void;
}): ReactElement {
  return (
    <div className="community-contribution__body">
      <ContributionTabs panelId={props.panelId} kind={props.kind} onSelect={props.onSelectKind} />
      <ContributionForm {...props} />
    </div>
  );
}

type ContributionController = {
  panelId: string;
  formProps: ContributionFormProps;
  selectKind: (kind: ContributionKind) => void;
};

function useContributionKindSelection({
  kind,
  setKind,
  photo,
  status,
  formRef,
  resetTurnstile,
}: {
  kind: ContributionKind;
  setKind: (kind: ContributionKind) => void;
  photo: PhotoSelection;
  status: SubmissionState;
  formRef: RefObject<HTMLFormElement | null>;
  resetTurnstile: () => void;
}): (kind: ContributionKind) => void {
  return useCallback((nextKind: ContributionKind) => {
    if (status.submitting || nextKind === kind) return;
    setKind(nextKind);
    status.setStartedAt(Date.now());
    photo.reset();
    status.setMessage("");
    status.setError("");
    formRef.current?.reset();
    resetTurnstile();
  }, [formRef, kind, photo, resetTurnstile, setKind, status]);
}

function useContributionController({
  spots,
  apiBaseUrl,
  submissionPath,
  turnstileSiteKey,
  enabled,
  hidden,
}: Required<Props>): ContributionController {
  const panelId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [kind, setKind] = useState<ContributionKind>("photo");
  const photo = usePhotoSelection(spots);
  const status = useSubmissionState();
  const turnstile = useTurnstile({ enabled, hidden, siteKey: turnstileSiteKey, setError: status.setError });
  const onSubmit = useSubmitContribution({
    enabled, kind, apiBaseUrl, submissionPath, turnstileSiteKey,
    turnstileToken: turnstile.token,
    resetTurnstile: turnstile.reset,
    photo, formRef, status,
  });
  const selectKind = useContributionKindSelection({
    kind, setKind, photo, status, formRef, resetTurnstile: turnstile.reset,
  });
  const categories = Array.from(new Set(spots.map((spot) => spot.category)));
  const areas = Array.from(new Set(spots.map((spot) => spot.area)));
  const formProps: ContributionFormProps = {
    panelId, kind, spots, areas, categories, photo,
    turnstileContainerRef: turnstile.containerRef,
    turnstileSiteKey, status, formRef, onSubmit,
  };
  return { panelId, formProps, selectKind };
}

export function CommunityContributionPanel({
  spots,
  apiBaseUrl = "",
  submissionPath = "/api/submissions",
  turnstileSiteKey = "",
  enabled = true,
  hidden = false,
}: Props): ReactElement {
  const { panelId, formProps, selectKind } = useContributionController({
    spots, apiBaseUrl, submissionPath, turnstileSiteKey, enabled, hidden,
  });

  return (
    <section id="community-contribution" className="community-contribution" aria-labelledby={`${panelId}-title`} hidden={hidden} tabIndex={-1}>
      <ContributionHeader panelId={panelId} />
      {!enabled ? (
        <div className="community-contribution__unavailable" role="status">
          <strong>投稿機能は準備中です</strong><p>もう少しお待ちください。</p>
        </div>
      ) : <ContributionPanelBody {...formProps} onSelectKind={selectKind} />}
    </section>
  );
}
