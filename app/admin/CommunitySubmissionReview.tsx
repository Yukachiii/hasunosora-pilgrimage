"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { PilgrimageSpot, SpotCategory } from "@/app/spots";

export type AdminCommunitySubmission = {
  id: string;
  kind: "photo" | "spot";
  status: "pending" | "approved" | "rejected" | "imported";
  payload: Record<string, unknown>;
  creditName: string | null;
  imageKey: string | null;
  imageMime: string | null;
  imageSize: number | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
};

type ImportResponse = {
  submission?: AdminCommunitySubmission;
  spot?: PilgrimageSpot;
  asset?: {
    id: string;
    originalName: string;
    placement: string;
    spotId: string | null;
    createdAt: string;
    imageUrl: string;
    creditName?: string;
    source?: string;
    submissionId?: string;
  };
  error?: string;
};

type Props = {
  initialSubmissions: AdminCommunitySubmission[];
  spots: PilgrimageSpot[];
  localToken: string;
  onSpotImported?(spot: PilgrimageSpot): void;
  onAssetImported?(asset: NonNullable<ImportResponse["asset"]>): void;
  onPendingCountChange?(count: number): void;
};

const categories: SpotCategory[] = [
  "交通",
  "まち歩き",
  "眺望",
  "宿泊",
  "甘味",
  "海辺",
  "文化",
  "飲食",
  "買い物",
  "レジャー",
  "寺社",
];

const statusLabels: Record<AdminCommunitySubmission["status"], string> = {
  pending: "未確認",
  approved: "承認済み",
  rejected: "却下",
  imported: "取込済み",
};

function payloadText(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function payloadNumber(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function suggestedSpotId(name: string) {
  const romanized = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return romanized || `community-spot-${Date.now().toString(36)}`;
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function CommunitySubmissionReview({
  initialSubmissions,
  spots,
  localToken,
  onSpotImported,
  onAssetImported,
  onPendingCountChange,
}: Props) {
  const initialSelected = initialSubmissions.find(
    (submission) => submission.status === "pending",
  ) ?? initialSubmissions[0] ?? null;
  const [submissions, setSubmissions] = useState(initialSubmissions);
  const [selectedId, setSelectedId] = useState(initialSelected?.id ?? "");
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [reviewNote, setReviewNote] = useState(initialSelected?.reviewNote ?? "");

  const visibleSubmissions = useMemo(
    () => submissions.filter((submission) => filter === "all" || submission.status === "pending"),
    [filter, submissions],
  );
  const selected = visibleSubmissions.find((submission) => submission.id === selectedId) ??
    visibleSubmissions[0] ??
    null;
  const pendingCount = submissions.filter((submission) => submission.status === "pending").length;
  const selectedPhotoSpotId = selected?.kind === "photo"
    ? payloadText(selected.payload, "spotId")
    : "";
  const selectedPhotoSpotExists = spots.some((spot) => spot.id === selectedPhotoSpotId);

  async function refreshQueue() {
    if (refreshing || busy) return;
    setRefreshing(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/state", { cache: "no-store" });
      const result = await response.json().catch(() => ({})) as {
        submissions?: AdminCommunitySubmission[];
        error?: string;
      };
      if (!response.ok || !Array.isArray(result.submissions)) {
        throw new Error(result.error ?? "投稿一覧を更新できませんでした。");
      }
      setSubmissions(result.submissions);
      onPendingCountChange?.(
        result.submissions.filter((submission) => submission.status === "pending").length,
      );
      const nextVisible = result.submissions.filter(
        (submission) => filter === "all" || submission.status === "pending",
      );
      const nextSelected = nextVisible.find((submission) => submission.id === selectedId) ??
        nextVisible[0] ??
        null;
      setSelectedId(nextSelected?.id ?? "");
      setReviewNote(nextSelected?.reviewNote ?? "");
      setMessage("投稿一覧を更新しました。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "投稿一覧を更新できませんでした。");
    } finally {
      setRefreshing(false);
    }
  }

  function updateSubmission(next: AdminCommunitySubmission) {
    const updated = submissions.map((item) => item.id === next.id ? next : item);
    setSubmissions(updated);
    onPendingCountChange?.(updated.filter((item) => item.status === "pending").length);
    const nextVisible = updated.filter(
      (submission) => filter === "all" || submission.status === "pending",
    );
    const nextSelected = nextVisible.find((submission) => submission.id === selectedId) ??
      nextVisible[0] ??
      null;
    setSelectedId(nextSelected?.id ?? "");
    setReviewNote(nextSelected?.reviewNote ?? "");
  }

  function changeFilter(nextFilter: "pending" | "all") {
    const nextVisible = submissions.filter(
      (submission) => nextFilter === "all" || submission.status === "pending",
    );
    const nextSelected = nextVisible.find((submission) => submission.id === selectedId) ??
      nextVisible[0] ??
      null;
    setFilter(nextFilter);
    setSelectedId(nextSelected?.id ?? "");
    setReviewNote(nextSelected?.reviewNote ?? "");
    setMessage("");
  }

  async function rejectSubmission() {
    if (!selected || selected.status !== "pending" || busy) return;
    if (!window.confirm("この投稿を却下し、公開データへ取り込まない状態にしますか？")) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/submissions/${selected.id}/reject`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-admin-token": localToken,
        },
        body: JSON.stringify({ reviewNote }),
      });
      const result = await response.json().catch(() => ({})) as ImportResponse;
      if (!response.ok || !result.submission) {
        throw new Error(result.error ?? "投稿を却下できませんでした。");
      }
      updateSubmission(result.submission);
      setMessage("投稿を却下しました。公開データは変更していません。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "投稿を却下できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  async function importSubmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || selected.status !== "pending" || busy) return;
    if (!window.confirm(
      "内容を確認済みとして、ローカルの公開候補へ取り込みますか？\nGitHub Pagesへはまだ公開されません。",
    )) return;

    const formData = new FormData(event.currentTarget);
    const body = selected.kind === "photo"
      ? {
          spotId: String(formData.get("spotId") ?? ""),
          reviewNote,
        }
      : {
          reviewNote,
          spot: {
            id: String(formData.get("id") ?? ""),
            name: String(formData.get("name") ?? ""),
            shortName: String(formData.get("shortName") ?? ""),
            area: String(formData.get("area") ?? ""),
            category: String(formData.get("category") ?? ""),
            address: String(formData.get("address") ?? ""),
            lat: Number(formData.get("lat")),
            lng: Number(formData.get("lng")),
            description: String(formData.get("description") ?? ""),
            accessNote: String(formData.get("accessNote") ?? ""),
            sourceUrl: String(formData.get("sourceUrl") ?? ""),
            transitSearchName: String(formData.get("transitSearchName") ?? ""),
            recommendedStayMinutes: Number(formData.get("recommendedStayMinutes")) || 30,
          },
        };

    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/submissions/${selected.id}/import`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-admin-token": localToken,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as ImportResponse;
      if (!response.ok || !result.submission) {
        throw new Error(result.error ?? "投稿を取り込めませんでした。");
      }
      updateSubmission(result.submission);
      if (result.spot) onSpotImported?.(result.spot);
      if (result.asset) onAssetImported?.(result.asset);
      setMessage(
        "ローカルの公開候補へ取り込みました。内容を最終確認してから、上部の公開ボタンを押してください。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "投稿を取り込めませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-workspace community-review">
      <aside className="admin-panel community-review__queue">
        <div className="admin-panel__heading">
          <div><span>PRIVATE QUEUE</span><h2>投稿待ち</h2></div>
          <div className="community-review__heading-actions">
            <small>{pendingCount}件</small>
            <button type="button" disabled={refreshing || busy} onClick={refreshQueue}>
              {refreshing ? "更新中…" : "最新に更新"}
            </button>
          </div>
        </div>
        <div className="community-review__filters" role="group" aria-label="投稿状態">
          <button type="button" className={filter === "pending" ? "is-active" : undefined} onClick={() => changeFilter("pending")}>未確認</button>
          <button type="button" className={filter === "all" ? "is-active" : undefined} onClick={() => changeFilter("all")}>すべて</button>
        </div>
        <div className="community-review__list">
          {visibleSubmissions.map((submission) => (
            <button
              type="button"
              key={submission.id}
              className={submission.id === selected?.id ? "is-active" : undefined}
              onClick={() => {
                setSelectedId(submission.id);
                setReviewNote(submission.reviewNote ?? "");
                setMessage("");
              }}
            >
              <span>{submission.kind === "photo" ? "写真" : "スポット"}</span>
              <strong>
                {submission.kind === "photo"
                  ? spots.find((spot) => spot.id === payloadText(submission.payload, "spotId"))?.name ?? "投稿写真"
                  : payloadText(submission.payload, "name") || "名称未設定"}
              </strong>
              <small>{formatDate(submission.createdAt)}・{statusLabels[submission.status]}</small>
            </button>
          ))}
          {!visibleSubmissions.length ? <p className="empty-note">該当する投稿はありません。</p> : null}
        </div>
      </aside>

      <div className="admin-panel community-review__detail">
        {selected ? (
          <form key={selected.id} onSubmit={importSubmission}>
            <div className="admin-panel__heading">
              <div>
                <span>{selected.kind === "photo" ? "PHOTO REVIEW" : "SPOT REVIEW"}</span>
                <h2>{selected.kind === "photo" ? "写真を確認" : "スポットを確認"}</h2>
              </div>
              <small className={`community-review__status is-${selected.status}`}>{statusLabels[selected.status]}</small>
            </div>

            {selected.imageKey ? (
              <figure className="community-review__image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/admin/submissions/${selected.id}/image`} alt="投稿された確認用写真" />
                <figcaption>掲載名：{selected.creditName || "未入力"}</figcaption>
              </figure>
            ) : null}

            {selected.kind === "photo" ? (
              <>
                <label className="admin-field">
                  <span>取り込み先スポット</span>
                  <select
                    name="spotId"
                    required
                    defaultValue={selectedPhotoSpotExists ? selectedPhotoSpotId : ""}
                  >
                    <option value="" disabled>
                      {selectedPhotoSpotId
                        ? "元のスポットが見つかりません。取り込み先を選択"
                        : "取り込み先を選択"}
                    </option>
                    {spots.map((spot) => <option value={spot.id} key={spot.id}>{spot.name}</option>)}
                  </select>
                </label>
                {payloadText(selected.payload, "comment") ? (
                  <div className="community-review__note"><span>投稿者からの補足</span><p>{payloadText(selected.payload, "comment")}</p></div>
                ) : null}
              </>
            ) : (
              <div className="community-review__spot-form">
                <div className="community-review__form-grid">
                  <label className="admin-field"><span>スポットID</span><input name="id" required pattern="[a-z0-9][a-z0-9-]{0,79}" defaultValue={suggestedSpotId(payloadText(selected.payload, "name"))} /></label>
                  <label className="admin-field"><span>名称</span><input name="name" required defaultValue={payloadText(selected.payload, "name")} /></label>
                  <label className="admin-field"><span>短縮名</span><input name="shortName" required defaultValue={payloadText(selected.payload, "shortName") || payloadText(selected.payload, "name")} /></label>
                  <label className="admin-field"><span>エリア</span><input name="area" required defaultValue={payloadText(selected.payload, "area")} /></label>
                  <label className="admin-field"><span>カテゴリ</span><select name="category" required defaultValue={payloadText(selected.payload, "category") || "まち歩き"}>{categories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
                  <label className="admin-field"><span>推奨滞在時間（分）</span><input name="recommendedStayMinutes" type="number" min="0" max="480" required defaultValue="30" /></label>
                </div>
                <label className="admin-field"><span>住所</span><input name="address" required defaultValue={payloadText(selected.payload, "address")} /></label>
                <div className="community-review__form-grid">
                  <label className="admin-field"><span>緯度</span><input name="lat" type="number" min="-90" max="90" step="any" required defaultValue={payloadNumber(selected.payload, "lat")} /></label>
                  <label className="admin-field"><span>経度</span><input name="lng" type="number" min="-180" max="180" step="any" required defaultValue={payloadNumber(selected.payload, "lng")} /></label>
                </div>
                <label className="admin-field"><span>説明</span><textarea name="description" required rows={4} defaultValue={payloadText(selected.payload, "description") || "訪問前に最新の施設情報と撮影・見学ルールを確認しましょう。"} /></label>
                <label className="admin-field"><span>アクセス案内</span><input name="accessNote" required defaultValue={payloadText(selected.payload, "accessNote") || "訪問前に交通手段を確認"} /></label>
                <label className="admin-field"><span>経路検索名</span><input name="transitSearchName" required defaultValue={payloadText(selected.payload, "name")} /></label>
                <label className="admin-field"><span>根拠URL</span><input name="sourceUrl" type="url" required defaultValue={payloadText(selected.payload, "sourceUrl")} /></label>
                {payloadText(selected.payload, "comment") ? (
                  <div className="community-review__note"><span>投稿者からの補足</span><p>{payloadText(selected.payload, "comment")}</p></div>
                ) : null}
              </div>
            )}

            <label className="admin-field">
              <span>審査メモ（任意・公開されません）</span>
              <textarea value={reviewNote} maxLength={500} rows={3} onChange={(event) => setReviewNote(event.target.value)} />
            </label>

            <div className="community-review__checks">
              <strong>取り込み前に確認</strong>
              <span>根拠URL・場所・私有地や撮影禁止物・人物や車両番号・写真の権利</span>
              {selected.kind === "spot" ? (
                <a href={payloadText(selected.payload, "sourceUrl")} target="_blank" rel="noreferrer noopener">根拠URLを別タブで確認 ↗</a>
              ) : null}
            </div>

            {message ? <p className="admin-message" role="status">{message}</p> : null}
            <div className="community-review__actions">
              <button type="button" className="community-review__reject" disabled={busy || selected.status !== "pending"} onClick={rejectSubmission}>却下（非公開のまま）</button>
              <button type="submit" className="admin-publish" disabled={busy || selected.status !== "pending"}>{busy ? "処理中…" : "承認して公開候補へ取り込む"}<span>→</span></button>
            </div>
            <p className="privacy-note">この操作だけではGitHub Pagesへ公開されません。取り込み後に内容を確認し、上部の「GitHub Pagesへ公開」を押してください。</p>
          </form>
        ) : (
          <p className="empty-note">左側から確認する投稿を選んでください。</p>
        )}
      </div>
    </section>
  );
}
