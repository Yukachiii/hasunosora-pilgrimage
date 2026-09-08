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
  formatDuration,
  majorStations,
  openingHoursStatus,
  recommendedStayMinutes,
  type TravelMode,
} from "../../app/route-planner";
import {
  decodeSharedPlanSnapshot,
  type SharedPlanSnapshot,
} from "../../app/planner-share";
import { cardModels, collaborations, spots, type PilgrimageSpot } from "../../app/spots";
import {
  departureIso,
  displayClock,
  japanDate,
  useLivePlanner,
  type ScheduleEntry,
} from "./use-live-planner";

type TrialPage = "explore" | "planner" | "today" | "guide";
type TrialView = TrialPage | "shared";
type ExploreMode = "spots" | "collaboration" | "map" | "cards";
type ExploreSourceFilter = "all" | "activity" | "sehas" | "with-meets";

type ModalState =
  | { kind: "guide"; src: string; alt: string }
  | { kind: "share"; url: string; includeDates: boolean }
  | null;

const baseUrl = import.meta.env.BASE_URL;
const cardModelSpotIds = Array.from(new Set(cardModels.flatMap((card) => card.spotId ? [card.spotId] : [])));
const exploreAreas = Array.from(new Set(spots.map((spot) => spot.area))).sort((a, b) => a.localeCompare(b, "ja"));
const exploreCategories = Array.from(new Set(spots.map((spot) => spot.category))).sort((a, b) => a.localeCompare(b, "ja"));
const mapboxAccessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim() ?? "";
const shareMessage = "訪問予定を共有します。\n#蓮ノ旅";
const pageLabels: Record<TrialPage, string> = {
  explore: "探す",
  planner: "予定",
  today: "当日",
  guide: "ガイド",
};

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
  },
  {
    number: "03",
    title: "一日を整える",
    description: "訪問順、滞在時間、出発時刻、移動手段を調整。",
    image: "guide/04-plan-stops.png",
    alt: "訪問するスポットと滞在時間を編集する画面",
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

function spotPhoto(spot?: PilgrimageSpot) {
  return spot?.imageUrl ? assetUrl(spot.imageUrl) : assetUrl("photos/hero/20260806-074048-78b958e5201d8916-watermarked.webp");
}

function SpotName({ name }: { name: string }) {
  const words = name.trim().split(/\s+/);
  return <>{words.map((word, index) => (
    <span className="ui-trial__spot-name-token" key={`${word}-${index}`}>{word}{index < words.length - 1 ? " " : ""}</span>
  ))}</>;
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

function TrialHeader({ page, itineraryCount, completedCount, visitDate, sharedPreview = false, onNavigate, onOpenShare }: {
  page: TrialPage;
  itineraryCount: number;
  completedCount: number;
  visitDate: string;
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
            <small>{page === "planner" ? `${visitDate.replaceAll("-", ".")} / DAY 01` : page === "today" ? `TODAY / ${visitDate.slice(5).replace("-", ".")}` : "USER GUIDE / JOURNEY 00"}</small>
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

function ExplorePage({ planned, mapView, onTogglePlanned, onNavigate }: {
  planned: PilgrimageSpot[];
  mapView: boolean;
  onTogglePlanned: (spot: PilgrimageSpot) => void;
  onNavigate: (page: TrialPage) => void;
}) {
  const initialSpot = spots.find((spot) => spot.id === "kanazawa-station") ?? spots[0];
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Exclude<ExploreMode, "map">>("spots");
  const [openExploreModal, setOpenExploreModal] = useState<Exclude<ExploreMode, "map"> | null>(null);
  const [areaFilter, setAreaFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState<ExploreSourceFilter>("all");
  const [spotQuery, setSpotQuery] = useState("");
  const [spotAreaFilter, setSpotAreaFilter] = useState("all");
  const [spotCategoryFilter, setSpotCategoryFilter] = useState("all");
  const [spotSourceFilter, setSpotSourceFilter] = useState<ExploreSourceFilter>("all");
  const [selectedId, setSelectedId] = useState(initialSpot?.id ?? "");
  const today = japanDate();
  const activeCollaborations = collaborations.filter((collaboration) => (
    collaboration.startDate <= today && collaboration.endDate >= today
  ));
  const availableCollaborations = activeCollaborations.length > 0 ? activeCollaborations : collaborations;
  const [selectedCollaborationId, setSelectedCollaborationId] = useState(availableCollaborations[0]?.id ?? "");
  const exploreModalCloseRef = useRef<HTMLButtonElement>(null);
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
    return [spot.name, spot.shortName, spot.area, spot.category, spot.address, spot.description]
      .some((value) => value.toLocaleLowerCase("ja").includes(normalizedSpotQuery));
  });
  const filteredSpots = spots.filter((spot) => {
    if (mode === "collaboration" && !collaborationSpotIds.has(spot.id)) return false;
    if (areaFilter !== "all" && spot.area !== areaFilter) return false;
    if (categoryFilter !== "all" && spot.category !== categoryFilter) return false;
    if (!matchesSource(spot, sourceFilter)) return false;
    if (!normalizedQuery) return true;
    return [spot.name, spot.shortName, spot.area, spot.category, spot.address, spot.description]
      .some((value) => value.toLocaleLowerCase("ja").includes(normalizedQuery));
  });
  const filteredCards = cardModels.filter((card) => {
    if (!card.spotId) return false;
    const spot = spots.find((item) => item.id === card.spotId);
    if (!spot) return false;
    if (areaFilter !== "all" && spot.area !== areaFilter) return false;
    if (categoryFilter !== "all" && spot.category !== categoryFilter) return false;
    if (!normalizedQuery) return true;
    return [card.card, card.model, card.address, card.note, spot.name, spot.area, spot.category, ...card.characters]
      .some((value) => value.toLocaleLowerCase("ja").includes(normalizedQuery));
  });
  const selectedCandidate = spots.find((spot) => spot.id === selectedId);
  const mapSelectedSpot = selectedCandidate ?? spots[0];
  const cardSpotIds = new Set(filteredCards.flatMap((card) => card.spotId ? [card.spotId] : []));
  const selectedSpot = mode === "cards"
    ? (selectedCandidate && cardSpotIds.has(selectedCandidate.id)
      ? selectedCandidate
      : spots.find((spot) => spot.id === filteredCards[0]?.spotId))
    : (filteredSpots.find((spot) => spot.id === selectedCandidate?.id) ?? filteredSpots[0]);
  const selectedIsPlanned = Boolean(selectedSpot && planned.some((spot) => spot.id === selectedSpot.id));
  const selectedCollaborationLocation = mode === "collaboration"
    ? currentCollaboration?.locations.find((location) => location.spotId === selectedSpot?.id)
    : undefined;
  const selectedNumber = Math.max(0, mode === "cards"
    ? filteredCards.findIndex((card) => card.spotId === selectedSpot?.id)
    : filteredSpots.findIndex((spot) => spot.id === selectedSpot?.id)) + 1;
  const activeFilterCount = Number(Boolean(normalizedQuery)) + Number(areaFilter !== "all") + Number(categoryFilter !== "all") + Number(sourceFilter !== "all" && openExploreModal === "collaboration");
  const standardFilterCount = Number(Boolean(normalizedSpotQuery)) + Number(spotAreaFilter !== "all") + Number(spotCategoryFilter !== "all") + Number(spotSourceFilter !== "all");
  const modalFilterCount = openExploreModal === "spots" ? standardFilterCount : activeFilterCount;
  const choices = [
    { number: "01", label: "地図", note: "場所から", mode: "map" as const },
    { number: "02", label: "スポット", note: "登録スポット", mode: "spots" as const },
    { number: "03", label: "カード", note: "モデル地から", mode: "cards" as const },
    { number: "04", label: "コラボ", note: "開催情報から", mode: "collaboration" as const },
  ];
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

  function openMode(nextMode: Exclude<ExploreMode, "map">) {
    if (mode !== nextMode) {
      setQuery("");
      setAreaFilter("all");
      setCategoryFilter("all");
      setSourceFilter("all");
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

  return (
    <>
      {mapView ? (
        <section className="ui-trial__page ui-trial__map-page" aria-labelledby="ui-trial-map-title">
          <header className="ui-trial__map-page-heading">
            <div>
              <p className="ui-trial__eyebrow">MAP / 97 SPOTS</p>
              <h1 id="ui-trial-map-title">地図から探す</h1>
            </div>
            <a href="#/explore"><span aria-hidden="true">←</span> 探し方へ戻る</a>
          </header>
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
                <img src={spotPhoto(mapSelectedSpot)} alt={`${mapSelectedSpot.name}の写真`} />
                <div>
                  <small>{mapSelectedSpot.area} · {mapSelectedSpot.category}</small>
                  <h2><SpotName name={mapSelectedSpot.name} /></h2>
                  <p>{mapSelectedSpot.address}</p>
                  <p>{mapSelectedSpot.description}</p>
                  <button type="button" onClick={() => onTogglePlanned(mapSelectedSpot)}>
                    {planned.some((spot) => spot.id === mapSelectedSpot.id) ? "予定から外す" : "予定に追加"}
                  </button>
                </div>
              </aside>
            ) : null}
          </div>
        </section>
      ) : (
      <section className="ui-trial__page ui-trial__explore" aria-labelledby="ui-trial-explore-title">
      <div className="ui-trial__explore-copy">
        <p className="ui-trial__eyebrow">ISHIKAWA / KANAZAWA</p>
        <h1 id="ui-trial-explore-title">作品の景色を、<br />旅の予定へ。</h1>
        <p className="ui-trial__explore-lead">蓮ノ空に関連するスポットから、行きたい場所を見つけて、そのまま予定へ追加できます。</p>
        <h2>探し方を選ぶ</h2>
        <div className="ui-trial__choices">
          {choices.map((choice) => choice.mode === "map" ? (
            <a href="#/explore/map" key={choice.number}>
              <small>{choice.number}</small><strong>{choice.label}</strong><span>{choice.note}</span><i aria-hidden="true">→</i>
            </a>
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

      <div className="ui-trial__feature">
        <img
          key={selectedSpot?.id ?? "empty"}
          src={spotPhoto(selectedSpot)}
          alt={selectedSpot ? `${selectedSpot.name}の写真` : "金沢の風景"}
        />
        <div className="ui-trial__feature-title">
          <small>{selectedSpot ? `${selectedSpot.area} / ${selectedSpot.category}` : "ISHIKAWA / KANAZAWA"}</small>
          <h2>{selectedSpot ? <SpotName name={selectedSpot.name} /> : "景色を、旅の予定へ。"}</h2>
        </div>
        {selectedSpot ? (
          <article>
            <small>{choices.find((choice) => choice.mode === mode)?.label.toUpperCase()} / {String(selectedNumber).padStart(2, "0")}</small>
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
              <button type="button" onClick={() => onTogglePlanned(selectedSpot)}>
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
      {!mapView && openExploreModal ? (
        <div
          className="ui-trial__modal ui-trial__explore-window"
          onClick={(event) => { if (event.target === event.currentTarget) setOpenExploreModal(null); }}
        >
          <section
            className={`ui-trial__modal-dialog ui-trial__explore-window-dialog${openExploreModal === "collaboration" ? " ui-trial__explore-window-dialog--collaboration" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ui-trial-explore-window-title"
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
            <div className="ui-trial__explore-window-filters">
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
              <div>
                <label><span>エリア</span><select value={openExploreModal === "spots" ? spotAreaFilter : areaFilter} onChange={(event) => openExploreModal === "spots" ? setSpotAreaFilter(event.target.value) : setAreaFilter(event.target.value)}><option value="all">すべて</option>{exploreAreas.map((area) => <option value={area} key={area}>{area}</option>)}</select></label>
                <label><span>カテゴリ</span><select value={openExploreModal === "spots" ? spotCategoryFilter : categoryFilter} onChange={(event) => openExploreModal === "spots" ? setSpotCategoryFilter(event.target.value) : setCategoryFilter(event.target.value)}><option value="all">すべて</option>{exploreCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
                {openExploreModal !== "cards" ? <label><span>出典</span><select value={openExploreModal === "spots" ? spotSourceFilter : sourceFilter} onChange={(event) => openExploreModal === "spots" ? setSpotSourceFilter(event.target.value as ExploreSourceFilter) : setSourceFilter(event.target.value as ExploreSourceFilter)}><option value="all">すべて</option><option value="activity">活動記録</option><option value="sehas">せーはす！</option><option value="with-meets">With×MEETS</option></select></label> : null}
                {modalFilterCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (openExploreModal === "spots") {
                        setSpotQuery(""); setSpotAreaFilter("all"); setSpotCategoryFilter("all"); setSpotSourceFilter("all");
                      } else {
                        setQuery(""); setAreaFilter("all"); setCategoryFilter("all"); setSourceFilter("all");
                      }
                    }}
                  >条件をクリア</button>
                ) : null}
              </div>
            </div>
            <div className="ui-trial__explore-window-body">
              {openExploreModal === "collaboration" && currentCollaboration ? (
                <div className="ui-trial__collaboration-summary">
                  <strong>{currentCollaboration.name}</strong>
                  <p>{currentCollaboration.description}</p>
                </div>
              ) : null}
              {openExploreModal === "cards" ? (
                <div className="ui-trial__card-results">
                  {filteredCards.map((card) => {
                    const spot = spots.find((item) => item.id === card.spotId);
                    if (!spot) return null;
                    const isPlanned = planned.some((item) => item.id === spot.id);
                    return (
                      <article className={selectedId === spot.id ? "is-selected" : ""} key={card.id} onClick={() => setSelectedId(spot.id)}>
                        {card.imageUrl ? <img src={assetUrl(card.imageUrl)} alt="" loading="lazy" /> : null}
                        <div><small>{card.card}</small><strong><SpotName name={card.model} /></strong><span><SpotName name={spot.name} /></span></div>
                        <button type="button" onClick={(event) => { event.stopPropagation(); onTogglePlanned(spot); }}>{isPlanned ? "予定から外す" : "予定に追加"}</button>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="ui-trial__spot-results">
                {(openExploreModal === "spots" ? filteredStandardSpots : filteredSpots).map((spot) => {
                  const isPlanned = planned.some((item) => item.id === spot.id);
                  const collaborationLocation = openExploreModal === "collaboration"
                    ? currentCollaboration?.locations.find((location) => location.spotId === spot.id)
                    : undefined;
                  return (
                    <article
                      className={selectedId === spot.id ? "is-selected" : ""}
                      key={spot.id}
                      onClick={() => setSelectedId(spot.id)}
                    >
                      <div><small>{spot.area} · {spot.category}</small><strong><SpotName name={spot.name} /></strong><span>{collaborationLocation?.role ?? spot.address}</span></div>
                      <button type="button" onClick={(event) => { event.stopPropagation(); onTogglePlanned(spot); }}>{isPlanned ? "予定から外す" : "予定に追加"}</button>
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

function PlannerStops({ planned, schedule, stayMinutes, onReorder, onRemove, onStayChange, onFocus }: {
  planned: PilgrimageSpot[];
  schedule: { entries: ScheduleEntry[] } | null;
  stayMinutes: Record<string, number>;
  onReorder: (from: number, to: number) => void;
  onRemove: (spotId: string) => void;
  onStayChange: (spotId: string, minutes: number) => void;
  onFocus: (spotId: string) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    currentIndex: number;
    offsetY: number;
    overlay: HTMLElement;
  } | null>(null);
  const previousPositionsRef = useRef<Map<string, number>>(new Map());
  const [draggedSpotId, setDraggedSpotId] = useState("");

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
  }, [planned]);

  const finishPointerDrag = useCallback((event?: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (event?.currentTarget.hasPointerCapture(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    }
    drag.overlay.remove();
    dragRef.current = null;
    setDraggedSpotId("");
  }, []);

  useEffect(() => () => {
    dragRef.current?.overlay.remove();
    dragRef.current = null;
  }, []);

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
    dragRef.current = {
      pointerId: event.pointerId,
      currentIndex: index,
      offsetY: event.clientY - rect.top,
      overlay,
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
    rememberPositions();
    onReorder(drag.currentIndex, targetIndex);
    drag.currentIndex = targetIndex;
  }

  function moveWithKeyboard(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const targetIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= planned.length) return;
    rememberPositions();
    onReorder(index, targetIndex);
  }

  return (
    <ol className="ui-trial__stop-list" ref={listRef}>
      {planned.map((spot, index) => (
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
              onPointerUp={finishPointerDrag}
              onPointerCancel={finishPointerDrag}
              onKeyDown={(event) => moveWithKeyboard(event, index)}
            >☷</button>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PlannerPage({ planner, onOpenShare, onNavigateExplore }: {
  planner: ReturnType<typeof useLivePlanner>;
  onOpenShare: () => void;
  onNavigateExplore: () => void;
}) {
  const [selectedId, setSelectedId] = useState(planner.itinerarySpots[0]?.id ?? "");
  const [focusRequest, setFocusRequest] = useState<{ spotId: string; requestId: number } | null>(null);
  const visitLabel = planner.activeDay?.visitDate
    ? new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric" }).format(new Date(`${planner.activeDay.visitDate}T12:00:00+09:00`))
    : "未設定";
  const summaryEnd = planner.schedule ? displayClock(planner.schedule.finish) : planner.activeDay?.endTime ?? "--:--";
  const focusSpot = (spotId: string) => {
    setSelectedId(spotId);
    setFocusRequest({ spotId, requestId: Date.now() });
  };
  const stopProps = {
    planned: planner.itinerarySpots,
    schedule: planner.schedule,
    stayMinutes: planner.stayMinutes,
    onReorder: planner.reorder,
    onRemove: planner.toggleSpot,
    onStayChange: planner.updateStayMinutes,
    onFocus: focusSpot,
  };
  return (
    <section className="ui-trial__page ui-trial__planner" aria-labelledby="ui-trial-planner-title">
      <div className="ui-trial__planner-summary">
        <p className="ui-trial__eyebrow">JOURNEY PLAN / DAY 01</p>
        <h1 id="ui-trial-planner-title">{visitLabel}の旅程</h1>
        <p>{planner.itinerarySpots.length}スポット　·　{planner.activeDay?.startTime ?? "--:--"} → {summaryEnd}</p>
        <article className="ui-trial__planner-list-card">
          <h2>訪問順</h2>
          {planner.itinerarySpots.length ? <PlannerStops {...stopProps} /> : <p>探す画面からスポットを追加してください。</p>}
          <button type="button" onClick={onNavigateExplore}>＋ スポットを選ぶ</button>
        </article>
      </div>

      <div className="ui-trial__route-map ui-trial__live-map">
        <MapboxPilgrimageMap
          spots={planner.itinerarySpots}
          selectedId={selectedId || planner.itinerarySpots[0]?.id || ""}
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
          <label><span>訪問日</span><input type="date" value={planner.activeDay?.visitDate ?? japanDate()} onChange={(event) => planner.updateDayField("visitDate", event.target.value)} /></label>
          <label><span>出発時刻</span><input type="time" value={planner.activeDay?.startTime ?? "09:00"} onChange={(event) => planner.updateDayField("startTime", event.target.value)} /></label>
          <label><span>終了目安</span><input type="time" value={planner.activeDay?.endTime ?? "18:00"} onChange={(event) => planner.updateDayField("endTime", event.target.value)} /></label>
          <label><span>移動手段</span><select value={planner.travelMode} onChange={(event) => planner.setTravelMode(event.target.value as TravelMode)}><option value="WALKING">徒歩</option><option value="DRIVING">車</option><option value="TRANSIT">公共交通</option><option value="BICYCLING">自転車</option></select></label>
          {planner.travelMode === "TRANSIT" ? (
            <label><span>出発駅</span><select value={planner.sourceStationId} onChange={(event) => planner.setSourceStationId(event.target.value)}><option value="">指定なし</option>{majorStations.map((station) => <option value={station.id} key={station.id}>{station.name}</option>)}</select></label>
          ) : null}
        </div>
        <label className="ui-trial__optimize"><input type="checkbox" checked={planner.optimizeOrder} disabled={planner.travelMode === "TRANSIT"} onChange={(event) => planner.setOptimizeOrder(event.target.checked)} /><span>訪問順を最適化する</span></label>
        <button className="ui-trial__calculate" type="button" onClick={planner.calculateRoute} disabled={planner.itinerarySpots.length < 2 || planner.routeResult.state === "loading"}>
          {planner.routeResult.state === "loading" ? "経路を計算中…" : planner.routeIsCurrent ? "経路を再計算する" : "移動時間を計算する"} <span aria-hidden="true">→</span>
        </button>
        {planner.routeResult.state !== "idle" ? (
          <p className={`ui-trial__calculated is-${planner.routeResult.state}`} role="status">
            <small>{planner.routeResult.state === "success" ? "計算結果" : "経路案内"}</small>
            <strong>{planner.routeResult.state === "success" ? `${planner.routeResult.distance} · 移動 ${planner.routeResult.duration}` : planner.routeResult.state === "loading" ? "Mapboxへ問い合わせています" : planner.routeResult.message}</strong>
            {planner.schedule ? <span>滞在込み　{formatDuration(planner.schedule.finish - planner.schedule.start)}</span> : null}
          </p>
        ) : null}
        <button className="ui-trial__planner-share-link" type="button" onClick={onOpenShare}>この予定を共有</button>
      </aside>
    </section>
  );
}

function TodayPage({ planner, onOpenPlanner }: {
  planner: ReturnType<typeof useLivePlanner>;
  onOpenPlanner: () => void;
}) {
  const completedCount = planner.itineraryIds.filter((id) => planner.completedSpotIds.includes(id)).length;
  const nextEntry = planner.schedule?.entries.find((entry) => !planner.completedSpotIds.includes(entry.spot.id));
  const nextSpot = nextEntry?.spot;
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
          spots={planner.itinerarySpots}
          selectedId={planner.itinerarySpots[0]?.id ?? ""}
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
        <p className="ui-trial__eyebrow">TODAY / {planner.activeDay?.visitDate.replaceAll("-", ".")}</p>
        <h1 id="ui-trial-today-title">今日の巡礼</h1>
        <p>{completedCount} / {planner.itinerarySpots.length} 訪問済み</p>
        <div className="ui-trial__progress"><span style={{ width: `${planner.itinerarySpots.length ? (completedCount / planner.itinerarySpots.length) * 100 : 0}%` }} /></div>
        {nextEntry && nextSpot ? (
          <article className="ui-trial__next-spot">
            <small>NEXT SPOT / {displayClock(nextEntry.arrival + planner.todayOffsetMinutes)}到着予定</small>
            <h2><SpotName name={nextSpot.name} /></h2>
            <p>{nextSpot.address}</p>
            {status ? <span className={`is-${status.kind}`}>{status.label}</span> : null}
            <div>
              <a href={mapsUrl} target="_blank" rel="noreferrer">Google Mapsで向かう <span aria-hidden="true">↗</span></a>
              <button type="button" onClick={() => planner.toggleCompleted(nextSpot.id)}>訪問済みにする ✓</button>
              <small>滞在 {nextEntry.stay}分　/　{displayClock(nextEntry.departure + planner.todayOffsetMinutes)} 出発</small>
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
        <ol>
          {(planner.schedule?.entries ?? planner.itinerarySpots.map((spot) => ({ spot, arrival: 0, departure: 0, stay: planner.stayMinutes[spot.id] ?? recommendedStayMinutes(spot) }))).map((entry, index) => {
            const complete = planner.completedSpotIds.includes(entry.spot.id);
            const current = entry.spot.id === nextSpot?.id;
            return (
              <li className={complete ? "is-complete" : current ? "is-current" : ""} key={entry.spot.id}>
                <span>{complete ? "✓" : index + 1}</span>
                <time>{planner.schedule ? displayClock(entry.arrival + planner.todayOffsetMinutes) : "--:--"}</time>
                <strong><SpotName name={entry.spot.name} /></strong>
                <small>{complete ? "訪問済み" : `${entry.stay}分`}</small>
              </li>
            );
          })}
        </ol>
        <div><strong>当日の調整</strong><p>遅れた分だけ、この予定を現在時刻に合わせられます。</p><button type="button" onClick={planner.alignScheduleToNow} disabled={!nextEntry}>次の到着を現在時刻に合わせる</button></div>
      </aside>
    </section>
  );
}

function SharedPreviewPage({ sharedPlan, onImport, onBack }: {
  sharedPlan: SharedPlanSnapshot | null;
  onImport: () => void;
  onBack: () => void;
}) {
  const [dayIndex, setDayIndex] = useState(sharedPlan?.activeDayIndex ?? 0);
  const [selectedId, setSelectedId] = useState(sharedPlan?.days[dayIndex]?.itineraryIds[0] ?? "");
  const [routeResult, setRouteResult] = useState<RouteResult>({ state: "idle" });
  const activeDay = sharedPlan?.days[dayIndex];
  const daySpots = useMemo(() => (activeDay?.itineraryIds ?? [])
    .map((id) => spots.find((spot) => spot.id === id))
    .filter((spot): spot is PilgrimageSpot => Boolean(spot)), [activeDay]);
  const routeRequest = useMemo<RouteRequest | null>(() => {
    if (!sharedPlan || !activeDay || sharedPlan.travelMode === "TRANSIT" || daySpots.length < 2) return null;
    return {
      requestId: dayIndex + 1,
      stops: daySpots,
      travelMode: sharedPlan.travelMode,
      optimizeWaypointOrder: sharedPlan.optimizeOrder,
      stayMinutes: sharedPlan.stayMinutes,
      departureTime: departureIso(activeDay.visitDate ?? japanDate(), activeDay.startTime),
    };
  }, [activeDay, dayIndex, daySpots, sharedPlan]);

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
          {sharedPlan.days.map((day, index) => <button type="button" aria-current={dayIndex === index ? "date" : undefined} onClick={() => { setDayIndex(index); setSelectedId(day.itineraryIds[0] ?? ""); }} key={`${day.startTime}-${index}`}>DAY {String(index + 1).padStart(2, "0")}</button>)}
        </nav>
      ) : null}
      <div className="ui-trial__shared-grid">
        <div className="ui-trial__shared-map">
          <MapboxPilgrimageMap
            spots={daySpots}
            selectedId={selectedId || daySpots[0]?.id || ""}
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
          <ol>{daySpots.map((spot, index) => <li key={spot.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong><SpotName name={spot.name} /></strong><small>{sharedPlan.stayMinutes[spot.id] ?? recommendedStayMinutes(spot)}分滞在</small></div></li>)}</ol>
          <p className="ui-trial__shared-route-status">{sharedPlan.travelMode === "TRANSIT" ? "公共交通の経路は取り込み後に各区間を確認します。" : routeResult.state === "success" ? `${routeResult.distance} · ${routeResult.duration}` : routeResult.state === "error" ? routeResult.message : "経路を計算しています…"}</p>
        </article>
      </div>
      <aside><strong>この予定を取り込む</strong><p>取り込むと、現在保存されている予定はこの内容で上書きされます。</p><button type="button" onClick={onImport}>内容を確認して取り込む</button></aside>
    </section>
  );
}

function GuidePage({ onNavigate, onOpenImage }: {
  onNavigate: (page: TrialPage) => void;
  onOpenImage: (src: string, alt: string) => void;
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
            <button type="button" onClick={() => onOpenImage(assetUrl(step.image), step.alt)} aria-label={`${step.alt}を拡大表示`}>
              <img src={assetUrl(step.image)} alt={step.alt} loading="lazy" decoding="async" />
            </button>
          </article>
        ))}
      </div>
      <div className="ui-trial__guide-notice">
        <strong>訪れるときのお願い</strong>
        <p>地域・お店への配慮と、出発前の公式情報確認を忘れずに。</p>
      </div>
      <p className="ui-trial__guide-source">画面内のカード画像：©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ</p>
    </section>
  );
}

function TrialModal({ modal, onClose, onUpdateShareDates }: {
  modal: ModalState;
  onClose: () => void;
  onUpdateShareDates: (includeDates: boolean) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [shareFeedback, setShareFeedback] = useState("");
  useEffect(() => {
    if (!modal) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const feedbackTimer = window.setTimeout(() => setShareFeedback(""), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
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

  return (
    <div className="ui-trial__modal" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ui-trial__modal-dialog" role="dialog" aria-modal="true" aria-labelledby="ui-trial-modal-title">
        <header>
          <strong id="ui-trial-modal-title">{modal.kind === "share" ? "予定を共有" : modal.alt}</strong>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="閉じる">×</button>
        </header>
        {modal.kind === "guide" ? (
          <figure><img src={modal.src} alt={modal.alt} /></figure>
        ) : (
          <div className="ui-trial__share-dialog">
            <p>予定をプレビューし、そのまま取り込める共有URLを作成します。</p>
            <label className="ui-trial__share-date"><input type="checkbox" checked={modal.includeDates} onChange={(event) => onUpdateShareDates(event.target.checked)} /><span>訪問日も共有する</span></label>
            <label><span>共有URL</span><input readOnly value={modal.url} onFocus={(event) => event.currentTarget.select()} /></label>
            {!modal.url ? <p role="alert">共有するスポットを1か所以上追加してください。</p> : null}
            <div><button type="button" onClick={sharePlan} disabled={!modal.url}>{typeof navigator.share === "function" ? "共有画面を開く" : "URLをコピー"}</button><button type="button" onClick={copyShareUrl} disabled={!modal.url}>コピー</button></div>
            <small aria-live="polite">{shareFeedback}</small>
          </div>
        )}
      </section>
    </div>
  );
}

export function UiTrialApp() {
  const planner = useLivePlanner(spots);
  const [view, setView] = useState<TrialView>("explore");
  const [exploreMapView, setExploreMapView] = useState(false);
  const [sharedPlan, setSharedPlan] = useState<SharedPlanSnapshot | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const closeModal = useCallback(() => setModal(null), []);
  const page = view === "shared" ? "planner" : view;

  useEffect(() => {
    const syncLocation = () => {
      const parts = window.location.hash.replace(/^#\/?/, "").split("/");
      if (parts[0] === "shared") {
        setSharedPlan(decodeSharedPlanSnapshot(parts.slice(1).join("/"), new Set(spots.map((spot) => spot.id))));
        setExploreMapView(false);
        setView("shared");
        return;
      }
      const nextPage = (Object.keys(pageLabels) as TrialPage[]).includes(parts[0] as TrialPage)
        ? parts[0] as TrialPage
        : "explore";
      setSharedPlan(null);
      setExploreMapView(nextPage === "explore" && parts[1] === "map");
      setView(nextPage);
    };
    syncLocation();
    window.addEventListener("hashchange", syncLocation);
    return () => window.removeEventListener("hashchange", syncLocation);
  }, []);

  useEffect(() => {
    if (
      (view !== "planner" && view !== "today") ||
      !planner.restored ||
      planner.itinerarySpots.length < 2 ||
      planner.routeResult.state === "loading" ||
      planner.requestedRouteSignature === planner.currentRouteSignature
    ) return undefined;
    const timer = window.setTimeout(planner.calculateRoute, 650);
    return () => window.clearTimeout(timer);
  }, [planner.calculateRoute, planner.currentRouteSignature, planner.itinerarySpots.length, planner.requestedRouteSignature, planner.restored, planner.routeResult.state, view]);

  const navigate = (nextPage: TrialPage) => {
    setView(nextPage);
    setExploreMapView(false);
    setSharedPlan(null);
    const hash = `#/${nextPage}`;
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

  return (
    <div className={`ui-trial ui-trial--${page}`}>
      <TrialHeader
        page={page}
        itineraryCount={planner.itinerarySpots.length}
        completedCount={completedCount}
        visitDate={planner.activeDay?.visitDate ?? japanDate()}
        sharedPreview={view === "shared"}
        onNavigate={navigate}
        onOpenShare={openShare}
      />
      <main>
        {view === "explore" ? <ExplorePage planned={planner.itinerarySpots} mapView={exploreMapView} onTogglePlanned={(spot) => planner.toggleSpot(spot.id)} onNavigate={navigate} /> : null}
        {view === "planner" ? <PlannerPage planner={planner} onOpenShare={openShare} onNavigateExplore={() => navigate("explore")} /> : null}
        {view === "today" ? <TodayPage planner={planner} onOpenPlanner={() => navigate("planner")} /> : null}
        {view === "guide" ? <GuidePage onNavigate={navigate} onOpenImage={(src, alt) => setModal({ kind: "guide", src, alt })} /> : null}
        {view === "shared" ? <SharedPreviewPage sharedPlan={sharedPlan} onImport={importShared} onBack={() => navigate("explore")} /> : null}
      </main>
      <TrialNavigation page={page} itineraryCount={planner.itinerarySpots.length} onNavigate={navigate} />
      <TrialModal modal={modal} onClose={closeModal} onUpdateShareDates={updateShareDates} />
    </div>
  );
}
