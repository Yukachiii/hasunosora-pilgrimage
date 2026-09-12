import {
  useMemo,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactElement,
  type SetStateAction,
} from "react";
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

type ImportedAsset = {
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

type ImportResponse = {
  submission?: AdminCommunitySubmission;
  spot?: PilgrimageSpot;
  asset?: ImportedAsset;
  error?: string;
};

type Props = {
  initialSubmissions: AdminCommunitySubmission[];
  spots: PilgrimageSpot[];
  localToken: string;
  onSpotImported?(spot: PilgrimageSpot): void;
  onAssetImported?(asset: ImportedAsset): void;
  onPendingCountChange?(count: number): void;
};

type SubmissionFilter = "pending" | "all";
type SetState<T> = Dispatch<SetStateAction<T>>;

type SpotImportPayload = {
  id: string;
  name: string;
  shortName: string;
  area: string;
  category: string;
  address: string;
  lat: number;
  lng: number;
  description: string;
  accessNote: string;
  sourceUrl: string;
  transitSearchName: string;
  recommendedStayMinutes: number;
};

type ImportRequestBody =
  | { spotId: string; reviewNote: string }
  | { reviewNote: string; spot: SpotImportPayload };

const categories: SpotCategory[] = [
  "交通", "まち歩き", "眺望", "宿泊", "甘味", "海辺", "文化", "飲食", "買い物", "レジャー", "寺社",
];

const statusLabels: Record<AdminCommunitySubmission["status"], string> = {
  pending: "未確認",
  approved: "承認済み",
  rejected: "却下",
  imported: "取込済み",
};

function payloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function payloadNumber(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function suggestedSpotId(name: string): string {
  const romanized = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return romanized || `community-spot-${Date.now().toString(36)}`;
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("ja-JP", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function visibleSubmissions(
  submissions: AdminCommunitySubmission[],
  filter: SubmissionFilter,
): AdminCommunitySubmission[] {
  return submissions.filter((submission) => filter === "all" || submission.status === "pending");
}

function nextSelectedSubmission(
  submissions: AdminCommunitySubmission[],
  filter: SubmissionFilter,
  selectedId: string,
): AdminCommunitySubmission | null {
  const visible = visibleSubmissions(submissions, filter);
  return visible.find((submission) => submission.id === selectedId) ?? visible[0] ?? null;
}

function pendingSubmissionCount(submissions: AdminCommunitySubmission[]): number {
  return submissions.filter((submission) => submission.status === "pending").length;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function spotImportPayload(formData: FormData): SpotImportPayload {
  return {
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
  };
}

function importRequestBody(
  submission: AdminCommunitySubmission,
  formData: FormData,
  reviewNote: string,
): ImportRequestBody {
  if (submission.kind === "photo") {
    return { spotId: String(formData.get("spotId") ?? ""), reviewNote };
  }
  return { reviewNote, spot: spotImportPayload(formData) };
}

async function postSubmissionAction(
  submissionId: string,
  action: "reject" | "import",
  body: object,
  localToken: string,
  fallback: string,
): Promise<ImportResponse> {
  const response = await fetch(`/api/admin/submissions/${submissionId}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-local-admin-token": localToken,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as ImportResponse;
  if (!response.ok || !result.submission) throw new Error(result.error ?? fallback);
  return result;
}

type SubmissionQueue = {
  submissions: AdminCommunitySubmission[];
  visible: AdminCommunitySubmission[];
  selected: AdminCommunitySubmission | null;
  filter: SubmissionFilter;
  reviewNote: string;
  pendingCount: number;
  setReviewNote: SetState<string>;
  replaceSubmissions(next: AdminCommunitySubmission[]): void;
  updateSubmission(next: AdminCommunitySubmission): void;
  changeFilter(next: SubmissionFilter): void;
  selectSubmission(next: AdminCommunitySubmission): void;
};

function useSubmissionQueue(
  initialSubmissions: AdminCommunitySubmission[],
  onPendingCountChange?: (count: number) => void,
): SubmissionQueue {
  const initialSelected = nextSelectedSubmission(initialSubmissions, "pending", "");
  const [submissions, setSubmissions] = useState(initialSubmissions);
  const [selectedId, setSelectedId] = useState(initialSelected?.id ?? "");
  const [filter, setFilter] = useState<SubmissionFilter>("pending");
  const [reviewNote, setReviewNote] = useState(initialSelected?.reviewNote ?? "");
  const visible = useMemo(() => visibleSubmissions(submissions, filter), [filter, submissions]);
  const selected = visible.find((submission) => submission.id === selectedId) ?? visible[0] ?? null;

  function applySelection(next: AdminCommunitySubmission[], nextFilter: SubmissionFilter): void {
    const nextSelected = nextSelectedSubmission(next, nextFilter, selectedId);
    setSelectedId(nextSelected?.id ?? "");
    setReviewNote(nextSelected?.reviewNote ?? "");
  }
  function replaceSubmissions(next: AdminCommunitySubmission[]): void {
    setSubmissions(next);
    onPendingCountChange?.(pendingSubmissionCount(next));
    applySelection(next, filter);
  }
  function updateSubmission(next: AdminCommunitySubmission): void {
    replaceSubmissions(submissions.map((item) => item.id === next.id ? next : item));
  }
  function changeFilter(next: SubmissionFilter): void {
    applySelection(submissions, next);
    setFilter(next);
  }
  function selectSubmission(next: AdminCommunitySubmission): void {
    setSelectedId(next.id);
    setReviewNote(next.reviewNote ?? "");
  }
  return {
    submissions, visible, selected, filter, reviewNote, setReviewNote,
    pendingCount: pendingSubmissionCount(submissions), replaceSubmissions,
    updateSubmission, changeFilter, selectSubmission,
  };
}

type SubmissionActionContext = {
  queue: SubmissionQueue;
  localToken: string;
  busy: boolean;
  setBusy: SetState<boolean>;
  refreshing: boolean;
  setRefreshing: SetState<boolean>;
  setMessage: SetState<string>;
  onSpotImported?: (spot: PilgrimageSpot) => void;
  onAssetImported?: (asset: ImportedAsset) => void;
};

async function refreshSubmissionQueue(context: SubmissionActionContext): Promise<void> {
  if (context.refreshing || context.busy) return;
  context.setRefreshing(true);
  context.setMessage("");
  try {
    const response = await fetch("/api/admin/state", { cache: "no-store" });
    const result = await response.json().catch(() => ({})) as {
      submissions?: AdminCommunitySubmission[];
      error?: string;
    };
    if (!response.ok || !Array.isArray(result.submissions)) {
      throw new Error(result.error ?? "投稿一覧を更新できませんでした。");
    }
    context.queue.replaceSubmissions(result.submissions);
    context.setMessage("投稿一覧を更新しました。");
  } catch (error) {
    context.setMessage(errorMessage(error, "投稿一覧を更新できませんでした。"));
  } finally {
    context.setRefreshing(false);
  }
}

async function rejectSelectedSubmission(context: SubmissionActionContext): Promise<void> {
  const { selected } = context.queue;
  if (!selected || selected.status !== "pending" || context.busy) return;
  if (!window.confirm("この投稿を却下し、公開データへ取り込まない状態にしますか？")) return;
  context.setBusy(true);
  context.setMessage("");
  try {
    const result = await postSubmissionAction(
      selected.id, "reject", { reviewNote: context.queue.reviewNote },
      context.localToken, "投稿を却下できませんでした。",
    );
    context.queue.updateSubmission(result.submission!);
    context.setMessage("投稿を却下しました。公開データは変更していません。");
  } catch (error) {
    context.setMessage(errorMessage(error, "投稿を却下できませんでした。"));
  } finally {
    context.setBusy(false);
  }
}

async function importSelectedSubmission(
  event: FormEvent<HTMLFormElement>,
  context: SubmissionActionContext,
): Promise<void> {
  event.preventDefault();
  const { selected } = context.queue;
  if (!selected || selected.status !== "pending" || context.busy) return;
  if (!window.confirm(
    "内容を確認済みとして、ローカルの公開候補へ取り込みますか？\nGitHub Pagesへはまだ公開されません。",
  )) return;
  const body = importRequestBody(selected, new FormData(event.currentTarget), context.queue.reviewNote);
  context.setBusy(true);
  context.setMessage("");
  try {
    const result = await postSubmissionAction(
      selected.id, "import", body, context.localToken, "投稿を取り込めませんでした。",
    );
    context.queue.updateSubmission(result.submission!);
    if (result.spot) context.onSpotImported?.(result.spot);
    if (result.asset) context.onAssetImported?.(result.asset);
    context.setMessage(
      "ローカルの公開候補へ取り込みました。内容を最終確認してから、上部の公開ボタンを押してください。",
    );
  } catch (error) {
    context.setMessage(errorMessage(error, "投稿を取り込めませんでした。"));
  } finally {
    context.setBusy(false);
  }
}

type SubmissionActions = {
  busy: boolean;
  refreshing: boolean;
  message: string;
  refreshQueue(): Promise<void>;
  rejectSubmission(): Promise<void>;
  importSubmission(event: FormEvent<HTMLFormElement>): Promise<void>;
  clearMessage(): void;
};

function useSubmissionActions(queue: SubmissionQueue, props: Props): SubmissionActions {
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const context: SubmissionActionContext = {
    queue, busy, setBusy, refreshing, setRefreshing, setMessage,
    localToken: props.localToken,
    onSpotImported: props.onSpotImported,
    onAssetImported: props.onAssetImported,
  };
  return {
    busy,
    refreshing,
    message,
    refreshQueue: () => refreshSubmissionQueue(context),
    rejectSubmission: () => rejectSelectedSubmission(context),
    importSubmission: (event) => importSelectedSubmission(event, context),
    clearMessage: () => setMessage(""),
  };
}

type ReviewQueueProps = {
  queue: SubmissionQueue;
  spots: PilgrimageSpot[];
  busy: boolean;
  refreshing: boolean;
  onRefresh(): Promise<void>;
  onClearMessage(): void;
};

function CommunityReviewQueue({
  queue, spots, busy, refreshing, onRefresh, onClearMessage,
}: ReviewQueueProps): ReactElement {
  return (
    <aside className="admin-panel community-review__queue">
      <div className="admin-panel__heading">
        <div><span>PRIVATE QUEUE</span><h2>投稿待ち</h2></div>
        <div className="community-review__heading-actions">
          <small>{queue.pendingCount}件</small>
          <button type="button" disabled={refreshing || busy} onClick={onRefresh}>
            {refreshing ? "更新中…" : "最新に更新"}
          </button>
        </div>
      </div>
      <div className="community-review__filters" role="group" aria-label="投稿状態">
        <button type="button" className={queue.filter === "pending" ? "is-active" : undefined} onClick={() => { queue.changeFilter("pending"); onClearMessage(); }}>未確認</button>
        <button type="button" className={queue.filter === "all" ? "is-active" : undefined} onClick={() => { queue.changeFilter("all"); onClearMessage(); }}>すべて</button>
      </div>
      <div className="community-review__list">
        {queue.visible.map((submission) => (
          <button type="button" key={submission.id} className={submission.id === queue.selected?.id ? "is-active" : undefined}
            onClick={() => { queue.selectSubmission(submission); onClearMessage(); }}>
            <span>{submission.kind === "photo" ? "写真" : "スポット"}</span>
            <strong>{submission.kind === "photo"
              ? spots.find((spot) => spot.id === payloadText(submission.payload, "spotId"))?.name ?? "投稿写真"
              : payloadText(submission.payload, "name") || "名称未設定"}</strong>
            <small>{formatDate(submission.createdAt)}・{statusLabels[submission.status]}</small>
          </button>
        ))}
        {!queue.visible.length ? <p className="empty-note">該当する投稿はありません。</p> : null}
      </div>
    </aside>
  );
}

function PhotoReviewFields({
  submission, spots,
}: { submission: AdminCommunitySubmission; spots: PilgrimageSpot[] }): ReactElement {
  const spotId = payloadText(submission.payload, "spotId");
  const spotExists = spots.some((spot) => spot.id === spotId);
  const comment = payloadText(submission.payload, "comment");
  return (
    <>
      <label className="admin-field">
        <span>取り込み先スポット</span>
        <select name="spotId" required defaultValue={spotExists ? spotId : ""}>
          <option value="" disabled>{spotId
            ? "元のスポットが見つかりません。取り込み先を選択"
            : "取り込み先を選択"}</option>
          {spots.map((spot) => <option value={spot.id} key={spot.id}>{spot.name}</option>)}
        </select>
      </label>
      {comment ? <div className="community-review__note"><span>投稿者からの補足</span><p>{comment}</p></div> : null}
    </>
  );
}

function SpotReviewFields({ submission }: { submission: AdminCommunitySubmission }): ReactElement {
  const payload = submission.payload;
  const name = payloadText(payload, "name");
  const comment = payloadText(payload, "comment");
  return (
    <div className="community-review__spot-form">
      <div className="community-review__form-grid">
        <label className="admin-field"><span>スポットID</span><input name="id" required pattern="[a-z0-9][a-z0-9-]{0,79}" defaultValue={suggestedSpotId(name)} /></label>
        <label className="admin-field"><span>名称</span><input name="name" required defaultValue={name} /></label>
        <label className="admin-field"><span>短縮名</span><input name="shortName" required defaultValue={payloadText(payload, "shortName") || name} /></label>
        <label className="admin-field"><span>エリア</span><input name="area" required defaultValue={payloadText(payload, "area")} /></label>
        <label className="admin-field"><span>カテゴリ</span><select name="category" required defaultValue={payloadText(payload, "category") || "まち歩き"}>{categories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
        <label className="admin-field"><span>推奨滞在時間（分）</span><input name="recommendedStayMinutes" type="number" min="0" max="480" required defaultValue="30" /></label>
      </div>
      <label className="admin-field"><span>住所</span><input name="address" required defaultValue={payloadText(payload, "address")} /></label>
      <div className="community-review__form-grid">
        <label className="admin-field"><span>緯度</span><input name="lat" type="number" min="-90" max="90" step="any" required defaultValue={payloadNumber(payload, "lat")} /></label>
        <label className="admin-field"><span>経度</span><input name="lng" type="number" min="-180" max="180" step="any" required defaultValue={payloadNumber(payload, "lng")} /></label>
      </div>
      <label className="admin-field"><span>説明</span><textarea name="description" required rows={4} defaultValue={payloadText(payload, "description") || "訪問前に最新の施設情報と撮影・見学ルールを確認しましょう。"} /></label>
      <label className="admin-field"><span>アクセス案内</span><input name="accessNote" required defaultValue={payloadText(payload, "accessNote") || "訪問前に交通手段を確認"} /></label>
      <label className="admin-field"><span>経路検索名</span><input name="transitSearchName" required defaultValue={name} /></label>
      <label className="admin-field"><span>根拠URL</span><input name="sourceUrl" type="url" required defaultValue={payloadText(payload, "sourceUrl")} /></label>
      {comment ? <div className="community-review__note"><span>投稿者からの補足</span><p>{comment}</p></div> : null}
    </div>
  );
}

function ReviewChecks({ submission }: { submission: AdminCommunitySubmission }): ReactElement {
  return (
    <div className="community-review__checks">
      <strong>取り込み前に確認</strong>
      <span>根拠URL・場所・私有地や撮影禁止物・人物や車両番号・写真の権利</span>
      {submission.kind === "spot" ? (
        <a href={payloadText(submission.payload, "sourceUrl")} target="_blank" rel="noreferrer noopener">根拠URLを別タブで確認 ↗</a>
      ) : null}
    </div>
  );
}

type ReviewFormProps = {
  submission: AdminCommunitySubmission;
  spots: PilgrimageSpot[];
  reviewNote: string;
  setReviewNote: SetState<string>;
  busy: boolean;
  message: string;
  onReject(): Promise<void>;
  onImport(event: FormEvent<HTMLFormElement>): Promise<void>;
};

function CommunityReviewForm(props: ReviewFormProps): ReactElement {
  const { submission, spots, reviewNote, setReviewNote, busy, message, onReject, onImport } = props;
  return (
    <form onSubmit={onImport}>
      <div className="admin-panel__heading">
        <div><span>{submission.kind === "photo" ? "PHOTO REVIEW" : "SPOT REVIEW"}</span><h2>{submission.kind === "photo" ? "写真を確認" : "スポットを確認"}</h2></div>
        <small className={`community-review__status is-${submission.status}`}>{statusLabels[submission.status]}</small>
      </div>
      {submission.imageKey ? (
        <figure className="community-review__image">
          <img src={`/api/admin/submissions/${submission.id}/image`} alt="投稿された確認用写真" />
          <figcaption>掲載名：{submission.creditName?.trim() || "匿名"}</figcaption>
        </figure>
      ) : null}
      {submission.kind === "photo"
        ? <PhotoReviewFields submission={submission} spots={spots} />
        : <SpotReviewFields submission={submission} />}
      <label className="admin-field">
        <span>審査メモ（任意・公開されません）</span>
        <textarea value={reviewNote} maxLength={500} rows={3} onChange={(event) => setReviewNote(event.target.value)} />
      </label>
      <ReviewChecks submission={submission} />
      {message ? <p className="admin-message" role="status">{message}</p> : null}
      <div className="community-review__actions">
        <button type="button" className="community-review__reject" disabled={busy || submission.status !== "pending"} onClick={onReject}>却下（非公開のまま）</button>
        <button type="submit" className="admin-publish" disabled={busy || submission.status !== "pending"}>{busy ? "処理中…" : "承認して公開候補へ取り込む"}<span>→</span></button>
      </div>
      <p className="privacy-note">この操作だけではGitHub Pagesへ公開されません。取り込み後に内容を確認し、上部の「GitHub Pagesへ公開」を押してください。</p>
    </form>
  );
}

function CommunityReviewDetail({
  queue, spots, actions,
}: { queue: SubmissionQueue; spots: PilgrimageSpot[]; actions: SubmissionActions }): ReactElement {
  return (
    <div className="admin-panel community-review__detail">
      {queue.selected ? (
        <CommunityReviewForm key={queue.selected.id} submission={queue.selected} spots={spots}
          reviewNote={queue.reviewNote} setReviewNote={queue.setReviewNote} busy={actions.busy}
          message={actions.message} onReject={actions.rejectSubmission} onImport={actions.importSubmission} />
      ) : (
        <p className="empty-note">左側から確認する投稿を選んでください。</p>
      )}
    </div>
  );
}

export function CommunitySubmissionReview(props: Props): ReactElement {
  const queue = useSubmissionQueue(props.initialSubmissions, props.onPendingCountChange);
  const actions = useSubmissionActions(queue, props);
  return (
    <section className="admin-workspace community-review">
      <CommunityReviewQueue queue={queue} spots={props.spots} busy={actions.busy}
        refreshing={actions.refreshing} onRefresh={actions.refreshQueue}
        onClearMessage={actions.clearMessage} />
      <CommunityReviewDetail queue={queue} spots={props.spots} actions={actions} />
    </section>
  );
}
