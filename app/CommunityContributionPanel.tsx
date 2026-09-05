"use client";

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
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type ContributionKind = "photo" | "spot";
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

export function CommunityContributionPanel({
  spots,
  apiBaseUrl = "",
  turnstileSiteKey = "",
  enabled = true,
}: Props) {
  const panelId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetIdRef = useRef<string | null>(null);
  const [kind, setKind] = useState<ContributionKind>("photo");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [turnstileToken, setTurnstileToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const siteKey = turnstileSiteKey.trim();
    const container = turnstileContainerRef.current;
    if (!enabled || !siteKey || !container) return;

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
          setError("確認機能を読み込めませんでした。通信状態を確認してください。");
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
  }, [enabled, turnstileSiteKey]);

  function selectKind(nextKind: ContributionKind) {
    if (submitting || nextKind === kind) return;
    setKind(nextKind);
    setStartedAt(Date.now());
    setSelectedFile(null);
    setMessage("");
    setError("");
    formRef.current?.reset();
    if (turnstileWidgetIdRef.current) {
      window.turnstile?.reset(turnstileWidgetIdRef.current);
    }
    setTurnstileToken("");
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
      if (selectedFile && !creditName) {
        throw new Error("写真に表示するクレジット名を入力してください。");
      }

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
      setError(submissionError instanceof Error ? submissionError.message : "投稿できませんでした。");
    } finally {
      setSubmitting(false);
    }
  }

  const categories = Array.from(new Set(spots.map((spot) => spot.category)));
  const areas = Array.from(new Set(spots.map((spot) => spot.area)));

  return (
    <section className="community-contribution" aria-labelledby={`${panelId}-title`}>
      <header className="community-contribution__heading">
        <div>
          <span>CONTRIBUTE</span>
          <h2 id={`${panelId}-title`}>写真・スポットの情報提供</h2>
        </div>
        <p>
          送信した内容はすぐには公開されません。運営者が内容、位置、写真の権利を確認し、承認したものだけを掲載します。
        </p>
      </header>

      {!enabled ? (
        <div className="community-contribution__unavailable" role="status">
          <strong>投稿受付は準備中です</strong>
          <p>受付サーバーの準備が整い次第、この画面から送信できるようになります。</p>
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
                  <select name="spotId" required defaultValue="">
                    <option value="" disabled>スポットを選択</option>
                    {spots.map((spot) => <option value={spot.id} key={spot.id}>{spot.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>写真</span>
                  <input
                    name="image"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    required
                    onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                  />
                  <small>JPEG・PNG・WebP、15MBまで。位置情報などのEXIFは受付時に削除します。</small>
                </label>
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
                  <span>確認できるURL</span>
                  <input name="sourceUrl" type="url" maxLength={500} placeholder="施設公式サイトや作品との関連が確認できるページ" required />
                </label>
                <label>
                  <span>スポットの説明（任意）</span>
                  <textarea name="description" maxLength={500} rows={3} />
                </label>
                <label>
                  <span>アクセスの補足（任意）</span>
                  <input name="accessNote" type="text" maxLength={160} />
                </label>
                <label>
                  <span>参考写真（任意）</span>
                  <input
                    name="image"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                  />
                  <small>位置が分かる写真を添付できます。画像は承認されるまで公開されません。</small>
                </label>
              </>
            )}

            <label>
              <span>写真のクレジット名{selectedFile ? "（必須）" : "（写真添付時のみ）"}</span>
              <input name="creditName" type="text" maxLength={60} required={Boolean(selectedFile)} placeholder="例：Yukachiii／匿名" />
            </label>
            <label>
              <span>補足（任意）</span>
              <textarea name="comment" maxLength={500} rows={3} placeholder="登場した回、撮影位置、注意点など" />
            </label>

            <label className="community-contribution__consent">
              <input name="consent" type="checkbox" value="accepted" required />
              <span>
                {selectedFile || kind === "photo"
                  ? "自分が撮影した、または掲載許可を得た写真です。人物・車両番号・私有地・撮影禁止物が写っていないことを確認し、運営者による編集と本サイトへの掲載を許可します。"
                  : "入力内容が正確で、公開して差し支えない情報であることを確認し、運営者による編集と本サイトへの掲載を許可します。"}
              </span>
            </label>

            {turnstileSiteKey.trim() ? (
              <div className="community-contribution__turnstile" ref={turnstileContainerRef} />
            ) : null}
            {error ? <p className="community-contribution__message is-error" role="alert">{error}</p> : null}
            {message ? <p className="community-contribution__message is-success" role="status">{message}</p> : null}

            <button className="community-contribution__submit" type="submit" disabled={submitting}>
              {submitting ? "送信中…" : "審査へ送る"}
              <span aria-hidden="true">→</span>
            </button>
            <p className="community-contribution__privacy">
              メールアドレスなどの連絡先は収集しません。却下した投稿と画像は一定期間後に削除します。
            </p>
          </form>
        </div>
      )}
    </section>
  );
}
