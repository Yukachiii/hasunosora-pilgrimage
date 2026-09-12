import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type SetStateAction,
} from "react";
import {
  MapboxPilgrimageMap,
  type RouteRequest,
  type RouteResult,
} from "./MapboxPilgrimageMap";
import {
  formatOpeningHours,
  formatDuration,
  majorStations,
  maximumItineraryStops,
  openingHoursStatus,
  recommendedStayMinutes,
  type TravelMode,
} from "./route-planner";
import {
  parsePlannerDraftCookie,
  PLANNER_DRAFT_COOKIE_KEY,
  sanitizePlannerSnapshot,
  serializePlannerDraftCookie,
  type PlannerAppointment,
  type PlannerDaySnapshot,
  type PlannerSnapshot,
  type TransitLegProgress,
} from "./planner-storage";
import {
  cardCharacters,
  cardModels,
  collaborationById,
  collaborations,
  type CardModelLocation,
  type CollaborationId,
  type CardCharacter,
  type PilgrimageCollaboration,
  type PilgrimageSpot,
} from "./spots";
import {
  buildYahooTransitUrl,
  createYahooTransitLegs,
  type YahooTransitLeg,
} from "./yahoo-transit";
import { reorderIdsForInsertion, sameIdOrder } from "./itinerary-order";
import {
  createPlannerSnapshotFromSharedPlan,
  createSharedPlanSnapshot,
  decodeSharedPlanSnapshot,
  encodeSharedPlanSnapshot,
  type SharedPlanSnapshot,
} from "./planner-share";
import { CommunityContributionPanel } from "./CommunityContributionPanel";

const LEGACY_PLANNER_DRAFT_STORAGE_KEY = "hasunosora-pilgrimage.planner-draft.v1";
const PLANNER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const CARD_MODEL_SPOT_IDS = Array.from(new Set(
  cardModels.flatMap((card) => card.spotId ? [card.spotId] : []),
));
const CARD_MODEL_INDEX_BY_ID = new Map(cardModels.map((card, index) => [card.id, index]));
const GENERIC_SPOT_DESCRIPTION = "活動記録・関連映像・協力クレジットなどから整理した巡礼スポットです。訪問前に最新の施設情報を確認しましょう。";
const GENERIC_ACCESS_NOTE = "訪問前に営業時間・利用案内を確認";
const CARD_ILLUSTRATION_COPYRIGHT = "©︎PL!HS ©︎S ©︎2023 BNML ©︎ODD No.";
const PLANNER_SHARE_MESSAGE = "訪問予定を共有します。\n#蓮ノ旅";

function publicSpotDescription(description: string): string {
  return description === GENERIC_SPOT_DESCRIPTION
    ? ""
    : description;
}

function publicAccessNote(accessNote: string): string {
  if (accessNote === GENERIC_ACCESS_NOTE) return "営業時間などは公式情報へ";
  if (accessNote === "通行や周辺の生活に配慮して訪問") return "周辺への配慮を忘れずに";
  return accessNote;
}

type NavigableAppPage = "explore" | "planner" | "today" | "guide";
type AppPage = NavigableAppPage | "shared";
type ExplorePanel = "spots" | "card-models";
type SpotSourceFilter = "すべて" | "activity-records" | "sehas" | "with-meets";

const appPageLabels: Record<NavigableAppPage, string> = {
  explore: "探す",
  planner: "予定",
  today: "当日",
  guide: "ガイド",
};

function pageFromHash(hash: string): AppPage {
  const page = hash.replace(/^#\/?/, "").split("/")[0];
  return page === "planner" || page === "today" || page === "guide" || page === "shared"
    ? page
    : "explore";
}

function resetWindowScroll(): void {
  const scrollToTop = (): void => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };
  scrollToTop();
  window.requestAnimationFrame(() => {
    scrollToTop();
    window.requestAnimationFrame(scrollToTop);
  });
  window.setTimeout(scrollToTop, 120);
}

const travelModes: Array<{
  value: TravelMode;
  label: string;
  icon: string;
  disabled?: boolean;
}> = [
  { value: "WALKING", label: "徒歩", icon: "歩" },
  { value: "DRIVING", label: "車", icon: "車" },
  { value: "TRANSIT", label: "公共交通", icon: "交" },
  { value: "BICYCLING", label: "自転車", icon: "自" },
];

function japanDate(daysFromToday = 0): string {
  const date = new Date(Date.now() + daysFromToday * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dateAfter(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function createPlannerDay(index: number, visitDate: string): PlannerDaySnapshot {
  return {
    id: `day-${Date.now()}-${index}`,
    visitDate,
    startTime: "09:00",
    endTime: "18:00",
    itineraryIds: [],
    hotelName: "",
    appointments: [],
  };
}

function departureIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 9) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function displayClock(totalMinutes: number): string {
  const day = Math.floor(totalMinutes / 1440);
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${day > 0 ? `翌${day > 1 ? day : ""}日 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function japanClockMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hours = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minutes = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hours * 60 + minutes;
}

function navigationTravelMode(mode: TravelMode): "driving" | "transit" | "bicycling" | "walking" {
  if (mode === "DRIVING") return "driving";
  if (mode === "TRANSIT") return "transit";
  if (mode === "BICYCLING") return "bicycling";
  return "walking";
}

type CollaborationStatus = "開催前" | "開催中" | "終了";

function collaborationStatus(collaboration: PilgrimageCollaboration): CollaborationStatus {
  const today = japanDate();
  if (today < collaboration.startDate) return "開催前";
  if (today > collaboration.endDate) return "終了";
  return "開催中";
}

function formatCollaborationDate(value: string): string {
  return value.replaceAll("-", ".");
}

type SpotCollaborationInfo = {
  collaboration: PilgrimageCollaboration;
  role?: string;
  members?: string[];
};

type ActiveGuideImage = {
  src: string;
  alt: string;
  variant?: "guide" | "card" | "spot";
  credit?: string;
};

type TransitLeg = YahooTransitLeg & { confirmed: boolean };

type MapSearchResult =
  | { kind: "spot"; id: string; spot: PilgrimageSpot; card: null }
  | { kind: "card"; id: string; spot: PilgrimageSpot; card: CardModelLocation };

type RouteSignatureInput = {
  stops: readonly string[];
  stay: readonly number[];
  travelMode: TravelMode;
  optimizeWaypointOrder: boolean;
  accessOriginId: string;
  departureTime: string;
};

type ExploreSheetDragState = {
  pointerId: number;
  startY: number;
  startHeight: number;
  collapsedHeight: number;
  maxHeight: number;
  startedExpanded: boolean;
  dragged: boolean;
};

type StateSetter<T> = Dispatch<SetStateAction<T>>;
type DayRouteCache = Record<string, { request: RouteRequest; result: RouteResult }>;
type MapFocusRequest = { spotId: string; requestId: number };
type MapReturnSection = "explore-menu" | "spots" | "card-models";
type ItineraryDragState = {
  pointerId: number;
  spotId: string;
  originalIds: string[];
  previewIds: string[];
  list: HTMLOListElement;
  overlay: HTMLElement;
  startY: number;
  pointerY: number;
};

function collaborationsForSpot(spot: PilgrimageSpot): SpotCollaborationInfo[] {
  return (spot.collaborationIds ?? []).flatMap((id) => {
    const collaboration = collaborationById(id);
    if (!collaboration) return [];
    const location = collaboration.locations.find((item) => item.spotId === spot.id);
    return [{ collaboration, role: location?.role, members: location?.members }];
  });
}

function normalizedSearchQuery(value: string): string {
  return value.trim().toLocaleLowerCase("ja");
}

function valuesMatchSearchQuery(values: readonly string[], normalizedQuery: string): boolean {
  return values.some((value) => value.toLocaleLowerCase("ja").includes(normalizedQuery));
}

function resolveSpotsByIds(
  ids: readonly string[],
  spotsById: ReadonlyMap<string, PilgrimageSpot>,
): PilgrimageSpot[] {
  return ids.flatMap((id) => {
    const spot = spotsById.get(id);
    return spot ? [spot] : [];
  });
}

function createRouteSignature(input: RouteSignatureInput): string {
  return JSON.stringify({
    stops: input.stops,
    stay: input.stay,
    travelMode: input.travelMode,
    optimizeWaypointOrder: input.optimizeWaypointOrder,
    accessOriginId: input.accessOriginId,
    departureTime: input.departureTime,
  });
}

function exploreSheetPosition(
  drag: ExploreSheetDragState,
  deltaY: number,
): { height: number; translateY: number } {
  if (!drag.startedExpanded) {
    if (deltaY < 0) {
      return {
        height: Math.min(drag.maxHeight, drag.startHeight - deltaY),
        translateY: 0,
      };
    }
    return { height: drag.startHeight, translateY: deltaY };
  }
  if (deltaY <= 0) return { height: drag.startHeight, translateY: 0 };
  const collapsibleDistance = Math.max(0, drag.startHeight - drag.collapsedHeight);
  return {
    height: drag.startHeight - Math.min(deltaY, collapsibleDistance),
    translateY: Math.max(0, deltaY - collapsibleDistance),
  };
}

function restorePageScroll(nextPage: AppPage, sectionId: string): void {
  if (nextPage === "shared") {
    resetWindowScroll();
    return;
  }
  if (!sectionId) {
    resetWindowScroll();
    return;
  }
  if (sectionId === "spots" || sectionId === "card-models") return;
  const section = document.getElementById(sectionId);
  if (sectionId === "community-contribution") section?.focus({ preventScroll: true });
  section?.scrollIntoView({ block: "start" });
}

function schedulePageScroll(nextPage: AppPage, sectionId: string): void {
  window.setTimeout(() => {
    restorePageScroll(nextPage, sectionId);
    if (nextPage === "explore") window.dispatchEvent(new Event("resize"));
  }, 0);
}

type Props = {
  mapboxConfig: {
    accessToken: string;
  };
  spots: PilgrimageSpot[];
  spotPhotoGroups: Record<string, string[]>;
  photoCredits?: Record<string, string>;
  heroImages: string[];
  initialHeroIndex?: number;
  siteVersion: string;
  communityApiUrl?: string;
  turnstileSiteKey?: string;
  communitySubmissionsEnabled?: boolean;
};

type ItinerarySpotRowProps = {
  spot: PilgrimageSpot;
  index: number;
  total: number;
  stayMinutes: number;
  isDragging: boolean;
  removeDisabled: boolean;
  dragDisabled: boolean;
  onFocus: (spotId: string) => void;
  onStayMinutesChange: (spotId: string, minutes: number) => void;
  onRemove: (index: number) => void;
  onDragStart: (event: ReactPointerEvent<HTMLButtonElement>, spotId: string) => void;
  onDragKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, spotId: string) => void;
};

function ItinerarySpotFocus({
  spot,
  index,
  total,
  onFocus,
}: Pick<ItinerarySpotRowProps, "spot" | "index" | "total" | "onFocus">): ReactElement {
  const pointClass = index === 0
    ? "route-point--start"
    : index === total - 1 ? "route-point--goal" : "";
  const pointLabel = index === 0 ? "S" : index === total - 1 ? "G" : index + 1;
  return (
    <button
      type="button"
      className="itinerary-spot-focus"
      onClick={() => onFocus(spot.id)}
      aria-label={`${spot.name}を地図で拡大表示`}
    >
      <span className={`route-point ${pointClass}`}>{pointLabel}</span>
      <span><strong>{spot.shortName}</strong><small>地図で見る</small></span>
    </button>
  );
}

function ItineraryDragHandle({
  spot,
  index,
  dragDisabled,
  onDragStart,
  onDragKeyDown,
}: Pick<ItinerarySpotRowProps, "spot" | "index" | "dragDisabled" | "onDragStart" | "onDragKeyDown">): ReactElement {
  return (
    <button
      type="button"
      className="itinerary-drag-handle"
      disabled={dragDisabled}
      aria-label={`${spot.name}を並べ替え。現在${index + 1}番目`}
      aria-describedby="itinerary-reorder-hint"
      onPointerDown={(event) => onDragStart(event, spot.id)}
      onKeyDown={(event) => onDragKeyDown(event, spot.id)}
    >
      <span aria-hidden="true"><i /><i /><i /></span>
    </button>
  );
}

function ItinerarySpotRow(props: ItinerarySpotRowProps): ReactElement {
  const { spot, index, stayMinutes, isDragging, removeDisabled, onStayMinutesChange, onRemove } = props;
  return (
    <li className={isDragging ? "is-dragging" : undefined} data-itinerary-spot-id={spot.id}>
      <ItinerarySpotFocus {...props} />
      <label>
        <span>滞在</span>
        <input
          type="number"
          min="0"
          max="480"
          step="5"
          value={stayMinutes}
          onChange={(event) => onStayMinutesChange(spot.id, Number(event.target.value))}
        />
        <span>分</span>
      </label>
      <button
        type="button"
        className="itinerary-remove"
        disabled={removeDisabled}
        onClick={() => onRemove(index)}
        aria-label={`${spot.name}を予定から外す`}
      >
        ×
      </button>
      <ItineraryDragHandle {...props} />
    </li>
  );
}

type TransitLegRowProps = {
  leg: TransitLeg;
  index: number;
  visitDate: string;
  onProgressChange: (legId: string, progress: TransitLegProgress[string]) => void;
};

function TransitLegDateTime({ leg, visitDate, onProgressChange }: TransitLegRowProps): ReactElement {
  return (
    <div className="transit-search-panel__datetime">
      <label>
        <span>出発日</span>
        <input
          type="date"
          min={visitDate}
          max={japanDate(100)}
          value={leg.date}
          onChange={(event) => onProgressChange(leg.id, {
            date: event.target.value, time: leg.time, confirmed: false,
          })}
        />
      </label>
      <label>
        <span>出発時刻</span>
        <input
          type="time"
          value={leg.time}
          onChange={(event) => onProgressChange(leg.id, {
            date: leg.date, time: event.target.value, confirmed: false,
          })}
        />
      </label>
    </div>
  );
}

function TransitLegConfirmation({ leg, onProgressChange }: TransitLegRowProps): ReactElement {
  return (
    <label className="transit-search-panel__confirmed">
      <input
        type="checkbox"
        checked={leg.confirmed}
        onChange={(event) => onProgressChange(leg.id, {
          date: leg.date, time: leg.time, confirmed: event.target.checked,
        })}
      />
      <span>
        <strong>{leg.confirmed ? "確認済み" : "Yahoo!の検索結果を確認する"}</strong>
        <small>{leg.confirmed ? "この区間の時刻を確認しました" : "結果を見たあとにチェックしてください"}</small>
      </span>
    </label>
  );
}

function TransitLegRow(props: TransitLegRowProps): ReactElement {
  const { leg, index } = props;
  return (
    <li className={leg.confirmed ? "is-confirmed" : undefined}>
      <div className="transit-search-panel__route">
        <span>{String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong>{leg.fromLabel} → {leg.toLabel}</strong>
          <small>検索名：{leg.from} → {leg.to}</small>
        </div>
      </div>
      <TransitLegDateTime {...props} />
      <a href={buildYahooTransitUrl(leg)} target="_blank" rel="noreferrer">
        Yahoo!乗換案内で検索
        <span aria-hidden="true">↗</span>
      </a>
      <TransitLegConfirmation {...props} />
    </li>
  );
}

type CollaborationCardProps = {
  collaboration: PilgrimageCollaboration;
  availableSpotIds: ReadonlySet<string>;
  onCreatePlan: (id: CollaborationId) => void;
  onViewSpots: (id: CollaborationId, firstSpotId: string | undefined) => void;
};

function CollaborationCardActions({
  collaboration,
  firstSpotId,
  onCreatePlan,
  onViewSpots,
}: Omit<CollaborationCardProps, "availableSpotIds"> & { firstSpotId: string | undefined }): ReactElement {
  return (
    <div className="collaboration-card__actions">
      <button type="button" onClick={() => onCreatePlan(collaboration.id)}>
        このコラボで予定を作る <span aria-hidden="true">→</span>
      </button>
      <button
        type="button"
        className="is-secondary"
        onClick={() => onViewSpots(collaboration.id, firstSpotId)}
      >
        対象スポットを見る <span aria-hidden="true">↓</span>
      </button>
      <a href={collaboration.sourceUrl} target="_blank" rel="noreferrer">
        公式情報 <span aria-hidden="true">↗</span>
      </a>
    </div>
  );
}

function CollaborationCard(props: CollaborationCardProps): ReactElement {
  const { collaboration, availableSpotIds } = props;
  const status = collaborationStatus(collaboration);
  const routeableSpotIds = collaboration.locations
    .filter((location) => availableSpotIds.has(location.spotId))
    .map((location) => location.spotId);
  const statusClass = status === "開催中" ? "is-active" : status === "開催前" ? "is-upcoming" : "is-ended";
  return (
    <article className="collaboration-card">
      <div className="collaboration-card__topline">
        <span className="collaboration-label">コラボ</span>
        <span className={`collaboration-status ${statusClass}`}>{status}</span>
      </div>
      <small>{collaboration.subtitle}</small>
      <h3>{collaboration.name}</h3>
      <p>{collaboration.description}</p>
      <dl>
        <div><dt>開催期間</dt><dd>{formatCollaborationDate(collaboration.startDate)} — {formatCollaborationDate(collaboration.endDate)}</dd></div>
        <div><dt>登録地点</dt><dd>{routeableSpotIds.length}か所</dd></div>
      </dl>
      <CollaborationCardActions {...props} firstSpotId={routeableSpotIds[0]} />
    </article>
  );
}

function SpotHours({ spot }: { spot: PilgrimageSpot }): ReactElement {
  return (
    <div className={`spot-card__hours${spot.openingTime && spot.closingTime ? " is-known" : ""}`}>
      <strong>{formatOpeningHours(spot)}</strong>
      {spot.openingHoursNote ? <span>{spot.openingHoursNote}</span> : null}
      {spot.openingHoursCheckedAt ? <small>{spot.openingHoursCheckedAt.replaceAll("-", ".")} 確認</small> : null}
    </div>
  );
}

function SpotEpisodes({ spot }: { spot: PilgrimageSpot }): ReactElement | null {
  if (!spot.activityRecords?.length && !spot.sehasEpisodes?.length && !spot.withMeetsEpisodes?.length) return null;
  return (
    <dl className="spot-card__episodes">
      {spot.activityRecords?.length ? <div><dt>活動記録</dt><dd>{spot.activityRecords.join("・")}</dd></div> : null}
      {spot.sehasEpisodes?.length ? <div><dt>せーはす！</dt><dd>{spot.sehasEpisodes.join("・")}</dd></div> : null}
      {spot.withMeetsEpisodes?.length ? <div><dt>With×MEETS</dt><dd>{spot.withMeetsEpisodes.join("・")}</dd></div> : null}
    </dl>
  );
}

function SpotCollaborationBadges({ items }: { items: SpotCollaborationInfo[] }): ReactElement | null {
  if (!items.length) return null;
  return (
    <div className="spot-card__collaborations">
      {items.map(({ collaboration, role, members }) => (
        <span key={collaboration.id}>
          <b>コラボ</b>
          {collaboration.name}
          {role ? <small>{role}</small> : null}
          {members?.length ? <small className="spot-card__panel-members">等身パネル：{members.join("、")}</small> : null}
        </span>
      ))}
    </div>
  );
}

type SpotCardProps = {
  spot: PilgrimageSpot;
  index: number;
  imageUrl: string | undefined;
  imagePosition: string;
  imageCredit: string | undefined;
  isSelected: boolean;
  isPlanned: boolean;
  onOpen: (spotId: string) => void;
  onTogglePlan: (spotId: string) => void;
};

function spotCardMedia(
  spot: PilgrimageSpot,
  spotPhotoGroups: Readonly<Record<string, string[]>>,
  photoCredits: Readonly<Record<string, string>>,
): Pick<SpotCardProps, "imageUrl" | "imagePosition" | "imageCredit"> {
  const managedImageUrl = spotPhotoGroups[spot.id]?.[0];
  const imageUrl = managedImageUrl ?? spot.imageUrl;
  return {
    imageUrl,
    imagePosition: managedImageUrl ? "center center" : spot.imagePosition ?? "center center",
    imageCredit: imageUrl ? photoCredits[imageUrl] : undefined,
  };
}

function SpotCardMain(props: SpotCardProps): ReactElement {
  const { spot, index, imageCredit, onOpen } = props;
  const description = publicSpotDescription(spot.description);
  const spotCollaborations = collaborationsForSpot(spot);
  return (
    <button type="button" className="spot-card__main" onClick={() => onOpen(spot.id)}>
      <div className="spot-card__topline">
        <span>{String(index + 1).padStart(2, "0")}</span>
        <small>{spot.area} · {spot.category}</small>
      </div>
      <h3>{spot.name}</h3>
      {imageCredit ? <small className="spot-card__photo-credit">写真：{imageCredit}</small> : null}
      {description ? <p>{description}</p> : null}
      <SpotHours spot={spot} />
      <SpotEpisodes spot={spot} />
      <SpotCollaborationBadges items={spotCollaborations} />
      {spot.appearances?.length ? (
        <div className="spot-card__appearances">
          {spot.appearances.map((appearance) => <span key={appearance}>{appearance}</span>)}
        </div>
      ) : null}
      <div className="spot-card__meta">
        <span>{publicAccessNote(spot.accessNote)}</span>
        <strong>地図で表示 <span aria-hidden="true">→</span></strong>
      </div>
    </button>
  );
}

function SpotCard(props: SpotCardProps): ReactElement {
  const { spot, imageUrl, imagePosition, isSelected, isPlanned, onTogglePlan } = props;
  const style = imageUrl ? ({
    "--spot-image": `url("${imageUrl}")`,
    "--spot-image-position": imagePosition,
  } as CSSProperties) : undefined;
  return (
    <article className={`spot-card${imageUrl ? " has-image" : ""}${isSelected ? " is-selected" : ""}`} style={style}>
      <SpotCardMain {...props} />
      <button
        type="button"
        className={`spot-card__select${isPlanned ? " is-selected" : ""}`}
        onClick={() => onTogglePlan(spot.id)}
        aria-pressed={isPlanned}
      >
        {isPlanned ? "予定から外す" : "予定に追加"}
      </button>
      <a href={spot.sourceUrl} target="_blank" rel="noreferrer">
        場所・公式情報
        <span aria-hidden="true">↗</span>
      </a>
    </article>
  );
}

type CardModelCardProps = {
  card: CardModelLocation;
  index: number;
  isPlanned: boolean;
  onOpenImage: (image: ActiveGuideImage) => void;
  onOpenMap: (spotId: string, cardId: string) => void;
  onTogglePlan: (spotId: string) => void;
};

function CardModelIllustration({ card, onOpenImage }: Pick<CardModelCardProps, "card" | "onOpenImage">): ReactElement | null {
  if (!card.imageUrl) return null;
  return (
    <figure className="card-model__image">
      <button
        type="button"
        className="card-model__image-button"
        aria-label={`${card.card}のカードイラストを拡大表示`}
        onClick={() => onOpenImage({ src: card.imageUrl!, alt: card.card, variant: "card" })}
      >
        {/* Static GitHub Pages assets avoid an external image-optimization request. */}
        <img src={card.imageUrl} alt={`${card.card}のカードイラスト`} loading="lazy" decoding="async" />
      </button>
      <figcaption>{CARD_ILLUSTRATION_COPYRIGHT}</figcaption>
    </figure>
  );
}

function CardModelActions(props: Pick<CardModelCardProps, "card" | "isPlanned" | "onOpenMap" | "onTogglePlan">): ReactElement {
  const { card, isPlanned, onOpenMap, onTogglePlan } = props;
  if (!card.spotId) {
    return <a href={card.sourceUrl} target="_blank" rel="noreferrer">Google マップで場所を見る <span aria-hidden="true">↗</span></a>;
  }
  return (
    <div className="card-model__actions">
      <button type="button" onClick={() => onOpenMap(card.spotId!, card.id)}>
        地図で見る <span aria-hidden="true">→</span>
      </button>
      <button
        type="button"
        className={isPlanned ? "is-selected" : ""}
        onClick={() => onTogglePlan(card.spotId!)}
        aria-pressed={isPlanned}
      >
        {isPlanned ? "予定から外す" : "予定に追加"}
      </button>
    </div>
  );
}

function CardModelCard(props: CardModelCardProps): ReactElement {
  const { card, index } = props;
  return (
    <article className={`card-model${card.imageUrl ? " has-image" : ""}`}>
      <CardModelIllustration {...props} />
      <div className="card-model__topline">
        <span>C{String(index + 1).padStart(2, "0")}</span>
        <h3>{card.card}</h3>
      </div>
      <div className="card-model__characters" aria-label="登場キャラクター">
        {card.characters.map((character) => <span key={character}>{character}</span>)}
      </div>
      <strong>{card.model}</strong>
      <p>{card.address}</p>
      {card.note && <small className="card-model__note">{card.note}</small>}
      <CardModelActions {...props} />
    </article>
  );
}

type PlannerState = {
  selectedId: string; setSelectedId: StateSetter<string>;
  plannerDays: PlannerDaySnapshot[]; setPlannerDays: StateSetter<PlannerDaySnapshot[]>;
  activeDayIndex: number; setActiveDayIndex: StateSetter<number>;
  stayMinutes: Record<string, number>; setStayMinutes: StateSetter<Record<string, number>>;
  travelMode: TravelMode; setTravelMode: StateSetter<TravelMode>;
  optimizeOrder: boolean; setOptimizeOrder: StateSetter<boolean>;
  sourceStationId: string; setSourceStationId: StateSetter<string>;
  routeRequest: RouteRequest | null; setRouteRequest: StateSetter<RouteRequest | null>;
  routeResult: RouteResult; setRouteResult: StateSetter<RouteResult>;
  dayRouteCache: DayRouteCache; setDayRouteCache: StateSetter<DayRouteCache>;
};

function usePlannerState(spots: PilgrimageSpot[]): PlannerState {
  const [selectedId, setSelectedId] = useState(spots[0].id);
  const [plannerDays, setPlannerDays] = useState<PlannerDaySnapshot[]>(() => [createPlannerDay(0, japanDate())]);
  const [activeDayIndex, setActiveDayIndex] = useState(0);
  const [stayMinutes, setStayMinutes] = useState<Record<string, number>>(() => Object.fromEntries(spots.map((spot) => [spot.id, recommendedStayMinutes(spot)])));
  const [travelMode, setTravelMode] = useState<TravelMode>("WALKING");
  const [optimizeOrder, setOptimizeOrder] = useState(false);
  const [sourceStationId, setSourceStationId] = useState("");
  const [routeRequest, setRouteRequest] = useState<RouteRequest | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult>({ state: "idle" });
  const [dayRouteCache, setDayRouteCache] = useState<DayRouteCache>({});
  return {
    selectedId, setSelectedId, plannerDays, setPlannerDays, activeDayIndex, setActiveDayIndex,
    stayMinutes, setStayMinutes, travelMode, setTravelMode, optimizeOrder, setOptimizeOrder,
    sourceStationId, setSourceStationId, routeRequest, setRouteRequest, routeResult,
    setRouteResult, dayRouteCache, setDayRouteCache,
  };
}

type SearchState = {
  spotQuery: string; setSpotQuery: StateSetter<string>;
  isSpotFilterExpanded: boolean; setIsSpotFilterExpanded: StateSetter<boolean>;
  mapSearchQuery: string; setMapSearchQuery: StateSetter<string>;
  selectedCardModelId: string | null; setSelectedCardModelId: StateSetter<string | null>;
  areaFilter: string; setAreaFilter: StateSetter<string>;
  collaborationFilter: CollaborationId | "すべて"; setCollaborationFilter: StateSetter<CollaborationId | "すべて">;
  spotSourceFilter: SpotSourceFilter; setSpotSourceFilter: StateSetter<SpotSourceFilter>;
  itineraryCollaborationId: CollaborationId | ""; setItineraryCollaborationId: StateSetter<CollaborationId | "">;
  cardCharacterFilter: CardCharacter | "すべて"; setCardCharacterFilter: StateSetter<CardCharacter | "すべて">;
};

function useSearchState(): SearchState {
  const [spotQuery, setSpotQuery] = useState("");
  const [isSpotFilterExpanded, setIsSpotFilterExpanded] = useState(false);
  const [mapSearchQuery, setMapSearchQuery] = useState("");
  const [selectedCardModelId, setSelectedCardModelId] = useState<string | null>(null);
  const [areaFilter, setAreaFilter] = useState("すべて");
  const [collaborationFilter, setCollaborationFilter] = useState<CollaborationId | "すべて">("すべて");
  const [spotSourceFilter, setSpotSourceFilter] = useState<SpotSourceFilter>("すべて");
  const [itineraryCollaborationId, setItineraryCollaborationId] = useState<CollaborationId | "">("");
  const [cardCharacterFilter, setCardCharacterFilter] = useState<CardCharacter | "すべて">("すべて");
  return {
    spotQuery, setSpotQuery, isSpotFilterExpanded, setIsSpotFilterExpanded, mapSearchQuery,
    setMapSearchQuery, selectedCardModelId, setSelectedCardModelId, areaFilter, setAreaFilter,
    collaborationFilter, setCollaborationFilter, spotSourceFilter, setSpotSourceFilter,
    itineraryCollaborationId, setItineraryCollaborationId, cardCharacterFilter, setCardCharacterFilter,
  };
}

type TodayState = {
  hasRestoredPlannerStorage: boolean; setHasRestoredPlannerStorage: StateSetter<boolean>;
  completedSpotIds: string[]; setCompletedSpotIds: StateSetter<string[]>;
  todayOffsetMinutes: number; setTodayOffsetMinutes: StateSetter<number>;
  currentJapanMinutes: number; setCurrentJapanMinutes: StateSetter<number>;
  transitLegProgress: TransitLegProgress; setTransitLegProgress: StateSetter<TransitLegProgress>;
};

function useTodayState(): TodayState {
  const [hasRestoredPlannerStorage, setHasRestoredPlannerStorage] = useState(false);
  const [completedSpotIds, setCompletedSpotIds] = useState<string[]>([]);
  const [todayOffsetMinutes, setTodayOffsetMinutes] = useState(0);
  const [currentJapanMinutes, setCurrentJapanMinutes] = useState(() => japanClockMinutes());
  const [transitLegProgress, setTransitLegProgress] = useState<TransitLegProgress>({});
  return {
    hasRestoredPlannerStorage, setHasRestoredPlannerStorage, completedSpotIds,
    setCompletedSpotIds, todayOffsetMinutes, setTodayOffsetMinutes, currentJapanMinutes,
    setCurrentJapanMinutes, transitLegProgress, setTransitLegProgress,
  };
}

type SharedState = {
  activePage: AppPage; setActivePage: StateSetter<AppPage>;
  sharedPlan: SharedPlanSnapshot | null; setSharedPlan: StateSetter<SharedPlanSnapshot | null>;
  sharedPlanLoaded: boolean; setSharedPlanLoaded: StateSetter<boolean>;
  sharedPlanDayIndex: number; setSharedPlanDayIndex: StateSetter<number>;
  sharedSelectedSpotId: string; setSharedSelectedSpotId: StateSetter<string>;
  sharedRouteResult: RouteResult; setSharedRouteResult: StateSetter<RouteResult>;
};

function useSharedState(): SharedState {
  const [activePage, setActivePage] = useState<AppPage>("explore");
  const [sharedPlan, setSharedPlan] = useState<SharedPlanSnapshot | null>(null);
  const [sharedPlanLoaded, setSharedPlanLoaded] = useState(false);
  const [sharedPlanDayIndex, setSharedPlanDayIndex] = useState(0);
  const [sharedSelectedSpotId, setSharedSelectedSpotId] = useState("");
  const [sharedRouteResult, setSharedRouteResult] = useState<RouteResult>({ state: "idle" });
  return {
    activePage, setActivePage, sharedPlan, setSharedPlan, sharedPlanLoaded,
    setSharedPlanLoaded, sharedPlanDayIndex, setSharedPlanDayIndex, sharedSelectedSpotId,
    setSharedSelectedSpotId, sharedRouteResult, setSharedRouteResult,
  };
}

type OverlayState = {
  isShareDialogOpen: boolean; setIsShareDialogOpen: StateSetter<boolean>;
  includeDatesInShare: boolean; setIncludeDatesInShare: StateSetter<boolean>;
  shareUrl: string; setShareUrl: StateSetter<string>;
  shareFeedback: string; setShareFeedback: StateSetter<string>;
  itineraryDragPreview: string[] | null; setItineraryDragPreview: StateSetter<string[] | null>;
  draggedItinerarySpotId: string | null; setDraggedItinerarySpotId: StateSetter<string | null>;
  mapReturnSection: MapReturnSection; setMapReturnSection: StateSetter<MapReturnSection>;
  activeExplorePanel: ExplorePanel | null; setActiveExplorePanel: StateSetter<ExplorePanel | null>;
  isExplorePickerOpen: boolean; setIsExplorePickerOpen: StateSetter<boolean>;
  isExploreSheetClosing: boolean; setIsExploreSheetClosing: StateSetter<boolean>;
  isExploreSheetExpanded: boolean; setIsExploreSheetExpanded: StateSetter<boolean>;
  activeGuideImage: ActiveGuideImage | null; setActiveGuideImage: StateSetter<ActiveGuideImage | null>;
  mapFocusRequest: MapFocusRequest | null; setMapFocusRequest: StateSetter<MapFocusRequest | null>;
};

function useOverlayState(): OverlayState {
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [includeDatesInShare, setIncludeDatesInShare] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [shareFeedback, setShareFeedback] = useState("");
  const [itineraryDragPreview, setItineraryDragPreview] = useState<string[] | null>(null);
  const [draggedItinerarySpotId, setDraggedItinerarySpotId] = useState<string | null>(null);
  const [mapReturnSection, setMapReturnSection] = useState<MapReturnSection>("explore-menu");
  const [activeExplorePanel, setActiveExplorePanel] = useState<ExplorePanel | null>(null);
  const [isExplorePickerOpen, setIsExplorePickerOpen] = useState(false);
  const [isExploreSheetClosing, setIsExploreSheetClosing] = useState(false);
  const [isExploreSheetExpanded, setIsExploreSheetExpanded] = useState(false);
  const [activeGuideImage, setActiveGuideImage] = useState<ActiveGuideImage | null>(null);
  const [mapFocusRequest, setMapFocusRequest] = useState<MapFocusRequest | null>(null);
  return {
    isShareDialogOpen, setIsShareDialogOpen, includeDatesInShare, setIncludeDatesInShare,
    shareUrl, setShareUrl, shareFeedback, setShareFeedback, itineraryDragPreview,
    setItineraryDragPreview, draggedItinerarySpotId, setDraggedItinerarySpotId,
    mapReturnSection, setMapReturnSection, activeExplorePanel, setActiveExplorePanel,
    isExplorePickerOpen, setIsExplorePickerOpen, isExploreSheetClosing,
    setIsExploreSheetClosing, isExploreSheetExpanded, setIsExploreSheetExpanded,
    activeGuideImage, setActiveGuideImage, mapFocusRequest, setMapFocusRequest,
  };
}

type AppRefs = {
  exploreSheetCloseButtonRef: MutableRefObject<HTMLButtonElement | null>;
  exploreSheetSwipeStartYRef: MutableRefObject<number | null>;
  exploreSheetPanelRef: MutableRefObject<HTMLDivElement | null>;
  exploreSheetCollapsedHeightRef: MutableRefObject<number>;
  exploreSheetDragRef: MutableRefObject<ExploreSheetDragState | null>;
  exploreSheetCloseTimerRef: MutableRefObject<number | null>;
  exploreSheetSettleTimerRef: MutableRefObject<number | null>;
  guideImageCloseButtonRef: MutableRefObject<HTMLButtonElement | null>;
  shareDialogCloseButtonRef: MutableRefObject<HTMLButtonElement | null>;
  shareDialogRef: MutableRefObject<HTMLElement | null>;
  shareDialogTriggerRef: MutableRefObject<HTMLButtonElement | null>;
  itineraryDragRef: MutableRefObject<ItineraryDragState | null>;
  itineraryDragScrollFrameRef: MutableRefObject<number | null>;
  itineraryFlipPositionsRef: MutableRefObject<Map<string, number> | null>;
  automaticRouteAttemptRef: MutableRefObject<string>;
};

function useAppRefs(): AppRefs {
  return {
    exploreSheetCloseButtonRef: useRef<HTMLButtonElement>(null),
    exploreSheetSwipeStartYRef: useRef<number | null>(null),
    exploreSheetPanelRef: useRef<HTMLDivElement>(null),
    exploreSheetCollapsedHeightRef: useRef(0),
    exploreSheetDragRef: useRef<ExploreSheetDragState | null>(null),
    exploreSheetCloseTimerRef: useRef<number | null>(null),
    exploreSheetSettleTimerRef: useRef<number | null>(null),
    guideImageCloseButtonRef: useRef<HTMLButtonElement>(null),
    shareDialogCloseButtonRef: useRef<HTMLButtonElement>(null),
    shareDialogRef: useRef<HTMLElement>(null),
    shareDialogTriggerRef: useRef<HTMLButtonElement>(null),
    itineraryDragRef: useRef<ItineraryDragState | null>(null),
    itineraryDragScrollFrameRef: useRef<number | null>(null),
    itineraryFlipPositionsRef: useRef<Map<string, number> | null>(null),
    automaticRouteAttemptRef: useRef(""),
  };
}

type AppState = PlannerState & SearchState & TodayState & SharedState & OverlayState;

function useItineraryFlipAnimation(
  itineraryDragPreview: string[] | null,
  refs: Pick<AppRefs, "itineraryDragRef" | "itineraryFlipPositionsRef">,
): void {
  const { itineraryDragRef, itineraryFlipPositionsRef } = refs;
  useLayoutEffect(() => {
    const previousPositions = itineraryFlipPositionsRef.current;
    itineraryFlipPositionsRef.current = null;
    const drag = itineraryDragRef.current;
    if (!previousPositions || !drag || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rows = drag.list.querySelectorAll<HTMLElement>("li[data-itinerary-spot-id]");
    rows.forEach((row) => {
      const spotId = row.dataset.itinerarySpotId;
      const previousTop = spotId ? previousPositions.get(spotId) : undefined;
      if (previousTop === undefined || spotId === drag.spotId) return;
      const deltaY = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 1) return;
      row.animate(
        [{ transform: `translate3d(0, ${deltaY}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration: 190, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    });
  }, [itineraryDragPreview, itineraryDragRef, itineraryFlipPositionsRef]);
}

function useControllerCleanup(refs: Pick<AppRefs,
  "exploreSheetCloseTimerRef" | "exploreSheetSettleTimerRef" | "itineraryDragScrollFrameRef"
>): void {
  const { exploreSheetCloseTimerRef, exploreSheetSettleTimerRef, itineraryDragScrollFrameRef } = refs;
  useEffect(() => () => {
    if (exploreSheetCloseTimerRef.current !== null) window.clearTimeout(exploreSheetCloseTimerRef.current);
    if (exploreSheetSettleTimerRef.current !== null) window.clearTimeout(exploreSheetSettleTimerRef.current);
    if (itineraryDragScrollFrameRef.current !== null) window.cancelAnimationFrame(itineraryDragScrollFrameRef.current);
  }, [exploreSheetCloseTimerRef, exploreSheetSettleTimerRef, itineraryDragScrollFrameRef]);
}

function useHistoryScrollRestoration(): void {
  useEffect(() => {
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => { window.history.scrollRestoration = previousScrollRestoration; };
  }, []);
}

function useHashPageSync(
  validSpotIds: Set<string>,
  state: Pick<AppState, "setActivePage" | "setIsExplorePickerOpen" | "setSharedPlan" |
    "setSharedPlanDayIndex" | "setSharedSelectedSpotId" | "setSharedRouteResult" |
    "setSharedPlanLoaded" | "setActiveExplorePanel" | "setIsExploreSheetExpanded">,
  refs: Pick<AppRefs, "exploreSheetCollapsedHeightRef" | "exploreSheetDragRef" | "exploreSheetSwipeStartYRef">,
): void {
  const { setActivePage, setActiveExplorePanel, setIsExplorePickerOpen, setIsExploreSheetExpanded,
    setSharedPlan, setSharedPlanDayIndex, setSharedPlanLoaded, setSharedRouteResult,
    setSharedSelectedSpotId } = state;
  const { exploreSheetCollapsedHeightRef, exploreSheetDragRef, exploreSheetSwipeStartYRef } = refs;
  useEffect(() => {
    const syncPage = (): void => {
      const nextPage = pageFromHash(window.location.hash);
      const sectionId = window.location.hash.replace(/^#\/?[^/]+\/?/, "");
      setActivePage(nextPage);
      setIsExplorePickerOpen(false);
      if (nextPage === "shared") {
        const plan = decodeSharedPlanSnapshot(sectionId, validSpotIds);
        const initialDayIndex = plan?.activeDayIndex ?? 0;
        setSharedPlan(plan); setSharedPlanDayIndex(initialDayIndex);
        setSharedSelectedSpotId(plan?.days[initialDayIndex]?.itineraryIds[0] ?? "");
        setSharedRouteResult({ state: "idle" }); setSharedPlanLoaded(true);
      } else {
        setSharedPlan(null); setSharedPlanLoaded(false); setSharedSelectedSpotId("");
        setSharedRouteResult({ state: "idle" });
      }
      const nextPanel = nextPage === "explore" && (sectionId === "spots" || sectionId === "card-models") ? sectionId : null;
      setActiveExplorePanel(nextPanel);
      if (!nextPanel) {
        setIsExploreSheetExpanded(false); exploreSheetCollapsedHeightRef.current = 0;
        exploreSheetDragRef.current = null; exploreSheetSwipeStartYRef.current = null;
      }
      schedulePageScroll(nextPage, sectionId);
    };
    syncPage(); window.addEventListener("hashchange", syncPage);
    return () => window.removeEventListener("hashchange", syncPage);
  }, [exploreSheetCollapsedHeightRef, exploreSheetDragRef, exploreSheetSwipeStartYRef,
    setActiveExplorePanel, setActivePage, setIsExplorePickerOpen, setIsExploreSheetExpanded,
    setSharedPlan, setSharedPlanDayIndex, setSharedPlanLoaded, setSharedRouteResult,
    setSharedSelectedSpotId, validSpotIds]);
}

function useExploreDialogEffect(
  activeExplorePanel: ExplorePanel | null,
  closeExplorePanel: () => void,
  closeButtonRef: MutableRefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    if (!activeExplorePanel) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeExplorePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer); document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeExplorePanel, closeButtonRef, closeExplorePanel]);
}

function useGuideDialogEffect(
  activeGuideImage: ActiveGuideImage | null,
  setActiveGuideImage: StateSetter<ActiveGuideImage | null>,
  closeButtonRef: MutableRefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    if (!activeGuideImage) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActiveGuideImage(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer); document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeGuideImage, closeButtonRef, setActiveGuideImage]);
}

function useShareDialogEffect(
  isShareDialogOpen: boolean,
  setIsShareDialogOpen: StateSetter<boolean>,
  refs: Pick<AppRefs, "shareDialogCloseButtonRef" | "shareDialogRef" | "shareDialogTriggerRef">,
): void {
  const { shareDialogCloseButtonRef, shareDialogRef, shareDialogTriggerRef } = refs;
  useEffect(() => {
    if (!isShareDialogOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const trigger = shareDialogTriggerRef.current;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => shareDialogCloseButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { setIsShareDialogOpen(false); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(shareDialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
      ) ?? []).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer); document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown); trigger?.focus();
    };
  }, [isShareDialogOpen, setIsShareDialogOpen, shareDialogCloseButtonRef,
    shareDialogRef, shareDialogTriggerRef]);
}

function usePlannerRestoreEffect(
  validSpotIds: Set<string>,
  state: Pick<AppState, "setPlannerDays" | "setActiveDayIndex" | "setStayMinutes" |
    "setTravelMode" | "setOptimizeOrder" | "setSourceStationId" |
    "setItineraryCollaborationId" | "setCompletedSpotIds" | "setTodayOffsetMinutes" |
    "setTransitLegProgress" | "setSelectedId" | "setHasRestoredPlannerStorage">,
): void {
  const { setPlannerDays, setActiveDayIndex, setStayMinutes, setTravelMode,
    setOptimizeOrder, setSourceStationId, setItineraryCollaborationId,
    setCompletedSpotIds, setTodayOffsetMinutes, setTransitLegProgress,
    setSelectedId, setHasRestoredPlannerStorage } = state;
  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const cookieDraft = parsePlannerDraftCookie(document.cookie, validSpotIds);
        const legacyRaw = cookieDraft ? null : window.localStorage.getItem(LEGACY_PLANNER_DRAFT_STORAGE_KEY);
        const draft = cookieDraft ?? (legacyRaw ? sanitizePlannerSnapshot(JSON.parse(legacyRaw) as unknown, validSpotIds) : null);
        if (draft) {
          const firstDate = draft.plannerDays[0]?.visitDate ?? japanDate();
          const restoredPastPlan = firstDate < japanDate();
          const days = restoredPastPlan ? draft.plannerDays.map((day, index) => ({ ...day, visitDate: dateAfter(japanDate(), index) })) : draft.plannerDays;
          setPlannerDays(days); setActiveDayIndex(draft.activeDayIndex);
          setStayMinutes((current) => ({ ...current, ...draft.stayMinutes }));
          setTravelMode(draft.travelMode); setOptimizeOrder(draft.optimizeOrder);
          setSourceStationId(draft.sourceStationId);
          setItineraryCollaborationId(draft.itineraryCollaborationId as CollaborationId | "");
          setCompletedSpotIds(restoredPastPlan ? [] : draft.completedSpotIds);
          setTodayOffsetMinutes(restoredPastPlan ? 0 : draft.todayOffsetMinutes);
          setTransitLegProgress(draft.transitLegProgress);
          if (draft.itineraryIds[0]) setSelectedId(draft.itineraryIds[0]);
        }
      } catch { /* 保存領域が使えない場合も、通常の旅程作成は利用できます。 */ }
      setHasRestoredPlannerStorage(true);
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [setActiveDayIndex, setCompletedSpotIds, setHasRestoredPlannerStorage,
    setItineraryCollaborationId, setOptimizeOrder, setPlannerDays, setSelectedId,
    setSourceStationId, setStayMinutes, setTodayOffsetMinutes, setTransitLegProgress,
    setTravelMode, validSpotIds]);
}

function usePlannerSaveEffect(
  activePage: AppPage,
  hasRestoredPlannerStorage: boolean,
  plannerSnapshot: PlannerSnapshot,
): void {
  useEffect(() => {
    if (!hasRestoredPlannerStorage || activePage === "shared") return;
    try {
      const encoded = serializePlannerDraftCookie(plannerSnapshot);
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${PLANNER_DRAFT_COOKIE_KEY}=${encoded}; Max-Age=${PLANNER_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
    } catch { /* 自動保存に失敗しても、画面上の編集中データは維持します。 */ }
  }, [activePage, hasRestoredPlannerStorage, plannerSnapshot]);
}

function useTodayClockEffect(
  activePage: AppPage,
  setCurrentJapanMinutes: StateSetter<number>,
): void {
  useEffect(() => {
    if (activePage !== "today") return undefined;
    const initialTimer = window.setTimeout(() => setCurrentJapanMinutes(japanClockMinutes()), 0);
    const timer = window.setInterval(() => setCurrentJapanMinutes(japanClockMinutes()), 60_000);
    return () => { window.clearTimeout(initialTimer); window.clearInterval(timer); };
  }, [activePage, setCurrentJapanMinutes]);
}

type SpotIndexes = {
  validSpotIds: Set<string>;
  spotsById: ReadonlyMap<string, PilgrimageSpot>;
  spotIndexById: ReadonlyMap<string, number>;
};

function useSpotIndexes(spots: PilgrimageSpot[]): SpotIndexes {
  const validSpotIds = useMemo(() => new Set(spots.map((spot) => spot.id)), [spots]);
  const spotsById = useMemo(() => new Map(spots.map((spot) => [spot.id, spot])), [spots]);
  const spotIndexById = useMemo(() => new Map(spots.map((spot, index) => [spot.id, index])), [spots]);
  return { validSpotIds, spotsById, spotIndexById };
}

function usePlannerSnapshot(
  state: Pick<AppState, "stayMinutes" | "travelMode" | "optimizeOrder" |
    "sourceStationId" | "itineraryCollaborationId" | "completedSpotIds" |
    "todayOffsetMinutes" | "transitLegProgress" | "plannerDays" | "activeDayIndex">,
  itineraryIds: string[],
  visitDate: string,
  startTime: string,
): PlannerSnapshot {
  const { activeDayIndex, completedSpotIds, itineraryCollaborationId, optimizeOrder,
    plannerDays, sourceStationId, stayMinutes, todayOffsetMinutes, transitLegProgress,
    travelMode } = state;
  return useMemo(() => ({
    itineraryIds, stayMinutes, travelMode, optimizeOrder, sourceStationId, visitDate,
    startTime, itineraryCollaborationId, completedSpotIds, todayOffsetMinutes,
    transitLegProgress, plannerDays, activeDayIndex,
  }), [activeDayIndex, completedSpotIds, itineraryCollaborationId, itineraryIds,
    optimizeOrder, plannerDays, sourceStationId, startTime, stayMinutes,
    todayOffsetMinutes, transitLegProgress, travelMode, visitDate]);
}

function useFilteredSpots(spots: PilgrimageSpot[], state: Pick<AppState,
  "areaFilter" | "collaborationFilter" | "spotQuery" | "spotSourceFilter"
>): PilgrimageSpot[] {
  const { areaFilter, collaborationFilter, spotQuery, spotSourceFilter } = state;
  return useMemo(() => {
    const query = normalizedSearchQuery(spotQuery);
    return spots.filter((spot) => {
      if (areaFilter !== "すべて" && spot.area !== areaFilter) return false;
      if (collaborationFilter !== "すべて" && !spot.collaborationIds?.includes(collaborationFilter)) return false;
      if (spotSourceFilter === "activity-records" && !spot.activityRecords?.length) return false;
      if (spotSourceFilter === "sehas" && !spot.sehasEpisodes?.length) return false;
      if (spotSourceFilter === "with-meets" && !spot.withMeetsEpisodes?.length) return false;
      if (!query) return true;
      return valuesMatchSearchQuery([
        spot.name, spot.shortName, spot.address, spot.category,
        ...(spot.activityRecords ?? []), ...(spot.sehasEpisodes ?? []),
        ...(spot.withMeetsEpisodes ?? []), ...(spot.appearances ?? []),
        ...collaborationsForSpot(spot).flatMap(({ collaboration, role, members }) => [
          collaboration.name, collaboration.subtitle, role ?? "", ...(members ?? []),
        ]),
      ], query);
    });
  }, [areaFilter, collaborationFilter, spotQuery, spotSourceFilter, spots]);
}

function useFilteredCardModels(filter: CardCharacter | "すべて"): CardModelLocation[] {
  return useMemo(() => cardModels.filter((card) => filter === "すべて" || card.characters.includes(filter)), [filter]);
}

type SelectedSpotData = {
  selectedSpot: PilgrimageSpot;
  selectedCardModel: CardModelLocation | null;
  selectedSpotCards: CardModelLocation[];
  selectedSpotPhotos: string[];
};

function useSelectedSpotData(
  spots: PilgrimageSpot[],
  spotPhotoGroups: Record<string, string[]>,
  spotsById: ReadonlyMap<string, PilgrimageSpot>,
  selectedId: string,
  selectedCardModelId: string | null,
): SelectedSpotData {
  const selectedSpot = spotsById.get(selectedId) ?? spots[0];
  const selectedCardModel = selectedCardModelId ? cardModels.find((card) => card.id === selectedCardModelId) ?? null : null;
  const selectedSpotCards = useMemo(() => {
    const related = cardModels.filter((card) => card.spotId === selectedSpot.id);
    if (!selectedCardModel || selectedCardModel.spotId !== selectedSpot.id) return related;
    return [selectedCardModel, ...related.filter((card) => card.id !== selectedCardModel.id)];
  }, [selectedCardModel, selectedSpot.id]);
  const selectedSpotPhotos = useMemo(() => Array.from(new Set([
    ...(spotPhotoGroups[selectedSpot.id] ?? []), ...(selectedSpot.imageUrl ? [selectedSpot.imageUrl] : []),
  ])), [selectedSpot.id, selectedSpot.imageUrl, spotPhotoGroups]);
  return { selectedSpot, selectedCardModel, selectedSpotCards, selectedSpotPhotos };
}

function useMapSearchResults(
  queryValue: string,
  spots: PilgrimageSpot[],
  spotsById: ReadonlyMap<string, PilgrimageSpot>,
): MapSearchResult[] {
  return useMemo(() => {
    const query = normalizedSearchQuery(queryValue);
    if (!query) return [];
    const matchingSpots = spots.flatMap((spot) => valuesMatchSearchQuery([
      spot.name, spot.shortName, spot.address, spot.area, spot.category, spot.description,
      ...(spot.activityRecords ?? []), ...(spot.sehasEpisodes ?? []),
      ...(spot.withMeetsEpisodes ?? []), ...(spot.appearances ?? []),
    ], query) ? [{ kind: "spot" as const, id: spot.id, spot, card: null }] : []);
    const matchingCards = cardModels.flatMap((card) => {
      if (!card.spotId) return [];
      const spot = spotsById.get(card.spotId);
      if (!spot) return [];
      const values = [card.card, card.model, card.address, card.note, ...card.characters];
      return valuesMatchSearchQuery(values, query)
        ? [{ kind: "card" as const, id: card.id, spot, card }] : [];
    });
    return [...matchingSpots, ...matchingCards].slice(0, 12);
  }, [queryValue, spots, spotsById]);
}

type ItineraryData = {
  itinerarySpots: PilgrimageSpot[];
  displayedItinerarySpots: PilgrimageSpot[];
  allPlannedSpotCount: number;
};

function useItineraryData(
  itineraryIds: string[],
  itineraryDragPreview: string[] | null,
  plannerDays: PlannerDaySnapshot[],
  spotsById: ReadonlyMap<string, PilgrimageSpot>,
): ItineraryData {
  const itinerarySpots = useMemo(() => resolveSpotsByIds(itineraryIds, spotsById), [itineraryIds, spotsById]);
  const displayedItinerarySpots = useMemo(() => resolveSpotsByIds(itineraryDragPreview ?? itineraryIds, spotsById), [itineraryDragPreview, itineraryIds, spotsById]);
  const allPlannedSpotCount = useMemo(() => plannerDays.reduce((total, day) => total + day.itineraryIds.length, 0), [plannerDays]);
  return { itinerarySpots, displayedItinerarySpots, allPlannedSpotCount };
}

type SharedPreviewData = {
  sharedActiveDay: SharedPlanSnapshot["days"][number] | null;
  sharedDaySpots: PilgrimageSpot[];
  sharedPreviewSpots: PilgrimageSpot[];
  sharedPreviewSelectedId: string;
  sharedTravelModeLabel: string;
};

function useSharedPreviewData(
  state: Pick<AppState, "sharedPlan" | "sharedPlanDayIndex" | "sharedRouteResult" | "sharedSelectedSpotId">,
  spotsById: ReadonlyMap<string, PilgrimageSpot>,
): SharedPreviewData {
  const { sharedPlan, sharedPlanDayIndex, sharedRouteResult, sharedSelectedSpotId } = state;
  const sharedActiveDay = sharedPlan?.days[sharedPlanDayIndex] ?? sharedPlan?.days[0] ?? null;
  const sharedDaySpots = useMemo(() => resolveSpotsByIds(sharedActiveDay?.itineraryIds ?? [], spotsById), [sharedActiveDay, spotsById]);
  const sharedPreviewSpots = useMemo(() => {
    if (sharedRouteResult.state !== "success" || !sharedRouteResult.orderedStopIds?.length) return sharedDaySpots;
    return resolveSpotsByIds(sharedRouteResult.orderedStopIds, new Map(sharedDaySpots.map((spot) => [spot.id, spot])));
  }, [sharedDaySpots, sharedRouteResult]);
  const sharedPreviewSelectedId = sharedPreviewSpots.some((spot) => spot.id === sharedSelectedSpotId)
    ? sharedSelectedSpotId : sharedPreviewSpots[0]?.id ?? "";
  const sharedTravelModeLabel = sharedPlan
    ? travelModes.find((mode) => mode.value === sharedPlan.travelMode)?.label ?? "徒歩" : "";
  return { sharedActiveDay, sharedDaySpots, sharedPreviewSpots, sharedPreviewSelectedId, sharedTravelModeLabel };
}

function useSharedRouteRequest(
  activePage: AppPage,
  sharedPlan: SharedPlanSnapshot | null,
  sharedActiveDay: SharedPlanSnapshot["days"][number] | null,
  sharedDaySpots: PilgrimageSpot[],
  sharedPlanDayIndex: number,
): RouteRequest | null {
  return useMemo(() => {
    if (activePage !== "shared" || !sharedPlan || !sharedActiveDay || sharedDaySpots.length < 2) return null;
    return {
      requestId: sharedPlanDayIndex + 1, stops: sharedDaySpots,
      travelMode: sharedPlan.travelMode,
      optimizeWaypointOrder: sharedPlan.travelMode !== "TRANSIT" && sharedPlan.optimizeOrder,
      stayMinutes: { ...sharedPlan.stayMinutes },
      departureTime: departureIso(sharedActiveDay.visitDate ?? japanDate(), sharedActiveDay.startTime),
    };
  }, [activePage, sharedActiveDay, sharedDaySpots, sharedPlan, sharedPlanDayIndex]);
}

type PlannerSchedule = {
  entries: Array<{ spot: PilgrimageSpot; arrival: number; departure: number; stay: number }>;
  start: number;
  finish: number;
  accessDuration: number;
};

function usePlannedSpots(
  itinerarySpots: PilgrimageSpot[],
  routeRequest: RouteRequest | null,
  routeResult: RouteResult,
): PilgrimageSpot[] {
  return useMemo(() => {
    if (routeResult.state !== "success" || !routeResult.orderedStopIds?.length || !routeRequest) {
      return routeRequest?.stops ?? itinerarySpots;
    }
    return resolveSpotsByIds(routeResult.orderedStopIds, new Map(routeRequest.stops.map((spot) => [spot.id, spot])));
  }, [itinerarySpots, routeRequest, routeResult]);
}

function usePlannerSchedule(
  plannedSpots: PilgrimageSpot[],
  routeRequest: RouteRequest | null,
  routeResult: RouteResult,
  startTime: string,
  stayMinutes: Record<string, number>,
): PlannerSchedule | null {
  return useMemo(() => {
    if (routeResult.state !== "success" || !routeRequest || !routeResult.legDurationMinutes) return null;
    const start = timeToMinutes(startTime);
    const accessDuration = routeResult.accessDurationMinutes ?? 0;
    const calculated = plannedSpots.reduce<{
      entries: PlannerSchedule["entries"];
      cursor: number;
    }>((current, spot, index) => {
      const arrival = current.cursor;
      const stay = stayMinutes[spot.id] ?? recommendedStayMinutes(spot);
      const departure = arrival + stay;
      return {
        entries: [...current.entries, { spot, arrival, departure, stay }],
        cursor: departure + (routeResult.legDurationMinutes?.[index] ?? 0),
      };
    }, { entries: [], cursor: start + accessDuration });
    return { entries: calculated.entries, start,
      finish: calculated.entries.at(-1)?.departure ?? start, accessDuration };
  }, [plannedSpots, routeRequest, routeResult, startTime, stayMinutes]);
}

type RouteSignatureData = {
  currentRouteSignature: string;
  requestedRouteSignature: string;
  routeIsCurrent: boolean;
};

function useRouteSignatures(
  state: Pick<AppState, "travelMode" | "optimizeOrder" | "sourceStationId" |
    "stayMinutes" | "routeRequest" | "routeResult">,
  itineraryIds: string[], visitDate: string, startTime: string,
  spotsById: ReadonlyMap<string, PilgrimageSpot>,
): RouteSignatureData {
  const { optimizeOrder, routeRequest, routeResult, sourceStationId, stayMinutes, travelMode } = state;
  const currentRouteSignature = useMemo(() => createRouteSignature({
    stops: itineraryIds,
    stay: travelMode === "TRANSIT" ? itineraryIds.map((id) => {
      const spot = spotsById.get(id);
      return stayMinutes[id] ?? (spot ? recommendedStayMinutes(spot) : 0);
    }) : [],
    travelMode, optimizeWaypointOrder: travelMode !== "TRANSIT" && optimizeOrder,
    accessOriginId: travelMode === "TRANSIT" ? sourceStationId : "",
    departureTime: travelMode === "TRANSIT" ? departureIso(visitDate, startTime) : "",
  }), [itineraryIds, optimizeOrder, sourceStationId, spotsById, startTime, stayMinutes, travelMode, visitDate]);
  const requestedRouteSignature = useMemo(() => routeRequest ? createRouteSignature({
    stops: routeRequest.stops.map((spot) => spot.id),
    stay: routeRequest.travelMode === "TRANSIT" ? routeRequest.stops.map((spot) => routeRequest.stayMinutes[spot.id] ?? recommendedStayMinutes(spot)) : [],
    travelMode: routeRequest.travelMode, optimizeWaypointOrder: routeRequest.optimizeWaypointOrder,
    accessOriginId: routeRequest.travelMode === "TRANSIT" ? routeRequest.accessOrigin?.id ?? "" : "",
    departureTime: routeRequest.travelMode === "TRANSIT" ? routeRequest.departureTime : "",
  }) : "", [routeRequest]);
  const routeIsCurrent = (routeResult.state === "success" || routeResult.state === "external")
    && currentRouteSignature === requestedRouteSignature;
  return { currentRouteSignature, requestedRouteSignature, routeIsCurrent };
}

function useTransitLegs(
  routeRequest: RouteRequest | null, routeIsCurrent: boolean, visitDate: string,
  startTime: string, transitLegProgress: TransitLegProgress,
): TransitLeg[] {
  return useMemo(() => {
    if (routeRequest?.travelMode !== "TRANSIT" || !routeIsCurrent) return [];
    return createYahooTransitLegs(routeRequest.stops, routeRequest.accessOrigin, visitDate, startTime, routeRequest.stayMinutes).map((leg) => {
      const progress = transitLegProgress[leg.id];
      return { ...leg, date: progress?.date ?? leg.date, time: progress?.time ?? leg.time,
        confirmed: progress?.confirmed ?? false };
    });
  }, [routeIsCurrent, routeRequest, startTime, transitLegProgress, visitDate]);
}

type PlannerStatusData = {
  confirmedTransitLegCount: number;
  completedScheduledSpotIds: string[];
  nextTodayEntry: PlannerSchedule["entries"][number] | undefined;
  scheduleOverrunMinutes: number;
  dayTimeWindowInvalid: boolean;
  fixedAppointments: PlannerAppointment[];
  appointmentConflictIds: Set<string>;
  previousHotelName: string;
  optionalPlannerSettingCount: number;
};

function derivePlannerStatus(
  schedule: PlannerSchedule | null, transitLegs: TransitLeg[], state: Pick<AppState,
    "completedSpotIds" | "activeDayIndex" | "plannerDays"
  >, activePlannerDay: PlannerDaySnapshot, startTime: string,
): PlannerStatusData {
  const { activeDayIndex, completedSpotIds, plannerDays } = state;
  const completedScheduledSpotIds = schedule
    ? schedule.entries.filter((entry) => completedSpotIds.includes(entry.spot.id)).map((entry) => entry.spot.id) : [];
  const nextTodayEntry = schedule?.entries.find((entry) => !completedSpotIds.includes(entry.spot.id));
  const scheduleOverrunMinutes = schedule ? Math.max(0, schedule.finish - timeToMinutes(activePlannerDay.endTime)) : 0;
  const dayTimeWindowInvalid = timeToMinutes(activePlannerDay.endTime) <= timeToMinutes(startTime);
  const fixedAppointments = [...activePlannerDay.appointments].sort((left, right) => timeToMinutes(left.time) - timeToMinutes(right.time));
  const appointmentConflictIds = new Set(schedule ? fixedAppointments.filter((appointment) => {
    const start = timeToMinutes(appointment.time); const end = start + appointment.durationMinutes;
    return start < schedule.finish && end > schedule.start;
  }).map((appointment) => appointment.id) : []);
  const previousHotelName = activeDayIndex > 0 ? plannerDays[activeDayIndex - 1]?.hotelName ?? "" : "";
  const optionalPlannerSettingCount = activePlannerDay.appointments.length
    + (activePlannerDay.hotelName.trim() ? 1 : 0) + (activePlannerDay.endTime !== "18:00" ? 1 : 0);
  return { confirmedTransitLegCount: transitLegs.filter((leg) => leg.confirmed).length,
    completedScheduledSpotIds, nextTodayEntry, scheduleOverrunMinutes,
    dayTimeWindowInvalid, fixedAppointments, appointmentConflictIds,
    previousHotelName, optionalPlannerSettingCount };
}

type ActiveDayActions = {
  updateActivePlannerDay: (
    update: Partial<PlannerDaySnapshot> | ((day: PlannerDaySnapshot) => PlannerDaySnapshot),
  ) => void;
  setItineraryIds: (value: SetStateAction<string[]>) => void;
  setVisitDate: (value: string) => void;
  setStartTime: (value: string) => void;
};

function useActiveDayActions(
  activeDayIndex: number,
  setPlannerDays: StateSetter<PlannerDaySnapshot[]>,
): ActiveDayActions {
  const updateActivePlannerDay: ActiveDayActions["updateActivePlannerDay"] = (update) => {
    setPlannerDays((current) => current.map((day, index) => {
      if (index !== activeDayIndex) return day;
      return typeof update === "function" ? update(day) : { ...day, ...update };
    }));
  };
  const setItineraryIds = (value: SetStateAction<string[]>): void => {
    updateActivePlannerDay((day) => ({ ...day,
      itineraryIds: typeof value === "function" ? value(day.itineraryIds) : value }));
  };
  const setVisitDate = (value: string): void => updateActivePlannerDay({ visitDate: value });
  const setStartTime = (value: string): void => updateActivePlannerDay({ startTime: value });
  return { updateActivePlannerDay, setItineraryIds, setVisitDate, setStartTime };
}

type ExploreSheetCloseActions = {
  cancelExploreSheetClose: () => void;
  closeExplorePanel: () => void;
};

function useExploreSheetCloseActions(
  state: Pick<AppState, "setIsExploreSheetClosing" | "setActiveExplorePanel" | "setIsExploreSheetExpanded">,
  refs: Pick<AppRefs, "exploreSheetCloseTimerRef" | "exploreSheetPanelRef" |
    "exploreSheetCollapsedHeightRef" | "exploreSheetDragRef">,
): ExploreSheetCloseActions {
  const { setActiveExplorePanel, setIsExploreSheetClosing, setIsExploreSheetExpanded } = state;
  const { exploreSheetCloseTimerRef, exploreSheetCollapsedHeightRef,
    exploreSheetDragRef, exploreSheetPanelRef } = refs;
  const cancelExploreSheetClose = useCallback((): void => {
    if (exploreSheetCloseTimerRef.current !== null) {
      window.clearTimeout(exploreSheetCloseTimerRef.current); exploreSheetCloseTimerRef.current = null;
    }
    const panel = exploreSheetPanelRef.current;
    panel?.classList.remove("is-dragging"); panel?.style.removeProperty("height");
    panel?.style.removeProperty("transform"); panel?.style.removeProperty("--explore-sheet-close-offset");
    setIsExploreSheetClosing(false);
  }, [exploreSheetCloseTimerRef, exploreSheetPanelRef, setIsExploreSheetClosing]);
  const closeExplorePanel = useCallback((): void => {
    if (exploreSheetCloseTimerRef.current !== null) return;
    const panel = exploreSheetPanelRef.current;
    if (panel) {
      const offset = panel.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? "0";
      panel.style.setProperty("--explore-sheet-close-offset", `${Math.max(0, Number(offset))}px`);
      panel.classList.remove("is-dragging");
    }
    setIsExploreSheetClosing(true);
    exploreSheetCloseTimerRef.current = window.setTimeout(() => {
      exploreSheetCloseTimerRef.current = null; setActiveExplorePanel(null);
      setIsExploreSheetClosing(false); setIsExploreSheetExpanded(false);
      exploreSheetCollapsedHeightRef.current = 0; exploreSheetDragRef.current = null;
      panel?.style.removeProperty("height"); panel?.style.removeProperty("transform");
      panel?.style.removeProperty("--explore-sheet-close-offset");
      if (/^#\/explore\/(?:spots|card-models)$/.test(window.location.hash)) window.history.replaceState(null, "", "#/explore");
    }, 180);
  }, [exploreSheetCloseTimerRef, exploreSheetCollapsedHeightRef, exploreSheetDragRef,
    exploreSheetPanelRef, setActiveExplorePanel, setIsExploreSheetClosing, setIsExploreSheetExpanded]);
  return { cancelExploreSheetClose, closeExplorePanel };
}

type ExploreSheetSettle = (expanded: boolean) => void;

function useExploreSheetSettle(
  setIsExploreSheetExpanded: StateSetter<boolean>,
  refs: Pick<AppRefs, "exploreSheetPanelRef" | "exploreSheetDragRef" |
    "exploreSheetSettleTimerRef" | "exploreSheetSwipeStartYRef">,
): ExploreSheetSettle {
  const { exploreSheetDragRef, exploreSheetPanelRef,
    exploreSheetSettleTimerRef, exploreSheetSwipeStartYRef } = refs;
  return useCallback((expanded: boolean): void => {
    const panel = exploreSheetPanelRef.current; const drag = exploreSheetDragRef.current;
    if (!panel || !drag) return;
    if (exploreSheetSettleTimerRef.current !== null) window.clearTimeout(exploreSheetSettleTimerRef.current);
    setIsExploreSheetExpanded(expanded); panel.classList.remove("is-dragging");
    panel.style.height = `${expanded ? drag.maxHeight : drag.collapsedHeight}px`;
    panel.style.transform = "translateY(0px)"; exploreSheetDragRef.current = null;
    exploreSheetSwipeStartYRef.current = null;
    exploreSheetSettleTimerRef.current = window.setTimeout(() => {
      exploreSheetSettleTimerRef.current = null; panel.style.removeProperty("height");
      panel.style.removeProperty("transform");
    }, 220);
  }, [exploreSheetDragRef, exploreSheetPanelRef, exploreSheetSettleTimerRef,
    exploreSheetSwipeStartYRef, setIsExploreSheetExpanded]);
}

type ExploreSheetDragEnvironment = {
  isExploreSheetClosing: boolean;
  isExploreSheetExpanded: boolean;
  closeExplorePanel: () => void;
  settleExploreSheet: ExploreSheetSettle;
  refs: Pick<AppRefs, "exploreSheetPanelRef" | "exploreSheetSettleTimerRef" |
    "exploreSheetCollapsedHeightRef" | "exploreSheetSwipeStartYRef" | "exploreSheetDragRef">;
};

function startExploreSheetDragAction(
  event: ReactPointerEvent<HTMLDivElement>, environment: ExploreSheetDragEnvironment,
): void {
  if (!event.isPrimary || event.button !== 0 || environment.isExploreSheetClosing) return;
  const { exploreSheetCollapsedHeightRef, exploreSheetDragRef, exploreSheetPanelRef,
    exploreSheetSettleTimerRef, exploreSheetSwipeStartYRef } = environment.refs;
  const panel = exploreSheetPanelRef.current; const overlay = panel?.parentElement;
  if (!panel || !overlay) return;
  if (exploreSheetSettleTimerRef.current !== null) {
    window.clearTimeout(exploreSheetSettleTimerRef.current); exploreSheetSettleTimerRef.current = null;
  }
  panel.style.removeProperty("height"); panel.style.removeProperty("transform");
  const panelRect = panel.getBoundingClientRect(); const overlayRect = overlay.getBoundingClientRect();
  const overlayStyle = window.getComputedStyle(overlay);
  const maximumHeight = panelRect.bottom - overlayRect.top - Number.parseFloat(overlayStyle.paddingTop || "0");
  if (!environment.isExploreSheetExpanded || exploreSheetCollapsedHeightRef.current === 0) {
    exploreSheetCollapsedHeightRef.current = panelRect.height;
  }
  const collapsedHeight = Math.min(exploreSheetCollapsedHeightRef.current, maximumHeight);
  exploreSheetSwipeStartYRef.current = event.clientY;
  exploreSheetDragRef.current = { pointerId: event.pointerId, startY: event.clientY,
    startHeight: panelRect.height, collapsedHeight, maxHeight: maximumHeight,
    startedExpanded: environment.isExploreSheetExpanded, dragged: false };
}

function moveExploreSheetDragAction(
  event: ReactPointerEvent<HTMLDivElement>, environment: ExploreSheetDragEnvironment,
): void {
  const panel = environment.refs.exploreSheetPanelRef.current;
  const drag = environment.refs.exploreSheetDragRef.current;
  if (!panel || !drag || drag.pointerId !== event.pointerId) return;
  const deltaY = event.clientY - drag.startY;
  if (Math.abs(deltaY) < 4) return;
  if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
  drag.dragged = true; panel.classList.add("is-dragging");
  const position = exploreSheetPosition(drag, deltaY);
  panel.style.height = `${position.height}px`; panel.style.transform = `translateY(${position.translateY}px)`;
}

function finishExploreSheetDragAction(
  event: ReactPointerEvent<HTMLDivElement>, environment: ExploreSheetDragEnvironment,
): void {
  const drag = environment.refs.exploreSheetDragRef.current;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  const deltaY = event.clientY - drag.startY;
  if (!drag.dragged) {
    environment.refs.exploreSheetDragRef.current = null;
    environment.refs.exploreSheetSwipeStartYRef.current = null; return;
  }
  const collapsedDistance = Math.max(0, drag.startHeight - drag.collapsedHeight);
  if (deltaY >= collapsedDistance + 96) { environment.closeExplorePanel(); return; }
  if (drag.startedExpanded) { environment.settleExploreSheet(deltaY < 40); return; }
  environment.settleExploreSheet(deltaY <= -36);
}

type ExploreSheetDragActions = {
  startExploreSheetDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  moveExploreSheetDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  finishExploreSheetDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  cancelExploreSheetDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

function createExploreSheetDragActions(
  environment: ExploreSheetDragEnvironment,
): ExploreSheetDragActions {
  return {
    startExploreSheetDrag: (event) => startExploreSheetDragAction(event, environment),
    moveExploreSheetDrag: (event) => moveExploreSheetDragAction(event, environment),
    finishExploreSheetDrag: (event) => finishExploreSheetDragAction(event, environment),
    cancelExploreSheetDrag: (event) => {
      const drag = environment.refs.exploreSheetDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      environment.settleExploreSheet(drag.startedExpanded);
    },
  };
}

type RouteResetActions = {
  resetRouteRequestAndResult: () => void;
  resetRouteProgress: () => void;
  updateTransitLegProgress: (legId: string, progress: TransitLegProgress[string]) => void;
  invalidateRoute: () => void;
};

function createRouteResetActions(
  activeDayId: string,
  state: Pick<AppState, "setRouteRequest" | "setRouteResult" | "setTodayOffsetMinutes" |
    "setTransitLegProgress" | "setDayRouteCache">,
): RouteResetActions {
  const resetRouteRequestAndResult = (): void => {
    state.setRouteRequest(null); state.setRouteResult({ state: "idle" });
  };
  const resetRouteProgress = (): void => {
    state.setTodayOffsetMinutes(0); state.setTransitLegProgress({});
  };
  const updateTransitLegProgress = (legId: string, progress: TransitLegProgress[string]): void => {
    state.setTransitLegProgress((current) => ({ ...current, [legId]: progress }));
  };
  const invalidateRoute = (): void => {
    resetRouteRequestAndResult();
    state.setDayRouteCache((current) => {
      if (!current[activeDayId]) return current;
      const next = { ...current }; delete next[activeDayId]; return next;
    });
    resetRouteProgress();
  };
  return { resetRouteRequestAndResult, resetRouteProgress, updateTransitLegProgress, invalidateRoute };
}

type TodayActions = {
  toggleCompletedSpot: (spotId: string) => void;
  alignRemainingScheduleToNow: () => void;
};

function createTodayActions(
  state: Pick<AppState, "setCompletedSpotIds" | "setTodayOffsetMinutes" | "currentJapanMinutes">,
  nextTodayEntry: PlannerSchedule["entries"][number] | undefined,
  visitDate: string,
): TodayActions {
  const toggleCompletedSpot = (spotId: string): void => state.setCompletedSpotIds((current) =>
    current.includes(spotId) ? current.filter((id) => id !== spotId) : [...current, spotId]);
  const alignRemainingScheduleToNow = (): void => {
    if (!nextTodayEntry || visitDate !== japanDate()) return;
    state.setTodayOffsetMinutes(state.currentJapanMinutes - nextTodayEntry.arrival);
  };
  return { toggleCompletedSpot, alignRemainingScheduleToNow };
}

function buildPlannerShareUrl(
  plannerSnapshot: PlannerSnapshot,
  validSpotIds: Set<string>,
  includeDates: boolean,
): string {
  const publicSnapshot = createSharedPlanSnapshot(plannerSnapshot, validSpotIds, { includeDates });
  if (!publicSnapshot) return "";
  const token = encodeSharedPlanSnapshot(publicSnapshot, validSpotIds);
  if (!token) return "";
  const url = new URL(window.location.href); url.hash = `#/shared/${token}`;
  return url.toString();
}

type ShareDialogActions = {
  openShareDialog: () => void;
  updateShareDates: (includeDates: boolean) => void;
  copyShareUrl: () => Promise<void>;
};

function createShareDialogActions(
  plannerSnapshot: PlannerSnapshot, validSpotIds: Set<string>,
  state: Pick<AppState, "shareUrl" | "setIncludeDatesInShare" | "setShareUrl" |
    "setShareFeedback" | "setIsShareDialogOpen">,
): ShareDialogActions {
  const openShareDialog = (): void => {
    state.setIncludeDatesInShare(false);
    state.setShareUrl(buildPlannerShareUrl(plannerSnapshot, validSpotIds, false));
    state.setShareFeedback(""); state.setIsShareDialogOpen(true);
  };
  const updateShareDates = (includeDates: boolean): void => {
    state.setIncludeDatesInShare(includeDates);
    state.setShareUrl(buildPlannerShareUrl(plannerSnapshot, validSpotIds, includeDates));
    state.setShareFeedback("");
  };
  const copyShareUrl = async (): Promise<void> => {
    if (!state.shareUrl) return;
    try {
      await navigator.clipboard.writeText(state.shareUrl);
      state.setShareFeedback("共有URLをコピーしました。");
    } catch { state.setShareFeedback("コピーできませんでした。上のURLを選択してコピーしてください。"); }
  };
  return { openShareDialog, updateShareDates, copyShareUrl };
}

function createShareCurrentPlanAction(
  shareUrl: string, copyShareUrl: () => Promise<void>, setShareFeedback: StateSetter<string>,
): () => Promise<void> {
  return async (): Promise<void> => {
    if (!shareUrl) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "蓮ノ旅の予定", text: PLANNER_SHARE_MESSAGE, url: shareUrl });
        setShareFeedback("共有画面を開きました。"); return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copyShareUrl();
  };
}

type NavigationEnvironment = {
  activePage: AppPage;
  cancelExploreSheetClose: () => void;
  state: Pick<AppState, "setIsExplorePickerOpen" | "setActiveExplorePanel" |
    "setIsExploreSheetExpanded" | "setActivePage" | "setSelectedId" |
    "setSelectedCardModelId" | "setMapReturnSection">;
  refs: Pick<AppRefs, "exploreSheetCollapsedHeightRef" | "exploreSheetDragRef" |
    "exploreSheetSwipeStartYRef">;
};

function navigateToPageAction(
  page: NavigableAppPage, sectionId: string | undefined, environment: NavigationEnvironment,
): void {
  environment.cancelExploreSheetClose(); environment.state.setIsExplorePickerOpen(false);
  if (page === "explore" && (sectionId === "spots" || sectionId === "card-models")) {
    environment.state.setActiveExplorePanel(sectionId); return;
  }
  environment.state.setActiveExplorePanel(null); environment.state.setIsExploreSheetExpanded(false);
  environment.refs.exploreSheetCollapsedHeightRef.current = 0;
  environment.refs.exploreSheetDragRef.current = null;
  environment.refs.exploreSheetSwipeStartYRef.current = null;
  const hash = `#/${page}${sectionId ? `/${sectionId}` : ""}`;
  if (page !== environment.activePage || !sectionId) resetWindowScroll();
  environment.state.setActivePage(page);
  if (window.location.hash === hash) {
    if (sectionId) document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    else resetWindowScroll();
    return;
  }
  window.location.hash = hash;
}

function navigateToMapSpotAction(
  spotId: string, returnSection: "spots" | "card-models", cardModelId: string | null,
  state: Pick<AppState, "setSelectedId" | "setSelectedCardModelId" | "setMapReturnSection">,
  navigateToPage: (page: NavigableAppPage, sectionId?: string) => void,
): void {
  state.setSelectedId(spotId); state.setSelectedCardModelId(cardModelId);
  state.setMapReturnSection(returnSection); navigateToPage("explore", "map");
  if (!window.matchMedia("(max-width: 1080px)").matches) return;
  window.setTimeout(() => {
    const heading = document.querySelector<HTMLElement>(".selected-map-detail__heading");
    if (!heading) return;
    const mobileNav = document.querySelector<HTMLElement>(".mobile-nav");
    const navVisible = mobileNav && window.getComputedStyle(mobileNav).display !== "none";
    const visibleBottom = navVisible ? mobileNav.getBoundingClientRect().top - 16 : window.innerHeight - 24;
    const scrollOffset = heading.getBoundingClientRect().bottom - visibleBottom;
    if (scrollOffset > 0) window.scrollBy({ top: scrollOffset, behavior: "smooth" });
  }, 360);
}

type NavigationActions = {
  navigateToPage: (page: NavigableAppPage, sectionId?: string) => void;
  navigateToMapSpot: (spotId: string, returnSection: "spots" | "card-models", cardModelId?: string | null) => void;
  openSpotFromList: (spotId: string) => void;
  openCardModelOnMap: (spotId: string, cardId: string) => void;
};

function createNavigationActions(environment: NavigationEnvironment): NavigationActions {
  const navigateToPage = (page: NavigableAppPage, sectionId?: string): void => navigateToPageAction(page, sectionId, environment);
  const navigateToMapSpot = (spotId: string, returnSection: "spots" | "card-models", cardModelId: string | null = null): void =>
    navigateToMapSpotAction(spotId, returnSection, cardModelId, environment.state, navigateToPage);
  return {
    navigateToPage, navigateToMapSpot,
    openSpotFromList: (spotId) => navigateToMapSpot(spotId, "spots"),
    openCardModelOnMap: (spotId, cardId) => navigateToMapSpot(spotId, "card-models", cardId),
  };
}

type SharedImportEnvironment = {
  sharedPlan: SharedPlanSnapshot | null;
  hasRestoredPlannerStorage: boolean;
  validSpotIds: Set<string>;
  spots: PilgrimageSpot[];
  state: AppState;
  resetRouteProgress: () => void;
  resetRouteRequestAndResult: () => void;
  automaticRouteAttemptRef: MutableRefObject<string>;
};

function importSharedPlanAction(environment: SharedImportEnvironment): void {
  const { sharedPlan, hasRestoredPlannerStorage, validSpotIds, spots, state } = environment;
  if (!sharedPlan || !hasRestoredPlannerStorage) return;
  const imported = createPlannerSnapshotFromSharedPlan(sharedPlan, validSpotIds, japanDate());
  if (!imported) return;
  if (!window.confirm("現在この端末に保存されている予定は、共有された予定で上書きされます。取り込みますか？")) return;
  state.setPlannerDays(imported.plannerDays); state.setActiveDayIndex(imported.activeDayIndex);
  state.setStayMinutes(imported.stayMinutes); state.setTravelMode(imported.travelMode);
  state.setOptimizeOrder(imported.optimizeOrder); state.setSourceStationId(imported.sourceStationId);
  state.setItineraryCollaborationId(""); state.setCompletedSpotIds([]);
  environment.resetRouteProgress(); state.setDayRouteCache({}); environment.resetRouteRequestAndResult();
  state.setSelectedCardModelId(null); state.setSelectedId(imported.itineraryIds[0] ?? spots[0].id);
  state.setSharedPlan(null); state.setSharedPlanLoaded(false); state.setSharedPlanDayIndex(0);
  state.setSharedSelectedSpotId(""); state.setSharedRouteResult({ state: "idle" });
  environment.automaticRouteAttemptRef.current = "";
  const plannerUrl = new URL(window.location.href); plannerUrl.hash = "#/planner";
  window.history.replaceState(window.history.state, "", plannerUrl);
  state.setActivePage("planner"); resetWindowScroll();
  window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

type RouteResultActions = {
  handleRouteResult: (result: RouteResult) => void;
  handleSharedRouteResult: (result: RouteResult) => void;
};

function useRouteResultActions(
  activeDayId: string, routeRequest: RouteRequest | null,
  state: Pick<AppState, "setRouteResult" | "setDayRouteCache" | "setSharedRouteResult">,
): RouteResultActions {
  const { setDayRouteCache, setRouteResult, setSharedRouteResult } = state;
  const handleRouteResult = useCallback((result: RouteResult): void => {
    setRouteResult(result);
    if (routeRequest && result.state === "success") {
      setDayRouteCache((current) => ({ ...current, [activeDayId]: { request: routeRequest, result } }));
    }
  }, [activeDayId, routeRequest, setDayRouteCache, setRouteResult]);
  const handleSharedRouteResult = useCallback((result: RouteResult): void => {
    setSharedRouteResult(result);
  }, [setSharedRouteResult]);
  return { handleRouteResult, handleSharedRouteResult };
}

type RouteSearchEnvironment = {
  activeDayId: string;
  itinerarySpots: PilgrimageSpot[];
  optimizeOrder: boolean;
  routeIsCurrent: boolean;
  sourceStationId: string;
  startTime: string;
  stayMinutes: Record<string, number>;
  travelMode: TravelMode;
  visitDate: string;
  state: Pick<AppState, "setRouteResult" | "setRouteRequest" | "setTransitLegProgress" |
    "setDayRouteCache" | "setSelectedId">;
};

function useRouteSearch(environment: RouteSearchEnvironment): () => void {
  const { activeDayId, itinerarySpots, optimizeOrder, routeIsCurrent, sourceStationId,
    startTime, stayMinutes, travelMode, visitDate, state } = environment;
  const { setDayRouteCache, setRouteRequest, setRouteResult, setSelectedId,
    setTransitLegProgress } = state;
  return useCallback((): void => {
    if (itinerarySpots.length < 2) {
      setRouteResult({ state: "error", message: "予定には2か所以上のスポットを追加してください。" });
      return;
    }
    if (routeIsCurrent) return;
    const accessOrigin = travelMode === "TRANSIT" ? majorStations.find((station) => station.id === sourceStationId) : undefined;
    const request: RouteRequest = {
      requestId: Date.now(), stops: itinerarySpots, travelMode,
      optimizeWaypointOrder: travelMode !== "TRANSIT" && optimizeOrder,
      stayMinutes: { ...stayMinutes }, accessOrigin,
      departureTime: departureIso(visitDate, startTime),
    };
    setRouteRequest(request);
    if (travelMode === "TRANSIT") {
      const legs = createYahooTransitLegs(itinerarySpots, accessOrigin, visitDate, startTime, stayMinutes);
      setTransitLegProgress((current) => Object.fromEntries(legs.map((leg) => [
        leg.id, current[leg.id] ?? { date: leg.date, time: leg.time, confirmed: false },
      ])));
      const externalResult: RouteResult = { state: "external", message: "訪問順にYahoo!乗換案内の区間検索を用意しました。" };
      setRouteResult(externalResult);
      setDayRouteCache((current) => ({ ...current, [activeDayId]: { request, result: externalResult } }));
    }
    setSelectedId(itinerarySpots.at(-1)!.id);
  }, [activeDayId, itinerarySpots, optimizeOrder, routeIsCurrent, sourceStationId,
    setDayRouteCache, setRouteRequest, setRouteResult, setSelectedId,
    setTransitLegProgress, startTime, stayMinutes, travelMode, visitDate]);
}

type AutomaticRouteOptions = {
  activeDayId: string; activeExplorePanel: ExplorePanel | null; activePage: AppPage;
  currentRouteSignature: string; dayTimeWindowInvalid: boolean;
  draggedItinerarySpotId: string | null; hasRestoredPlannerStorage: boolean;
  itinerarySpotCount: number; routeIsCurrent: boolean; routeResultState: RouteResult["state"];
  searchRoute: () => void; automaticRouteAttemptRef: MutableRefObject<string>;
};

function useAutomaticRouteSearch(options: AutomaticRouteOptions): void {
  const { activeDayId, activeExplorePanel, activePage, automaticRouteAttemptRef,
    currentRouteSignature, dayTimeWindowInvalid, draggedItinerarySpotId,
    hasRestoredPlannerStorage, itinerarySpotCount, routeIsCurrent,
    routeResultState, searchRoute } = options;
  useEffect(() => {
    if (activePage !== "planner") {
      automaticRouteAttemptRef.current = ""; return undefined;
    }
    if (!hasRestoredPlannerStorage || activeExplorePanel !== null
      || draggedItinerarySpotId !== null || itinerarySpotCount < 2
      || dayTimeWindowInvalid || routeIsCurrent || routeResultState === "loading") return undefined;
    const attemptKey = `${activeDayId}:${currentRouteSignature}`;
    if (automaticRouteAttemptRef.current === attemptKey) return undefined;
    const timer = window.setTimeout(() => {
      automaticRouteAttemptRef.current = attemptKey; searchRoute();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [activeDayId, activeExplorePanel, activePage, automaticRouteAttemptRef,
    currentRouteSignature, dayTimeWindowInvalid, draggedItinerarySpotId,
    hasRestoredPlannerStorage, itinerarySpotCount, routeIsCurrent, routeResultState, searchRoute]);
}

function createPlannerPrimaryAction(
  routeIsCurrent: boolean, routeResult: RouteResult, navigateToPage: NavigationActions["navigateToPage"],
  automaticRouteAttemptRef: MutableRefObject<string>, searchRoute: () => void,
): () => void {
  return (): void => {
    if (routeIsCurrent && routeResult.state === "success") { navigateToPage("today"); return; }
    if (routeIsCurrent && routeResult.state === "external") {
      const panel = document.getElementById("transit-search-panel") as HTMLDetailsElement | null;
      if (panel) panel.open = true;
      panel?.scrollIntoView({ behavior: "smooth", block: "start" }); return;
    }
    automaticRouteAttemptRef.current = ""; searchRoute();
  };
}

type SpotPlanActions = {
  focusItinerarySpot: (spotId: string) => void;
  addSpot: (id: string) => void;
  toggleItinerarySpot: (id: string) => void;
  removeSpot: (index: number) => void;
  moveSpot: (index: number, direction: -1 | 1) => void;
  changeStayMinutes: (id: string, value: number) => void;
};

function createSpotPlanActions(
  itineraryIds: string[], travelMode: TravelMode, routeRequest: RouteRequest | null,
  setItineraryIds: ActiveDayActions["setItineraryIds"],
  state: Pick<AppState, "setSelectedId" | "setMapFocusRequest" | "setStayMinutes">,
  invalidateRoute: () => void,
): SpotPlanActions {
  const focusItinerarySpot = (spotId: string): void => {
    state.setSelectedId(spotId); state.setMapFocusRequest({ spotId, requestId: Date.now() });
  };
  const addSpot = (id: string): void => {
    if (!id || itineraryIds.includes(id) || itineraryIds.length >= maximumItineraryStops) return;
    setItineraryIds((current) => [...current, id]); invalidateRoute();
  };
  const removeSpot = (index: number): void => {
    setItineraryIds((current) => current.filter((_, itemIndex) => itemIndex !== index)); invalidateRoute();
  };
  const toggleItinerarySpot = (id: string): void => {
    const index = itineraryIds.indexOf(id);
    if (index >= 0) { removeSpot(index); return; }
    addSpot(id);
  };
  const moveSpot = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= itineraryIds.length) return;
    setItineraryIds((current) => {
      const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next;
    });
    invalidateRoute();
  };
  const changeStayMinutes = (id: string, value: number): void => {
    state.setStayMinutes((current) => ({ ...current, [id]: Math.max(0, Math.min(480, value || 0)) }));
    if (travelMode === "TRANSIT" && routeRequest) invalidateRoute();
  };
  return { focusItinerarySpot, addSpot, toggleItinerarySpot, removeSpot, moveSpot, changeStayMinutes };
}

type CollaborationActions = {
  fillItineraryFromCollaboration: (id: CollaborationId | "") => void;
  createPlanFromCollaboration: (id: CollaborationId) => void;
  viewCollaborationSpots: (id: CollaborationId, firstSpotId: string | undefined) => void;
};

function createCollaborationActions(
  validSpotIds: Set<string>, spotsById: ReadonlyMap<string, PilgrimageSpot>,
  setItineraryIds: ActiveDayActions["setItineraryIds"], invalidateRoute: () => void,
  navigateToPage: NavigationActions["navigateToPage"], state: Pick<AppState,
    "setItineraryCollaborationId" | "setRouteResult" | "setSelectedId" |
    "setCollaborationFilter" | "setAreaFilter" | "setSpotQuery"
  >,
): CollaborationActions {
  const fillItineraryFromCollaboration = (id: CollaborationId | ""): void => {
    state.setItineraryCollaborationId(id);
    if (!id) return;
    const collaboration = collaborationById(id);
    if (!collaboration) return;
    const ids = Array.from(new Set(collaboration.locations.map((location) => location.spotId)
      .filter((spotId) => validSpotIds.has(spotId)))).slice(0, maximumItineraryStops);
    if (ids.length < 2) {
      state.setRouteResult({ state: "error", message: "このコラボは、予定を作れるスポットがまだ足りません。" }); return;
    }
    setItineraryIds(ids); state.setSelectedId(ids[0]); state.setCollaborationFilter(id);
    state.setAreaFilter("すべて"); state.setSpotQuery(""); invalidateRoute();
  };
  const createPlanFromCollaboration = (id: CollaborationId): void => {
    fillItineraryFromCollaboration(id); navigateToPage("planner");
  };
  const viewCollaborationSpots = (id: CollaborationId, firstSpotId: string | undefined): void => {
    state.setCollaborationFilter(id); state.setAreaFilter("すべて"); state.setSpotQuery("");
    const firstSpot = firstSpotId ? spotsById.get(firstSpotId) : undefined;
    if (firstSpot) state.setSelectedId(firstSpot.id);
    navigateToPage("explore", "spots");
  };
  return { fillItineraryFromCollaboration, createPlanFromCollaboration, viewCollaborationSpots };
}

type PlannerDayActions = {
  selectPlannerDay: (index: number) => void;
  addPlannerDay: () => void;
  removeActivePlannerDay: () => void;
};

function createPlannerDayActions(
  state: Pick<AppState, "plannerDays" | "activeDayIndex" | "dayRouteCache" |
    "setActiveDayIndex" | "setRouteRequest" | "setRouteResult" | "setSelectedId" |
    "setPlannerDays" | "setDayRouteCache">,
  resetRouteRequestAndResult: () => void, resetRouteProgress: () => void,
): PlannerDayActions {
  const selectPlannerDay = (index: number): void => {
    if (index < 0 || index >= state.plannerDays.length || index === state.activeDayIndex) return;
    state.setActiveDayIndex(index); const cached = state.dayRouteCache[state.plannerDays[index].id];
    state.setRouteRequest(cached?.request ?? null); state.setRouteResult(cached?.result ?? { state: "idle" });
    const nextSpotId = state.plannerDays[index].itineraryIds[0]; if (nextSpotId) state.setSelectedId(nextSpotId);
    resetRouteProgress();
  };
  const addPlannerDay = (): void => {
    if (state.plannerDays.length >= 7) return;
    const previous = state.plannerDays.at(-1)!;
    const next = createPlannerDay(state.plannerDays.length, dateAfter(previous.visitDate, 1));
    state.setPlannerDays((current) => [...current, next]); state.setActiveDayIndex(state.plannerDays.length);
    resetRouteRequestAndResult(); resetRouteProgress();
  };
  const removeActivePlannerDay = (): void => {
    if (state.plannerDays.length <= 1) return;
    const removedId = state.plannerDays[state.activeDayIndex].id;
    const nextIndex = Math.max(0, state.activeDayIndex - 1);
    const remaining = state.plannerDays.filter((_, index) => index !== state.activeDayIndex);
    state.setPlannerDays(remaining); state.setDayRouteCache((current) => {
      const next = { ...current }; delete next[removedId]; return next;
    });
    state.setActiveDayIndex(nextIndex); const nextSpotId = remaining[nextIndex]?.itineraryIds[0];
    if (nextSpotId) state.setSelectedId(nextSpotId);
    resetRouteRequestAndResult(); resetRouteProgress();
  };
  return { selectPlannerDay, addPlannerDay, removeActivePlannerDay };
}

type AppointmentActions = {
  addAppointment: () => void;
  updateAppointment: (id: string, update: Partial<PlannerAppointment>) => void;
  removeAppointment: (id: string) => void;
};

function createAppointmentActions(
  updateActivePlannerDay: ActiveDayActions["updateActivePlannerDay"],
): AppointmentActions {
  const addAppointment = (): void => updateActivePlannerDay((day) => ({ ...day, appointments: [
    ...day.appointments, { id: `appointment-${Date.now()}`, title: "予定を入力", time: "12:00", durationMinutes: 60 },
  ] }));
  const updateAppointment = (id: string, update: Partial<PlannerAppointment>): void => updateActivePlannerDay((day) => ({ ...day,
    appointments: day.appointments.map((appointment) => appointment.id === id ? { ...appointment, ...update } : appointment) }));
  const removeAppointment = (id: string): void => updateActivePlannerDay((day) => ({ ...day,
    appointments: day.appointments.filter((appointment) => appointment.id !== id) }));
  return { addAppointment, updateAppointment, removeAppointment };
}

type ItineraryDragEnvironment = {
  itineraryIds: string[];
  setItineraryIds: ActiveDayActions["setItineraryIds"];
  invalidateRoute: () => void;
  moveSpot: SpotPlanActions["moveSpot"];
  setItineraryDragPreview: StateSetter<string[] | null>;
  setDraggedItinerarySpotId: StateSetter<string | null>;
  refs: Pick<AppRefs, "itineraryDragRef" | "itineraryFlipPositionsRef" | "itineraryDragScrollFrameRef">;
};

function updateItineraryDragPreviewAction(clientY: number, environment: ItineraryDragEnvironment): void {
  const drag = environment.refs.itineraryDragRef.current;
  if (!drag || !drag.list.isConnected) return;
  const remainingRows = Array.from(drag.list.querySelectorAll<HTMLElement>("li[data-itinerary-spot-id]"))
    .filter((row) => row.dataset.itinerarySpotId !== drag.spotId);
  const firstBelow = remainingRows.findIndex((row) => {
    const bounds = row.getBoundingClientRect(); return clientY < bounds.top + bounds.height / 2;
  });
  const insertionIndex = firstBelow < 0 ? remainingRows.length : firstBelow;
  const nextOrder = reorderIdsForInsertion(drag.previewIds, drag.spotId, insertionIndex);
  if (sameIdOrder(nextOrder, drag.previewIds)) return;
  environment.refs.itineraryFlipPositionsRef.current = new Map(
    Array.from(drag.list.querySelectorAll<HTMLElement>("li[data-itinerary-spot-id]"))
      .map((row) => [row.dataset.itinerarySpotId, row.getBoundingClientRect().top] as const)
      .filter((entry): entry is readonly [string, number] => Boolean(entry[0])),
  );
  drag.list.querySelectorAll<HTMLElement>("li[data-itinerary-spot-id]").forEach((row) => {
    row.getAnimations().forEach((animation) => animation.cancel());
  });
  drag.previewIds = nextOrder; environment.setItineraryDragPreview(nextOrder);
}

function itineraryDragScrollAmount(clientY: number): number {
  const scrollEdge = Math.min(88, window.innerHeight * 0.18);
  if (clientY < scrollEdge) return -Math.min(18, Math.ceil((scrollEdge - clientY) / 4));
  if (clientY > window.innerHeight - scrollEdge) {
    return Math.min(18, Math.ceil((clientY - (window.innerHeight - scrollEdge)) / 4));
  }
  return 0;
}

function stopItineraryDragAutoScroll(environment: ItineraryDragEnvironment): void {
  const frameRef = environment.refs.itineraryDragScrollFrameRef;
  if (frameRef.current === null) return;
  window.cancelAnimationFrame(frameRef.current); frameRef.current = null;
}

function removeItineraryDragOverlay(overlay: HTMLElement): void {
  overlay.remove(); document.documentElement.classList.remove("is-itinerary-dragging");
}

function runItineraryDragAutoScroll(environment: ItineraryDragEnvironment): void {
  environment.refs.itineraryDragScrollFrameRef.current = null;
  const drag = environment.refs.itineraryDragRef.current;
  if (!drag) return;
  const amount = itineraryDragScrollAmount(drag.pointerY);
  if (!amount) return;
  const scrollingElement = document.scrollingElement ?? document.documentElement;
  const previousScrollTop = scrollingElement.scrollTop; scrollingElement.scrollTop += amount;
  updateItineraryDragPreviewAction(drag.pointerY, environment);
  if (scrollingElement.scrollTop === previousScrollTop) return;
  environment.refs.itineraryDragScrollFrameRef.current = window.requestAnimationFrame(
    () => runItineraryDragAutoScroll(environment),
  );
}

function syncItineraryDragAutoScroll(clientY: number, environment: ItineraryDragEnvironment): void {
  if (!itineraryDragScrollAmount(clientY)) { stopItineraryDragAutoScroll(environment); return; }
  if (environment.refs.itineraryDragScrollFrameRef.current === null) {
    environment.refs.itineraryDragScrollFrameRef.current = window.requestAnimationFrame(
      () => runItineraryDragAutoScroll(environment),
    );
  }
}

function startItineraryDragAction(
  event: ReactPointerEvent<HTMLButtonElement>, spotId: string, environment: ItineraryDragEnvironment,
): void {
  if (!event.isPrimary || event.button !== 0 || environment.itineraryIds.length < 2) return;
  const list = event.currentTarget.closest("ol") as HTMLOListElement | null;
  const row = event.currentTarget.closest<HTMLElement>("li[data-itinerary-spot-id]");
  if (!list || !row) return;
  event.preventDefault(); const previewIds = [...environment.itineraryIds];
  const bounds = row.getBoundingClientRect(); const overlay = row.cloneNode(true) as HTMLElement;
  overlay.className = "itinerary-drag-overlay"; overlay.removeAttribute("data-itinerary-spot-id");
  overlay.setAttribute("aria-hidden", "true"); overlay.setAttribute("role", "presentation");
  overlay.style.left = `${bounds.left}px`; overlay.style.top = `${bounds.top}px`;
  overlay.style.width = `${bounds.width}px`; overlay.style.height = `${bounds.height}px`;
  overlay.querySelectorAll<HTMLElement>("button, input").forEach((control) => { control.tabIndex = -1; });
  document.body.appendChild(overlay); document.documentElement.classList.add("is-itinerary-dragging");
  environment.refs.itineraryDragRef.current = {
    pointerId: event.pointerId, spotId, originalIds: previewIds, previewIds, list, overlay,
    startY: event.clientY, pointerY: event.clientY,
  };
  list.setPointerCapture(event.pointerId); environment.setItineraryDragPreview(previewIds);
  environment.setDraggedItinerarySpotId(spotId);
}

function moveItineraryDragAction(
  event: ReactPointerEvent<HTMLOListElement>, environment: ItineraryDragEnvironment,
): void {
  const drag = environment.refs.itineraryDragRef.current;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault(); drag.pointerY = event.clientY;
  drag.overlay.style.transform = `translate3d(0, ${event.clientY - drag.startY}px, 0)`;
  updateItineraryDragPreviewAction(event.clientY, environment);
  syncItineraryDragAutoScroll(event.clientY, environment);
}

function finishItineraryDragAction(
  event: ReactPointerEvent<HTMLOListElement>, environment: ItineraryDragEnvironment,
): void {
  const drag = environment.refs.itineraryDragRef.current;
  if (!drag || drag.pointerId !== event.pointerId) return;
  stopItineraryDragAutoScroll(environment); environment.refs.itineraryDragRef.current = null;
  removeItineraryDragOverlay(drag.overlay);
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  environment.setDraggedItinerarySpotId(null); environment.setItineraryDragPreview(null);
  if (sameIdOrder(drag.previewIds, drag.originalIds)) return;
  environment.setItineraryIds(drag.previewIds); environment.invalidateRoute();
}

function cancelItineraryDragAction(
  event: ReactPointerEvent<HTMLOListElement>, environment: ItineraryDragEnvironment,
): void {
  const drag = environment.refs.itineraryDragRef.current;
  if (!drag || drag.pointerId !== event.pointerId) return;
  stopItineraryDragAutoScroll(environment); environment.refs.itineraryDragRef.current = null;
  removeItineraryDragOverlay(drag.overlay); environment.setDraggedItinerarySpotId(null);
  environment.setItineraryDragPreview(null);
}

type ItineraryDragActions = {
  startItineraryDrag: (event: ReactPointerEvent<HTMLButtonElement>, spotId: string) => void;
  moveItineraryDrag: (event: ReactPointerEvent<HTMLOListElement>) => void;
  finishItineraryDrag: (event: ReactPointerEvent<HTMLOListElement>) => void;
  cancelItineraryDrag: (event: ReactPointerEvent<HTMLOListElement>) => void;
  handleItineraryDragKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, spotId: string) => void;
};

function createItineraryDragActions(environment: ItineraryDragEnvironment): ItineraryDragActions {
  return {
    startItineraryDrag: (event, spotId) => startItineraryDragAction(event, spotId, environment),
    moveItineraryDrag: (event) => moveItineraryDragAction(event, environment),
    finishItineraryDrag: (event) => finishItineraryDragAction(event, environment),
    cancelItineraryDrag: (event) => cancelItineraryDragAction(event, environment),
    handleItineraryDragKeyDown: (event, spotId) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault(); const index = environment.itineraryIds.indexOf(spotId);
      if (index < 0) return; environment.moveSpot(index, event.key === "ArrowUp" ? -1 : 1);
    },
  };
}

type ControllerConfig = {
  mapboxConfig: Props["mapboxConfig"];
  spots: PilgrimageSpot[];
  spotPhotoGroups: Record<string, string[]>;
  photoCredits: Record<string, string>;
  heroImage: string | null;
  siteVersion: string;
  communityApiUrl: string;
  turnstileSiteKey: string;
  communitySubmissionsEnabled: boolean;
};

type ControllerFoundation = {
  config: ControllerConfig;
  state: AppState;
  refs: AppRefs;
};

type ControllerDerived = SpotIndexes & SelectedSpotData & ItineraryData &
  SharedPreviewData & RouteSignatureData & PlannerStatusData & {
    activePlannerDay: PlannerDaySnapshot;
    itineraryIds: string[];
    visitDate: string;
    startTime: string;
    activeDayId: string;
    plannerSnapshot: PlannerSnapshot;
    areas: string[];
    filteredSpots: PilgrimageSpot[];
    filteredCardModels: CardModelLocation[];
    mapSearchResults: MapSearchResult[];
    sharedRouteRequest: RouteRequest | null;
    plannedSpots: PilgrimageSpot[];
    schedule: PlannerSchedule | null;
    transitLegs: TransitLeg[];
  };

type ControllerFoundationActions = ActiveDayActions & ExploreSheetCloseActions &
  ExploreSheetDragActions;

type ControllerRouteActions = RouteResetActions & RouteResultActions & {
  searchRoute: () => void;
  handlePlannerPrimaryAction: () => void;
};

type ControllerActions = ControllerFoundationActions & ControllerRouteActions &
  TodayActions & ShareDialogActions & NavigationActions & SpotPlanActions &
  CollaborationActions & ItineraryDragActions & PlannerDayActions & AppointmentActions & {
    shareCurrentPlan: () => Promise<void>;
    importSharedPlan: () => void;
  };

type PilgrimageController = ControllerConfig & AppState & AppRefs &
  ControllerDerived & ControllerActions;

function useControllerFoundation(props: Props): ControllerFoundation {
  const plannerState = usePlannerState(props.spots);
  const searchState = useSearchState();
  const todayState = useTodayState();
  const sharedState = useSharedState();
  const overlayState = useOverlayState();
  const state: AppState = {
    ...plannerState, ...searchState, ...todayState, ...sharedState, ...overlayState,
  };
  const config: ControllerConfig = {
    mapboxConfig: props.mapboxConfig,
    spots: props.spots,
    spotPhotoGroups: props.spotPhotoGroups,
    photoCredits: props.photoCredits ?? {},
    heroImage: props.heroImages[props.initialHeroIndex ?? 0] ?? props.heroImages[0] ?? null,
    siteVersion: props.siteVersion,
    communityApiUrl: props.communityApiUrl ?? "",
    turnstileSiteKey: props.turnstileSiteKey ?? "",
    communitySubmissionsEnabled: props.communitySubmissionsEnabled ?? false,
  };
  return { config, state, refs: useAppRefs() };
}

function useControllerDerived(config: ControllerConfig, state: AppState): ControllerDerived {
  const activePlannerDay = state.plannerDays[state.activeDayIndex] ?? state.plannerDays[0];
  const { itineraryIds, visitDate, startTime, id: activeDayId } = activePlannerDay;
  const indexes = useSpotIndexes(config.spots);
  const plannerSnapshot = usePlannerSnapshot(state, itineraryIds, visitDate, startTime);
  const areas = useMemo(
    () => Array.from(new Set(config.spots.map((spot) => spot.area))),
    [config.spots],
  );
  const filteredSpots = useFilteredSpots(config.spots, state);
  const filteredCardModels = useFilteredCardModels(state.cardCharacterFilter);
  const selected = useSelectedSpotData(
    config.spots, config.spotPhotoGroups, indexes.spotsById,
    state.selectedId, state.selectedCardModelId,
  );
  const mapSearchResults = useMapSearchResults(state.mapSearchQuery, config.spots, indexes.spotsById);
  const itinerary = useItineraryData(
    itineraryIds, state.itineraryDragPreview, state.plannerDays, indexes.spotsById,
  );
  const shared = useSharedPreviewData(state, indexes.spotsById);
  const sharedRouteRequest = useSharedRouteRequest(
    state.activePage, state.sharedPlan, shared.sharedActiveDay,
    shared.sharedDaySpots, state.sharedPlanDayIndex,
  );
  const plannedSpots = usePlannedSpots(itinerary.itinerarySpots, state.routeRequest, state.routeResult);
  const schedule = usePlannerSchedule(
    plannedSpots, state.routeRequest, state.routeResult, startTime, state.stayMinutes,
  );
  const routeSignatures = useRouteSignatures(state, itineraryIds, visitDate, startTime, indexes.spotsById);
  const transitLegs = useTransitLegs(
    state.routeRequest, routeSignatures.routeIsCurrent, visitDate,
    startTime, state.transitLegProgress,
  );
  const status = derivePlannerStatus(schedule, transitLegs, state, activePlannerDay, startTime);
  return {
    activePlannerDay, itineraryIds, visitDate, startTime, activeDayId, plannerSnapshot,
    areas, filteredSpots, filteredCardModels, mapSearchResults, sharedRouteRequest,
    plannedSpots, schedule, transitLegs, ...indexes, ...selected, ...itinerary,
    ...shared, ...routeSignatures, ...status,
  };
}

function useControllerFoundationActions(
  state: AppState, refs: AppRefs,
): ControllerFoundationActions {
  const activeDayActions = useActiveDayActions(state.activeDayIndex, state.setPlannerDays);
  const closeActions = useExploreSheetCloseActions(state, refs);
  const settleExploreSheet = useExploreSheetSettle(state.setIsExploreSheetExpanded, refs);
  const dragActions = createExploreSheetDragActions({
    isExploreSheetClosing: state.isExploreSheetClosing,
    isExploreSheetExpanded: state.isExploreSheetExpanded,
    closeExplorePanel: closeActions.closeExplorePanel,
    settleExploreSheet,
    refs,
  });
  return { ...activeDayActions, ...closeActions, ...dragActions };
}

function useControllerEffects(
  state: AppState, refs: AppRefs, derived: ControllerDerived,
  actions: ControllerFoundationActions,
): void {
  useItineraryFlipAnimation(state.itineraryDragPreview, refs);
  useControllerCleanup(refs);
  useHistoryScrollRestoration();
  useHashPageSync(derived.validSpotIds, state, refs);
  useExploreDialogEffect(
    state.activeExplorePanel, actions.closeExplorePanel, refs.exploreSheetCloseButtonRef,
  );
  useGuideDialogEffect(state.activeGuideImage, state.setActiveGuideImage, refs.guideImageCloseButtonRef);
  useShareDialogEffect(state.isShareDialogOpen, state.setIsShareDialogOpen, refs);
  usePlannerRestoreEffect(derived.validSpotIds, state);
  usePlannerSaveEffect(state.activePage, state.hasRestoredPlannerStorage, derived.plannerSnapshot);
  useTodayClockEffect(state.activePage, state.setCurrentJapanMinutes);
}

type ControllerRouteEnvironment = {
  state: AppState;
  refs: AppRefs;
  derived: ControllerDerived;
  navigateToPage: NavigationActions["navigateToPage"];
};

function useControllerRouteActions(
  environment: ControllerRouteEnvironment,
): ControllerRouteActions {
  const { state, refs, derived, navigateToPage } = environment;
  const resetActions = createRouteResetActions(derived.activeDayId, state);
  const resultActions = useRouteResultActions(derived.activeDayId, state.routeRequest, state);
  const searchRoute = useRouteSearch({
    activeDayId: derived.activeDayId,
    itinerarySpots: derived.itinerarySpots,
    optimizeOrder: state.optimizeOrder,
    routeIsCurrent: derived.routeIsCurrent,
    sourceStationId: state.sourceStationId,
    startTime: derived.startTime,
    stayMinutes: state.stayMinutes,
    travelMode: state.travelMode,
    visitDate: derived.visitDate,
    state,
  });
  useAutomaticRouteSearch({
    activeDayId: derived.activeDayId, activeExplorePanel: state.activeExplorePanel,
    activePage: state.activePage, currentRouteSignature: derived.currentRouteSignature,
    dayTimeWindowInvalid: derived.dayTimeWindowInvalid,
    draggedItinerarySpotId: state.draggedItinerarySpotId,
    hasRestoredPlannerStorage: state.hasRestoredPlannerStorage,
    itinerarySpotCount: derived.itinerarySpots.length,
    routeIsCurrent: derived.routeIsCurrent, routeResultState: state.routeResult.state,
    searchRoute, automaticRouteAttemptRef: refs.automaticRouteAttemptRef,
  });
  const handlePlannerPrimaryAction = createPlannerPrimaryAction(
    derived.routeIsCurrent, state.routeResult, navigateToPage,
    refs.automaticRouteAttemptRef, searchRoute,
  );
  return { ...resetActions, ...resultActions, searchRoute, handlePlannerPrimaryAction };
}

function useControllerActions(
  config: ControllerConfig, state: AppState, refs: AppRefs,
  derived: ControllerDerived, foundation: ControllerFoundationActions,
): ControllerActions {
  const navigation = createNavigationActions({
    activePage: state.activePage, cancelExploreSheetClose: foundation.cancelExploreSheetClose,
    state, refs,
  });
  const route = useControllerRouteActions({
    state, refs, derived, navigateToPage: navigation.navigateToPage,
  });
  const today = createTodayActions(state, derived.nextTodayEntry, derived.visitDate);
  const share = createShareDialogActions(derived.plannerSnapshot, derived.validSpotIds, state);
  const shareCurrentPlan = createShareCurrentPlanAction(
    state.shareUrl, share.copyShareUrl, state.setShareFeedback,
  );
  const importSharedPlan = (): void => importSharedPlanAction({
    sharedPlan: state.sharedPlan, hasRestoredPlannerStorage: state.hasRestoredPlannerStorage,
    validSpotIds: derived.validSpotIds, spots: config.spots, state,
    resetRouteProgress: route.resetRouteProgress,
    resetRouteRequestAndResult: route.resetRouteRequestAndResult,
    automaticRouteAttemptRef: refs.automaticRouteAttemptRef,
  });
  const spotPlan = createSpotPlanActions(
    derived.itineraryIds, state.travelMode, state.routeRequest,
    foundation.setItineraryIds, state, route.invalidateRoute,
  );
  const collaboration = createCollaborationActions(
    derived.validSpotIds, derived.spotsById, foundation.setItineraryIds,
    route.invalidateRoute, navigation.navigateToPage, state,
  );
  const itineraryDrag = createItineraryDragActions({
    itineraryIds: derived.itineraryIds, setItineraryIds: foundation.setItineraryIds,
    invalidateRoute: route.invalidateRoute, moveSpot: spotPlan.moveSpot,
    setItineraryDragPreview: state.setItineraryDragPreview,
    setDraggedItinerarySpotId: state.setDraggedItinerarySpotId, refs,
  });
  const plannerDays = createPlannerDayActions(
    state, route.resetRouteRequestAndResult, route.resetRouteProgress,
  );
  const appointments = createAppointmentActions(foundation.updateActivePlannerDay);
  return {
    ...foundation, ...navigation, ...route, ...today, ...share, ...spotPlan,
    ...collaboration, ...itineraryDrag, ...plannerDays, ...appointments,
    shareCurrentPlan, importSharedPlan,
  };
}

function usePilgrimageController(props: Props): PilgrimageController {
  const { config, state, refs } = useControllerFoundation(props);
  const derived = useControllerDerived(config, state);
  const foundation = useControllerFoundationActions(state, refs);
  useControllerEffects(state, refs, derived, foundation);
  const actions = useControllerActions(config, state, refs, derived, foundation);
  return { ...config, ...state, ...refs, ...derived, ...actions };
}
const PilgrimageContext = createContext<PilgrimageController | null>(null);

function usePilgrimageContext(): PilgrimageController {
  const controller = useContext(PilgrimageContext);
  if (!controller) throw new Error("PilgrimageContext is not available.");
  return controller;
}

function SiteHeader(): ReactElement {
  const { activePage, allPlannedSpotCount, navigateToPage } = usePilgrimageContext();
  return (
    <header className="site-header">
      <a className="brand" href="#/explore" aria-label="蓮ノ旅 探すページ" onClick={(event) => { event.preventDefault(); navigateToPage("explore"); }}>
        <span className="brand-mark" aria-hidden="true">蓮</span>
        <span>
          <strong>蓮ノ旅</strong>
          <small>HASUNOSORA PILGRIMAGE GUIDE</small>
        </span>
      </a>
      <nav className="desktop-nav" aria-label="メインナビゲーション">
        {(Object.keys(appPageLabels) as NavigableAppPage[]).map((page) => (
          <a
            href={`#/${page}`}
            key={page}
            aria-current={activePage === page ? "page" : undefined}
            onClick={(event) => { event.preventDefault(); navigateToPage(page); }}
          >
            {appPageLabels[page]}
            {page === "planner" && allPlannedSpotCount ? <b>{allPlannedSpotCount}</b> : null}
          </a>
        ))}
      </nav>
      <a className="header-cta" href="https://www.lovelive-anime.jp/hasunosora/" target="_blank" rel="noreferrer">
        作品公式サイト
        <span aria-hidden="true">↗</span>
      </a>
    </header>
  );
}

function MobileExplorePicker(): ReactElement | null {
  const { activeExplorePanel, isExplorePickerOpen, navigateToPage } = usePilgrimageContext();
  if (!isExplorePickerOpen) return null;
  return (
    <nav className="mobile-explore-picker" id="mobile-explore-picker" aria-label="スポット・カード一覧">
      <button
        type="button"
        aria-pressed={activeExplorePanel === "spots"}
        onClick={() => navigateToPage("explore", "spots")}
      >
        スポット
      </button>
      <button
        type="button"
        aria-pressed={activeExplorePanel === "card-models"}
        onClick={() => navigateToPage("explore", "card-models")}
      >
        カード
      </button>
    </nav>
  );
}

function MobileNavigation(): ReactElement {
  const {
    activeExplorePanel, activePage, allPlannedSpotCount, closeExplorePanel,
    isExplorePickerOpen, navigateToPage, setIsExplorePickerOpen,
  } = usePilgrimageContext();
  const togglePicker = (): void => {
    if (!activeExplorePanel) {
      setIsExplorePickerOpen((current) => !current);
      return;
    }
    closeExplorePanel();
    setIsExplorePickerOpen(true);
  };
  return (
    <nav className={`mobile-nav${activeExplorePanel ? " mobile-nav--sheet-open" : ""}`} aria-label="スマートフォン用メニュー">
      <a href="#/explore" aria-current={activePage === "explore" && !activeExplorePanel ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigateToPage("explore"); }}>
        <span>ホーム</span>
      </a>
      <button type="button" aria-pressed={isExplorePickerOpen || Boolean(activeExplorePanel)} aria-expanded={isExplorePickerOpen} aria-controls="mobile-explore-picker" onClick={togglePicker}>
        <span>{activeExplorePanel === "spots" ? "スポット" : activeExplorePanel === "card-models" ? "カード" : "探す"}</span>
      </button>
      {(["planner", "today", "guide"] as NavigableAppPage[]).map((page) => (
        <a href={`#/${page}`} key={page} aria-current={activePage === page ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigateToPage(page); }}>
          <span>{appPageLabels[page]}</span>
          {page === "planner" && allPlannedSpotCount ? <b>{allPlannedSpotCount}</b> : null}
        </a>
      ))}
    </nav>
  );
}

function HeroSection(): ReactElement {
  const { activePage, areas, heroImage, navigateToPage, siteVersion, spots } = usePilgrimageContext();
  const heroStyle = heroImage
    ? ({ "--hero-image": `url("${heroImage}")` } as CSSProperties)
    : undefined;
  return (
    <section className={`hero hero--magazine${heroImage ? " has-managed-image" : ""}`} id="top" hidden={activePage !== "explore"} style={heroStyle}>
      <div className="hero-magazine-grid" aria-hidden="true" />
      <div className="hero-magazine-number" aria-hidden="true">01</div>
      <div className="hero-copy hero-magazine-copy">
        <div className="eyebrow">ISHIKAWA / KANAZAWA</div>
        <p className="hero-kicker">蓮ノ空女学院<br />スクールアイドルクラブ</p>
        <div className="hero-magazine-rule" aria-label={`${spots.length}スポット、${areas.length}エリア`}>
          <span>{spots.length} SPOTS</span>
          <span>{areas.length} AREAS</span>
        </div>
        <p className="hero-lead">作品に関連するスポットを検索し、訪問予定を作成できます。</p>
        <div className="hero-actions hero-magazine-actions">
          <a href="#/explore/explore-menu" onClick={(event) => { event.preventDefault(); navigateToPage("explore", "explore-menu"); }}>
            <small>01</small><strong>探し方を選ぶ</strong><span aria-hidden="true">↓</span>
          </a>
          <a href="#/explore/spots" onClick={(event) => { event.preventDefault(); navigateToPage("explore", "spots"); }}>
            <small>02</small><strong>スポット一覧</strong><span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
      <div className="hero-magazine-side" aria-hidden="true">HASUNOSORA PILGRIMAGE · VER. {siteVersion}</div>
    </section>
  );
}

function ExploreMenu(): ReactElement {
  const { activePage, communitySubmissionsEnabled, navigateToPage, setMapReturnSection } = usePilgrimageContext();
  const openMap = (): void => {
    setMapReturnSection("explore-menu");
    navigateToPage("explore", "map");
  };
  return (
    <section className="explore-menu" id="explore-menu" hidden={activePage !== "explore"} aria-labelledby="explore-menu-title">
      <div><h2 id="explore-menu-title">探し方を選ぶ</h2><p>目的に合う入口を選んでください。</p></div>
      <div className="explore-menu__grid">
        <button type="button" onClick={() => navigateToPage("explore", "spots")}><strong>定番</strong><span>登録スポットから選ぶ</span></button>
        <button type="button" onClick={() => navigateToPage("explore", "collaborations")}><strong>コラボ</strong><span>対象スポットをまとめて選ぶ</span></button>
        <button type="button" onClick={openMap}><strong>地図</strong><span>場所を確認しながら選ぶ</span></button>
        <button type="button" onClick={() => navigateToPage("explore", "card-models")}><strong>カード</strong><span>キャラクターからモデル地を探す</span></button>
        <a href="#/explore/community-contribution" className="explore-menu__contribute">
          <strong>投稿</strong><span>{communitySubmissionsEnabled ? "写真や新しいスポットを送る" : "投稿機能は準備中"}</span>
        </a>
      </div>
    </section>
  );
}

function CollaborationsSection(): ReactElement {
  const {
    activePage, createPlanFromCollaboration, validSpotIds, viewCollaborationSpots,
  } = usePilgrimageContext();
  return (
    <section className="collaborations-section" id="collaborations" hidden={activePage !== "explore"}>
      <div className="section-heading">
        <div><h2>コラボ</h2></div>
        <p>
          コラボ企画と対象スポットをまとめています。
          お出かけ前に、開催期間やお休みを公式案内でもご確認ください。
        </p>
      </div>
      <div className="collaboration-grid">
        {collaborations.map((collaboration) => (
          <CollaborationCard
            key={collaboration.id}
            collaboration={collaboration}
            availableSpotIds={validSpotIds}
            onCreatePlan={createPlanFromCollaboration}
            onViewSpots={viewCollaborationSpots}
          />
        ))}
      </div>
    </section>
  );
}

function ContributionSection(): ReactElement {
  const {
    activePage, communityApiUrl, communitySubmissionsEnabled, spots, turnstileSiteKey,
  } = usePilgrimageContext();
  return (
    <CommunityContributionPanel
      spots={spots}
      apiBaseUrl={communityApiUrl}
      turnstileSiteKey={turnstileSiteKey}
      enabled={communitySubmissionsEnabled}
      hidden={activePage !== "explore"}
    />
  );
}

type GuideScreen = { src: string; alt: string; label: string; className?: string };
type GuideStepData = { number: string; title: string; description: string; screens: GuideScreen[] };

const GUIDE_STEPS: GuideStepData[] = [
  {
    number: "01", title: "探し方を選ぶ",
    description: "「探す」では、目的に合う方法でスポットやカードを探せます。",
    screens: [{ src: "./guide/02-choose-method.png", alt: "探し方を選ぶ画面", label: "大きく見る" }],
  },
  {
    number: "02", title: "行きたい場所を追加する",
    description: "スポットまたはカードを開き、「予定に追加」を押します。追加した件数は下の「予定」に表示されます。",
    screens: [
      { src: "./guide/03-add-spots.png", alt: "スポット一覧から場所を選ぶ画面", label: "スポット", className: "guide-step__screen--spots" },
      { src: "./guide/07-card-search.png", alt: "カードからモデル地を選ぶ画面", label: "カード" },
    ],
  },
  {
    number: "03", title: "場所と日時を整える",
    description: "「予定」で訪問順と滞在時間を調整し、移動手段、訪問日、出発時刻を設定します。",
    screens: [
      { src: "./guide/04-plan-stops.png", alt: "訪問するスポットと滞在時間を編集する画面", label: "場所" },
      { src: "./guide/05-plan-time.png", alt: "移動手段と訪問日時を設定する画面", label: "日時" },
    ],
  },
  {
    number: "04", title: "計算して当日に使う",
    description: "内容を確認して予定を計算します。計算後は「当日」で次の訪問先、時刻、進捗を確認できます。",
    screens: [{ src: "./guide/06-plan-check.png", alt: "予定内容を確認して計算する画面", label: "大きく見る" }],
  },
];

function GuideScreenButton({ screen }: { screen: GuideScreen }): ReactElement {
  const { setActiveGuideImage } = usePilgrimageContext();
  return (
    <button
      type="button"
      className={`guide-step__screen${screen.className ? ` ${screen.className}` : ""}`}
      onClick={() => setActiveGuideImage({ src: screen.src, alt: screen.alt })}
    >
      <img src={screen.src} alt={screen.alt} loading="lazy" decoding="async" />
      <span>{screen.label}</span>
    </button>
  );
}

function GuideStep({ step }: { step: GuideStepData }): ReactElement {
  return (
    <article className="guide-step">
      <div className="guide-step__copy">
        <span className="guide-step__number">{step.number}</span>
        <h3>{step.title}</h3>
        <p>{step.description}</p>
      </div>
      <div className={`guide-step__screens${step.screens.length > 1 ? " guide-step__screens--double" : ""}`}>
        {step.screens.map((screen) => <GuideScreenButton key={screen.src} screen={screen} />)}
      </div>
    </article>
  );
}

function GuidePage(): ReactElement {
  const { activePage } = usePilgrimageContext();
  return (
    <section className="guide-section" id="guide" hidden={activePage !== "guide"}>
      <div className="guide-intro">
        <span>USER GUIDE</span>
        <h2>このサイトの使い方</h2>
        <p>下のメニューを「探す」「予定」「当日」の順に使います。画像を押すと大きく表示できます。</p>
      </div>
      <div className="guide-walkthrough" aria-label="基本的な使い方">
        {GUIDE_STEPS.map((step) => <GuideStep key={step.number} step={step} />)}
      </div>
      <p className="guide-source-note">
        画面内のカード画像：<a href="https://www.lovelive-anime.jp/hasunosora/" target="_blank" rel="noreferrer">©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ</a>
      </p>
    </section>
  );
}

function SiteDisclaimer(): ReactElement {
  const { activePage, communitySubmissionsEnabled } = usePilgrimageContext();
  return (
    <section className="site-disclaimer" id="site-notice" aria-labelledby="site-notice-title" hidden={activePage !== "guide"}>
      <div className="site-disclaimer__heading">
        <h2 id="site-notice-title">訪れるときのお願い</h2>
        <p>みんなが気持ちよく楽しめるよう、次の点だけご協力ください。</p>
      </div>
      <div className="site-disclaimer__content">
        <ul>
          <li>お店や地域の方、通行する方への配慮を忘れず、立入りや撮影は各施設の案内に従いましょう。</li>
          <li>営業時間や交通、天候は変わることがあります。お出かけ前に公式情報も確認しておくと安心です。</li>
          <li>旅程や所要時間は目安です。当日は現地の状況に合わせて、無理のない予定でお楽しみください。</li>
        </ul>
        <div className="site-data-note" aria-labelledby="site-data-note-title">
          <h3 id="site-data-note-title">このサイトで扱うデータ</h3>
          <p>作成した予定はこの端末のブラウザに保存され、サイト側で予定を保管することはありません。 ブラウザのデータを消すと予定も消えます。</p>
          <p>地図や経路を表示するときは、表示範囲や選んだ地点、移動条件をMapboxへ送ります。</p>
          {communitySubmissionsEnabled ? <p>投稿すると、入力内容と写真は運営者のサーバーへ送られ、確認後に掲載します。 迷惑投稿を防ぐため、Cloudflare Turnstileへ接続元IPなどが送られます。</p> : null}
          <p>アクセス解析や広告用の追跡は行っていません。</p>
        </div>
      </div>
    </section>
  );
}

function SiteFooter(): ReactElement {
  const { activePage, siteVersion } = usePilgrimageContext();
  return (
    <footer hidden={activePage === "today"}>
      <div className="brand brand--footer">
        <span className="brand-mark" aria-hidden="true">蓮</span>
        <span>
          <strong>蓮ノ旅</strong>
          <small>HASUNOSORA PILGRIMAGE GUIDE</small>
        </span>
      </div>
      <p>ファンが個人で運営する非公式サイトです。作品・施設・地域の各公式とは関係ありません。</p>
      <span>Ver. {siteVersion} · © 2026 Yukachiii · 写真のクレジットは各画像に記載</span>
    </footer>
  );
}

function ShareModalHeader(): ReactElement {
  const { setIsShareDialogOpen, shareDialogCloseButtonRef } = usePilgrimageContext();
  return (
    <header>
      <div><small>SHARE PLAN</small><h2 id="planner-share-title">予定を共有</h2></div>
      <button type="button" ref={shareDialogCloseButtonRef} onClick={() => setIsShareDialogOpen(false)} aria-label="共有画面を閉じる">×</button>
    </header>
  );
}

function ShareModalContent(): ReactElement {
  const { includeDatesInShare, shareUrl, updateShareDates } = usePilgrimageContext();
  return (
    <>
      <p>訪問先や時間を、見るだけのリンクで共有します。</p>
      <label className="planner-share-modal__date-option">
        <input type="checkbox" checked={includeDatesInShare} onChange={(event) => updateShareDates(event.target.checked)} />
        <span><strong>訪問日も共有する</strong><small>訪問日は、ここを選んだときだけ共有されます。</small></span>
      </label>
      <div className="planner-share-modal__privacy">
        <strong>共有しない情報</strong><span>宿泊地・自由予定・訪問済みの進捗・出発駅</span>
      </div>
      {shareUrl ? (
        <label className="planner-share-modal__url">
          <span>共有URL</span>
          <input type="text" readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />
        </label>
      ) : (
        <p className="planner-share-modal__error" role="alert">共有URLを作成できませんでした。訪問先を減らして、もう一度お試しください。</p>
      )}
    </>
  );
}

function ShareModalActions(): ReactElement {
  const { copyShareUrl, shareCurrentPlan, shareFeedback, shareUrl } = usePilgrimageContext();
  return (
    <>
      <div className="planner-share-modal__actions">
        <button type="button" onClick={shareCurrentPlan} disabled={!shareUrl}>
          {typeof navigator !== "undefined" && typeof navigator.share === "function" ? "共有メニューを開く" : "URLをコピー"}
        </button>
        <button type="button" className="is-secondary" onClick={copyShareUrl} disabled={!shareUrl}>URLをコピー</button>
      </div>
      <p className="planner-share-modal__feedback" aria-live="polite">{shareFeedback}</p>
    </>
  );
}

function ShareModal(): ReactElement | null {
  const { isShareDialogOpen, setIsShareDialogOpen, shareDialogRef } = usePilgrimageContext();
  if (!isShareDialogOpen) return null;
  return (
    <div className="planner-share-modal" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) setIsShareDialogOpen(false);
    }}>
      <section ref={shareDialogRef} className="planner-share-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="planner-share-title">
        <ShareModalHeader />
        <ShareModalContent />
        <ShareModalActions />
      </section>
    </div>
  );
}

function GuideImageModal(): ReactElement | null {
  const { activeGuideImage, guideImageCloseButtonRef, setActiveGuideImage } = usePilgrimageContext();
  if (!activeGuideImage) return null;
  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveGuideImage(null);
  };
  return (
    <div className={`guide-image-modal${activeGuideImage.variant === "card" ? " guide-image-modal--card" : ""}`} role="presentation" onClick={closeFromBackdrop}>
      <section className="guide-image-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="guide-image-modal-title">
        <header>
          <strong id="guide-image-modal-title">{activeGuideImage.alt}</strong>
          <button type="button" ref={guideImageCloseButtonRef} onClick={() => setActiveGuideImage(null)} aria-label="画像を閉じる">
            閉じる <span aria-hidden="true">×</span>
          </button>
        </header>
        <figure><div className="guide-image-modal__image-frame">
          <img src={activeGuideImage.src} alt={activeGuideImage.alt} />
          {activeGuideImage.variant === "card" ? <span className="guide-image-modal__copyright">{CARD_ILLUSTRATION_COPYRIGHT}</span> : null}
          {activeGuideImage.credit ? <span className="guide-image-modal__photo-credit">写真：{activeGuideImage.credit}</span> : null}
        </div></figure>
      </section>
    </div>
  );
}

function SharedPlanSummary(): ReactElement | null {
  const { sharedPlan, sharedTravelModeLabel } = usePilgrimageContext();
  if (!sharedPlan) return null;
  return (
    <div className="shared-plan-summary" aria-label="共有予定の概要">
      <span><small>日程</small><strong>{sharedPlan.days.length}日間</strong></span>
      <span><small>訪問先</small><strong>{sharedPlan.days.reduce((total, day) => total + day.itineraryIds.length, 0)}か所</strong></span>
      <span><small>移動手段</small><strong>{sharedTravelModeLabel}</strong></span>
      <span><small>訪問日</small><strong>{sharedPlan.days.some((day) => day.visitDate) ? "共有あり" : "非公開"}</strong></span>
    </div>
  );
}

function SharedPlanDays(): ReactElement | null {
  const {
    setSharedPlanDayIndex, setSharedRouteResult, setSharedSelectedSpotId,
    sharedPlan, sharedPlanDayIndex,
  } = usePilgrimageContext();
  if (!sharedPlan || sharedPlan.days.length <= 1) return null;
  const selectDay = (index: number): void => {
    const day = sharedPlan.days[index];
    setSharedPlanDayIndex(index);
    setSharedSelectedSpotId(day.itineraryIds[0] ?? "");
    setSharedRouteResult({ state: "idle" });
  };
  return (
    <nav className="shared-plan-days" aria-label="表示する日程">
      {sharedPlan.days.map((day, index) => (
        <button type="button" key={`${day.startTime}-${index}`} aria-current={index === sharedPlanDayIndex ? "date" : undefined} onClick={() => selectDay(index)}>
          <strong>{index + 1}日目</strong>
          <span>{day.visitDate?.replaceAll("-", "/") ?? "日付非公開"}</span>
        </button>
      ))}
    </nav>
  );
}

function SharedRouteStatus(): ReactElement | null {
  const { sharedDaySpots, sharedPlan, sharedRouteResult } = usePilgrimageContext();
  if (!sharedPlan) return null;
  return (
    <div className={`shared-plan-route-preview__status is-${sharedRouteResult.state}`} aria-live="polite">
      {sharedPlan.travelMode === "TRANSIT" ? (
        <><strong>訪問先を地図で確認できます</strong><span>公共交通の区間検索は、取り込み後の予定画面から確認してください。</span></>
      ) : sharedDaySpots.length < 2 ? (
        <strong>訪問先を地図で表示しています</strong>
      ) : sharedRouteResult.state === "success" ? (
        <><strong>{sharedRouteResult.distance} · {sharedRouteResult.duration}</strong><span>経路と移動時間はMapboxによる目安です。</span></>
      ) : sharedRouteResult.state === "error" || sharedRouteResult.state === "fallback" ? (
        <><strong>経路を表示できませんでした</strong><span>{sharedRouteResult.message}</span></>
      ) : (
        <strong>{sharedRouteResult.state === "loading" ? "経路を計算しています…" : "経路を準備しています…"}</strong>
      )}
    </div>
  );
}

function SharedRoutePreview(): ReactElement | null {
  const {
    activePage, handleSharedRouteResult, mapboxConfig, setSharedSelectedSpotId,
    sharedActiveDay, sharedDaySpots, sharedPlanDayIndex, sharedPreviewSelectedId,
    sharedPreviewSpots, sharedRouteRequest,
  } = usePilgrimageContext();
  if (activePage !== "shared" || !sharedActiveDay || !sharedDaySpots.length) return null;
  return (
    <section className="shared-plan-route-preview" aria-labelledby="shared-route-preview-title">
      <header>
        <div><small>ROUTE PREVIEW</small><h2 id="shared-route-preview-title">共有された経路</h2></div>
        <span>{sharedPlanDayIndex + 1}日目 · {sharedDaySpots.length}か所</span>
      </header>
      <MapboxPilgrimageMap
        spots={sharedPreviewSpots} selectedId={sharedPreviewSelectedId}
        plannedSpotIds={sharedActiveDay.itineraryIds} cardModelSpotIds={CARD_MODEL_SPOT_IDS}
        onSelect={setSharedSelectedSpotId} routeRequest={sharedRouteRequest}
        onRouteResult={handleSharedRouteResult} accessToken={mapboxConfig.accessToken}
        isVisible={activePage === "shared"} viewMode="planner"
      />
      <SharedRouteStatus />
    </section>
  );
}

function SharedPlanDay(): ReactElement | null {
  const { sharedActiveDay, sharedPlan, sharedPlanDayIndex, sharedPreviewSpots } = usePilgrimageContext();
  if (!sharedActiveDay || !sharedPlan) return null;
  return (
    <article className="shared-plan-day">
      <header>
        <div><small>DAY {String(sharedPlanDayIndex + 1).padStart(2, "0")}</small><h2>{sharedActiveDay.visitDate?.replaceAll("-", ".") ?? `${sharedPlanDayIndex + 1}日目`}</h2></div>
        <span>{sharedActiveDay.startTime}開始 · {sharedActiveDay.endTime}終了目安</span>
      </header>
      <ol>
        {sharedPreviewSpots.map((spot, index) => (
          <li key={spot.id}>
            <span className="shared-plan-day__number">{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{spot.name}</strong><small>{spot.address}</small></div>
            <span className="shared-plan-day__stay">{sharedPlan.stayMinutes[spot.id] ?? recommendedStayMinutes(spot)}分滞在</span>
          </li>
        ))}
      </ol>
      <p>{sharedPlan.optimizeOrder ? "おすすめの訪問順" : "共有された順番"}<span>地図上の経路と移動時間は目安です。</span></p>
    </article>
  );
}

function SharedPlanImport(): ReactElement {
  const { hasRestoredPlannerStorage, importSharedPlan } = usePilgrimageContext();
  return (
    <section className="shared-plan-import" aria-labelledby="shared-plan-import-title">
      <div>
        <small>IMPORT PLAN</small><strong id="shared-plan-import-title">この予定を自分の予定に取り込む</strong>
        <p>現在この端末に保存されている予定は、共有された予定で上書きされます。 訪問日が共有されていない場合は、今日からの日程として取り込みます。</p>
      </div>
      <button type="button" disabled={!hasRestoredPlannerStorage} onClick={importSharedPlan}>
        {hasRestoredPlannerStorage ? "予定に取り込む" : "保存済み予定を確認中…"}<span aria-hidden="true">→</span>
      </button>
    </section>
  );
}

function SharedPlanContent(): ReactElement {
  const { navigateToPage } = usePilgrimageContext();
  return (
    <>
      <SharedPlanSummary /><SharedPlanDays /><SharedRoutePreview /><SharedPlanDay /><SharedPlanImport />
      <aside className="shared-plan-privacy">
        <strong>共有されない情報</strong>
        <p>宿泊地、予約・待ち合わせなどの自由予定、訪問済みの進捗、出発駅は共有されません。</p>
      </aside>
      <a className="shared-plan-home" href="#/explore" onClick={(event) => { event.preventDefault(); navigateToPage("explore"); }}>
        蓮ノ旅を開く <span aria-hidden="true">→</span>
      </a>
    </>
  );
}

function SharedPlanPage(): ReactElement {
  const { activePage, navigateToPage, sharedPlan, sharedPlanLoaded } = usePilgrimageContext();
  return (
    <section className="shared-plan-page" aria-labelledby="shared-plan-title" hidden={activePage !== "shared"}>
      <header className="shared-plan-page__header">
        <small>SHARED PLAN</small><h1 id="shared-plan-title">共有された予定</h1>
        <p>共有された訪問先と滞在時間を表示しています。</p>
      </header>
      {!sharedPlanLoaded ? (
        <p className="shared-plan-page__status">予定を読み込んでいます…</p>
      ) : !sharedPlan ? (
        <section className="shared-plan-page__error" role="alert">
          <strong>この共有URLを読み込めませんでした</strong>
          <p>URLが途中で切れているか、共有データが古い可能性があります。</p>
          <a href="#/explore" onClick={(event) => { event.preventDefault(); navigateToPage("explore"); }}>ホームへ戻る</a>
        </section>
      ) : <SharedPlanContent />}
    </section>
  );
}

function TodayDaySwitch(): ReactElement | null {
  const { activeDayIndex, plannerDays, selectPlannerDay } = usePilgrimageContext();
  if (plannerDays.length <= 1) return null;
  return (
    <nav className="today-day-switch" aria-label="確認する日を選択">
      {plannerDays.map((day, index) => (
        <button type="button" key={day.id} className={index === activeDayIndex ? "is-current" : undefined} aria-current={index === activeDayIndex ? "date" : undefined} onClick={() => selectPlannerDay(index)}>
          <strong>{index + 1}日目</strong><span>{day.visitDate.replaceAll("-", "/")}</span>
        </button>
      ))}
    </nav>
  );
}

function TodayFixedAppointments(): ReactElement | null {
  const { fixedAppointments } = usePilgrimageContext();
  if (!fixedAppointments.length) return null;
  return (
    <section className="today-mode__fixed" aria-label="時間を固定した予定">
      <strong>時間を固定した予定</strong>
      <ol>{fixedAppointments.map((appointment) => (
        <li key={appointment.id}><time>{appointment.time}</time><span>{appointment.title || "名称未入力"}</span><small>{appointment.durationMinutes}分</small></li>
      ))}</ol>
    </section>
  );
}

function TodayNextSpot(): ReactElement {
  const { nextTodayEntry, todayOffsetMinutes, toggleCompletedSpot, travelMode, visitDate } = usePilgrimageContext();
  if (!nextTodayEntry) {
    return <article className="today-mode__complete"><strong>本日の予定はすべて訪問済みです</strong><p>訪問済みの記録は下のボタンからリセットできます。</p></article>;
  }
  const hours = openingHoursStatus(nextTodayEntry.spot, visitDate, nextTodayEntry.arrival + todayOffsetMinutes);
  return (
    <article className="today-mode__next">
      <small>NEXT SPOT · {displayClock(nextTodayEntry.arrival + todayOffsetMinutes)} 到着予定</small>
      <h3>{nextTodayEntry.spot.name}</h3><p>{nextTodayEntry.spot.address}</p>
      <div className={`opening-status opening-status--${hours.kind}`}>{hours.label}</div>
      <div className="today-mode__next-actions">
        <a href={`https://www.google.com/maps/dir/?api=1&destination=${nextTodayEntry.spot.lat},${nextTodayEntry.spot.lng}&travelmode=${navigationTravelMode(travelMode)}&dir_action=navigate`} target="_blank" rel="noreferrer">
          現在地からGoogle Mapsで向かう<span aria-hidden="true">↗</span>
        </a>
        <button type="button" onClick={() => toggleCompletedSpot(nextTodayEntry.spot.id)}>訪問済みにする</button>
      </div>
    </article>
  );
}

function TodayTools(): ReactElement {
  const {
    alignRemainingScheduleToNow, completedScheduledSpotIds, nextTodayEntry,
    setCompletedSpotIds, setTodayOffsetMinutes, todayOffsetMinutes, visitDate,
  } = usePilgrimageContext();
  return (
    <details className="today-mode__tools">
      <summary><span>当日の調整</span><small>{todayOffsetMinutes ? `予定時刻を${todayOffsetMinutes >= 0 ? "+" : ""}${todayOffsetMinutes}分調整中` : "必要な場合のみ"}</small></summary>
      <div>
        <button type="button" onClick={alignRemainingScheduleToNow} disabled={!nextTodayEntry || visitDate !== japanDate()}>残りを現在時刻に合わせる</button>
        <button type="button" onClick={() => setTodayOffsetMinutes(0)} disabled={!todayOffsetMinutes}>調整を元に戻す</button>
        <button type="button" onClick={() => setCompletedSpotIds([])} disabled={!completedScheduledSpotIds.length}>訪問済みをリセット</button>
        <p>{visitDate === japanDate() ? `表示時刻を${todayOffsetMinutes >= 0 ? "+" : ""}${todayOffsetMinutes}分調整しています。` : "訪問日当日は、残りの予定を現在時刻に合わせられます。"}</p>
      </div>
    </details>
  );
}

type TodayEntryProps = { entry: NonNullable<PilgrimageController["schedule"]>["entries"][number] };

function TodayEntry({ entry }: TodayEntryProps): ReactElement {
  const { completedSpotIds, todayOffsetMinutes, toggleCompletedSpot, visitDate } = usePilgrimageContext();
  const isComplete = completedSpotIds.includes(entry.spot.id);
  const adjustedArrival = entry.arrival + todayOffsetMinutes;
  const adjustedDeparture = entry.departure + todayOffsetMinutes;
  const hoursStatus = openingHoursStatus(entry.spot, visitDate, adjustedArrival);
  return (
    <li className={isComplete ? "is-complete" : ""}>
      <button type="button" onClick={() => toggleCompletedSpot(entry.spot.id)} aria-pressed={isComplete}>
        <span className="today-mode__check" aria-hidden="true">{isComplete ? "✓" : ""}</span>
        <time>{displayClock(adjustedArrival)}</time>
        <div>
          <strong>{entry.spot.shortName}</strong>
          <small>{displayClock(adjustedDeparture)} 出発 · {entry.stay}分滞在</small>
          <span className={`opening-status opening-status--${hoursStatus.kind}`}>{hoursStatus.label}</span>
        </div>
      </button>
    </li>
  );
}

function TodaySchedule(): ReactElement | null {
  const {
    activeDayIndex, activePlannerDay, completedScheduledSpotIds, currentJapanMinutes,
    schedule, visitDate,
  } = usePilgrimageContext();
  if (!schedule) return null;
  return (
    <section className="today-mode__dialog" aria-labelledby="today-mode-title">
      <header className="today-mode__header"><div>
        <h2 id="today-mode-title">{activeDayIndex + 1}日目の予定</h2>
        <p>{visitDate === japanDate() ? `${visitDate.replaceAll("-", ".")} · 現在 ${displayClock(currentJapanMinutes)}` : `${visitDate.replaceAll("-", ".")} の予定を確認中`}</p>
      </div></header>
      <div className="today-mode__progress"><div><strong>{completedScheduledSpotIds.length} / {schedule.entries.length}</strong><span>訪問済み</span></div><progress value={completedScheduledSpotIds.length} max={schedule.entries.length} /></div>
      <TodayFixedAppointments /><TodayNextSpot /><TodayTools />
      <ol className="today-mode__list">{schedule.entries.map((entry) => <TodayEntry key={entry.spot.id} entry={entry} />)}</ol>
      <p className="today-mode__notice">営業時間や交通状況は変わる場合があります。現地と公式案内もご確認ください。 訪問済みと時刻の変更は、この端末に自動保存されます。</p>
      {activePlannerDay.hotelName ? <p className="today-mode__hotel">宿泊地：<strong>{activePlannerDay.hotelName}</strong><span>宿泊地までの移動時間は予定に含まれていません。</span></p> : null}
    </section>
  );
}

function TodayPage(): ReactElement | null {
  const { activePage, navigateToPage, schedule } = usePilgrimageContext();
  if (activePage !== "today") return null;
  return (
    <div className="today-mode today-mode--page">
      <TodayDaySwitch />
      {schedule ? <TodaySchedule /> : (
        <section className="today-page__empty" aria-labelledby="today-page-empty-title">
          <h2 id="today-page-empty-title">当日の予定</h2>
          <p>確認できる予定がまだありません。先に訪問スポットと日時を設定し、移動時間を計算してください。</p>
          <button type="button" onClick={() => navigateToPage("planner")}>予定を作る <span aria-hidden="true">→</span></button>
        </section>
      )}
    </div>
  );
}

function ExploreSheetTabs(): ReactElement {
  const { activeExplorePanel, navigateToPage, spots } = usePilgrimageContext();
  return (
    <nav className="explore-sheet__tabs" role="tablist" aria-label="一覧を切り替える">
      <button type="button" role="tab" aria-selected={activeExplorePanel === "spots"} onClick={() => navigateToPage("explore", "spots")}>
        スポット <small>{spots.length}</small>
      </button>
      <button type="button" role="tab" aria-selected={activeExplorePanel === "card-models"} onClick={() => navigateToPage("explore", "card-models")}>
        カード <small>{cardModels.length}</small>
      </button>
    </nav>
  );
}

function ExploreSheetSwipeZone(): ReactElement {
  const {
    cancelExploreSheetDrag, closeExplorePanel, exploreSheetCloseButtonRef,
    finishExploreSheetDrag, moveExploreSheetDrag, startExploreSheetDrag,
  } = usePilgrimageContext();
  return (
    <div className="explore-sheet__swipe-zone" onPointerDown={startExploreSheetDrag} onPointerMove={moveExploreSheetDrag} onPointerUp={finishExploreSheetDrag} onPointerCancel={cancelExploreSheetDrag}>
      <div className="explore-sheet__grab-zone">
        <div className="explore-sheet__handle" aria-hidden="true" />
        <header className="explore-sheet__header">
          <strong id="explore-sheet-title">探す</strong>
          <button type="button" ref={exploreSheetCloseButtonRef} aria-label="閉じる" title="閉じる" onClick={closeExplorePanel}><span aria-hidden="true">×</span></button>
        </header>
      </div>
      <ExploreSheetTabs />
    </div>
  );
}

function SpotAdvancedFilters(): ReactElement {
  const {
    areaFilter, areas, collaborationFilter, isSpotFilterExpanded, setAreaFilter,
    setCollaborationFilter, setSpotSourceFilter, spotSourceFilter,
  } = usePilgrimageContext();
  return (
    <div className={`spot-filters__advanced${isSpotFilterExpanded ? " is-expanded" : ""}`} id="spot-advanced-filters">
      <label><span>エリア</span><select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}>
        <option>すべて</option>{areas.map((area) => <option key={area}>{area}</option>)}
      </select></label>
      <label><span>コラボ</span><select value={collaborationFilter} onChange={(event) => setCollaborationFilter(event.target.value as CollaborationId | "すべて")}>
        <option value="すべて">すべて</option>
        {collaborations.map((collaboration) => <option value={collaboration.id} key={collaboration.id}>{collaboration.name}</option>)}
      </select></label>
      <label><span>出典</span><select value={spotSourceFilter} onChange={(event) => setSpotSourceFilter(event.target.value as SpotSourceFilter)}>
        <option value="すべて">すべて</option><option value="sehas">せーはす！</option>
        <option value="activity-records">活動記録</option><option value="with-meets">With×MEETS</option>
      </select></label>
    </div>
  );
}

function SpotFilters(): ReactElement {
  const {
    areaFilter, collaborationFilter, filteredSpots, isSpotFilterExpanded,
    setIsSpotFilterExpanded, setSpotQuery, spotQuery, spots, spotSourceFilter,
  } = usePilgrimageContext();
  const filtersActive = areaFilter !== "すべて" || collaborationFilter !== "すべて" || spotSourceFilter !== "すべて";
  return (
    <div className="spot-filters" aria-label="スポットの絞り込み">
      <label className="spot-filters__query"><span>キーワード</span><input type="search" value={spotQuery} onChange={(event) => setSpotQuery(event.target.value)} placeholder="施設名・住所・登場回で検索" /></label>
      <button type="button" className={`spot-filters__toggle${filtersActive ? " is-active" : ""}`} aria-expanded={isSpotFilterExpanded} aria-controls="spot-advanced-filters" onClick={() => setIsSpotFilterExpanded((current) => !current)}>
        <span>{isSpotFilterExpanded ? "閉じる" : "絞り込み"}</span><small>{filteredSpots.length}件</small>
      </button>
      <SpotAdvancedFilters />
      <p><strong>{filteredSpots.length}</strong> / {spots.length} SPOTS</p>
    </div>
  );
}

function SpotList(): ReactElement {
  const {
    filteredSpots, itineraryIds, openSpotFromList, photoCredits, selectedId,
    spotIndexById, spotPhotoGroups, toggleItinerarySpot,
  } = usePilgrimageContext();
  return (
    <>
      <div className="spot-grid" role="region" aria-label="スポット一覧">
        {filteredSpots.map((spot) => {
          const media = spotCardMedia(spot, spotPhotoGroups, photoCredits);
          return <SpotCard key={spot.id} spot={spot} index={spotIndexById.get(spot.id) ?? -1} {...media} isSelected={selectedId === spot.id} isPlanned={itineraryIds.includes(spot.id)} onOpen={openSpotFromList} onTogglePlan={toggleItinerarySpot} />;
        })}
      </div>
      {!filteredSpots.length && <p className="spot-empty">条件に合うスポットがありません。検索語かエリアを変更してください。</p>}
    </>
  );
}

function SpotsPanel(): ReactElement {
  const { activeExplorePanel, spots } = usePilgrimageContext();
  return (
    <section className="spots-section" id="spots" hidden={activeExplorePanel !== "spots"}>
      <div className="section-heading"><div><h2>スポット一覧（{spots.length}件）</h2></div><p>活動記録や関連映像、コラボなどにまつわる場所をまとめています。 お出かけ前に、施設の最新情報もご確認ください。</p></div>
      <SpotFilters /><SpotList />
    </section>
  );
}

function CardModelsPanel(): ReactElement {
  const {
    activeExplorePanel, cardCharacterFilter, filteredCardModels, itineraryIds,
    openCardModelOnMap, setActiveGuideImage, setCardCharacterFilter, toggleItinerarySpot,
  } = usePilgrimageContext();
  return (
    <section className="card-models-section" id="card-models" hidden={activeExplorePanel !== "card-models"}>
      <div className="section-heading"><div><h2>カードモデル地（{cardModels.length}件）</h2></div><p>カードイラストのモデルと思われる場所を紹介しています。</p></div>
      <div className="card-model-filter" aria-label="カードイラストのキャラクター絞り込み">
        <label><span>キャラクター</span><select value={cardCharacterFilter} onChange={(event) => setCardCharacterFilter(event.target.value as CardCharacter | "すべて")}>
          <option value="すべて">すべてのキャラクター</option>{cardCharacters.map((character) => <option value={character} key={character}>{character}</option>)}
        </select></label>
        <p><strong>{filteredCardModels.length}</strong> / {cardModels.length} CARDS</p>
      </div>
      <div className="card-model-grid" role="region" aria-label="カードモデル地一覧">
        {filteredCardModels.map((card) => <CardModelCard key={card.id} card={card} index={CARD_MODEL_INDEX_BY_ID.get(card.id) ?? -1} isPlanned={card.spotId ? itineraryIds.includes(card.spotId) : false} onOpenImage={setActiveGuideImage} onOpenMap={openCardModelOnMap} onTogglePlan={toggleItinerarySpot} />)}
      </div>
    </section>
  );
}

function ExploreSheet(): ReactElement {
  const {
    activeExplorePanel, closeExplorePanel, exploreSheetPanelRef,
    isExploreSheetClosing, isExploreSheetExpanded,
  } = usePilgrimageContext();
  return (
    <div className={`explore-sheet${isExploreSheetClosing ? " is-closing" : ""}`} hidden={!activeExplorePanel} role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) closeExplorePanel();
    }}>
      <div ref={exploreSheetPanelRef} className={`explore-sheet__panel${isExploreSheetExpanded ? " is-expanded" : ""}`} role="dialog" aria-modal="true" aria-labelledby="explore-sheet-title">
        <ExploreSheetSwipeZone />
        <div className="explore-sheet__body"><SpotsPanel /><CardModelsPanel /></div>
      </div>
    </div>
  );
}

function MapSectionHeading(): ReactElement {
  const { activePage, mapReturnSection, navigateToPage } = usePilgrimageContext();
  const returnLabel = mapReturnSection === "spots"
    ? "スポット一覧へ戻る"
    : mapReturnSection === "card-models" ? "カードモデル地へ戻る" : "探し方へ戻る";
  return (
    <div className="section-heading">
      <div>
        <h2>{activePage === "planner" ? "予定を作る" : "スポットを地図から探す"}</h2>
        {activePage === "explore" ? (
          <button type="button" className="map-return-link" onClick={() => navigateToPage("explore", mapReturnSection)}>
            <span aria-hidden="true">←</span>{returnLabel}
          </button>
        ) : null}
      </div>
      <p>{activePage === "planner" ? "訪問日・出発時刻・移動手段は、下の項目を押して変更できます。" : "ピンを選択すると、スポット情報の確認と予定への追加ができます。"}</p>
    </div>
  );
}

function PlannerDaysSection(): ReactElement | null {
  const {
    activeDayIndex, activePage, addPlannerDay, plannerDays, previousHotelName,
    removeActivePlannerDay, selectPlannerDay,
  } = usePilgrimageContext();
  if (activePage !== "planner" || plannerDays.length <= 1) return null;
  return (
    <section className="planner-days" aria-labelledby="planner-days-title">
      <div className="planner-days__heading">
        <div><strong id="planner-days-title">旅行日程</strong><span>{plannerDays.length}日間</span></div>
        <button type="button" onClick={addPlannerDay} disabled={plannerDays.length >= 7}>日程を追加</button>
      </div>
      <div className="planner-days__tabs" role="tablist" aria-label="編集する日を選択">
        {plannerDays.map((day, index) => (
          <button type="button" role="tab" key={day.id} aria-selected={index === activeDayIndex} className={index === activeDayIndex ? "is-current" : undefined} onClick={() => selectPlannerDay(index)}>
            <strong>{index + 1}日目</strong><span>{day.visitDate.replaceAll("-", "/")}</span><small>{day.itineraryIds.length}か所</small>
          </button>
        ))}
      </div>
      <div className="planner-days__active-note">
        {previousHotelName ? <span>前日の宿泊地：{previousHotelName}</span> : <span />}
        <button type="button" onClick={removeActivePlannerDay} disabled={plannerDays.length <= 1}>この日を削除</button>
      </div>
    </section>
  );
}

function PlannerOverview(): ReactElement | null {
  const {
    activePage, invalidateRoute, itineraryIds, setStartTime, setTravelMode,
    setVisitDate, sourceStationId, startTime, travelMode, visitDate,
  } = usePilgrimageContext();
  if (activePage !== "planner") return null;
  const changeVisitDate = (value: string): void => {
    setVisitDate(value);
    if (travelMode === "TRANSIT" || sourceStationId) invalidateRoute();
  };
  const changeStartTime = (value: string): void => {
    setStartTime(value);
    if (travelMode === "TRANSIT" || sourceStationId) invalidateRoute();
  };
  const changeTravelMode = (value: TravelMode): void => {
    setTravelMode(value);
    invalidateRoute();
  };
  return (
    <div className="planner-overview" aria-label="現在の予定概要">
      <span className="planner-overview__static"><small>訪問先</small><strong>{itineraryIds.length}か所</strong></span>
      <label className="planner-overview__control"><small>訪問日</small><input type="date" min={japanDate()} max={japanDate(99)} value={visitDate} aria-label="訪問日" onChange={(event) => changeVisitDate(event.target.value)} /></label>
      <label className="planner-overview__control"><small>出発時刻</small><input type="time" value={startTime} aria-label="出発時刻" onChange={(event) => changeStartTime(event.target.value)} /></label>
      <label className="planner-overview__control"><small>移動手段</small><select value={travelMode} aria-label="移動手段" onChange={(event) => changeTravelMode(event.target.value as TravelMode)}>
        {travelModes.filter((mode) => !mode.disabled).map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
      </select></label>
    </div>
  );
}

function PlannerShareLaunch(): ReactElement | null {
  const { activePage, allPlannedSpotCount, openShareDialog, shareDialogTriggerRef } = usePilgrimageContext();
  if (activePage !== "planner") return null;
  return (
    <section className="planner-share-launch" aria-label="予定の共有">
      <div><small>SHARE PLAN</small><strong>この予定を共有</strong><span>宿泊地・自由予定・進捗・出発駅は共有されません。</span></div>
      <button type="button" ref={shareDialogTriggerRef} onClick={openShareDialog} disabled={!allPlannedSpotCount}>予定を共有<span aria-hidden="true">↗</span></button>
    </section>
  );
}

function MapSearchResults(): ReactElement | null {
  const {
    mapSearchQuery, mapSearchResults, selectedCardModelId, setMapSearchQuery,
    setSelectedCardModelId, setSelectedId,
  } = usePilgrimageContext();
  if (!mapSearchQuery.trim()) return null;
  const selectResult = (result: MapSearchResult): void => {
    setSelectedId(result.spot.id);
    setSelectedCardModelId(result.card?.id ?? null);
    setMapSearchQuery("");
  };
  return (
    <div className="map-search__results" role="listbox" aria-label="地図の検索結果">
      {mapSearchResults.length ? mapSearchResults.map((result) => (
        <button type="button" role="option" aria-selected={result.kind === "card" && selectedCardModelId === result.id} key={`${result.kind}-${result.id}`} onClick={() => selectResult(result)}>
          <span>{result.kind === "card" ? "カード" : "スポット"}</span>
          <strong>{result.kind === "card" ? result.card.card : result.spot.name}</strong>
          <small>{result.kind === "card" ? result.card.model : result.spot.address}</small>
        </button>
      )) : <p>登録済みのスポット・カードに一致する場所がありません。</p>}
    </div>
  );
}

function MapSearch(): ReactElement {
  const { mapSearchQuery, setMapSearchQuery } = usePilgrimageContext();
  return (
    <div className="map-search">
      <label htmlFor="map-freeword-search">地図から検索</label>
      <div className="map-search__field">
        <span aria-hidden="true">⌕</span>
        <input id="map-freeword-search" type="search" value={mapSearchQuery} onChange={(event) => setMapSearchQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape") setMapSearchQuery("");
        }} placeholder="施設名・住所・カード・キャラクターで検索" autoComplete="off" />
      </div>
      <MapSearchResults />
    </div>
  );
}

function MapColumn(): ReactElement {
  const {
    activePage, handleRouteResult, itineraryIds, itinerarySpots, mapFocusRequest,
    mapboxConfig, routeRequest, selectedId, setSelectedCardModelId, setSelectedId, spots,
  } = usePilgrimageContext();
  const selectSpot = (id: string): void => {
    setSelectedId(id);
    setSelectedCardModelId(null);
  };
  return (
    <div className={`map-column${activePage === "planner" ? " map-column--route" : ""}`} hidden={activePage !== "explore" && activePage !== "planner"}>
      {activePage === "explore" ? <MapSearch /> : (
        <div className="planner-route-map__heading"><div><small>ROUTE MAP</small><strong>予定の経路</strong></div><span>{itinerarySpots.length}か所</span></div>
      )}
      {activePage !== "shared" ? (
        <MapboxPilgrimageMap spots={activePage === "planner" ? itinerarySpots : spots} selectedId={selectedId} focusSpotRequest={mapFocusRequest} plannedSpotIds={itineraryIds} cardModelSpotIds={CARD_MODEL_SPOT_IDS} onSelect={selectSpot} routeRequest={routeRequest} onRouteResult={handleRouteResult} accessToken={mapboxConfig.accessToken} isVisible={activePage === "explore" || activePage === "planner"} viewMode={activePage === "planner" ? "planner" : "explore"} />
      ) : null}
    </div>
  );
}

function SelectedSpotPhotos(): ReactElement | null {
  const {
    photoCredits, selectedSpot, selectedSpotPhotos, setActiveGuideImage,
  } = usePilgrimageContext();
  if (!selectedSpotPhotos.length) return null;
  return (
    <div className="selected-map-detail__photos">
      <div className="selected-map-detail__cards-heading"><strong>この場所の写真</strong><span>{selectedSpotPhotos.length}枚</span></div>
      <div className="selected-map-detail__photo-grid">
        {selectedSpotPhotos.map((imageUrl, index) => (
          <button type="button" key={imageUrl} aria-label={`${selectedSpot.name}の写真${index + 1}を拡大表示`} onClick={() => setActiveGuideImage({
            src: imageUrl, alt: `${selectedSpot.name}の写真 ${index + 1}`, variant: "spot", credit: photoCredits[imageUrl],
          })}>
            <img src={imageUrl} alt="" loading="lazy" decoding="async" />
            <span>{String(index + 1).padStart(2, "0")}</span>
            {photoCredits[imageUrl] ? <small className="selected-map-detail__photo-credit">写真：{photoCredits[imageUrl]}</small> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectedSpotCards(): ReactElement | null {
  const { selectedCardModel, selectedSpotCards } = usePilgrimageContext();
  if (!selectedSpotCards.length) return null;
  return (
    <div className="selected-map-detail__cards">
      <div className="selected-map-detail__cards-heading"><strong>この場所に関連するカード</strong><span>{selectedSpotCards.length}件</span></div>
      <div className="selected-map-detail__card-grid">
        {selectedSpotCards.map((card) => (
          <article key={card.id} className={`${card.imageUrl ? "has-image" : ""}${selectedCardModel?.id === card.id ? " is-selected" : ""}`.trim() || undefined}>
            {card.imageUrl ? <img src={card.imageUrl} alt="" loading="lazy" decoding="async" /> : null}
            <div><small>カードモデル地</small><strong>{card.card}</strong><span>{card.model}</span></div>
          </article>
        ))}
      </div>
    </div>
  );
}

function SelectedMapDetail(): ReactElement {
  const { activePage, itineraryIds, selectedSpot, toggleItinerarySpot } = usePilgrimageContext();
  const description = publicSpotDescription(selectedSpot.description);
  return (
    <div className="selected-map-detail" hidden={activePage !== "explore"}>
      <div className="selected-map-detail__heading">
        <div><small>{selectedSpot.area} · {selectedSpot.category}</small><strong>{selectedSpot.name}</strong><span>{selectedSpot.address}</span></div>
        <button type="button" disabled={!itineraryIds.includes(selectedSpot.id) && itineraryIds.length >= maximumItineraryStops} onClick={() => toggleItinerarySpot(selectedSpot.id)}>
          {itineraryIds.includes(selectedSpot.id) ? "予定から外す" : "予定に追加する"}<span aria-hidden="true">→</span>
        </button>
      </div>
      {description ? <p className="selected-map-detail__description">{description}</p> : null}
      <SelectedSpotPhotos /><SelectedSpotCards />
    </div>
  );
}

function ItineraryEditor(): ReactElement {
  const {
    activePage, cancelItineraryDrag, changeStayMinutes, displayedItinerarySpots,
    draggedItinerarySpotId, finishItineraryDrag, focusItinerarySpot,
    handleItineraryDragKeyDown, itineraryIds, itinerarySpots, moveItineraryDrag,
    removeSpot, startItineraryDrag, stayMinutes,
  } = usePilgrimageContext();
  return (
    <aside className="route-planner" aria-label="訪問するスポット" hidden={activePage !== "planner"}>
      <div className="itinerary-editor">
        <div className="itinerary-editor__heading"><div><strong>訪問するスポット</strong><span>{itineraryIds.length} / {maximumItineraryStops}</span></div><small id="itinerary-reorder-hint">右端をドラッグして並べ替え</small></div>
        <ol onPointerMove={moveItineraryDrag} onPointerUp={finishItineraryDrag} onPointerCancel={cancelItineraryDrag} onLostPointerCapture={cancelItineraryDrag}>
          {!itinerarySpots.length ? <li className="itinerary-editor__empty">下の「探す」からスポットを追加してください。</li> : null}
          {displayedItinerarySpots.map((spot, index) => (
            <ItinerarySpotRow key={spot.id} spot={spot} index={index} total={itinerarySpots.length} stayMinutes={stayMinutes[spot.id] ?? recommendedStayMinutes(spot)} isDragging={draggedItinerarySpotId === spot.id} removeDisabled={draggedItinerarySpotId !== null} dragDisabled={itineraryIds.length < 2} onFocus={focusItinerarySpot} onStayMinutesChange={changeStayMinutes} onRemove={removeSpot} onDragStart={startItineraryDrag} onDragKeyDown={handleItineraryDragKeyDown} />
          ))}
        </ol>
      </div>
    </aside>
  );
}

function MapLayout(): ReactElement {
  return <div className="map-layout"><MapColumn /><SelectedMapDetail /><ItineraryEditor /></div>;
}

function TransitOrigin(): ReactElement | null {
  const { invalidateRoute, setSourceStationId, sourceStationId, travelMode } = usePilgrimageContext();
  if (travelMode !== "TRANSIT") return null;
  const changeOrigin = (value: string): void => {
    setSourceStationId(value);
    invalidateRoute();
  };
  return (
    <div className="transit-origin">
      <label><span>出発駅（任意）</span><select value={sourceStationId} onChange={(event) => changeOrigin(event.target.value)} aria-describedby="station-search-status">
        <option value="">現地の最初のスポットから開始</option>
        {Array.from(new Set(majorStations.map((station) => station.region))).map((region) => (
          <optgroup label={region} key={region}>{majorStations.filter((station) => station.region === region).map((station) => <option value={station.id} key={station.id}>{station.name}</option>)}</optgroup>
        ))}
      </select></label>
      <p id="station-search-status" className="journey-start__status">全国の主要駅から最初のスポットまでの検索も追加できます。</p>
    </div>
  );
}

function AppointmentRow({ appointment }: { appointment: PlannerAppointment }): ReactElement {
  const { removeAppointment, updateAppointment } = usePilgrimageContext();
  const updateDuration = (value: string): void => updateAppointment(appointment.id, {
    durationMinutes: Math.max(0, Math.min(720, Number(value) || 0)),
  });
  return (
    <li>
      <label className="planner-appointment__title"><span>予定名</span><input type="text" maxLength={80} value={appointment.title} onChange={(event) => updateAppointment(appointment.id, { title: event.target.value })} /></label>
      <label><span>開始</span><input type="time" value={appointment.time} onChange={(event) => updateAppointment(appointment.id, { time: event.target.value })} /></label>
      <label><span>所要</span><span className="planner-appointment__duration">
        <input type="number" min="0" max="720" step="5" value={appointment.durationMinutes} onChange={(event) => updateDuration(event.target.value)} />分
      </span></label>
      <button type="button" className="planner-appointment__remove" onClick={() => removeAppointment(appointment.id)} aria-label={`${appointment.title || "予定"}を削除`}>×</button>
    </li>
  );
}

function PlannerAppointments(): ReactElement {
  const { activePlannerDay, addAppointment } = usePilgrimageContext();
  return (
    <section className="planner-appointments" aria-labelledby="planner-appointments-title">
      <div className="planner-appointments__heading">
        <div><strong id="planner-appointments-title">時間を固定する予定</strong><span>予約・待ち合わせ・食事など</span></div>
        <button type="button" onClick={addAppointment} disabled={activePlannerDay.appointments.length >= 12}>予定を追加</button>
      </div>
      {activePlannerDay.appointments.length ? (
        <ol>{activePlannerDay.appointments.map((appointment) => <AppointmentRow key={appointment.id} appointment={appointment} />)}</ol>
      ) : <p>時間が決まっている予定があれば追加してください。</p>}
    </section>
  );
}

function PlannerExtras(): ReactElement {
  const { activePlannerDay, optionalPlannerSettingCount, updateActivePlannerDay } = usePilgrimageContext();
  return (
    <details className="planner-extras">
      <summary><span><strong>宿泊・予約を追加</strong><small>任意</small></span><em>{optionalPlannerSettingCount ? `${optionalPlannerSettingCount}件設定中` : "必要な場合のみ"}</em></summary>
      <div className="planner-extras__body">
        <div className="day-boundaries">
          <label><span>その日の終了目安</span><input type="time" value={activePlannerDay.endTime} onChange={(event) => updateActivePlannerDay({ endTime: event.target.value })} /></label>
          <label><span>宿泊地（任意）</span><input type="text" maxLength={120} value={activePlannerDay.hotelName} placeholder="ホテル名・宿泊施設名" onChange={(event) => updateActivePlannerDay({ hotelName: event.target.value })} /></label>
          <p>宿泊地は、翌日の開始地点メモにも表示されます。移動時間には含まれません。</p>
        </div>
        <PlannerAppointments />
      </div>
    </details>
  );
}

function RouteOptimize(): ReactElement {
  const { invalidateRoute, optimizeOrder, setOptimizeOrder, travelMode } = usePilgrimageContext();
  const updateOrder = (value: boolean): void => {
    setOptimizeOrder(value);
    invalidateRoute();
  };
  return (
    <label className={`route-optimize ${travelMode === "TRANSIT" ? "is-disabled" : ""}`}>
      <input type="checkbox" checked={travelMode !== "TRANSIT" && optimizeOrder} disabled={travelMode === "TRANSIT"} onChange={(event) => updateOrder(event.target.checked)} />
      <span><strong>おすすめの順番に並べる</strong><small>{travelMode === "TRANSIT" ? "公共交通では、選んだ順番で区間ごとに調べます。" : "最初と最後はそのままに、中間の順番を調整します。"}</small></span>
    </label>
  );
}

function PlannerConditions(): ReactElement {
  const { addPlannerDay, plannerDays } = usePilgrimageContext();
  return (
    <details className="planner-conditions">
      <summary><span><small>OPTIONAL</small><strong>詳細設定</strong></span><em>出発駅・宿泊・予約・訪問順</em></summary>
      <div className="journey-start">
        <TransitOrigin />
        {plannerDays.length === 1 ? <div className="multi-day-prompt"><span>宿泊を伴う旅行ですか？</span><button type="button" onClick={addPlannerDay}>複数日にする</button></div> : null}
        <PlannerExtras /><RouteOptimize />
      </div>
    </details>
  );
}

function PlannerFixedReview(): ReactElement | null {
  const { appointmentConflictIds, fixedAppointments } = usePilgrimageContext();
  if (!fixedAppointments.length) return null;
  return (
    <section className="planner-fixed-review" aria-label="時間を固定した予定">
      <strong>時間を固定した予定</strong>
      <ol>{fixedAppointments.map((appointment) => (
        <li key={appointment.id} className={appointmentConflictIds.has(appointment.id) ? "has-conflict" : undefined}>
          <time>{appointment.time}</time><span>{appointment.title || "名称未入力"}</span><small>{appointment.durationMinutes}分</small>
          {appointmentConflictIds.has(appointment.id) ? <em>計算した訪問予定と時間が重なります</em> : null}
        </li>
      ))}</ol>
    </section>
  );
}

function plannerActionLabel(controller: PilgrimageController): string {
  const { dayTimeWindowInvalid, itineraryIds, routeIsCurrent, routeResult, travelMode } = controller;
  if (itineraryIds.length < 2) return "訪問先を2か所以上選んでください";
  if (dayTimeWindowInvalid) return "日時を修正してください";
  if (routeResult.state === "loading") return "作成しています…";
  if (routeIsCurrent) return travelMode === "TRANSIT" ? "乗換検索を確認する" : "当日の予定を見る";
  if (routeResult.state === "error" || routeResult.state === "fallback") return "もう一度計算する";
  return "自動で予定を作成します";
}

function plannerActionNote(controller: PilgrimageController): string {
  const { routeIsCurrent, travelMode } = controller;
  if (routeIsCurrent) return travelMode === "TRANSIT"
    ? "区間検索を作成しました。内容を確認してください。"
    : "予定を作成しました。当日タブからいつでも確認できます。";
  return travelMode === "TRANSIT"
    ? "予定タブを開くと、指定順の区間検索を自動で作ります。"
    : "予定タブを開くと、移動時間と訪問順を自動で計算します。";
}

function PlannerCreateBar(): ReactElement {
  const controller = usePilgrimageContext();
  const { dayTimeWindowInvalid, handlePlannerPrimaryAction, itineraryIds, routeIsCurrent, routeResult } = controller;
  const disabled = itineraryIds.length < 2 || dayTimeWindowInvalid || routeResult.state === "loading"
    || (!routeIsCurrent && routeResult.state === "idle");
  return (
    <div className={`planner-create-bar${routeIsCurrent ? " is-complete" : ""}`}>
      <button className="route-search-button" type="button" onClick={handlePlannerPrimaryAction} disabled={disabled}>
        {plannerActionLabel(controller)}<span aria-hidden="true">→</span>
      </button>
      <p className="route-api-note">{plannerActionNote(controller)}</p>
    </div>
  );
}

function RouteWorkspaceControls(): ReactElement {
  const { activePlannerDay, dayTimeWindowInvalid, previousHotelName } = usePilgrimageContext();
  return (
    <div className="route-workspace__controls">
      <PlannerConditions />
      <div className="route-workspace__options">
        {previousHotelName || activePlannerDay.hotelName ? (
          <p className="planner-review__note">
            {previousHotelName ? `前泊：${previousHotelName}` : ""}{previousHotelName && activePlannerDay.hotelName ? " ／ " : ""}{activePlannerDay.hotelName ? `宿泊：${activePlannerDay.hotelName}` : ""}
          </p>
        ) : null}
        <PlannerFixedReview />
        {dayTimeWindowInvalid ? <p className="planner-window-warning">終了目安は出発時刻より後に設定してください。</p> : null}
        <PlannerCreateBar />
      </div>
    </div>
  );
}

function RouteResultPanel(): ReactElement {
  const { itineraryIds, routeResult } = usePilgrimageContext();
  return (
    <div className={`route-result route-result--${routeResult.state}`} aria-live="polite">
      {routeResult.state === "idle" && <><span className="result-symbol">＋</span><p>{itineraryIds.length < 2 ? "訪問先を2か所以上選び、滞在時間と訪問順を決めてください。" : "選んだ訪問先から予定を自動で作成します。"}</p></>}
      {routeResult.state === "loading" && <><span className="result-symbol is-loading">◌</span><p>移動ルートと一日の予定を計算しています…</p></>}
      {routeResult.state === "success" && (
        <><span className="result-symbol">✓</span><div className="result-details"><div className="result-metrics">
          <span><small>距離</small><strong>{routeResult.distance ?? "—"}</strong></span>
          <span><small>総移動時間</small><strong>{routeResult.duration ?? "—"}</strong></span>
        </div></div></>
      )}
      {routeResult.state === "external" && <><span className="result-symbol">交</span><p>{routeResult.message}</p></>}
      {(routeResult.state === "fallback" || routeResult.state === "error") && <><span className="result-symbol">i</span><p>{routeResult.message}</p></>}
    </div>
  );
}

function TransitSearchPanel(): ReactElement | null {
  const { confirmedTransitLegCount, transitLegs, updateTransitLegProgress, visitDate } = usePilgrimageContext();
  if (!transitLegs.length) return null;
  return (
    <details className="transit-search-panel" id="transit-search-panel">
      <summary className="transit-search-panel__heading">
        <div><small>PUBLIC TRANSIT</small><strong>Yahoo!乗換案内の区間検索</strong></div>
        <span>{confirmedTransitLegCount} / {transitLegs.length} 確認済み</span>
      </summary>
      <progress className="transit-search-panel__progress" value={confirmedTransitLegCount} max={transitLegs.length} aria-label={`${transitLegs.length}区間中${confirmedTransitLegCount}区間を確認済み`} />
      <p>2区間目以降の時刻は、移動を各60分として仮置きしています。 前の検索結果に合わせて出発時刻を調整し、確認済みにしてください。</p>
      <ol>{transitLegs.map((leg, index) => <TransitLegRow key={leg.id} leg={leg} index={index} visitDate={visitDate} onProgressChange={updateTransitLegProgress} />)}</ol>
      <small>確認状態と調整した時刻は、この端末の旅程にだけ保存されます。 Yahoo!側で表示される施設候補、運休日、臨時ダイヤも確認してください。</small>
    </details>
  );
}

function DayScheduleFixed(): ReactElement | null {
  const { appointmentConflictIds, fixedAppointments } = usePilgrimageContext();
  if (!fixedAppointments.length) return null;
  return (
    <div className="day-schedule__fixed">
      <strong>時間を固定した予定</strong>
      <ol>{fixedAppointments.map((appointment) => (
        <li key={appointment.id} className={appointmentConflictIds.has(appointment.id) ? "has-conflict" : undefined}>
          <time>{appointment.time}</time><div><strong>{appointment.title || "名称未入力"}</strong><small>{appointment.durationMinutes}分</small>
            {appointmentConflictIds.has(appointment.id) ? <span>訪問予定と重なるため調整が必要です</span> : null}
          </div>
        </li>
      ))}</ol>
    </div>
  );
}

type ScheduleEntryProps = {
  entry: NonNullable<PilgrimageController["schedule"]>["entries"][number];
  index: number;
};

function ScheduleEntry({ entry, index }: ScheduleEntryProps): ReactElement {
  const { routeResult, visitDate } = usePilgrimageContext();
  const hoursStatus = openingHoursStatus(entry.spot, visitDate, entry.arrival);
  return (
    <li>
      <time>{displayClock(entry.arrival)}</time>
      <div>
        <strong>{entry.spot.shortName}</strong>
        <small>{entry.stay}分滞在 · {displayClock(entry.departure)}出発</small>
        <small className={`opening-status opening-status--${hoursStatus.kind}`}>{hoursStatus.label}</small>
        {routeResult.legDurationMinutes?.[index] ? <span>次へ 約{formatDuration(routeResult.legDurationMinutes[index])}</span> : null}
      </div>
    </li>
  );
}

function DaySchedule(): ReactElement | null {
  const {
    activePlannerDay, routeRequest, routeResult, schedule, scheduleOverrunMinutes, visitDate,
  } = usePilgrimageContext();
  if (!schedule || routeResult.state !== "success") return null;
  const orderWasOptimized = routeResult.orderedStopIds?.join("|")
    !== routeRequest?.stops.map((spot) => spot.id).join("|");
  return (
    <section className="day-schedule" id="created-plan" aria-label="作成した一日予定">
      <div className="day-schedule__heading"><div><small>YOUR DAY</small><strong>{visitDate.replaceAll("-", ".")}</strong></div><span>{displayClock(schedule.finish)} 終了予定</span></div>
      {scheduleOverrunMinutes ? <p className="day-schedule__warning">終了目安の{activePlannerDay.endTime}を約{formatDuration(scheduleOverrunMinutes)}超えます。 滞在時間、訪問先、出発時刻を調整してください。</p> : null}
      {routeRequest?.accessOrigin && <div className="access-schedule"><time>{displayClock(schedule.start)}</time><p><strong>{routeRequest.accessOrigin.name}</strong>を出発</p><small>公共交通 約{formatDuration(schedule.accessDuration)}</small></div>}
      <DayScheduleFixed />
      <ol>{schedule.entries.map((entry, index) => <ScheduleEntry key={entry.spot.id} entry={entry} index={index} />)}</ol>
      {activePlannerDay.hotelName ? <div className="day-schedule__hotel"><time>{displayClock(schedule.finish)}</time><div><strong>宿泊地：{activePlannerDay.hotelName}</strong><small>宿泊地までの移動時間は計算に含まれていません</small></div></div> : null}
      <p>滞在込み <strong>{formatDuration(schedule.finish - schedule.start)}</strong>{orderWasOptimized ? " · おすすめの順番で表示" : ""}</p>
    </section>
  );
}

function RouteWorkspace(): ReactElement {
  const { activePage } = usePilgrimageContext();
  return (
    <section className="route-workspace" id="planner" aria-label="予定の詳細と一日の予定" hidden={activePage !== "planner"}>
      <RouteWorkspaceControls /><RouteResultPanel /><TransitSearchPanel /><DaySchedule />
    </section>
  );
}

function MapSection(): ReactElement {
  const { activePage } = usePilgrimageContext();
  return (
    <section className="map-section" id="map" hidden={activePage !== "explore" && activePage !== "planner"}>
      <MapSectionHeading /><PlannerDaysSection />
      <PlannerOverview /><PlannerShareLaunch />
      <MapLayout /><RouteWorkspace />
    </section>
  );
}

export function PilgrimageApp(props: Props): ReactElement {
  const controller = usePilgrimageController(props);
  return (
    <PilgrimageContext.Provider value={controller}>
      <PilgrimageView />
    </PilgrimageContext.Provider>
  );
}

function PilgrimageView(): ReactElement {
  const { activePage, heroImage } = usePilgrimageContext();
  return (
    <>
      <main className={`app-shell app-page--${activePage}${heroImage ? " has-managed-hero" : ""}`} data-page={activePage}>
      <SiteHeader />

      <MobileExplorePicker />
      <MobileNavigation />

      <HeroSection />
      <ExploreMenu />

      <MapSection />

      <CollaborationsSection />
      <ContributionSection />

      <ExploreSheet />

      <GuidePage />
      <SiteDisclaimer />

      <SharedPlanPage />

      <SiteFooter />
      </main>

      <ShareModal />

      <GuideImageModal />

      <TodayPage />
    </>
  );
}
