import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  MapboxPilgrimageMap,
  type RouteRequest,
  type RouteResult,
} from "../../app/MapboxPilgrimageMap";
import {
  formatOpeningHours,
  formatDuration,
  majorStations,
  maximumItineraryStops,
  openingHoursStatus,
  recommendedStayMinutes,
  type TravelMode,
} from "../../app/route-planner";
import {
  decodeSharedPlanSnapshot,
  type SharedPlanSnapshot,
} from "../../app/planner-share";
import {
  cardCharacters,
  cardModels,
  collaborations,
  type CardCharacter,
  type PilgrimageCollaboration,
  type PilgrimageSpot,
} from "../../app/spots";
import { CommunityContributionPanel } from "../../app/CommunityContributionPanel";
import { buildYahooTransitUrl } from "../../app/yahoo-transit";
import {
  departureIso,
  displayClock,
  japanDate,
  timeToMinutes,
  useLivePlanner,
  type ScheduleEntry,
} from "./use-live-planner";
import {
  filterTrialCards,
  hasValidTimeWindow,
  hasValidVisitDate,
  orderItemsByIds,
} from "./trial-utils";

type TrialPage = "explore" | "planner" | "today" | "guide";
type TrialView = TrialPage | "shared";
type ExploreMode = "spots" | "collaboration" | "map" | "cards";
type ExploreSourceFilter = "all" | "activity" | "sehas" | "with-meets";

type ModalState =
  | { kind: "image"; src: string; alt: string; credit?: string; copyright?: string }
  | { kind: "share"; url: string; includeDates: boolean }
  | { kind: "spot"; spot: PilgrimageSpot; photos: string[]; credits: Record<string, string> }
  | { kind: "spot-map"; spot: PilgrimageSpot }
  | null;

type UiTrialAppProps = {
  spots: PilgrimageSpot[];
  spotPhotoGroups: Record<string, string[]>;
  photoCredits: Record<string, string>;
  heroImages: string[];
  initialHeroIndex: number;
  siteVersion: string;
  communityApiUrl: string;
  turnstileSiteKey: string;
  communitySubmissionsEnabled: boolean;
};

const baseUrl = import.meta.env.BASE_URL;
const cardModelSpotIds = Array.from(new Set(cardModels.flatMap((card) => card.spotId ? [card.spotId] : [])));
const mapboxAccessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim() ?? "";
const shareMessage = "訪問予定を共有します。\n#蓮ノ旅";
const CARD_ILLUSTRATION_COPYRIGHT = "©︎PL!HS ©︎S ©︎2023 BNML ©︎ODD No.";
const pageLabels: Record<TrialPage, string> = {
  explore: "探す",
  planner: "予定",
  today: "当日",
  guide: "ガイド",
};

const exploreChoices = [
  { number: "01", label: "地図", note: "場所から", mode: "map" as const },
  { number: "02", label: "スポット", note: "登録スポット", mode: "spots" as const },
  { number: "03", label: "カード", note: "モデル地から", mode: "cards" as const },
  { number: "04", label: "コラボ", note: "開催情報から", mode: "collaboration" as const },
];

const guideSteps = [
  {
    number: "01",
    title: "探し方を選ぶ",
    description: "地図・スポット・カード・コラボから入口を選ぶ。",
    image: "guide/02-choose-method.png",
    alt: "探し方を選ぶ画面",
  },
  {
    number: "02",
    title: "予定に追加する",
    description: "気になる場所を見つけたら、順番を気にせず追加。",
    image: "guide/03-add-spots.png",
    alt: "スポット一覧から場所を選ぶ画面",
    secondaryImage: "guide/07-card-search.png",
    secondaryAlt: "カードからモデル地を選ぶ画面",
  },
  {
    number: "03",
    title: "一日を整える",
    description: "訪問順、滞在時間、出発時刻、移動手段を調整。",
    image: "guide/04-plan-stops.png",
    alt: "訪問するスポットと滞在時間を編集する画面",
    secondaryImage: "guide/05-plan-time.png",
    secondaryAlt: "移動手段と訪問日時を設定する画面",
  },
  {
    number: "04",
    title: "当日は見るだけ",
    description: "次の場所と時刻を確認しながら進む。",
    image: "guide/06-plan-check.png",
    alt: "予定内容を確認して計算する画面",
  },
] as const;

function assetUrl(path: string) {
  return `${baseUrl}${path.replace(/^\//, "")}`;
}

function displayAssetUrl(path: string) {
  return /^(?:https?:|data:|blob:)/.test(path) || path.startsWith(baseUrl) ? path : assetUrl(path);
}

function spotPhoto(spot: PilgrimageSpot | undefined, spotPhotoGroups: Record<string, string[]>) {
  const source = spot ? spotPhotoGroups[spot.id]?.[0] ?? spot.imageUrl : undefined;
  return source ? displayAssetUrl(source) : undefined;
}

function publicSpotDescription(description: string) {
  return description.replace(/期間限定[^。]*。?/g, "").trim();
}

function collaborationStatus(collaboration: PilgrimageCollaboration) {
  const today = japanDate();
  if (today < collaboration.startDate) return "開催前";
  if (today > collaboration.endDate) return "終了";
  return "開催中";
}

function formatCollaborationDate(value: string) {
  return value.replaceAll("-", ".");
}

function SpotName({ name }: { name: string }) {
  const words = name.trim().split(/\s+/);
  return <>{words.map((word, index) => (
    <span className="ui-trial__spot-name-token" key={`${word}-${index}`}>{word}{index < words.length - 1 ? " " : ""}</span>
  ))}</>;
}

function EmptySpotPhoto({ className, spotName }: { className: string; spotName: string }) {
  return (
    <span className={`${className} is-empty`} role="img" aria-label={`${spotName}の写真はまだ登録されていません`}>
      <svg viewBox="0 0 32 26" aria-hidden="true">
        <path d="M4.5 8.5h4l2-3h11l2 3h4v14h-23z" />
        <circle cx="16" cy="15.5" r="4.5" />
        <path className="ui-trial__photo-empty-slash" d="M3 3l26 21" />
      </svg>
      <small className="ui-trial__photo-empty-short" aria-hidden="true">写真未登録</small>
      <small className="ui-trial__photo-empty-long" aria-hidden="true">写真はまだ登録されていません</small>
    </span>
  );
}

function ExploreModeTabs({ activeMode, onSelect }: {
  activeMode: ExploreMode;
  onSelect: (mode: ExploreMode) => void;
}) {
  return (
    <div className="ui-trial__explore-mode-tabs" role="tablist" aria-label="探し方を切り替え">
      {exploreChoices.filter((choice) => choice.mode !== "map").map((choice) => (
        <button
          className={activeMode === choice.mode ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={activeMode === choice.mode}
          onClick={() => onSelect(choice.mode)}
          key={choice.mode}
        >{choice.label}</button>
      ))}
    </div>
  );
}

function PageLink({ page, currentPage, onNavigate, children }: {
  page: TrialPage;
  currentPage: TrialPage;
  onNavigate: (page: TrialPage) => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={currentPage === page ? "page" : undefined}
      onClick={() => onNavigate(page)}
    >
      {children ?? pageLabels[page]}
    </button>
  );
}

function Brand() {
  return (
    <button className="ui-trial__brand" type="button" aria-label="蓮ノ旅 探すページ">
      <span aria-hidden="true">蓮</span>
      <span>
        <strong>蓮ノ旅</strong>
        <small>HASUNOSORA PILGRIMAGE GUIDE</small>
      </span>
    </button>
  );
}

function TrialHeader({ page, itineraryCount, completedCount, visitDate, activeDayIndex, sharedPreview = false, onNavigate, onOpenShare }: {
  page: TrialPage;
  itineraryCount: number;
  completedCount: number;
  visitDate: string;
  activeDayIndex: number;
  sharedPreview?: boolean;
  onNavigate: (page: TrialPage) => void;
  onOpenShare: () => void;
}) {
  return (
    <header className={`ui-trial__header${page === "today" ? " ui-trial__header--today" : ""}`}>
      <div className="ui-trial__desktop-brand" onClick={() => onNavigate("explore")}>
        <Brand />
      </div>
      <div className="ui-trial__mobile-title">
        {page === "explore" ? (
          <div onClick={() => onNavigate("explore")}><Brand /></div>
        ) : (
          <div>
            <strong>{pageLabels[page]}</strong>
            <small>{page === "planner" ? `${visitDate.replaceAll("-", ".")} / DAY ${String(activeDayIndex + 1).padStart(2, "0")}` : page === "today" ? `TODAY / ${visitDate.slice(5).replace("-", ".")}` : "USER GUIDE / JOURNEY 00"}</small>
          </div>
        )}
      </div>
      <nav className="ui-trial__desktop-nav" aria-label="メインナビゲーション">
        {(Object.keys(pageLabels) as TrialPage[]).map((navPage) => (
          <PageLink page={navPage} currentPage={page} onNavigate={onNavigate} key={navPage}>
            {pageLabels[navPage]}
            {navPage === "planner" && itineraryCount > 0 ? <b>{itineraryCount}</b> : null}
          </PageLink>
        ))}
      </nav>
      {page === "planner" && !sharedPreview ? (
        <button className="ui-trial__mobile-share" type="button" onClick={onOpenShare}>共有する <span aria-hidden="true">↗</span></button>
      ) : null}
      {page === "today" ? <strong className="ui-trial__mobile-progress">{completedCount} / {itineraryCount}</strong> : null}
      <a className="ui-trial__official" href="https://www.lovelive-anime.jp/hasunosora/" target="_blank" rel="noreferrer">
        作品公式サイト <span aria-hidden="true">↗</span>
      </a>
    </header>
  );
}

function TrialNavigation({ page, itineraryCount, onNavigate }: {
  page: TrialPage;
  itineraryCount: number;
  onNavigate: (page: TrialPage) => void;
}) {
  return (
    <nav className="ui-trial__mobile-nav" aria-label="スマートフォン用メニュー">
      {(Object.keys(pageLabels) as TrialPage[]).map((navPage) => (
        <PageLink page={navPage} currentPage={page} onNavigate={onNavigate} key={navPage}>
          {pageLabels[navPage]}
          {navPage === "planner" && itineraryCount > 0 ? <b>{itineraryCount}</b> : null}
        </PageLink>
      ))}
    </nav>
  );
}

function ExplorePage({
  spots,
  spotPhotoGroups,
  photoCredits,
  fallbackPhoto,
  planned,
  mapView,
  onTogglePlanned,
  onNavigate,
  onOpenMap,
  onOpenSpot,
  onOpenImage,
  onFillCollaboration,
}: {
  spots: PilgrimageSpot[];
  spotPhotoGroups: Record<string, string[]>;
  photoCredits: Record<string, string>;
  fallbackPhoto: string;
  planned: PilgrimageSpot[];
  mapView: boolean;
  onTogglePlanned: (spot: PilgrimageSpot) => void;
  onNavigate: (page: TrialPage) => void;
  onOpenMap: () => void;
  onOpenSpot: (spot: PilgrimageSpot) => void;
  onOpenImage: (src: string, alt: string, credit?: string, copyright?: string) => void;
  onFillCollaboration: (collaboration: PilgrimageCollaboration) => void;
}) {
  const exploreAreas = useMemo(() => Array.from(new Set(spots.map((spot) => spot.area))).sort((a, b) => a.localeCompare(b, "ja")), [spots]);
  const exploreCategories = useMemo(() => Array.from(new Set(spots.map((spot) => spot.category))).sort((a, b) => a.localeCompare(b, "ja")), [spots]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Exclude<ExploreMode, "map">>("spots");
  const [openExploreModal, setOpenExploreModal] = useState<Exclude<ExploreMode, "map"> | null>(null);
  const [modalFiltersExpanded, setModalFiltersExpanded] = useState(false);
  const [areaFilter, setAreaFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [spotQuery, setSpotQuery] = useState("");
  const [spotAreaFilter, setSpotAreaFilter] = useState("all");
  const [spotCategoryFilter, setSpotCategoryFilter] = useState("all");
  const [spotSourceFilter, setSpotSourceFilter] = useState<ExploreSourceFilter>("all");
  const [cardCharacterFilter, setCardCharacterFilter] = useState<CardCharacter | "all">("all");
  const [mapQuery, setMapQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const today = japanDate();
  const activeCollaborations = collaborations.filter((collaboration) => (
    collaboration.startDate <= today && collaboration.endDate >= today
  ));
  const availableCollaborations = activeCollaborations.length > 0 ? activeCollaborations : collaborations;
  const [selectedCollaborationId, setSelectedCollaborationId] = useState(availableCollaborations[0]?.id ?? "");
  const exploreModalCloseRef = useRef<HTMLButtonElement>(null);
  const exploreModalDialogRef = useRef<HTMLElement>(null);
  const exploreModalBodyRef = useRef<HTMLDivElement>(null);
  const exploreSheetDragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    collapsedHeight: number;
    maximumHeight: number;
    startedExpanded: boolean;
    dragged: boolean;
  } | null>(null);
  const [exploreSheetExpanded, setExploreSheetExpanded] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase("ja");
  const normalizedSpotQuery = spotQuery.trim().toLocaleLowerCase("ja");
  const currentCollaboration = availableCollaborations.find(
    (collaboration) => collaboration.id === selectedCollaborationId,
  ) ?? availableCollaborations[0];
  const collaborationSpotIds = new Set(currentCollaboration?.locations.map((location) => location.spotId) ?? []);
  const matchesSource = (spot: PilgrimageSpot, filter: ExploreSourceFilter) => (
    filter === "all" ||
    (filter === "activity" && Boolean(spot.activityRecords?.length)) ||
    (filter === "sehas" && Boolean(spot.sehasEpisodes?.length)) ||
    (filter === "with-meets" && Boolean(spot.withMeetsEpisodes?.length))
  );
  const filteredStandardSpots = spots.filter((spot) => {
    if (spotAreaFilter !== "all" && spot.area !== spotAreaFilter) return false;
    if (spotCategoryFilter !== "all" && spot.category !== spotCategoryFilter) return false;
    if (!matchesSource(spot, spotSourceFilter)) return false;
    if (!normalizedSpotQuery) return true;
    return [
      spot.name,
      spot.shortName,
      spot.area,
      spot.category,
      spot.address,
      spot.description,
      spot.accessNote,
      ...(spot.activityRecords ?? []),
      ...(spot.sehasEpisodes ?? []),
      ...(spot.withMeetsEpisodes ?? []),
      ...(spot.appearances ?? []),
    ]
      .some((value) => value.toLocaleLowerCase("ja").includes(normalizedSpotQuery));
  });
  const filteredSpots = spots.filter((spot) => {
    if (mode === "collaboration" && !collaborationSpotIds.has(spot.id)) return false;
    return true;
  });
  const filteredCards = filterTrialCards(cardModels, spots, {
    query,
    area: areaFilter,
    category: categoryFilter,
    character: cardCharacterFilter,
  });
  const normalizedMapQuery = mapQuery.trim().toLocaleLowerCase("ja");
  const mapSearchResults = normalizedMapQuery
    ? [
      ...spots.map((spot) => ({
        kind: "spot" as const,
        id: spot.id,
        spot,
        title: spot.name,
        subtitle: spot.address,
        values: [spot.name, spot.shortName, spot.address, spot.area, ...(spot.activityRecords ?? []), ...(spot.sehasEpisodes ?? []), ...(spot.withMeetsEpisodes ?? [])],
      })),
      ...cardModels.flatMap((card) => {
        const spot = spots.find((item) => item.id === card.spotId);
        return spot ? [{
          kind: "card" as const,
          id: card.id,
          spot,
          title: card.card,
          subtitle: `${card.model} · ${card.characters.join("・")}`,
          values: [card.card, card.model, card.address, card.note, ...card.characters, spot.name],
        }] : [];
      }),
    ].filter((result) => result.values.some((value) => value.toLocaleLowerCase("ja").includes(normalizedMapQuery))).slice(0, 8)
    : [];
  const selectedCandidate = spots.find((spot) => spot.id === selectedId);
  const mapSelectedSpot = selectedCandidate ?? spots[0];
  const mapSelectedCards = mapSelectedSpot
    ? cardModels.filter((card) => card.spotId === mapSelectedSpot.id)
    : [];
  const cardSpotIds = new Set(filteredCards.flatMap((card) => card.spotId ? [card.spotId] : []));
  const selectedSpot = mode === "cards"
    ? (selectedCandidate && cardSpotIds.has(selectedCandidate.id)
      ? selectedCandidate
      : spots.find((spot) => spot.id === filteredCards[0]?.spotId))
    : (filteredSpots.find((spot) => spot.id === selectedCandidate?.id) ?? filteredSpots[0]);
  const mapSelectedPhoto = spotPhoto(mapSelectedSpot, spotPhotoGroups);
  const selectedSpotPhoto = spotPhoto(selectedSpot, spotPhotoGroups);
  const selectedIsPlanned = Boolean(selectedSpot && planned.some((spot) => spot.id === selectedSpot.id));
  const selectedCollaborationLocation = mode === "collaboration"
    ? currentCollaboration?.locations.find((location) => location.spotId === selectedSpot?.id)
    : undefined;
  const selectedNumber = Math.max(0, mode === "cards"
    ? filteredCards.findIndex((card) => card.spotId === selectedSpot?.id)
    : filteredSpots.findIndex((spot) => spot.id === selectedSpot?.id)) + 1;
  const activeFilterCount = Number(Boolean(normalizedQuery)) + Number(areaFilter !== "all") + Number(categoryFilter !== "all") + Number(cardCharacterFilter !== "all");
  const standardFilterCount = Number(Boolean(normalizedSpotQuery)) + Number(spotAreaFilter !== "all") + Number(spotCategoryFilter !== "all") + Number(spotSourceFilter !== "all");
  const modalFilterCount = openExploreModal === "spots" ? standardFilterCount : activeFilterCount;
  const modalTitle = openExploreModal === "cards"
    ? "カードモデル地"
    : openExploreModal === "collaboration"
      ? "コラボスポット"
      : "スポット一覧";
  const modalEyebrow = openExploreModal === "cards"
    ? "CARD LOCATIONS"
    : openExploreModal === "collaboration"
      ? "COLLABORATION"
      : "SPOTS";
  const modalResultCount = openExploreModal === "cards"
    ? filteredCards.length
    : openExploreModal === "collaboration"
      ? filteredSpots.length
      : filteredStandardSpots.length;
  const noopRouteResult = useCallback(() => undefined, []);

  useEffect(() => {
    if (!openExploreModal) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => exploreModalCloseRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenExploreModal(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [openExploreModal]);

  function beginExploreSheetDrag(event: ReactPointerEvent<HTMLElement>) {
    if (window.innerWidth > 760 || !event.isPrimary || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, label")) return;
    const dialog = exploreModalDialogRef.current;
    const body = exploreModalBodyRef.current;
    if (!dialog || !body || event.clientY >= body.getBoundingClientRect().top) return;
    const rect = dialog.getBoundingClientRect();
    const maximumHeight = Math.max(rect.height, window.innerHeight - 8);
    exploreSheetDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: rect.height,
      collapsedHeight: exploreSheetExpanded ? Math.min(rect.height, window.innerHeight * 0.78) : rect.height,
      maximumHeight,
      startedExpanded: exploreSheetExpanded,
      dragged: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveExploreSheetDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = exploreSheetDragRef.current;
    const dialog = exploreModalDialogRef.current;
    if (!drag || !dialog || drag.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) < 4) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    drag.dragged = true;
    dialog.classList.add("is-dragging");
    if (drag.startedExpanded) {
      const downwardY = Math.max(0, deltaY);
      const collapseTravel = Math.max(0, drag.startHeight - drag.collapsedHeight);
      const nextHeight = Math.max(drag.collapsedHeight, drag.startHeight - downwardY);
      dialog.style.height = `${nextHeight}px`;
      dialog.style.transform = `translateY(${Math.max(0, downwardY - collapseTravel)}px)`;
    } else if (deltaY < 0) {
      dialog.style.height = `${Math.min(drag.maximumHeight, drag.startHeight - deltaY)}px`;
      dialog.style.transform = "translateY(0)";
    } else {
      dialog.style.transform = `translateY(${deltaY}px)`;
    }
  }

  function finishExploreSheetDrag(event: ReactPointerEvent<HTMLElement>, cancelled = false) {
    const drag = exploreSheetDragRef.current;
    const dialog = exploreModalDialogRef.current;
    if (!drag || !dialog || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const deltaY = event.clientY - drag.startY;
    const collapseTravel = drag.startedExpanded
      ? Math.max(0, drag.startHeight - drag.collapsedHeight)
      : 0;
    const closeDistance = collapseTravel + 90;
    exploreSheetDragRef.current = null;
    dialog.classList.remove("is-dragging");
    if (cancelled) {
      dialog.style.removeProperty("height");
      dialog.style.removeProperty("transform");
      return;
    }
    if (drag.dragged && deltaY >= closeDistance) {
      dialog.classList.add("is-closing");
      dialog.style.transform = "translateY(calc(100% + 24px))";
      window.setTimeout(() => setOpenExploreModal(null), 190);
      return;
    }
    dialog.style.removeProperty("height");
    dialog.style.removeProperty("transform");
    if (!drag.dragged) return;
    setExploreSheetExpanded(drag.startedExpanded ? deltaY < 55 : deltaY <= -42);
  }

  function openMode(nextMode: Exclude<ExploreMode, "map">) {
    setExploreSheetExpanded(false);
    setModalFiltersExpanded(false);
    exploreSheetDragRef.current = null;
    if (mode !== nextMode) {
      setQuery("");
      setAreaFilter("all");
      setCategoryFilter("all");
      setCardCharacterFilter("all");
    }
    setMode(nextMode);
    if (nextMode === "collaboration") {
      setSelectedId(currentCollaboration?.locations[0]?.spotId ?? "");
    } else if (nextMode === "cards") {
      setSelectedId(filteredCards[0]?.spotId ?? "");
    } else if (!spots.some((spot) => spot.id === selectedId)) {
      setSelectedId(filteredSpots[0]?.id ?? "");
    }
    setOpenExploreModal(nextMode);
  }

  function selectExploreMode(nextMode: ExploreMode) {
    if (nextMode === "map") {
      setOpenExploreModal(null);
      openMainMap();
      return;
    }
    openMode(nextMode);
  }

  function openMainMap() {
    if (window.matchMedia("(max-width: 760px)").matches && !mapView) {
      setOpenExploreModal(null);
      window.setTimeout(() => document.getElementById("ui-trial-main-map")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      return;
    }
    onOpenMap();
  }

  return (
    <>
      {mapView ? (
        <section className="ui-trial__page ui-trial__map-page" aria-labelledby="ui-trial-map-title" aria-hidden={openExploreModal ? true : undefined}>
          <header className="ui-trial__map-page-heading">
            <div>
              <p className="ui-trial__eyebrow">MAP / 97 SPOTS</p>
              <h1 id="ui-trial-map-title">地図から探す</h1>
            </div>
            <a href="#/explore"><span aria-hidden="true">←</span> 探し方へ戻る</a>
          </header>
          <div className="ui-trial__map-search">
            <label>
              <span className="ui-trial__visually-hidden">地図からスポットを検索</span>
              <input
                type="search"
                value={mapQuery}
                placeholder="施設名・住所・カード・キャラクターで検索"
                onChange={(event) => setMapQuery(event.target.value)}
              />
              <i aria-hidden="true">⌕</i>
            </label>
            {normalizedMapQuery ? (
              <div role="listbox" aria-label="地図の検索結果">
                {mapSearchResults.length ? mapSearchResults.map((result) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={mapSelectedSpot?.id === result.spot.id}
                    onClick={() => { setSelectedId(result.spot.id); setMapQuery(""); }}
                    key={`${result.kind}-${result.id}`}
                  >
                    <span>{result.kind === "card" ? "カード" : "スポット"}</span>
                    <strong><SpotName name={result.title} /></strong>
                    <small>{result.subtitle}</small>
                  </button>
                )) : <p>一致するスポットがありません。</p>}
              </div>
            ) : null}
          </div>
          <div className="ui-trial__map-page-layout">
            <div className="ui-trial__map-page-map">
              <MapboxPilgrimageMap
                spots={spots}
                selectedId={mapSelectedSpot?.id ?? ""}
                plannedSpotIds={planned.map((spot) => spot.id)}
                cardModelSpotIds={cardModelSpotIds}
                onSelect={setSelectedId}
                routeRequest={null}
                onRouteResult={noopRouteResult}
                accessToken={mapboxAccessToken}
                isVisible={mapView}
                viewMode="explore"
              />
            </div>
            {mapSelectedSpot ? (
              <aside className="ui-trial__map-page-detail">
                {mapSelectedPhoto ? <button
                  className="ui-trial__map-page-photo"
                  type="button"
                  onClick={() => onOpenImage(
                    mapSelectedPhoto,
                    `${mapSelectedSpot.name}の写真`,
                    photoCredits[mapSelectedPhoto],
                  )}
                >
                  <img src={mapSelectedPhoto} alt={`${mapSelectedSpot.name}の写真`} />
                </button> : <EmptySpotPhoto className="ui-trial__map-page-photo" spotName={mapSelectedSpot.name} />}
                <div>
                  <small>{mapSelectedSpot.area} · {mapSelectedSpot.category}</small>
                  <h2><SpotName name={mapSelectedSpot.name} /></h2>
                  <p>{mapSelectedSpot.address}</p>
                  {publicSpotDescription(mapSelectedSpot.description) ? <p>{publicSpotDescription(mapSelectedSpot.description)}</p> : null}
                  <div className="ui-trial__spot-facts">
                    <span>{formatOpeningHours(mapSelectedSpot)}</span>
                    {mapSelectedSpot.activityRecords?.length ? <span>活動記録：{mapSelectedSpot.activityRecords.join("・")}</span> : null}
                    {mapSelectedSpot.sehasEpisodes?.length ? <span>せーはす！：{mapSelectedSpot.sehasEpisodes.join("・")}</span> : null}
                    {mapSelectedSpot.withMeetsEpisodes?.length ? <span>With×MEETS：{mapSelectedSpot.withMeetsEpisodes.join("・")}</span> : null}
                    {mapSelectedSpot.appearances?.length ? <span>登場：{mapSelectedSpot.appearances.join("・")}</span> : null}
                    {mapSelectedSpot.collaborationIds?.length ? <span>コラボ：{mapSelectedSpot.collaborationIds.map((id) => collaborations.find((collaboration) => collaboration.id === id)?.name).filter(Boolean).join("・")}</span> : null}
                  </div>
                  {(spotPhotoGroups[mapSelectedSpot.id]?.length ?? 0) > 1 ? (
                    <div className="ui-trial__spot-photo-strip" aria-label="この場所の写真">
                      {spotPhotoGroups[mapSelectedSpot.id].map((imageUrl, index) => (
                        <button type="button" aria-label={`${mapSelectedSpot.name}の写真${index + 1}を拡大表示`} onClick={() => onOpenImage(imageUrl, `${mapSelectedSpot.name}の写真 ${index + 1}`, photoCredits[imageUrl])} key={imageUrl}>
                          <img src={imageUrl} alt="" loading="lazy" />
                          <span>{String(index + 1).padStart(2, "0")}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {mapSelectedCards.length ? (
                    <section className="ui-trial__map-related-cards" aria-label="この場所に関連するカード">
                      <header><strong>関連するカード</strong><span>{mapSelectedCards.length}件</span></header>
                      <div>
                        {mapSelectedCards.map((card) => card.imageUrl ? (
                          <button type="button" onClick={() => onOpenImage(displayAssetUrl(card.imageUrl!), card.card, undefined, CARD_ILLUSTRATION_COPYRIGHT)} key={card.id}>
                            <img src={displayAssetUrl(card.imageUrl)} alt="" loading="lazy" />
                            <span>{card.card}</span>
                          </button>
                        ) : <span key={card.id}>{card.card}</span>)}
                      </div>
                    </section>
                  ) : null}
                  <button className={planned.some((spot) => spot.id === mapSelectedSpot.id) ? "ui-trial__plan-toggle is-planned" : "ui-trial__plan-toggle"} type="button" disabled={!planned.some((spot) => spot.id === mapSelectedSpot.id) && planned.length >= maximumItineraryStops} onClick={() => onTogglePlanned(mapSelectedSpot)}>
                    {planned.some((spot) => spot.id === mapSelectedSpot.id) ? "予定から外す" : "予定に追加"}
                  </button>
                  <a href={mapSelectedSpot.sourceUrl} target="_blank" rel="noreferrer">場所・公式情報 <span aria-hidden="true">↗</span></a>
                </div>
              </aside>
            ) : null}
          </div>
        </section>
      ) : (
      <section
        className="ui-trial__page ui-trial__explore"
        aria-labelledby="ui-trial-explore-title"
        aria-hidden={openExploreModal ? true : undefined}
        style={{ "--ui-trial-hero": `url("${fallbackPhoto}")` } as React.CSSProperties}
      >
      <div className="ui-trial__explore-copy">
        <p className="ui-trial__eyebrow">ISHIKAWA / KANAZAWA</p>
        <h1 id="ui-trial-explore-title">作品の景色を、<br />旅の予定へ。</h1>
        <p className="ui-trial__explore-lead">蓮ノ空に関連するスポットから、行きたい場所を見つけて、そのまま予定へ追加できます。</p>
        <h2>探し方を選ぶ</h2>
        <div className="ui-trial__choices">
          {exploreChoices.map((choice) => choice.mode === "map" ? (
            <button type="button" onClick={openMainMap} key={choice.number}>
              <small>{choice.number}</small><strong>{choice.label}</strong><span>{choice.note}</span><i aria-hidden="true">→</i>
            </button>
          ) : (
            <button
              className={openExploreModal === choice.mode ? "is-active" : ""}
              type="button"
              key={choice.number}
              onClick={() => openMode(choice.mode)}
            >
              <small>{choice.number}</small><strong>{choice.label}</strong><span>{choice.note}</span><i aria-hidden="true">→</i>
            </button>
          ))}
        </div>
      </div>

      <section className="ui-trial__home-map" id="ui-trial-main-map" aria-label="スポット地図">
        <header>
          <div><small>MAP / {spots.length} SPOTS</small><strong>地図から探す</strong></div>
          <button type="button" onClick={onOpenMap}>地図を大きく表示 <span aria-hidden="true">↗</span></button>
        </header>
        <div>
          <MapboxPilgrimageMap
            spots={spots}
            selectedId={mapSelectedSpot?.id ?? ""}
            plannedSpotIds={planned.map((spot) => spot.id)}
            cardModelSpotIds={cardModelSpotIds}
            onSelect={setSelectedId}
            routeRequest={null}
            onRouteResult={noopRouteResult}
            accessToken={mapboxAccessToken}
            isVisible={!mapView}
            viewMode="explore"
          />
        </div>
        {selectedId && mapSelectedSpot ? (
          <button className="ui-trial__home-map-selection" type="button" onClick={() => onOpenSpot(mapSelectedSpot)}>
            <span><small>{mapSelectedSpot.area} · {mapSelectedSpot.category}</small><strong><SpotName name={mapSelectedSpot.name} /></strong></span>
            <i aria-hidden="true">詳細を見る →</i>
          </button>
        ) : <p>ピンを押すとスポットの詳細を確認できます。</p>}
      </section>

      <div className="ui-trial__feature">
        {selectedId && selectedSpot && !selectedSpotPhoto ? (
          <EmptySpotPhoto className="ui-trial__feature-photo-empty" spotName={selectedSpot.name} />
        ) : <img
          key={selectedId && selectedSpot ? selectedSpot.id : "empty"}
          src={selectedSpotPhoto ?? fallbackPhoto}
          alt={selectedId && selectedSpot ? `${selectedSpot.name}の写真` : "金沢市内のメインビジュアル"}
        />}
        <div className="ui-trial__feature-brand" aria-label="蓮ノ旅">
          <span aria-hidden="true">蓮</span>
          <span><strong>蓮ノ旅</strong><small>HASUNOSORA PILGRIMAGE GUIDE</small></span>
        </div>
        {selectedId && selectedSpot ? (
          <div className="ui-trial__feature-title">
            <small>{selectedSpot.area} / {selectedSpot.category}</small>
            <h2><SpotName name={selectedSpot.name} /></h2>
          </div>
        ) : null}
        {selectedId && selectedSpot ? (
          <article>
            <small>{exploreChoices.find((choice) => choice.mode === mode)?.label.toUpperCase()} / {String(selectedNumber).padStart(2, "0")}</small>
            <h2><SpotName name={selectedSpot.name} /></h2>
            <p>{selectedSpot.area}　·　{selectedSpot.category}</p>
            {selectedCollaborationLocation ? (
              <p className="ui-trial__feature-context">
                {selectedCollaborationLocation.role}
                {selectedCollaborationLocation.members?.length ? ` / ${selectedCollaborationLocation.members.join("・")}` : ""}
              </p>
            ) : null}
            <p>{selectedSpot.description}</p>
            <div className="ui-trial__feature-actions">
              <button className={selectedIsPlanned ? "ui-trial__plan-toggle is-planned" : "ui-trial__plan-toggle"} type="button" disabled={!selectedIsPlanned && planned.length >= maximumItineraryStops} onClick={() => onTogglePlanned(selectedSpot)}>
                {selectedIsPlanned ? "予定から外す" : "予定に追加"} <span aria-hidden="true">{selectedIsPlanned ? "−" : "+"}</span>
              </button>
              <a href="#/explore/map">地図で見る <span aria-hidden="true">→</span></a>
            </div>
          </article>
        ) : null}
      </div>
        <button className="ui-trial__explore-plan-link" type="button" onClick={() => onNavigate("planner")}>予定を確認する</button>
      </section>
      )}
      {openExploreModal ? (
        <div
          className="ui-trial__modal ui-trial__explore-window"
          onClick={(event) => { if (event.target === event.currentTarget) setOpenExploreModal(null); }}
        >
          <section
            ref={exploreModalDialogRef}
            className={`ui-trial__modal-dialog ui-trial__explore-window-dialog${openExploreModal === "collaboration" ? " ui-trial__explore-window-dialog--collaboration" : ""}${exploreSheetExpanded ? " is-expanded" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ui-trial-explore-window-title"
            onPointerDown={beginExploreSheetDrag}
            onPointerMove={moveExploreSheetDrag}
            onPointerUp={(event) => finishExploreSheetDrag(event)}
            onPointerCancel={(event) => finishExploreSheetDrag(event, true)}
          >
            <div className="ui-trial__explore-window-handle" aria-hidden="true" />
            <header>
              <div>
                <small>{modalEyebrow}</small>
                <strong id="ui-trial-explore-window-title">{modalTitle}</strong>
                <span>{modalResultCount}件</span>
              </div>
              <button ref={exploreModalCloseRef} type="button" onClick={() => setOpenExploreModal(null)} aria-label={`${modalTitle}を閉じる`}>×</button>
            </header>
            <ExploreModeTabs activeMode={openExploreModal} onSelect={selectExploreMode} />
            {openExploreModal === "collaboration" ? (
              <div className="ui-trial__collaboration-options" aria-label="コラボを選択">
                {availableCollaborations.map((collaboration) => (
                  <button
                    className={currentCollaboration?.id === collaboration.id ? "is-active" : ""}
                    type="button"
                    key={collaboration.id}
                    onClick={() => {
                      setSelectedCollaborationId(collaboration.id);
                      setSelectedId(collaboration.locations[0]?.spotId ?? "");
                    }}
                  >
                    <strong>{collaboration.name}</strong>
                    <span>{collaboration.subtitle}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {openExploreModal !== "collaboration" ? <div className="ui-trial__explore-window-filters">
              <div className="ui-trial__search-row">
                <label className="ui-trial__search">
                  <span className="ui-trial__visually-hidden">{modalTitle}を検索</span>
                  <input
                    type="search"
                    value={openExploreModal === "spots" ? spotQuery : query}
                    placeholder={openExploreModal === "cards" ? "カード名・モデル地・キャラクターで検索" : "施設名・住所・登場回で検索"}
                    onChange={(event) => openExploreModal === "spots" ? setSpotQuery(event.target.value) : setQuery(event.target.value)}
                  />
                  <span aria-hidden="true">⌕</span>
                </label>
                <button
                  className={`ui-trial__filter-toggle${modalFiltersExpanded || modalFilterCount > 0 ? " is-active" : ""}`}
                  type="button"
                  aria-expanded={modalFiltersExpanded}
                  aria-controls="ui-trial-modal-filters"
                  onClick={() => setModalFiltersExpanded((current) => !current)}
                ><span>{modalFiltersExpanded ? "閉じる" : "絞り込み"}</span><b>{modalResultCount}件</b></button>
              </div>
              <div className={`ui-trial__search-filters${modalFiltersExpanded ? " is-expanded" : ""}`} id="ui-trial-modal-filters">
                <label><span>エリア</span><select value={openExploreModal === "spots" ? spotAreaFilter : areaFilter} onChange={(event) => openExploreModal === "spots" ? setSpotAreaFilter(event.target.value) : setAreaFilter(event.target.value)}><option value="all">すべて</option>{exploreAreas.map((area) => <option value={area} key={area}>{area}</option>)}</select></label>
                <label><span>カテゴリ</span><select value={openExploreModal === "spots" ? spotCategoryFilter : categoryFilter} onChange={(event) => openExploreModal === "spots" ? setSpotCategoryFilter(event.target.value) : setCategoryFilter(event.target.value)}><option value="all">すべて</option>{exploreCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
                {openExploreModal === "spots" ? <label><span>出典</span><select value={spotSourceFilter} onChange={(event) => setSpotSourceFilter(event.target.value as ExploreSourceFilter)}><option value="all">すべて</option><option value="activity">活動記録</option><option value="sehas">せーはす！</option><option value="with-meets">With×MEETS</option></select></label> : null}
                {openExploreModal === "cards" ? <label><span>キャラクター</span><select value={cardCharacterFilter} onChange={(event) => setCardCharacterFilter(event.target.value as CardCharacter | "all")}><option value="all">すべて</option>{cardCharacters.map((character) => <option value={character} key={character}>{character}</option>)}</select></label> : null}
                <button
                  type="button"
                  disabled={modalFilterCount === 0}
                  onClick={() => {
                    if (openExploreModal === "spots") {
                      setSpotQuery(""); setSpotAreaFilter("all"); setSpotCategoryFilter("all"); setSpotSourceFilter("all");
                    } else {
                      setQuery(""); setAreaFilter("all"); setCategoryFilter("all"); setCardCharacterFilter("all");
                    }
                  }}
                >条件をクリア</button>
              </div>
            </div> : null}
            <div className="ui-trial__explore-window-body" ref={exploreModalBodyRef}>
            {openExploreModal === "collaboration" && currentCollaboration ? (
              <div className="ui-trial__collaboration-summary">
                  <div>
                    <small>{collaborationStatus(currentCollaboration)}　{formatCollaborationDate(currentCollaboration.startDate)} — {formatCollaborationDate(currentCollaboration.endDate)}</small>
                    <strong>{currentCollaboration.name}</strong>
                    <p>{currentCollaboration.description}</p>
                  </div>
                  <div>
                    <button type="button" onClick={() => onFillCollaboration(currentCollaboration)}>対象スポットを予定に追加</button>
                    <a href={currentCollaboration.sourceUrl} target="_blank" rel="noreferrer">公式情報 <span aria-hidden="true">↗</span></a>
                  </div>
                </div>
              ) : null}
              {openExploreModal === "cards" ? (
                <div className="ui-trial__card-results">
                  {filteredCards.map((card) => {
                    const spot = spots.find((item) => item.id === card.spotId);
                    const isPlanned = Boolean(spot && planned.some((item) => item.id === spot.id));
                    return (
                      <article
                        className={spot ? (selectedId === spot.id ? "is-selected" : "") : "is-unlinked"}
                        key={card.id}
                        onClick={spot ? () => setSelectedId(spot.id) : undefined}
                      >
                        {card.imageUrl ? (
                          <button
                            className="ui-trial__card-image-button"
                            type="button"
                            aria-label={`${card.card}のカードイラストを拡大表示`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenImage(displayAssetUrl(card.imageUrl!), card.card, undefined, CARD_ILLUSTRATION_COPYRIGHT);
                            }}
                          >
                            <img src={displayAssetUrl(card.imageUrl)} alt="" loading="lazy" />
                            <small>{CARD_ILLUSTRATION_COPYRIGHT}</small>
                          </button>
                        ) : null}
                        <div>
                          <small>{card.card}</small>
                          <strong><SpotName name={card.model} /></strong>
                          <span>{spot ? <SpotName name={spot.name} /> : "スポット未登録"}</span>
                          <em>{card.characters.join("・")}</em>
                          <p>{card.address}</p>
                          {card.note ? <p>{card.note}</p> : null}
                          <a href={card.sourceUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>出典を開く <span aria-hidden="true">↗</span></a>
                        </div>
                        {spot ? <button className={isPlanned ? "ui-trial__plan-toggle is-planned" : "ui-trial__plan-toggle"} type="button" disabled={!isPlanned && planned.length >= maximumItineraryStops} onClick={(event) => { event.stopPropagation(); onTogglePlanned(spot); }}>{isPlanned ? "予定から外す" : "予定に追加"}</button> : null}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className={`ui-trial__spot-results${openExploreModal === "collaboration" ? " is-collaboration" : ""}`}>
                {(openExploreModal === "spots" ? filteredStandardSpots : filteredSpots).map((spot) => {
                  const isPlanned = planned.some((item) => item.id === spot.id);
                  const source = spotPhoto(spot, spotPhotoGroups);
                  const collaborationLocation = openExploreModal === "collaboration"
                    ? currentCollaboration?.locations.find((location) => location.spotId === spot.id)
                    : undefined;
                  return (
                    <article
                      className={selectedId === spot.id ? "is-selected" : ""}
                      key={spot.id}
                      onClick={() => {
                        setSelectedId(spot.id);
                        if (window.matchMedia("(max-width: 760px)").matches) onOpenSpot(spot);
                      }}
                    >
                      {openExploreModal !== "collaboration" ? source ? <button
                          className="ui-trial__spot-result-photo"
                          type="button"
                          aria-label={`${spot.name}の写真を拡大表示`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenImage(source, `${spot.name}の写真`, photoCredits[source]);
                          }}
                        ><img src={source} alt="" loading="lazy" /></button>
                        : <EmptySpotPhoto className="ui-trial__spot-result-photo" spotName={spot.name} /> : null}
                      <div>
                        <small>{spot.area} · {spot.category}</small>
                        <strong><SpotName name={spot.name} /></strong>
                        <span>{collaborationLocation?.role ?? spot.address}</span>
                        {collaborationLocation?.members?.length ? <em>等身パネル：{collaborationLocation.members.join("・")}</em> : null}
                        {openExploreModal === "spots" ? (
                          <>
                            <em>{formatOpeningHours(spot)}</em>
                            {publicSpotDescription(spot.description) ? <p>{publicSpotDescription(spot.description)}</p> : null}
                            {spot.activityRecords?.length ? <p>活動記録：{spot.activityRecords.join("・")}</p> : null}
                            {spot.sehasEpisodes?.length ? <p>せーはす！：{spot.sehasEpisodes.join("・")}</p> : null}
                            {spot.withMeetsEpisodes?.length ? <p>With×MEETS：{spot.withMeetsEpisodes.join("・")}</p> : null}
                            {spot.appearances?.length ? <p>登場：{spot.appearances.join("・")}</p> : null}
                            {spot.collaborationIds?.length ? <p>コラボ：{spot.collaborationIds.map((id) => collaborations.find((collaboration) => collaboration.id === id)?.name).filter(Boolean).join("・")}</p> : null}
                            <button className="ui-trial__spot-detail-link" type="button" onClick={(event) => { event.stopPropagation(); onOpenSpot(spot); }}>詳細を見る <span aria-hidden="true">→</span></button>
                            <a href={spot.sourceUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>場所・公式情報 <span aria-hidden="true">↗</span></a>
                          </>
                        ) : null}
                      </div>
                      <button className={isPlanned ? "ui-trial__plan-toggle is-planned" : "ui-trial__plan-toggle"} type="button" disabled={!isPlanned && planned.length >= maximumItineraryStops} onClick={(event) => { event.stopPropagation(); onTogglePlanned(spot); }}>{isPlanned ? "予定から外す" : "予定に追加"}</button>
                    </article>
                  );
                })}
              </div>
              )}
              {modalResultCount === 0 ? <p>条件に合う場所がありません。</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function PlannerStops({ planned, schedule, stayMinutes, onReorder, onRemove, onStayChange, onFocus, onReorderStateChange }: {
  planned: PilgrimageSpot[];
  schedule: { entries: ScheduleEntry[] } | null;
  stayMinutes: Record<string, number>;
  onReorder: (orderedIds: string[]) => void;
  onRemove: (spotId: string) => void;
  onStayChange: (spotId: string, minutes: number) => void;
  onFocus: (spotId: string) => void;
  onReorderStateChange: (isReordering: boolean) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startIndex: number;
    currentIndex: number;
    offsetY: number;
    overlay: HTMLElement;
    order: PilgrimageSpot[];
  } | null>(null);
  const previousPositionsRef = useRef<Map<string, number>>(new Map());
  const [draggedSpotId, setDraggedSpotId] = useState("");
  const [previewOrder, setPreviewOrder] = useState<PilgrimageSpot[] | null>(null);
  const displayedSpots = previewOrder ?? planned;

  const rememberPositions = useCallback(() => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("li[data-stop-id]") ?? [];
    previousPositionsRef.current = new Map(Array.from(rows, (row) => [
      row.dataset.stopId ?? "",
      row.getBoundingClientRect().top,
    ]));
  }, []);

  useLayoutEffect(() => {
    if (!previousPositionsRef.current.size) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("li[data-stop-id]") ?? [];
    rows.forEach((row) => {
      const previousTop = previousPositionsRef.current.get(row.dataset.stopId ?? "");
      if (previousTop === undefined || typeof row.animate !== "function") return;
      const delta = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return;
      row.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: 190, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    });
    previousPositionsRef.current.clear();
  }, [displayedSpots]);

  function finishPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) {
    const drag = dragRef.current;
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    drag.overlay.remove();
    dragRef.current = null;
    setDraggedSpotId("");
    setPreviewOrder(null);
    onReorderStateChange(false);
    if (commit && drag.startIndex !== drag.currentIndex) {
      onReorder(drag.order.map((spot) => spot.id));
    }
  }

  useEffect(() => () => {
    dragRef.current?.overlay.remove();
    dragRef.current = null;
    onReorderStateChange(false);
  }, [onReorderStateChange]);

  function startPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, index: number, spotId: string) {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const row = event.currentTarget.closest("li");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const overlay = row.cloneNode(true) as HTMLElement;
    overlay.classList.add("ui-trial__drag-overlay");
    Object.assign(overlay.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: "200",
      pointerEvents: "none",
    });
    document.body.append(overlay);
    event.currentTarget.setPointerCapture(event.pointerId);
    onReorderStateChange(true);
    setPreviewOrder(planned);
    dragRef.current = {
      pointerId: event.pointerId,
      startIndex: index,
      currentIndex: index,
      offsetY: event.clientY - rect.top,
      overlay,
      order: [...planned],
    };
    setDraggedSpotId(spotId);
  }

  function movePointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    drag.overlay.style.top = `${event.clientY - drag.offsetY}px`;
    const viewportEdge = 72;
    if (event.clientY < viewportEdge) window.scrollBy({ top: -12 });
    if (event.clientY > window.innerHeight - viewportEdge) window.scrollBy({ top: 12 });
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("li[data-stop-index]") ?? []);
    const listBounds = listRef.current?.getBoundingClientRect();
    if (!rows.length || !listBounds || event.clientX < listBounds.left - 48 || event.clientX > listBounds.right + 48) return;
    const target = rows.find((row) => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2) ?? rows.at(-1);
    const targetIndex = Number(target?.dataset.stopIndex);
    if (!Number.isInteger(targetIndex) || targetIndex === drag.currentIndex) return;
    const fromIndex = drag.currentIndex;
    rememberPositions();
    const next = [...drag.order];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(targetIndex, 0, moved);
    drag.order = next;
    setPreviewOrder(next);
    drag.currentIndex = targetIndex;
  }

  function moveWithKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const targetIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= displayedSpots.length) return;
    rememberPositions();
    const next = [...displayedSpots];
    const [moved] = next.splice(index, 1);
    next.splice(targetIndex, 0, moved);
    onReorder(next.map((spot) => spot.id));
  }

  return (
    <ol className="ui-trial__stop-list" ref={listRef}>
      {displayedSpots.map((spot, index) => (
        <li
          key={spot.id}
          data-stop-index={index}
          data-stop-id={spot.id}
          className={draggedSpotId === spot.id ? "is-dragging" : ""}
        >
          <span>{index + 1}</span>
          <time>{schedule ? displayClock(schedule.entries.find((entry) => entry.spot.id === spot.id)?.arrival ?? 0) : "--:--"}</time>
          <div role="button" tabIndex={0} onClick={() => onFocus(spot.id)} onKeyDown={(event) => { if (event.key === "Enter") onFocus(spot.id); }}>
            <strong><SpotName name={spot.name} /></strong>
            <label onClick={(event) => event.stopPropagation()}>
              滞在
              <input
                type="number"
                min="0"
                max="480"
                step="5"
                value={stayMinutes[spot.id] ?? recommendedStayMinutes(spot)}
                onChange={(event) => onStayChange(spot.id, Number(event.target.value))}
              />分
            </label>
          </div>
          <div className="ui-trial__stop-actions">
            <button type="button" onClick={() => onRemove(spot.id)} aria-label={`${spot.name}を予定から外す`}>×</button>
            <button
              type="button"
              aria-label={`${spot.name}をドラッグして並べ替え`}
              title="ドラッグまたは上下キーで並べ替え"
              onPointerDown={(event) => startPointerDrag(event, index, spot.id)}
              onPointerMove={movePointerDrag}
              onPointerUp={(event) => finishPointerDrag(event, true)}
              onPointerCancel={(event) => finishPointerDrag(event, false)}
              onKeyDown={(event) => moveWithKeyboard(event, index)}
            >☷</button>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PlannerPage({ planner, onOpenShare, onReorderStateChange }: {
  planner: ReturnType<typeof useLivePlanner>;
  onOpenShare: () => void;
  onReorderStateChange: (isReordering: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState(planner.itinerarySpots[0]?.id ?? "");
  const [focusRequest, setFocusRequest] = useState<{ spotId: string; requestId: number } | null>(null);
  const visitLabel = planner.activeDay?.visitDate
    ? new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric" }).format(new Date(`${planner.activeDay.visitDate}T12:00:00+09:00`))
    : "未設定";
  const summaryEnd = planner.schedule ? displayClock(planner.schedule.finish) : planner.activeDay?.endTime ?? "--:--";
  const fixedAppointments = [...(planner.activeDay?.appointments ?? [])].sort(
    (left, right) => timeToMinutes(left.time) - timeToMinutes(right.time),
  );
  const appointmentConflictIds = new Set(planner.schedule
    ? fixedAppointments.filter((appointment) => {
      const start = timeToMinutes(appointment.time);
      const end = start + appointment.durationMinutes;
      return start < planner.schedule!.finish && end > planner.schedule!.start;
    }).map((appointment) => appointment.id)
    : []);
  const dayTimeWindowInvalid = Boolean(planner.activeDay && !hasValidTimeWindow(planner.activeDay.startTime, planner.activeDay.endTime));
  const visitDateInvalid = Boolean(planner.activeDay && !hasValidVisitDate(planner.activeDay.visitDate));
  const scheduleOverrunMinutes = planner.schedule && planner.activeDay
    ? Math.max(0, planner.schedule.finish - timeToMinutes(planner.activeDay.endTime))
    : 0;
  const previousHotelName = planner.activeDayIndex > 0
    ? planner.plannerDays[planner.activeDayIndex - 1]?.hotelName ?? ""
    : "";
  const displayedPlannerSpots = planner.routeIsCurrent ? planner.plannedSpots : planner.itinerarySpots;
  const focusSpot = (spotId: string) => {
    setSelectedId(spotId);
    setFocusRequest({ spotId, requestId: Date.now() });
  };
  const stopProps = {
    planned: displayedPlannerSpots,
    schedule: planner.schedule,
    stayMinutes: planner.stayMinutes,
    onReorder: planner.replaceActiveItinerary,
    onRemove: planner.toggleSpot,
    onStayChange: planner.updateStayMinutes,
    onFocus: focusSpot,
    onReorderStateChange,
  };
  return (
    <section className="ui-trial__page ui-trial__planner" aria-labelledby="ui-trial-planner-title">
      <section className="ui-trial__planner-days" aria-label="旅行日程">
        <header>
          <div><small>TRIP DAYS</small><strong>{planner.plannerDays.length}日間</strong></div>
          <button type="button" onClick={planner.addDay} disabled={planner.plannerDays.length >= 7}>日程を追加</button>
        </header>
        <div role="tablist" aria-label="編集する日を選択">
          {planner.plannerDays.map((day, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={index === planner.activeDayIndex}
              className={index === planner.activeDayIndex ? "is-active" : ""}
              onClick={() => planner.selectDay(index)}
              key={day.id}
            >
              <strong>{index + 1}日目</strong>
              <span>{day.visitDate.replaceAll("-", "/")}</span>
              <small>{day.itineraryIds.length}か所</small>
            </button>
          ))}
        </div>
        <footer>
          <span>{previousHotelName ? `前日の宿泊地：${previousHotelName}` : "日ごとに訪問先を設定できます"}</span>
          <button type="button" onClick={planner.removeActiveDay} disabled={planner.plannerDays.length <= 1}>この日を削除</button>
        </footer>
      </section>
      <div className="ui-trial__planner-summary">
        <p className="ui-trial__eyebrow">JOURNEY PLAN / DAY {String(planner.activeDayIndex + 1).padStart(2, "0")}</p>
        <h1 id="ui-trial-planner-title">{visitLabel}の旅程</h1>
        <p>{planner.itinerarySpots.length}スポット　·　{planner.activeDay?.startTime ?? "--:--"} → {summaryEnd}</p>
        <article className="ui-trial__planner-list-card">
          <h2>訪問順</h2>
          {planner.itinerarySpots.length ? <PlannerStops {...stopProps} /> : <p>探す画面からスポットを追加してください。</p>}
        </article>
      </div>

      <div className="ui-trial__route-map ui-trial__live-map">
        <MapboxPilgrimageMap
          spots={displayedPlannerSpots}
          selectedId={selectedId || displayedPlannerSpots[0]?.id || ""}
          focusSpotRequest={focusRequest}
          plannedSpotIds={planner.itineraryIds}
          cardModelSpotIds={[]}
          onSelect={setSelectedId}
          routeRequest={planner.routeRequest}
          onRouteResult={planner.handleRouteResult}
          accessToken={mapboxAccessToken}
          isVisible
          viewMode="planner"
        />
      </div>

      <aside className="ui-trial__planner-controls">
        <div className="ui-trial__mobile-sheet-handle" aria-hidden="true" />
        <small>{planner.itinerarySpots.length}スポット　·　{planner.activeDay?.startTime ?? "--:--"} → {summaryEnd}</small>
        <h2>予定を整える</h2>
        <p>必要なところだけ変更できます。</p>
        <div className="ui-trial__mobile-planner-stops">
          {planner.itinerarySpots.length ? <PlannerStops {...stopProps} /> : <p>探す画面からスポットを追加してください。</p>}
        </div>
        <div className="ui-trial__planner-fields">
          <label><span>訪問日</span><input type="date" value={planner.activeDay?.visitDate ?? japanDate()} onChange={(event) => planner.updateDayField("visitDate", event.target.value || planner.activeDay?.visitDate || japanDate())} /></label>
          <label><span>出発時刻</span><input type="time" value={planner.activeDay?.startTime ?? "09:00"} onChange={(event) => planner.updateDayField("startTime", event.target.value || planner.activeDay?.startTime || "09:00")} /></label>
          <label><span>終了目安</span><input type="time" value={planner.activeDay?.endTime ?? "18:00"} onChange={(event) => planner.updateDayField("endTime", event.target.value || planner.activeDay?.endTime || "18:00")} /></label>
          <label><span>移動手段</span><select value={planner.travelMode} onChange={(event) => planner.setTravelMode(event.target.value as TravelMode)}><option value="WALKING">徒歩</option><option value="DRIVING">車</option><option value="TRANSIT">公共交通</option><option value="BICYCLING">自転車</option></select></label>
          {planner.travelMode === "TRANSIT" ? (
            <label><span>出発駅</span><select value={planner.sourceStationId} onChange={(event) => planner.setSourceStationId(event.target.value)}><option value="">指定なし</option>{majorStations.map((station) => <option value={station.id} key={station.id}>{station.name}</option>)}</select></label>
          ) : null}
        </div>
        <details className="ui-trial__planner-extras">
          <summary><span><strong>宿泊・時間指定</strong><small>ホテル、予約、待ち合わせなど</small></span><i aria-hidden="true">＋</i></summary>
          <div>
            <label><span>宿泊地</span><input type="text" maxLength={120} value={planner.activeDay?.hotelName ?? ""} placeholder="ホテル名・宿泊施設名" onChange={(event) => planner.updateDayDetails({ hotelName: event.target.value })} /></label>
            <section>
              <header><div><strong>時間が決まっている予定</strong><small>この日の旅程へ時刻順に反映します</small></div><button type="button" onClick={planner.addAppointment} disabled={(planner.activeDay?.appointments.length ?? 0) >= 12}>時間指定を追加</button></header>
              {(planner.activeDay?.appointments.length ?? 0) > 0 ? (
                <ol>
                  {planner.activeDay!.appointments.map((appointment) => (
                    <li key={appointment.id}>
                      <label><span>予定名</span><input type="text" maxLength={80} value={appointment.title} onChange={(event) => planner.updateAppointment(appointment.id, { title: event.target.value })} /></label>
                      <label><span>開始</span><input type="time" value={appointment.time} onChange={(event) => planner.updateAppointment(appointment.id, { time: event.target.value })} /></label>
                      <label><span>所要時間</span><input type="number" min={0} max={720} step={5} value={appointment.durationMinutes} onChange={(event) => planner.updateAppointment(appointment.id, { durationMinutes: Math.max(0, Math.min(720, Number(event.target.value) || 0)) })} /></label>
                      <button type="button" aria-label={`${appointment.title || "予定"}を削除`} onClick={() => planner.removeAppointment(appointment.id)}>×</button>
                    </li>
                  ))}
                </ol>
              ) : <p>予約や待ち合わせがある場合は「時間指定を追加」から登録できます。</p>}
            </section>
          </div>
        </details>
        <label className="ui-trial__optimize"><input type="checkbox" checked={planner.optimizeOrder} disabled={planner.travelMode === "TRANSIT"} onChange={(event) => planner.setOptimizeOrder(event.target.checked)} /><span>訪問順を最適化する</span></label>
        {previousHotelName || planner.activeDay?.hotelName ? <p className="ui-trial__planner-note">{previousHotelName ? `前泊：${previousHotelName}` : ""}{previousHotelName && planner.activeDay?.hotelName ? " ／ " : ""}{planner.activeDay?.hotelName ? `宿泊：${planner.activeDay.hotelName}` : ""}</p> : null}
        {fixedAppointments.length ? (
          <section className="ui-trial__fixed-appointments"><strong>時間を固定した予定</strong><ol>{fixedAppointments.map((appointment) => <li className={appointmentConflictIds.has(appointment.id) ? "has-conflict" : ""} key={appointment.id}><time>{appointment.time}</time><span>{appointment.title || "名称未入力"}</span><small>{appointment.durationMinutes}分</small>{appointmentConflictIds.has(appointment.id) ? <em>訪問予定と時間が重なります</em> : null}</li>)}</ol></section>
        ) : null}
        {visitDateInvalid ? <p className="ui-trial__planner-warning">訪問日を設定してください。</p> : null}
        {dayTimeWindowInvalid ? <p className="ui-trial__planner-warning">終了目安は出発時刻より後に設定してください。</p> : null}
        {scheduleOverrunMinutes > 0 ? <p className="ui-trial__planner-warning">終了目安を{formatDuration(scheduleOverrunMinutes)}超える予定です。</p> : null}
        <button className="ui-trial__calculate" type="button" onClick={planner.calculateRoute} disabled={planner.itinerarySpots.length < 2 || visitDateInvalid || dayTimeWindowInvalid || planner.routeResult.state === "loading"}>
          {planner.routeResult.state === "loading" ? "経路を計算中…" : planner.routeIsCurrent ? "経路を再計算する" : "移動時間を計算する"} <span aria-hidden="true">→</span>
        </button>
        {planner.routeResult.state !== "idle" ? (
          <p className={`ui-trial__calculated is-${planner.routeResult.state}`} role="status">
            <small>{planner.routeResult.state === "success" ? "計算結果" : "経路案内"}</small>
            <strong>{planner.routeResult.state === "success" ? `${planner.routeResult.distance} · 移動 ${planner.routeResult.duration}` : planner.routeResult.state === "loading" ? "Mapboxへ問い合わせています" : planner.routeResult.message}</strong>
            {planner.schedule ? <span>滞在込み　{formatDuration(planner.schedule.finish - planner.schedule.start)}</span> : null}
          </p>
        ) : null}
        {planner.travelMode === "TRANSIT" && planner.transitLegs.length ? (
          <section className="ui-trial__transit-legs">
            <header><strong>公共交通の区間確認</strong><span>{planner.transitLegs.filter((leg) => leg.confirmed).length} / {planner.transitLegs.length} 確認済み</span></header>
            <ol>{planner.transitLegs.map((leg) => <li key={leg.id}><div><strong>{leg.fromLabel} → {leg.toLabel}</strong><label><span>日付</span><input type="date" value={leg.date} onChange={(event) => planner.updateTransitLeg(leg.id, { date: event.target.value, time: leg.time, confirmed: false })} /></label><label><span>時刻</span><input type="time" value={leg.time} onChange={(event) => planner.updateTransitLeg(leg.id, { date: leg.date, time: event.target.value, confirmed: false })} /></label></div><a href={buildYahooTransitUrl(leg)} target="_blank" rel="noreferrer">乗換案内を開く ↗</a><label><input type="checkbox" checked={leg.confirmed} onChange={(event) => planner.updateTransitLeg(leg.id, { date: leg.date, time: leg.time, confirmed: event.target.checked })} /><span>確認済み</span></label></li>)}</ol>
          </section>
        ) : null}
        <button className="ui-trial__planner-share-link" type="button" onClick={onOpenShare}>この予定を共有</button>
      </aside>
    </section>
  );
}

function TodayPage({ planner, onOpenPlanner, onOpenSpotMap }: {
  planner: ReturnType<typeof useLivePlanner>;
  onOpenPlanner: () => void;
  onOpenSpotMap: (spot: PilgrimageSpot) => void;
}) {
  const todaySpots = planner.routeIsCurrent ? planner.plannedSpots : planner.itinerarySpots;
  const completedCount = planner.itineraryIds.filter((id) => planner.completedSpotIds.includes(id)).length;
  const nextEntry = planner.schedule?.entries.find((entry) => !planner.completedSpotIds.includes(entry.spot.id));
  const nextSpot = nextEntry?.spot ?? todaySpots.find((spot) => !planner.completedSpotIds.includes(spot.id));
  const mapsUrl = nextSpot
    ? `https://www.google.com/maps/dir/?api=1&destination=${nextSpot.lat},${nextSpot.lng}&travelmode=${planner.travelMode.toLowerCase()}&dir_action=navigate`
    : "https://www.google.com/maps";
  const status = nextEntry && planner.activeDay
    ? openingHoursStatus(nextEntry.spot, planner.activeDay.visitDate, nextEntry.arrival + planner.todayOffsetMinutes)
    : null;

  return (
    <section className="ui-trial__page ui-trial__today" aria-labelledby="ui-trial-today-title">
      <div className="ui-trial__today-route-engine" aria-hidden="true">
        <MapboxPilgrimageMap
          spots={todaySpots}
          selectedId={todaySpots[0]?.id ?? ""}
          plannedSpotIds={planner.itineraryIds}
          cardModelSpotIds={[]}
          onSelect={() => undefined}
          routeRequest={planner.routeRequest}
          onRouteResult={planner.handleRouteResult}
          accessToken={mapboxAccessToken}
          isVisible={false}
          viewMode="planner"
        />
      </div>
      <div className="ui-trial__today-main">
        {planner.plannerDays.length > 1 ? (
          <nav className="ui-trial__today-days" aria-label="表示する日程">
            {planner.plannerDays.map((day, index) => <button type="button" aria-current={index === planner.activeDayIndex ? "date" : undefined} onClick={() => planner.selectDay(index)} key={day.id}>{index + 1}日目 <small>{day.visitDate.replaceAll("-", "/")}</small></button>)}
          </nav>
        ) : null}
        <p className="ui-trial__eyebrow">TODAY / {planner.activeDay?.visitDate.replaceAll("-", ".")}</p>
        <h1 id="ui-trial-today-title">今日の巡礼</h1>
        <p>{completedCount} / {planner.itinerarySpots.length} 訪問済み</p>
        <div className="ui-trial__progress"><span style={{ width: `${planner.itinerarySpots.length ? (completedCount / planner.itinerarySpots.length) * 100 : 0}%` }} /></div>
        {nextSpot ? (
          <article className="ui-trial__next-spot">
            <small>{nextEntry ? `NEXT SPOT / ${displayClock(nextEntry.arrival + planner.todayOffsetMinutes)}到着予定` : "NEXT SPOT / 次の訪問先"}</small>
            <h2><SpotName name={nextSpot.name} /></h2>
            <p>{nextSpot.address}</p>
            {status ? <span className={`is-${status.kind}`}>{status.label}</span> : null}
            <div className="ui-trial__next-spot-details">
              <p>{nextSpot.area} · {nextSpot.category}</p>
              {publicSpotDescription(nextSpot.description) ? <p>{publicSpotDescription(nextSpot.description)}</p> : null}
              <p>{formatOpeningHours(nextSpot)}</p>
              {nextSpot.accessNote ? <p>{nextSpot.accessNote}</p> : null}
            </div>
            <div>
              <a href={mapsUrl} target="_blank" rel="noreferrer">Google Mapsで向かう <span aria-hidden="true">↗</span></a>
              <button type="button" onClick={() => planner.toggleCompleted(nextSpot.id)}>訪問済みにする ✓</button>
              <small>{nextEntry
                ? `滞在 ${nextEntry.stay}分　/　${displayClock(nextEntry.departure + planner.todayOffsetMinutes)} 出発`
                : `滞在 ${planner.stayMinutes[nextSpot.id] ?? recommendedStayMinutes(nextSpot)}分`}</small>
            </div>
          </article>
        ) : planner.schedule && planner.itinerarySpots.length ? (
          <div className="ui-trial__today-empty"><strong>本日の予定はすべて訪問済みです</strong><button type="button" onClick={() => planner.completedSpotIds.forEach(planner.toggleCompleted)}>訪問済みをリセット</button></div>
        ) : (
          <div className="ui-trial__today-empty"><strong>{planner.routeResult.state === "loading" ? "経路を計算しています" : "計算済みの予定がありません"}</strong><p>{planner.routeResult.state === "loading" ? "Mapboxから移動時間を取得しています。" : "予定タブで2か所以上を選び、経路を計算してください。"}</p><button type="button" onClick={onOpenPlanner}>予定を開く</button></div>
        )}
      </div>

      <aside className="ui-trial__today-route">
        <h2>本日のルート</h2>
        {planner.activeDay?.hotelName ? <p className="ui-trial__today-hotel">宿泊：{planner.activeDay.hotelName}</p> : null}
        {planner.activeDay?.appointments.length ? <div className="ui-trial__today-appointments"><strong>時間が決まっている予定</strong>{[...planner.activeDay.appointments].sort((left, right) => left.time.localeCompare(right.time)).map((appointment) => <span key={appointment.id}><time>{appointment.time}</time>{appointment.title || "名称未入力"}（{appointment.durationMinutes}分）</span>)}</div> : null}
        <ol>
          {(planner.schedule?.entries ?? todaySpots.map((spot) => ({ spot, arrival: 0, departure: 0, stay: planner.stayMinutes[spot.id] ?? recommendedStayMinutes(spot) }))).map((entry, index) => {
            const complete = planner.completedSpotIds.includes(entry.spot.id);
            const current = entry.spot.id === nextSpot?.id;
            return (
              <li className={complete ? "is-complete" : current ? "is-current" : ""} key={entry.spot.id} onClick={() => onOpenSpotMap(entry.spot)}>
                <span>{complete ? "✓" : index + 1}</span>
                <time>{planner.schedule ? displayClock(entry.arrival + planner.todayOffsetMinutes) : "--:--"}</time>
                <strong><SpotName name={entry.spot.name} /></strong>
                <small>{complete ? "訪問済み" : `${entry.stay}分`}</small>
                {planner.activeDay ? <em>{openingHoursStatus(entry.spot, planner.activeDay.visitDate, entry.arrival + planner.todayOffsetMinutes).label}</em> : null}
                <button type="button" onClick={(event) => { event.stopPropagation(); planner.toggleCompleted(entry.spot.id); }}>{complete ? "未訪問に戻す" : "訪問済みにする"}</button>
              </li>
            );
          })}
        </ol>
        {planner.travelMode === "TRANSIT" && planner.transitLegs.length ? <div className="ui-trial__today-transit"><strong>公共交通の区間</strong>{planner.transitLegs.map((leg) => <a href={buildYahooTransitUrl(leg)} target="_blank" rel="noreferrer" key={leg.id}>{leg.fromLabel} → {leg.toLabel} <span>{leg.confirmed ? "確認済み" : "乗換案内 ↗"}</span></a>)}</div> : null}
        <div>
          <strong>当日の調整</strong>
          <p>{planner.activeDay?.visitDate === japanDate() ? `表示時刻を${planner.todayOffsetMinutes >= 0 ? "+" : ""}${planner.todayOffsetMinutes}分調整しています。` : "訪問日当日は、残りの予定を現在時刻に合わせられます。"}</p>
          <div>
            <button type="button" onClick={planner.alignScheduleToNow} disabled={!nextEntry || planner.activeDay?.visitDate !== japanDate()}>残りを現在時刻に合わせる</button>
            <button type="button" onClick={planner.resetTodayOffset} disabled={!planner.todayOffsetMinutes}>時刻調整を元に戻す</button>
            <button type="button" onClick={planner.resetCompleted} disabled={!completedCount}>訪問済みをリセット</button>
          </div>
        </div>
      </aside>
    </section>
  );
}

function SharedPreviewPage({ spots, sharedPlan, onImport, onBack }: {
  spots: PilgrimageSpot[];
  sharedPlan: SharedPlanSnapshot | null;
  onImport: () => void;
  onBack: () => void;
}) {
  const [dayIndex, setDayIndex] = useState(sharedPlan?.activeDayIndex ?? 0);
  const [selectedId, setSelectedId] = useState(sharedPlan?.days[dayIndex]?.itineraryIds[0] ?? "");
  const [routeResult, setRouteResult] = useState<RouteResult>({ state: "idle" });
  const activeDay = sharedPlan?.days[dayIndex];
  const sharedTimeWindowValid = Boolean(activeDay && hasValidTimeWindow(activeDay.startTime, activeDay.endTime));
  const sharedVisitDateValid = Boolean(activeDay && hasValidVisitDate(activeDay.visitDate ?? japanDate()));
  const daySpots = useMemo(() => (activeDay?.itineraryIds ?? [])
    .map((id) => spots.find((spot) => spot.id === id))
    .filter((spot): spot is PilgrimageSpot => Boolean(spot)), [activeDay, spots]);
  const routeRequest = useMemo<RouteRequest | null>(() => {
    if (!sharedPlan || !activeDay || !sharedVisitDateValid || !sharedTimeWindowValid || sharedPlan.travelMode === "TRANSIT" || daySpots.length < 2) return null;
    return {
      requestId: dayIndex + 1,
      stops: daySpots,
      travelMode: sharedPlan.travelMode,
      optimizeWaypointOrder: sharedPlan.optimizeOrder,
      stayMinutes: sharedPlan.stayMinutes,
      departureTime: departureIso(activeDay.visitDate ?? japanDate(), activeDay.startTime),
    };
  }, [activeDay, dayIndex, daySpots, sharedPlan, sharedTimeWindowValid, sharedVisitDateValid]);
  const displayedDaySpots = useMemo(() => (
    routeResult.state === "success"
      ? orderItemsByIds(daySpots, routeResult.orderedStopIds)
      : daySpots
  ), [daySpots, routeResult]);

  if (!sharedPlan || !activeDay) {
    return (
      <section className="ui-trial__shared ui-trial__shared--error">
        <small>SHARED JOURNEY</small>
        <h1>共有予定を読み込めませんでした</h1>
        <p>URLが途中で切れているか、期限切れの形式です。</p>
        <button type="button" onClick={onBack}>探すへ戻る</button>
      </section>
    );
  }

  return (
    <section className="ui-trial__shared" aria-labelledby="ui-trial-shared-title">
      <header>
        <div><small>SHARED JOURNEY</small><h1 id="ui-trial-shared-title">共有された予定</h1><p>{sharedPlan.days.length}日間 · {sharedPlan.days.reduce((total, day) => total + day.itineraryIds.length, 0)}か所</p></div>
        <button type="button" onClick={onBack}>閉じる</button>
      </header>
      {sharedPlan.days.length > 1 ? (
        <nav aria-label="共有予定の日程">
          {sharedPlan.days.map((day, index) => <button type="button" aria-current={dayIndex === index ? "date" : undefined} onClick={() => {
            if (index === dayIndex) return;
            setDayIndex(index);
            setSelectedId(day.itineraryIds[0] ?? "");
            setRouteResult({ state: "idle" });
          }} key={`${day.startTime}-${index}`}>DAY {String(index + 1).padStart(2, "0")}</button>)}
        </nav>
      ) : null}
      <div className="ui-trial__shared-grid">
        <div className="ui-trial__shared-map">
          <MapboxPilgrimageMap
            spots={displayedDaySpots}
            selectedId={selectedId || displayedDaySpots[0]?.id || ""}
            plannedSpotIds={activeDay.itineraryIds}
            cardModelSpotIds={[]}
            onSelect={setSelectedId}
            routeRequest={routeRequest}
            onRouteResult={setRouteResult}
            accessToken={mapboxAccessToken}
            isVisible
            viewMode="planner"
          />
        </div>
        <article>
          <small>DAY {String(dayIndex + 1).padStart(2, "0")}</small>
          <h2>{activeDay.visitDate?.replaceAll("-", ".") ?? `${dayIndex + 1}日目`}</h2>
          <p>{activeDay.startTime} → {activeDay.endTime}　·　{sharedPlan.travelMode === "TRANSIT" ? "公共交通" : sharedPlan.travelMode === "DRIVING" ? "車" : sharedPlan.travelMode === "BICYCLING" ? "自転車" : "徒歩"}</p>
          <ol>{displayedDaySpots.map((spot, index) => <li key={spot.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong><SpotName name={spot.name} /></strong><small>{sharedPlan.stayMinutes[spot.id] ?? recommendedStayMinutes(spot)}分滞在</small></div></li>)}</ol>
          <p className="ui-trial__shared-route-status">{!sharedVisitDateValid
            ? "訪問日を確認できません。"
            : !sharedTimeWindowValid
            ? "終了目安は出発時刻より後に設定してください。"
            : sharedPlan.travelMode === "TRANSIT"
              ? "公共交通の経路は取り込み後に各区間を確認します。"
              : daySpots.length < 2
                ? daySpots.length === 1 ? "1か所の予定です。地図で場所を確認できます。" : "表示できるスポットがありません。"
                : routeResult.state === "success"
                  ? `${routeResult.distance} · ${routeResult.duration}`
                  : routeResult.state === "error" ? routeResult.message : "経路を計算しています…"}</p>
        </article>
      </div>
      <aside><strong>この予定を取り込む</strong><p>取り込むと、現在保存されている予定はこの内容で上書きされます。</p><button type="button" onClick={onImport}>内容を確認して取り込む</button></aside>
    </section>
  );
}

function GuidePage({ onNavigate, onOpenImage, communitySubmissionsEnabled }: {
  onNavigate: (page: TrialPage) => void;
  onOpenImage: (src: string, alt: string) => void;
  communitySubmissionsEnabled: boolean;
}) {
  return (
    <section className="ui-trial__page ui-trial__guide" aria-labelledby="ui-trial-guide-title">
      <div className="ui-trial__guide-intro">
        <p className="ui-trial__eyebrow">USER GUIDE / JOURNEY 00</p>
        <h1 id="ui-trial-guide-title">旅の準備は、4つだけ。</h1>
        <p>探す → 予定を組む → 当日使う。迷わないための最短ルートです。</p>
      </div>
      <aside className="ui-trial__guide-start">
        <small>START HERE</small>
        <button type="button" onClick={() => onNavigate("explore")}>探すから始める <span aria-hidden="true">→</span></button>
        <div aria-hidden="true">{guideSteps.map((step) => <span key={step.number}>{step.number}</span>)}</div>
      </aside>
      <div className="ui-trial__guide-route" aria-label="基本的な使い方">
        {guideSteps.map((step) => (
          <article key={step.number}>
            <span>{step.number}</span>
            <div>
              <h2>{step.title}</h2>
              <p>{step.description}</p>
            </div>
            <div className="ui-trial__guide-images">
              <button type="button" onClick={() => onOpenImage(assetUrl(step.image), step.alt)} aria-label={`${step.alt}を拡大表示`}>
                <img src={assetUrl(step.image)} alt={step.alt} loading="lazy" decoding="async" />
              </button>
              {"secondaryImage" in step ? (
                <button type="button" onClick={() => onOpenImage(assetUrl(step.secondaryImage), step.secondaryAlt)} aria-label={`${step.secondaryAlt}を拡大表示`}>
                  <img src={assetUrl(step.secondaryImage)} alt={step.secondaryAlt} loading="lazy" decoding="async" />
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <div className="ui-trial__guide-notice">
        <strong>訪れるときのお願い</strong>
        <ul>
          <li>お店や地域の方、通行する方への配慮を忘れず、立入りや撮影は各施設の案内に従ってください。</li>
          <li>営業時間や交通、天候は変わることがあります。出発前に公式情報も確認してください。</li>
          <li>旅程や所要時間は目安です。当日は無理のない予定でお楽しみください。</li>
        </ul>
        <details>
          <summary>このサイトで扱うデータ</summary>
          <p>予定はこの端末のブラウザに保存されます。ブラウザのデータを消すと予定も消えます。</p>
          <p>地図や経路の表示時は、表示範囲・選んだ地点・移動条件をMapboxへ送ります。</p>
          {communitySubmissionsEnabled ? <p>投稿内容と写真は運営者の受付サーバーへ送られ、確認後に掲載されます。迷惑投稿対策としてCloudflare Turnstileを使用します。</p> : null}
          <p>独自のアクセス解析や広告用の追跡は行っていません。</p>
        </details>
      </div>
      <p className="ui-trial__guide-source">画面内のカード画像：{CARD_ILLUSTRATION_COPYRIGHT}</p>
    </section>
  );
}

function TrialModal({ modal, onClose, onOpenImage, onUpdateShareDates, plannedSpotIds, onToggleSpot }: {
  modal: ModalState;
  onClose: () => void;
  onOpenImage: (src: string, alt: string, credit?: string) => void;
  onUpdateShareDates: (includeDates: boolean) => void;
  plannedSpotIds: string[];
  onToggleSpot: (spotId: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; dragged: boolean } | null>(null);
  const [shareFeedback, setShareFeedback] = useState("");
  const noopRouteResult = useCallback(() => undefined, []);
  useEffect(() => {
    if (!modal) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const feedbackTimer = window.setTimeout(() => setShareFeedback(""), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(feedbackTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [modal, onClose]);
  if (!modal) return null;

  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if (window.innerWidth > 760 || !event.isPrimary || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, label")) return;
    if (!target.closest("header, .ui-trial__modal-handle")) return;
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, dragged: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const dialog = dialogRef.current;
    if (!drag || !dialog || drag.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) < 4) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    drag.dragged = true;
    dialog.classList.add("is-dragging");
    dialog.style.transform = `translateY(${Math.max(-18, deltaY)}px)`;
  }

  function finishDrag(event: ReactPointerEvent<HTMLElement>, cancelled = false) {
    const drag = dragRef.current;
    const dialog = dialogRef.current;
    if (!drag || !dialog || drag.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - drag.startY;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    dialog.classList.remove("is-dragging");
    if (cancelled) {
      dialog.style.removeProperty("transform");
      return;
    }
    if (drag.dragged && deltaY >= 90) {
      dialog.classList.add("is-closing");
      dialog.style.transform = "translateY(calc(100% + 24px))";
      window.setTimeout(onClose, 190);
      return;
    }
    dialog.style.removeProperty("transform");
  }

  async function copyShareUrl() {
    if (!modal || modal.kind !== "share" || !modal.url) return;
    try {
      await navigator.clipboard.writeText(modal.url);
      setShareFeedback("共有URLをコピーしました。");
    } catch {
      setShareFeedback("コピーできませんでした。URL欄を選択してコピーしてください。");
    }
  }

  async function sharePlan() {
    if (!modal || modal.kind !== "share" || !modal.url) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "蓮ノ旅の予定", text: shareMessage, url: modal.url });
        setShareFeedback("共有画面を開きました。");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    await copyShareUrl();
  }

  const modalTitle = modal.kind === "share"
    ? "予定を共有"
    : modal.kind === "image"
      ? modal.alt
      : modal.kind === "spot-map"
        ? `${modal.spot.name}の地図`
        : modal.spot.name;
  const modalSpot = modal.kind === "spot" || modal.kind === "spot-map" ? modal.spot : null;
  const modalSpotIsPlanned = Boolean(modalSpot && plannedSpotIds.includes(modalSpot.id));

  return (
    <div className="ui-trial__modal" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={dialogRef}
        className={`ui-trial__modal-dialog ui-trial__modal-dialog--${modal.kind}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-trial-modal-title"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={(event) => finishDrag(event)}
        onPointerCancel={(event) => finishDrag(event, true)}
      >
        <div className="ui-trial__modal-handle" aria-hidden="true" />
        <header>
          <strong id="ui-trial-modal-title">{modalTitle}</strong>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="閉じる">×</button>
        </header>
        {modal.kind === "image" ? (
          <figure className="ui-trial__image-preview">
            <img src={modal.src} alt={modal.alt} />
            {modal.credit ? <figcaption>写真：{modal.credit}</figcaption> : null}
            {modal.copyright ? <figcaption>{modal.copyright}</figcaption> : null}
          </figure>
        ) : modal.kind === "share" ? (
          <div className="ui-trial__share-dialog">
            <p>訪問先や時間を、見るだけのリンクで共有します。</p>
            <label className="ui-trial__share-date"><input type="checkbox" checked={modal.includeDates} onChange={(event) => onUpdateShareDates(event.target.checked)} /><span>訪問日も共有する</span></label>
            <div className="ui-trial__share-privacy"><strong>共有しない情報</strong><span>宿泊地・自由予定・訪問済みの進捗・出発駅</span></div>
            <label><span>共有URL</span><input readOnly value={modal.url} onFocus={(event) => event.currentTarget.select()} /></label>
            {!modal.url ? <p role="alert">共有するスポットを1か所以上追加してください。</p> : null}
            <div><button type="button" onClick={sharePlan} disabled={!modal.url}>{typeof navigator.share === "function" ? "共有画面を開く" : "URLをコピー"}</button><button type="button" onClick={copyShareUrl} disabled={!modal.url}>コピー</button></div>
            <small aria-live="polite">{shareFeedback}</small>
          </div>
        ) : modal.kind === "spot" ? (
          <div className="ui-trial__spot-detail-dialog">
            {modal.photos.length ? (
              <div className="ui-trial__spot-detail-photos">
                {modal.photos.map((photo, index) => (
                  <figure key={photo}>
                    <button
                      className="ui-trial__spot-detail-photo-button"
                      type="button"
                      aria-label={`${modal.spot.name}の写真 ${index + 1}を拡大表示`}
                      onClick={() => onOpenImage(displayAssetUrl(photo), `${modal.spot.name}の写真 ${index + 1}`, modal.credits[photo])}
                    >
                      <img src={displayAssetUrl(photo)} alt="" />
                    </button>
                    <figcaption>{modal.credits[photo] ? `写真：${modal.credits[photo]}` : `${index + 1} / ${modal.photos.length}`}</figcaption>
                  </figure>
                ))}
              </div>
            ) : <EmptySpotPhoto className="ui-trial__spot-detail-photo-empty" spotName={modal.spot.name} />}
            <div className="ui-trial__spot-detail-copy">
              <small>{modal.spot.area} · {modal.spot.category}</small>
              <h2><SpotName name={modal.spot.name} /></h2>
              <p>{modal.spot.address}</p>
              {publicSpotDescription(modal.spot.description) ? <p>{publicSpotDescription(modal.spot.description)}</p> : null}
              <div className="ui-trial__spot-facts">
                <span>{formatOpeningHours(modal.spot)}</span>
                {modal.spot.accessNote ? <span>{modal.spot.accessNote}</span> : null}
                {modal.spot.activityRecords?.length ? <span>活動記録：{modal.spot.activityRecords.join("・")}</span> : null}
                {modal.spot.sehasEpisodes?.length ? <span>せーはす！：{modal.spot.sehasEpisodes.join("・")}</span> : null}
                {modal.spot.withMeetsEpisodes?.length ? <span>With×MEETS：{modal.spot.withMeetsEpisodes.join("・")}</span> : null}
              </div>
              <div className="ui-trial__spot-detail-actions">
                <a href={`https://www.google.com/maps/search/?api=1&query=${modal.spot.lat},${modal.spot.lng}`} target="_blank" rel="noreferrer">地図で開く <span aria-hidden="true">↗</span></a>
                <button className={modalSpotIsPlanned ? "ui-trial__plan-toggle is-planned" : "ui-trial__plan-toggle"} type="button" disabled={!modalSpotIsPlanned && plannedSpotIds.length >= maximumItineraryStops} onClick={() => onToggleSpot(modal.spot.id)}>{modalSpotIsPlanned ? "予定から外す −" : "予定に追加 ＋"}</button>
              </div>
            </div>
          </div>
        ) : modal.kind === "spot-map" ? (
          <div className="ui-trial__single-spot-map">
            <MapboxPilgrimageMap
              spots={[modal.spot]}
              selectedId={modal.spot.id}
              plannedSpotIds={plannedSpotIds}
              cardModelSpotIds={[]}
              onSelect={() => undefined}
              routeRequest={null}
              onRouteResult={noopRouteResult}
              accessToken={mapboxAccessToken}
              isVisible
              viewMode="explore"
            />
            <div><small>{modal.spot.area} · {modal.spot.category}</small><strong><SpotName name={modal.spot.name} /></strong><span>{modal.spot.address}</span></div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function UiTrialApp({
  spots,
  spotPhotoGroups,
  photoCredits,
  heroImages,
  initialHeroIndex,
  siteVersion,
  communityApiUrl,
  turnstileSiteKey,
  communitySubmissionsEnabled,
}: UiTrialAppProps) {
  const planner = useLivePlanner(spots);
  const heroImage = heroImages[initialHeroIndex] ?? assetUrl("photos/hero/20260806-074048-78b958e5201d8916-watermarked.webp");
  const [view, setView] = useState<TrialView>("explore");
  const [exploreMapView, setExploreMapView] = useState(false);
  const [sharedPlan, setSharedPlan] = useState<SharedPlanSnapshot | null>(null);
  const [sharedPlanKey, setSharedPlanKey] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [isReordering, setIsReordering] = useState(false);
  const closeModal = useCallback(() => setModal(null), []);
  const page = view === "shared" ? "planner" : view;
  const handleReorderStateChange = useCallback((nextIsReordering: boolean) => {
    setIsReordering(nextIsReordering);
  }, []);

  useEffect(() => {
    const syncLocation = () => {
      setModal(null);
      const parts = window.location.hash.replace(/^#\/?/, "").split("/");
      if (parts[0] === "shared") {
        const token = parts.slice(1).join("/");
        setSharedPlanKey(token);
        setSharedPlan(decodeSharedPlanSnapshot(token, new Set(spots.map((spot) => spot.id))));
        setExploreMapView(false);
        setView("shared");
        return;
      }
      const nextPage = (Object.keys(pageLabels) as TrialPage[]).includes(parts[0] as TrialPage)
        ? parts[0] as TrialPage
        : "explore";
      setSharedPlan(null);
      setSharedPlanKey("");
      setExploreMapView(nextPage === "explore" && parts[1] === "map");
      setView(nextPage);
    };
    syncLocation();
    window.addEventListener("hashchange", syncLocation);
    return () => window.removeEventListener("hashchange", syncLocation);
  }, [spots]);

  useEffect(() => {
    if (
      (view !== "planner" && view !== "today") ||
      !planner.restored ||
      planner.itinerarySpots.length < 2 ||
      !planner.activeDay ||
      !hasValidVisitDate(planner.activeDay.visitDate) ||
      !hasValidTimeWindow(planner.activeDay.startTime, planner.activeDay.endTime) ||
      isReordering ||
      planner.routeResult.state === "loading" ||
      planner.requestedRouteSignature === planner.currentRouteSignature
    ) return undefined;
    const timer = window.setTimeout(planner.calculateRoute, 650);
    return () => window.clearTimeout(timer);
  }, [isReordering, planner.activeDay, planner.calculateRoute, planner.currentRouteSignature, planner.itinerarySpots.length, planner.requestedRouteSignature, planner.restored, planner.routeResult.state, view]);

  const navigate = (nextPage: TrialPage) => {
    setModal(null);
    setView(nextPage);
    setExploreMapView(false);
    setSharedPlan(null);
    setSharedPlanKey("");
    const hash = `#/${nextPage}`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openExploreMap = () => {
    setModal(null);
    setView("explore");
    setExploreMapView(true);
    setSharedPlan(null);
    setSharedPlanKey("");
    const hash = "#/explore/map";
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openShare = () => {
    setModal({ kind: "share", url: planner.createShareUrl(false), includeDates: false });
  };
  const updateShareDates = (includeDates: boolean) => {
    setModal({ kind: "share", url: planner.createShareUrl(includeDates), includeDates });
  };
  const importShared = () => {
    if (!sharedPlan) return;
    const confirmed = window.confirm("現在保存されている予定は、共有された予定で上書きされます。取り込みますか？");
    if (!confirmed || !planner.importSharedPlan(sharedPlan)) return;
    navigate("planner");
  };

  const completedCount = planner.itineraryIds.filter((id) => planner.completedSpotIds.includes(id)).length;
  const allPlannedSpotCount = planner.plannerDays.reduce((total, day) => total + day.itineraryIds.length, 0);

  return (
    <div className={`ui-trial ui-trial--${page}`}>
      <TrialHeader
        page={page}
        itineraryCount={allPlannedSpotCount}
        completedCount={completedCount}
        visitDate={planner.activeDay?.visitDate ?? japanDate()}
        activeDayIndex={planner.activeDayIndex}
        sharedPreview={view === "shared"}
        onNavigate={navigate}
        onOpenShare={openShare}
      />
      <main>
        {view === "explore" ? <ExplorePage
          spots={spots}
          spotPhotoGroups={spotPhotoGroups}
          photoCredits={photoCredits}
          fallbackPhoto={heroImage}
          planned={planner.itinerarySpots}
          mapView={exploreMapView}
          onTogglePlanned={(spot) => planner.toggleSpot(spot.id)}
          onNavigate={navigate}
          onOpenMap={openExploreMap}
          onOpenSpot={(spot) => setModal({
            kind: "spot",
            spot,
            photos: spotPhotoGroups[spot.id]?.length ? spotPhotoGroups[spot.id] : spot.imageUrl ? [spot.imageUrl] : [],
            credits: photoCredits,
          })}
          onOpenImage={(src, alt, credit, copyright) => setModal({ kind: "image", src, alt, credit, copyright })}
          onFillCollaboration={(collaboration) => {
            planner.addToActiveItinerary(collaboration.locations.map((location) => location.spotId));
            navigate("planner");
          }}
        /> : null}
        {view === "planner" ? <PlannerPage planner={planner} onOpenShare={openShare} onReorderStateChange={handleReorderStateChange} /> : null}
        {view === "today" ? <TodayPage planner={planner} onOpenPlanner={() => navigate("planner")} onOpenSpotMap={(spot) => setModal({ kind: "spot-map", spot })} /> : null}
        {view === "guide" ? <GuidePage onNavigate={navigate} onOpenImage={(src, alt) => setModal({ kind: "image", src, alt })} communitySubmissionsEnabled={communitySubmissionsEnabled} /> : null}
        {view === "shared" ? <SharedPreviewPage key={sharedPlanKey} spots={spots} sharedPlan={sharedPlan} onImport={importShared} onBack={() => navigate("explore")} /> : null}
        <CommunityContributionPanel
          spots={spots}
          apiBaseUrl={communityApiUrl}
          submissionPath="/api/ui-test-submissions"
          turnstileSiteKey={turnstileSiteKey}
          enabled={communitySubmissionsEnabled}
          hidden={view !== "explore" || exploreMapView}
        />
      </main>
      <footer className="ui-trial__site-footer"><span>蓮ノ旅 Ver.{siteVersion}</span><small>非公式の聖地巡礼ガイドです。</small></footer>
      <TrialNavigation page={page} itineraryCount={allPlannedSpotCount} onNavigate={navigate} />
      <TrialModal
        modal={modal}
        onClose={closeModal}
        onOpenImage={(src, alt, credit) => setModal({ kind: "image", src, alt, credit })}
        onUpdateShareDates={updateShareDates}
        plannedSpotIds={planner.itineraryIds}
        onToggleSpot={planner.toggleSpot}
      />
    </div>
  );
}
