"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
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
  type PlannerSnapshot,
  type TransitLegProgress,
} from "./planner-storage";
import {
  cardCharacters,
  cardModels,
  collaborationById,
  collaborations,
  type CollaborationId,
  type CardCharacter,
  type PilgrimageCollaboration,
  type PilgrimageSpot,
} from "./spots";
import {
  buildYahooTransitUrl,
  createYahooTransitLegs,
} from "./yahoo-transit";

const VISITOR_NOTICE_STORAGE_KEY = "hasunosora-pilgrimage.visitor-notice.v2";
const LEGACY_PLANNER_DRAFT_STORAGE_KEY = "hasunosora-pilgrimage.planner-draft.v1";
const PLANNER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

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

function japanDate(daysFromToday = 0) {
  const date = new Date(Date.now() + daysFromToday * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function departureIso(date: string, time: string) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function timeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 9) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function displayClock(totalMinutes: number) {
  const day = Math.floor(totalMinutes / 1440);
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${day > 0 ? `翌${day > 1 ? day : ""}日 ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function japanClockMinutes() {
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

function navigationTravelMode(mode: TravelMode) {
  if (mode === "DRIVING") return "driving";
  if (mode === "TRANSIT") return "transit";
  if (mode === "BICYCLING") return "bicycling";
  return "walking";
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

function collaborationsForSpot(spot: PilgrimageSpot) {
  return (spot.collaborationIds ?? []).flatMap((id) => {
    const collaboration = collaborationById(id);
    if (!collaboration) return [];
    const location = collaboration.locations.find((item) => item.spotId === spot.id);
    return [{ collaboration, role: location?.role, members: location?.members }];
  });
}

type Props = {
  mapboxConfig: {
    accessToken: string;
  };
  routeServiceUrl?: string;
  spots: PilgrimageSpot[];
  spotImages: Record<string, string>;
  heroImage: string | null;
};

export function PilgrimageApp({
  mapboxConfig,
  routeServiceUrl = "",
  spots,
  spotImages,
  heroImage,
}: Props) {
  const [hasAcceptedVisitorNotice, setHasAcceptedVisitorNotice] = useState(false);
  const [visitorNoticeChecks, setVisitorNoticeChecks] = useState([false, false, false]);
  const [selectedId, setSelectedId] = useState(spots[0].id);
  const [itineraryIds, setItineraryIds] = useState(() => spots.slice(0, 2).map((spot) => spot.id));
  const [addSpotId, setAddSpotId] = useState(spots[2]?.id ?? spots[0].id);
  const [stayMinutes, setStayMinutes] = useState<Record<string, number>>(() =>
    Object.fromEntries(spots.map((spot) => [spot.id, recommendedStayMinutes(spot)])),
  );
  const [travelMode, setTravelMode] = useState<TravelMode>("WALKING");
  const [optimizeOrder, setOptimizeOrder] = useState(true);
  const [sourceStationId, setSourceStationId] = useState("");
  const [visitDate, setVisitDate] = useState(() => japanDate());
  const [startTime, setStartTime] = useState("09:00");
  const [routeRequest, setRouteRequest] = useState<RouteRequest | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult>({ state: "idle" });
  const [spotQuery, setSpotQuery] = useState("");
  const [areaFilter, setAreaFilter] = useState("すべて");
  const [collaborationFilter, setCollaborationFilter] = useState<CollaborationId | "すべて">("すべて");
  const [itineraryCollaborationId, setItineraryCollaborationId] = useState<CollaborationId | "">("");
  const [cardCharacterFilter, setCardCharacterFilter] = useState<CardCharacter | "すべて">("すべて");
  const [hasRestoredPlannerStorage, setHasRestoredPlannerStorage] = useState(false);
  const [completedSpotIds, setCompletedSpotIds] = useState<string[]>([]);
  const [todayOffsetMinutes, setTodayOffsetMinutes] = useState(0);
  const [isTodayModeOpen, setIsTodayModeOpen] = useState(false);
  const [currentJapanMinutes, setCurrentJapanMinutes] = useState(() => japanClockMinutes());
  const [transitLegProgress, setTransitLegProgress] = useState<TransitLegProgress>({});

  useEffect(() => {
    let wasAccepted = false;
    try {
      wasAccepted = window.localStorage.getItem(VISITOR_NOTICE_STORAGE_KEY) === "accepted";
    } catch {
      return undefined;
    }
    if (!wasAccepted) return undefined;
    const restoreAcceptance = window.setTimeout(() => {
      setHasAcceptedVisitorNotice(true);
    }, 0);
    return () => window.clearTimeout(restoreAcceptance);
  }, []);

  useEffect(() => {
    if (hasAcceptedVisitorNotice) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [hasAcceptedVisitorNotice]);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      const validSpotIds = new Set(spots.map((spot) => spot.id));
      try {
        const cookieDraft = parsePlannerDraftCookie(document.cookie, validSpotIds);
        const legacyDraftRaw = cookieDraft
          ? null
          : window.localStorage.getItem(LEGACY_PLANNER_DRAFT_STORAGE_KEY);
        const draft = cookieDraft ?? (legacyDraftRaw
          ? sanitizePlannerSnapshot(JSON.parse(legacyDraftRaw) as unknown, validSpotIds)
          : null);
        if (draft) {
          setItineraryIds(draft.itineraryIds);
          setStayMinutes((current) => ({ ...current, ...draft.stayMinutes }));
          setTravelMode(draft.travelMode);
          setOptimizeOrder(draft.optimizeOrder);
          setSourceStationId(draft.sourceStationId);
          setVisitDate(draft.visitDate || japanDate());
          setStartTime(draft.startTime);
          setItineraryCollaborationId(draft.itineraryCollaborationId as CollaborationId | "");
          setCompletedSpotIds(draft.completedSpotIds);
          setTodayOffsetMinutes(draft.todayOffsetMinutes);
          setTransitLegProgress(draft.transitLegProgress);
          setSelectedId(draft.itineraryIds[0]);
        }
      } catch {
        // 保存領域が使えない場合も、通常の旅程作成はそのまま利用できます。
      }
      setHasRestoredPlannerStorage(true);
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [spots]);

  useEffect(() => {
    if (!hasRestoredPlannerStorage) return;
    const snapshot: PlannerSnapshot = {
      itineraryIds,
      stayMinutes,
      travelMode,
      optimizeOrder,
      sourceStationId,
      visitDate,
      startTime,
      itineraryCollaborationId,
      completedSpotIds,
      todayOffsetMinutes,
      transitLegProgress,
    };
    try {
      const encoded = serializePlannerDraftCookie(snapshot);
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${PLANNER_DRAFT_COOKIE_KEY}=${encoded}; Max-Age=${PLANNER_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
    } catch {
      // 自動保存に失敗しても、画面上の編集中データは維持します。
    }
  }, [completedSpotIds, hasRestoredPlannerStorage, itineraryCollaborationId, itineraryIds, optimizeOrder, sourceStationId, startTime, stayMinutes, todayOffsetMinutes, transitLegProgress, travelMode, visitDate]);

  useEffect(() => {
    if (!isTodayModeOpen) return undefined;
    const initialTimer = window.setTimeout(() => setCurrentJapanMinutes(japanClockMinutes()), 0);
    const timer = window.setInterval(() => setCurrentJapanMinutes(japanClockMinutes()), 60_000);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
      document.body.style.overflow = previousOverflow;
    };
  }, [isTodayModeOpen]);

  const confirmedVisitorNoticeCount = visitorNoticeChecks.filter(Boolean).length;
  const hasConfirmedAllVisitorNotices = confirmedVisitorNoticeCount === visitorNoticeChecks.length;

  function changeVisitorNoticeCheck(index: number, checked: boolean) {
    setVisitorNoticeChecks((current) =>
      current.map((value, currentIndex) => currentIndex === index ? checked : value),
    );
  }

  function acceptVisitorNotice() {
    if (!hasConfirmedAllVisitorNotices) return;
    try {
      window.localStorage.setItem(VISITOR_NOTICE_STORAGE_KEY, "accepted");
    } catch {
      // 保存できない環境でも、この閲覧中はサイトを利用できるようにします。
    }
    setHasAcceptedVisitorNotice(true);
  }

  function reviewVisitorNotice() {
    try {
      window.localStorage.removeItem(VISITOR_NOTICE_STORAGE_KEY);
    } catch {
      // 保存領域を利用できない環境でも、同意画面は再表示します。
    }
    setVisitorNoticeChecks([false, false, false]);
    setHasAcceptedVisitorNotice(false);
  }

  const areas = useMemo(
    () => Array.from(new Set(spots.map((spot) => spot.area))),
    [spots],
  );
  const filteredSpots = useMemo(() => {
    const normalizedQuery = spotQuery.trim().toLocaleLowerCase("ja");
    return spots.filter((spot) => {
      if (areaFilter !== "すべて" && spot.area !== areaFilter) return false;
      if (
        collaborationFilter !== "すべて" &&
        !spot.collaborationIds?.includes(collaborationFilter)
      ) return false;
      if (!normalizedQuery) return true;
      return [
        spot.name,
        spot.shortName,
        spot.address,
        spot.category,
        ...(spot.activityRecords ?? []),
        ...(spot.sehasEpisodes ?? []),
        ...(spot.appearances ?? []),
        ...collaborationsForSpot(spot).flatMap(({ collaboration, role, members }) => [
          collaboration.name,
          collaboration.subtitle,
          role ?? "",
          ...(members ?? []),
        ]),
      ].some((value) => value.toLocaleLowerCase("ja").includes(normalizedQuery));
    });
  }, [areaFilter, collaborationFilter, spotQuery, spots]);
  const filteredCardModels = useMemo(
    () => cardModels.filter((card) =>
      cardCharacterFilter === "すべて" || card.characters.includes(cardCharacterFilter),
    ),
    [cardCharacterFilter],
  );

  const spotById = (id: string) => spots.find((spot) => spot.id === id);
  const selectedSpot = spotById(selectedId) ?? spots[0];
  const selectedCollaborations = collaborationsForSpot(selectedSpot);
  const itinerarySpots = useMemo(
    () => itineraryIds.map((id) => spots.find((spot) => spot.id === id)).filter((spot): spot is PilgrimageSpot => Boolean(spot)),
    [itineraryIds, spots],
  );
  const availableSpots = spots.filter((spot) => !itineraryIds.includes(spot.id));

  const plannedSpots = useMemo(() => {
    if (routeResult.state !== "success" || !routeResult.orderedStopIds?.length || !routeRequest) {
      return routeRequest?.stops ?? itinerarySpots;
    }
    const byId = new Map(routeRequest.stops.map((spot) => [spot.id, spot]));
    return routeResult.orderedStopIds.map((id) => byId.get(id)).filter((spot): spot is PilgrimageSpot => Boolean(spot));
  }, [itinerarySpots, routeRequest, routeResult]);

  const schedule = useMemo(() => {
    if (routeResult.state !== "success" || !routeRequest || !routeResult.legDurationMinutes) return null;
    const start = timeToMinutes(startTime);
    const accessDuration = routeResult.accessDurationMinutes ?? 0;
    const calculated = plannedSpots.reduce<{
      entries: Array<{ spot: PilgrimageSpot; arrival: number; departure: number; stay: number }>;
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
    const entries = calculated.entries;
    return {
      entries,
      start,
      finish: entries.at(-1)?.departure ?? start,
      accessDuration,
    };
  }, [plannedSpots, routeRequest, routeResult, startTime, stayMinutes]);

  const currentRouteSignature = useMemo(() => JSON.stringify({
    stops: itineraryIds,
    stay: travelMode === "TRANSIT" ? itineraryIds.map((id) => {
      const spot = spots.find((item) => item.id === id);
      return stayMinutes[id] ?? (spot ? recommendedStayMinutes(spot) : 0);
    }) : [],
    travelMode,
    optimizeWaypointOrder: travelMode !== "TRANSIT" && optimizeOrder,
    accessOriginId: travelMode === "TRANSIT" ? sourceStationId : "",
    departureTime: travelMode === "TRANSIT"
      ? departureIso(visitDate, startTime)
      : "",
  }), [itineraryIds, optimizeOrder, sourceStationId, spots, startTime, stayMinutes, travelMode, visitDate]);
  const requestedRouteSignature = useMemo(() => routeRequest ? JSON.stringify({
    stops: routeRequest.stops.map((spot) => spot.id),
    stay: routeRequest.travelMode === "TRANSIT"
      ? routeRequest.stops.map((spot) => routeRequest.stayMinutes[spot.id] ?? recommendedStayMinutes(spot))
      : [],
    travelMode: routeRequest.travelMode,
    optimizeWaypointOrder: routeRequest.optimizeWaypointOrder,
    accessOriginId: routeRequest.travelMode === "TRANSIT" ? routeRequest.accessOrigin?.id ?? "" : "",
    departureTime: routeRequest.travelMode === "TRANSIT"
      ? routeRequest.departureTime
      : "",
  }) : "", [routeRequest]);
  const routeIsCurrent = (
    routeResult.state === "success" || routeResult.state === "external"
  ) && currentRouteSignature === requestedRouteSignature;
  const transitLegs = useMemo(() => {
    if (routeRequest?.travelMode !== "TRANSIT" || !routeIsCurrent) return [];
    return createYahooTransitLegs(
      routeRequest.stops,
      routeRequest.accessOrigin,
      visitDate,
      startTime,
      routeRequest.stayMinutes,
    ).map((leg) => {
      const progress = transitLegProgress[leg.id];
      return {
        ...leg,
        date: progress?.date ?? leg.date,
        time: progress?.time ?? leg.time,
        confirmed: progress?.confirmed ?? false,
      };
    });
  }, [routeIsCurrent, routeRequest, startTime, transitLegProgress, visitDate]);
  const confirmedTransitLegCount = transitLegs.filter((leg) => leg.confirmed).length;

  const completedScheduledSpotIds = schedule
    ? schedule.entries.filter((entry) => completedSpotIds.includes(entry.spot.id)).map((entry) => entry.spot.id)
    : [];
  const nextTodayEntry = schedule?.entries.find((entry) => !completedSpotIds.includes(entry.spot.id));

  function toggleCompletedSpot(spotId: string) {
    setCompletedSpotIds((current) => current.includes(spotId)
      ? current.filter((id) => id !== spotId)
      : [...current, spotId]);
  }

  function alignRemainingScheduleToNow() {
    if (!nextTodayEntry || visitDate !== japanDate()) return;
    setTodayOffsetMinutes(currentJapanMinutes - nextTodayEntry.arrival);
  }

  function invalidateRoute() {
    setRouteRequest(null);
    setRouteResult({ state: "idle" });
    setIsTodayModeOpen(false);
    setTodayOffsetMinutes(0);
    setTransitLegProgress({});
  }

  const handleRouteResult = useCallback((result: RouteResult) => {
    setRouteResult(result);
  }, []);

  function searchRoute() {
    if (itinerarySpots.length < 2) {
      setRouteResult({
        state: "error",
        message: "予定には2か所以上のスポットを追加してください。",
      });
      return;
    }
    if (routeIsCurrent) return;
    const accessOrigin = travelMode === "TRANSIT"
      ? majorStations.find((station) => station.id === sourceStationId)
      : undefined;
    const request: RouteRequest = {
      requestId: Date.now(),
      stops: itinerarySpots,
      travelMode,
      optimizeWaypointOrder: travelMode !== "TRANSIT" && optimizeOrder,
      stayMinutes: { ...stayMinutes },
      accessOrigin,
      departureTime: departureIso(visitDate, startTime),
    };
    setRouteRequest(request);
    if (travelMode === "TRANSIT") {
      const legs = createYahooTransitLegs(
        itinerarySpots,
        accessOrigin,
        visitDate,
        startTime,
        stayMinutes,
      );
      setTransitLegProgress((current) => Object.fromEntries(
        legs.map((leg) => [
          leg.id,
          current[leg.id] ?? { date: leg.date, time: leg.time, confirmed: false },
        ]),
      ));
      setRouteResult({
        state: "external",
        message: "訪問順にYahoo!乗換案内の区間検索を用意しました。",
      });
    }
    setSelectedId(itinerarySpots.at(-1)!.id);
  }

  function addSpot(requestedId?: string) {
    const id = requestedId ?? (
      itineraryIds.includes(addSpotId)
        ? spots.find((spot) => !itineraryIds.includes(spot.id))?.id
        : addSpotId
    );
    if (!id || itineraryIds.includes(id) || itineraryIds.length >= maximumItineraryStops) return;
    setItineraryIds((current) => [...current, id]);
    const next = spots.find((spot) => !itineraryIds.includes(spot.id) && spot.id !== id);
    if (next) setAddSpotId(next.id);
    invalidateRoute();
  }

  function fillItineraryFromCollaboration(id: CollaborationId | "") {
    setItineraryCollaborationId(id);
    if (!id) return;

    const collaboration = collaborationById(id);
    if (!collaboration) return;
    const knownSpotIds = new Set(spots.map((spot) => spot.id));
    const collaborationSpotIds = Array.from(
      new Set(
        collaboration.locations
          .map((location) => location.spotId)
          .filter((spotId) => knownSpotIds.has(spotId)),
      ),
    ).slice(0, maximumItineraryStops);
    if (collaborationSpotIds.length < 2) {
      setRouteResult({
        state: "error",
        message: "このコラボはルート検索できる登録地点が不足しています。",
      });
      return;
    }

    setItineraryIds(collaborationSpotIds);
    setSelectedId(collaborationSpotIds[0]);
    setCollaborationFilter(id);
    setAreaFilter("すべて");
    setSpotQuery("");
    const nextAvailable = spots.find((spot) => !collaborationSpotIds.includes(spot.id));
    if (nextAvailable) setAddSpotId(nextAvailable.id);
    invalidateRoute();
  }

  function removeSpot(index: number) {
    if (itineraryIds.length <= 2) return;
    setItineraryIds((current) => current.filter((_, itemIndex) => itemIndex !== index));
    invalidateRoute();
  }

  function moveSpot(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= itineraryIds.length) return;
    setItineraryIds((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    invalidateRoute();
  }

  function changeStayMinutes(id: string, value: number) {
    setStayMinutes((current) => ({ ...current, [id]: Math.max(0, Math.min(480, value || 0)) }));
    if (travelMode === "TRANSIT" && routeRequest) invalidateRoute();
  }

  return (
    <>
      {!hasAcceptedVisitorNotice ? (
        <div className="visitor-notice" role="presentation">
          <section
            className="visitor-notice__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="visitor-notice-title"
            aria-describedby="visitor-notice-description"
          >
            <div className="visitor-notice__mark" aria-hidden="true">蓮</div>
            <p className="visitor-notice__eyebrow">BEFORE YOUR JOURNEY</p>
            <h2 id="visitor-notice-title">巡礼へ出発する前に</h2>
            <p id="visitor-notice-description" className="visitor-notice__lead">
              このサイトをご利用になる前に、以下の注意事項をご確認ください。
            </p>
            <div className="visitor-notice__items">
              <label>
                <input
                  type="checkbox"
                  checked={visitorNoticeChecks[0]}
                  onChange={(event) => changeVisitorNoticeCheck(0, event.target.checked)}
                  autoFocus
                />
                <span className="visitor-notice__number">01</span>
                <div>
                  <h3>地域とスポットへの配慮</h3>
                  <p>
                    通行や営業、地域で暮らす方を優先してください。私有地への立入りや無断撮影、
                    長時間の占有などはせず、各施設のルールと係員の案内を守りましょう。
                  </p>
                </div>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={visitorNoticeChecks[1]}
                  onChange={(event) => changeVisitorNoticeCheck(1, event.target.checked)}
                />
                <span className="visitor-notice__number">02</span>
                <div>
                  <h3>最新情報と安全の確認</h3>
                  <p>
                    営業時間、休業日、交通機関、道路状況、天候は変わることがあります。
                    出発前と移動中に公式情報を確認し、無理のない行動をしてください。
                  </p>
                </div>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={visitorNoticeChecks[2]}
                  onChange={(event) => changeVisitorNoticeCheck(2, event.target.checked)}
                />
                <span className="visitor-notice__number">03</span>
                <div>
                  <h3>旅程とルートについて</h3>
                  <p>
                    本サイトの旅程、所要時間、ルートは参考情報であり、予定どおりの移動や到着を保証するものではありません。
                    遅延、予定変更、費用その他の損害についてサイト運営者は責任を負いません。
                    安全確認と最終的な判断は、ご自身でお願いいたします。
                  </p>
                </div>
              </label>
            </div>
            <p className="visitor-notice__progress" id="visitor-notice-progress" aria-live="polite">
              <span>確認済み {confirmedVisitorNoticeCount} / {visitorNoticeChecks.length}</span>
              <strong>{hasConfirmedAllVisitorNotices ? "すべて確認済みです" : "各項目にチェックしてください"}</strong>
            </p>
            <button
              type="button"
              className="visitor-notice__accept"
              onClick={acceptVisitorNotice}
              disabled={!hasConfirmedAllVisitorNotices}
              aria-describedby="visitor-notice-progress"
            >
              内容に同意してサイトを見る
              <span aria-hidden="true">→</span>
            </button>
            <small>同意しない場合は、このページを閉じてください。</small>
          </section>
        </div>
      ) : null}

      <main className={heroImage ? "has-managed-hero" : undefined}>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="蓮ノ旅 ホーム">
          <span className="brand-mark" aria-hidden="true">
            蓮
          </span>
          <span>
            <strong>蓮ノ旅</strong>
            <small>HASUNOSORA PILGRIMAGE GUIDE</small>
          </span>
        </a>
        <nav className="desktop-nav" aria-label="メインナビゲーション">
          <a href="#map">巡礼マップ</a>
          <a href="#collaborations">コラボ</a>
          <a href="#spots">スポット</a>
          <a href="#card-models">カードモデル地</a>
          <a href="#guide">巡礼のしおり</a>
        </nav>
        <a
          className="header-cta"
          href="https://www.lovelive-anime.jp/hasunosora/"
          target="_blank"
          rel="noreferrer"
        >
          作品公式サイト
          <span aria-hidden="true">↗</span>
        </a>
      </header>

      <nav className="mobile-nav" aria-label="スマートフォン用メニュー">
        <a href="#map"><span>地図</span><small>MAP</small></a>
        <a href="#planner"><span>予定</span><small>PLAN</small></a>
        <a href="#spots"><span>場所</span><small>SPOTS</small></a>
        <a href="#card-models"><span>カード</span><small>CARDS</small></a>
      </nav>

      <section
        className={`hero${heroImage ? " has-managed-image" : ""}`}
        id="top"
        style={
          heroImage
            ? ({ "--hero-image": `url("${heroImage}")` } as CSSProperties)
            : undefined
        }
      >
        <div className="hero-orb hero-orb--one" />
        <div className="hero-orb hero-orb--two" />
        <div className="hero-copy">
          <div className="eyebrow">
            <span>MVP</span>
            ISHIKAWA · KANAZAWA
          </div>
          <p className="hero-kicker">蓮ノ空女学院スクールアイドルクラブ</p>
          <h1 className="hero-title-space" aria-hidden="true" />
          <p className="hero-lead">
            金沢から能登・加賀まで、作品にまつわる場所をひとつの地図に。
            行きたい場所を選んだら、そのまま次の景色へ向かえます。
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#map">
              地図から探す
              <span aria-hidden="true">↓</span>
            </a>
            <a className="text-link" href="#spots">
              全{spots.length}スポットを見る
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="hero-date">
            <span>JOURNEY</span>
            <strong>01</strong>
          </div>
          <div className="lotus lotus--one" />
          <div className="lotus lotus--two" />
          <div className="hero-place-card">
            <small>START FROM</small>
            <strong>KANAZAWA</strong>
            <span>36.5781° N · 136.6481° E</span>
          </div>
          <div className="vertical-copy">ONE STORY · {spots.length} PLACES</div>
        </div>
        <div className="hero-stats">
          <div>
            <strong>{spots.length}</strong>
            <span>SPOTS</span>
          </div>
          <div>
            <strong>{areas.length}</strong>
            <span>AREAS</span>
          </div>
          <div>
            <strong>ROUTE</strong>
            <span>MAP BY MAPBOX</span>
          </div>
        </div>
      </section>

      <section className="map-section" id="map">
        <div className="section-heading">
          <div>
            <p className="section-number">01 — PILGRIMAGE MAP</p>
            <h2>次に向かう景色を選ぶ</h2>
          </div>
          <p>
            ピンまたは一覧からスポットを選択してください。
            行きたい場所を予定へ追加すると、訪問順と一日の時刻表を作れます。
          </p>
        </div>

        <div className="map-layout">
          <div className="map-column">
            <MapboxPilgrimageMap
              spots={spots}
              selectedId={selectedId}
              onSelect={setSelectedId}
              routeRequest={routeRequest}
              onRouteResult={handleRouteResult}
              accessToken={mapboxConfig.accessToken}
              routeServiceUrl={routeServiceUrl}
            />
            <div className="selected-spot-bar">
              <span className="spot-index">
                {String(
                  spots.findIndex((spot) => spot.id === selectedSpot.id) + 1,
                ).padStart(2, "0")}
              </span>
              <div>
                <small>
                  {selectedSpot.area} · {selectedSpot.category}
                </small>
                <strong>{selectedSpot.name}</strong>
                {selectedCollaborations.length ? (
                  <span className="selected-spot-collaboration">
                    コラボ · {selectedCollaborations.map(({ collaboration }) => collaboration.name).join(" / ")}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                disabled={itineraryIds.includes(selectedSpot.id) || itineraryIds.length >= maximumItineraryStops}
                onClick={() => {
                  addSpot(selectedSpot.id);
                  document
                    .querySelector(".route-planner")
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              >
                {itineraryIds.includes(selectedSpot.id) ? "予定に追加済み" : "予定に追加する"}
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>

          <aside className="route-planner" id="planner" aria-label="一日の予定作成">
            <div className="route-planner__heading">
              <div>
                <p>DAY PLANNER</p>
                <h3>一日の巡礼予定を作る</h3>
              </div>
              <span className="route-badge">
                {travelMode === "TRANSIT" ? "Yahoo!乗換案内" : "Mapbox"}
              </span>
            </div>

            <div className="collaboration-route-fill">
              <label>
                <span>コラボから自動入力</span>
                <select
                  value={itineraryCollaborationId}
                  onChange={(event) =>
                    fillItineraryFromCollaboration(event.target.value as CollaborationId | "")
                  }
                >
                  <option value="">コラボを選択してください</option>
                  {collaborations.map((collaboration) => (
                    <option key={collaboration.id} value={collaboration.id}>
                      {collaboration.name}（{collaboration.locations.length}か所）
                    </option>
                  ))}
                </select>
              </label>
              {itineraryCollaborationId ? (
                <p>
                  <strong>{collaborationById(itineraryCollaborationId)?.name}</strong>の登録地点を予定へ自動入力しました。
                  順番・滞在時間・不要な地点は下で調整できます。
                </p>
              ) : (
                <p>選択すると対象地点をまとめて予定へ追加します。</p>
              )}
            </div>

            <div className="journey-start">
              <label>
                <span>出発駅（任意）</span>
                <select
                  value={sourceStationId}
                  disabled={travelMode !== "TRANSIT"}
                  onChange={(event) => {
                    setSourceStationId(event.target.value);
                    invalidateRoute();
                  }}
                  aria-describedby="station-search-status"
                >
                  <option value="">現地の最初のスポットから開始</option>
                  {Array.from(new Set(majorStations.map((station) => station.region))).map((region) => (
                    <optgroup label={region} key={region}>
                      {majorStations
                        .filter((station) => station.region === region)
                        .map((station) => (
                          <option value={station.id} key={station.id}>{station.name}</option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <p id="station-search-status" className="journey-start__status">
                {travelMode === "TRANSIT"
                  ? "全国の主要駅から最初のスポットまでの検索も追加できます。"
                  : "公共交通を選ぶと、出発駅を指定できます。"}
              </p>
              <div>
                <label>
                  <span>訪問日</span>
                  <input
                    type="date"
                    min={japanDate()}
                    max={japanDate(99)}
                    value={visitDate}
                    onChange={(event) => {
                      setVisitDate(event.target.value);
                      if (travelMode === "TRANSIT" || sourceStationId) invalidateRoute();
                    }}
                  />
                </label>
                <label>
                  <span>出発時刻</span>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(event) => {
                      setStartTime(event.target.value);
                      if (travelMode === "TRANSIT" || sourceStationId) invalidateRoute();
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="itinerary-editor">
              <div className="itinerary-editor__heading">
                <strong>訪問するスポット</strong>
                <span>{itineraryIds.length} / {maximumItineraryStops}</span>
              </div>
              <ol>
                {itinerarySpots.map((spot, index) => (
                  <li key={spot.id}>
                    <span className={`route-point ${index === 0 ? "route-point--start" : index === itinerarySpots.length - 1 ? "route-point--goal" : ""}`}>
                      {index === 0 ? "S" : index === itinerarySpots.length - 1 ? "G" : index + 1}
                    </span>
                    <div>
                      <strong>{spot.shortName}</strong>
                      <label>
                        滞在
                        <input
                          type="number"
                          min="0"
                          max="480"
                          step="5"
                          value={stayMinutes[spot.id] ?? recommendedStayMinutes(spot)}
                          onChange={(event) => changeStayMinutes(spot.id, Number(event.target.value))}
                        />
                        分
                      </label>
                    </div>
                    <div className="itinerary-actions">
                      <button type="button" disabled={index === 0} onClick={() => moveSpot(index, -1)} aria-label={`${spot.name}を一つ前へ`}>↑</button>
                      <button type="button" disabled={index === itinerarySpots.length - 1} onClick={() => moveSpot(index, 1)} aria-label={`${spot.name}を一つ後ろへ`}>↓</button>
                      <button type="button" disabled={itinerarySpots.length <= 2} onClick={() => removeSpot(index)} aria-label={`${spot.name}を予定から外す`}>×</button>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="itinerary-add">
                <select
                  value={availableSpots.some((spot) => spot.id === addSpotId) ? addSpotId : availableSpots[0]?.id ?? ""}
                  onChange={(event) => setAddSpotId(event.target.value)}
                  disabled={!availableSpots.length || itineraryIds.length >= maximumItineraryStops}
                  aria-label="追加するスポット"
                >
                  {areas.map((area) => {
                    const areaSpots = availableSpots.filter((spot) => spot.area === area);
                    return areaSpots.length ? (
                      <optgroup label={area} key={area}>
                        {areaSpots.map((spot) => <option key={spot.id} value={spot.id}>{spot.shortName}</option>)}
                      </optgroup>
                    ) : null;
                  })}
                </select>
                <button type="button" onClick={() => addSpot()} disabled={!availableSpots.length || itineraryIds.length >= maximumItineraryStops}>追加</button>
              </div>
            </div>

            <fieldset className="travel-modes">
              <legend>移動手段</legend>
              <div>
                {travelModes.map((mode) => (
                  <label key={mode.value} className={mode.disabled ? "is-disabled" : undefined}>
                    <input
                      type="radio"
                      name="travel-mode"
                      value={mode.value}
                      checked={travelMode === mode.value}
                      disabled={mode.disabled}
                      onChange={() => {
                        if (mode.disabled) return;
                        setTravelMode(mode.value);
                        invalidateRoute();
                      }}
                    />
                    <span className="mode-icon">{mode.icon}</span>
                    <span>{mode.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className={`route-optimize ${travelMode === "TRANSIT" ? "is-disabled" : ""}`}>
              <input
                type="checkbox"
                checked={travelMode !== "TRANSIT" && optimizeOrder}
                disabled={travelMode === "TRANSIT"}
                onChange={(event) => {
                  setOptimizeOrder(event.target.checked);
                  invalidateRoute();
                }}
              />
              <span>
                <strong>訪問順を自動で最適化</strong>
                <small>{travelMode === "TRANSIT" ? "公共交通は指定順で、各スポットの滞在終了時刻に合わせて区間検索します。" : "最初と最後を固定して、中間地点を並べ替えます。"}</small>
              </span>
            </label>

            <button
              className="route-search-button"
              type="button"
              onClick={searchRoute}
              disabled={routeResult.state === "loading" || routeIsCurrent}
            >
              {routeResult.state === "loading"
                ? "計算しています…"
                : routeIsCurrent
                  ? travelMode === "TRANSIT" ? "検索リンクを作成済みです" : "この内容は計算済みです"
                  : travelMode === "TRANSIT" ? "Yahoo!検索リンクを作る" : "この内容で予定を計算する"}
              <span aria-hidden="true">→</span>
            </button>

            <p className="route-api-note">
              {travelMode === "TRANSIT"
                ? "指定順に区間検索を作ります。検索結果はYahoo!乗換案内で確認してください。"
                : "移動時間と訪問順を計算し、一日の予定として表示します。"}
            </p>

            <div
              className={`route-result route-result--${routeResult.state}`}
              aria-live="polite"
            >
              {routeResult.state === "idle" && (
                <>
                  <span className="result-symbol">＋</span>
                  <p>
                    2か所以上を選び、滞在時間と訪問順を決めてください。
                  </p>
                </>
              )}
              {routeResult.state === "loading" && (
                <>
                  <span className="result-symbol is-loading">◌</span>
                  <p>移動ルートと一日の予定を計算しています…</p>
                </>
              )}
              {routeResult.state === "success" && (
                <>
                  <span className="result-symbol">✓</span>
                  <div className="result-details">
                    <div className="result-metrics">
                      <span>
                        <small>距離</small>
                        <strong>{routeResult.distance ?? "—"}</strong>
                      </span>
                      <span>
                        <small>総移動時間</small>
                        <strong>{routeResult.duration ?? "—"}</strong>
                      </span>
                    </div>
                  </div>
                </>
              )}
              {routeResult.state === "external" && (
                <>
                  <span className="result-symbol">交</span>
                  <p>{routeResult.message}</p>
                </>
              )}
              {(routeResult.state === "fallback" ||
                routeResult.state === "error") && (
                <>
                  <span className="result-symbol">i</span>
                  <p>{routeResult.message}</p>
                </>
              )}
            </div>

            {transitLegs.length ? (
              <section className="transit-search-panel" aria-label="Yahoo!乗換案内の区間検索">
                <div className="transit-search-panel__heading">
                  <div>
                    <small>PUBLIC TRANSIT</small>
                    <strong>区間ごとに乗換を調べる</strong>
                  </div>
                  <span>{confirmedTransitLegCount} / {transitLegs.length} 確認済み</span>
                </div>
                <progress
                  className="transit-search-panel__progress"
                  value={confirmedTransitLegCount}
                  max={transitLegs.length}
                  aria-label={`${transitLegs.length}区間中${confirmedTransitLegCount}区間を確認済み`}
                />
                <p>
                  2区間目以降の時刻は、移動を各60分として仮置きしています。
                  前の検索結果に合わせて出発時刻を調整し、確認済みにしてください。
                </p>
                <ol>
                  {transitLegs.map((leg, index) => (
                    <li key={leg.id} className={leg.confirmed ? "is-confirmed" : undefined}>
                      <div className="transit-search-panel__route">
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <strong>{leg.fromLabel} → {leg.toLabel}</strong>
                          <small>検索名：{leg.from} → {leg.to}</small>
                        </div>
                      </div>
                      <div className="transit-search-panel__datetime">
                        <label>
                          <span>出発日</span>
                          <input
                            type="date"
                            min={visitDate}
                            max={japanDate(100)}
                            value={leg.date}
                            onChange={(event) => setTransitLegProgress((current) => ({
                              ...current,
                              [leg.id]: {
                                date: event.target.value,
                                time: leg.time,
                                confirmed: false,
                              },
                            }))}
                          />
                        </label>
                        <label>
                          <span>出発時刻</span>
                          <input
                            type="time"
                            value={leg.time}
                            onChange={(event) => setTransitLegProgress((current) => ({
                              ...current,
                              [leg.id]: {
                                date: leg.date,
                                time: event.target.value,
                                confirmed: false,
                              },
                            }))}
                          />
                        </label>
                      </div>
                      <a
                        href={buildYahooTransitUrl(leg)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Yahoo!乗換案内で検索
                        <span aria-hidden="true">↗</span>
                      </a>
                      <label className="transit-search-panel__confirmed">
                        <input
                          type="checkbox"
                          checked={leg.confirmed}
                          onChange={(event) => setTransitLegProgress((current) => ({
                            ...current,
                            [leg.id]: {
                              date: leg.date,
                              time: leg.time,
                              confirmed: event.target.checked,
                            },
                          }))}
                        />
                        <span>
                          <strong>{leg.confirmed ? "確認済み" : "Yahoo!の検索結果を確認する"}</strong>
                          <small>{leg.confirmed ? "この区間の時刻を確認しました" : "結果を見たあとにチェックしてください"}</small>
                        </span>
                      </label>
                    </li>
                  ))}
                </ol>
                <small>
                  確認状態と調整した時刻は、この端末の旅程にだけ保存されます。
                  Yahoo!側で表示される施設候補、運休日、臨時ダイヤも確認してください。
                </small>
              </section>
            ) : null}

            {schedule && routeResult.state === "success" && (
              <section className="day-schedule" aria-label="作成した一日予定">
                <div className="day-schedule__heading">
                  <div>
                    <small>YOUR DAY</small>
                    <strong>{visitDate.replaceAll("-", ".")}</strong>
                  </div>
                  <span>{displayClock(schedule.finish)} 終了予定</span>
                </div>
                {routeRequest?.accessOrigin && (
                  <div className="access-schedule">
                    <time>{displayClock(schedule.start)}</time>
                    <p><strong>{routeRequest.accessOrigin.name}</strong>を出発</p>
                    <small>公共交通 約{formatDuration(schedule.accessDuration)}</small>
                  </div>
                )}
                <ol>
                  {schedule.entries.map((entry, index) => {
                    const hoursStatus = openingHoursStatus(entry.spot, visitDate, entry.arrival);
                    return (
                      <li key={entry.spot.id}>
                        <time>{displayClock(entry.arrival)}</time>
                        <div>
                          <strong>{entry.spot.shortName}</strong>
                          <small>{entry.stay}分滞在 · {displayClock(entry.departure)}出発</small>
                          <small className={`opening-status opening-status--${hoursStatus.kind}`}>
                            {hoursStatus.label}
                          </small>
                          {routeResult.legDurationMinutes?.[index] ? (
                            <span>次へ 約{formatDuration(routeResult.legDurationMinutes[index])}</span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <p>
                  滞在込み <strong>{formatDuration(schedule.finish - schedule.start)}</strong>
                  {routeResult.orderedStopIds?.join("|") !== routeRequest?.stops.map((spot) => spot.id).join("|") ? " · 最適化した順で表示" : ""}
                </p>
                <button
                  type="button"
                  className="today-mode-open"
                  onClick={() => setIsTodayModeOpen(true)}
                >
                  当日用モードを開く
                  <span aria-hidden="true">→</span>
                </button>
              </section>
            )}
          </aside>
        </div>
      </section>

      <section className="collaborations-section" id="collaborations">
        <div className="section-heading">
          <div>
            <p className="section-number">02 — LIMITED COLLABORATIONS</p>
            <h2>期間限定のコラボを巡る</h2>
          </div>
          <p>
            公式発表済みの企画から、加賀温泉郷コラボと石川県コラボ第5弾だけを掲載しています。
            開催期間や各施設の休業日は、出発前に公式案内も確認してください。
          </p>
        </div>
        <div className="collaboration-grid">
          {collaborations.map((collaboration) => {
            const status = collaborationStatus(collaboration);
            const routeableSpots = collaboration.locations.filter((location) =>
              spots.some((spot) => spot.id === location.spotId),
            );
            return (
              <article className="collaboration-card" key={collaboration.id}>
                <div className="collaboration-card__topline">
                  <span className="collaboration-label">コラボ</span>
                  <span className={`collaboration-status${status === "開催中" ? " is-active" : status === "開催前" ? " is-upcoming" : " is-ended"}`}>
                    {status}
                  </span>
                </div>
                <small>{collaboration.subtitle}</small>
                <h3>{collaboration.name}</h3>
                <p>{collaboration.description}</p>
                <dl>
                  <div>
                    <dt>開催期間</dt>
                    <dd>
                      {formatCollaborationDate(collaboration.startDate)} — {formatCollaborationDate(collaboration.endDate)}
                    </dd>
                  </div>
                  <div>
                    <dt>登録地点</dt>
                    <dd>{routeableSpots.length}か所</dd>
                  </div>
                </dl>
                <div className="collaboration-card__actions">
                  <button
                    type="button"
                    onClick={() => {
                      fillItineraryFromCollaboration(collaboration.id);
                      document
                        .querySelector(".route-planner")
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    このコラボで予定を作る <span aria-hidden="true">→</span>
                  </button>
                  <button
                    type="button"
                    className="is-secondary"
                    onClick={() => {
                      setCollaborationFilter(collaboration.id);
                      setAreaFilter("すべて");
                      setSpotQuery("");
                      const firstSpot = spots.find((spot) => spot.id === routeableSpots[0]?.spotId);
                      if (firstSpot) setSelectedId(firstSpot.id);
                      document.querySelector("#spots")?.scrollIntoView({ behavior: "smooth" });
                    }}
                  >
                    対象スポットを見る <span aria-hidden="true">↓</span>
                  </button>
                  <a href={collaboration.sourceUrl} target="_blank" rel="noreferrer">
                    公式情報 <span aria-hidden="true">↗</span>
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="spots-section" id="spots">
        <div className="section-heading">
          <div>
            <p className="section-number">03 — SPOT LIST</p>
            <h2>物語をたどる、{spots.length}か所</h2>
          </div>
          <p>
            活動記録・せーはす！・関連映像等から整理した一覧です。
            名称や営業情報は、訪問前に各施設の最新案内も確認してください。
          </p>
        </div>

        <div className="spot-filters" aria-label="スポットの絞り込み">
          <label>
            <span>キーワード</span>
            <input
              type="search"
              value={spotQuery}
              onChange={(event) => setSpotQuery(event.target.value)}
              placeholder="施設名・住所・登場回で検索"
            />
          </label>
          <label>
            <span>エリア</span>
            <select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)}>
              <option>すべて</option>
              {areas.map((area) => <option key={area}>{area}</option>)}
            </select>
          </label>
          <label>
            <span>コラボ</span>
            <select
              value={collaborationFilter}
              onChange={(event) => setCollaborationFilter(event.target.value as CollaborationId | "すべて")}
            >
              <option value="すべて">すべて</option>
              {collaborations.map((collaboration) => (
                <option value={collaboration.id} key={collaboration.id}>{collaboration.name}</option>
              ))}
            </select>
          </label>
          <p><strong>{filteredSpots.length}</strong> / {spots.length} SPOTS</p>
        </div>

        <div className="spot-grid">
          {filteredSpots.map((spot) => {
            const index = spots.findIndex((item) => item.id === spot.id);
            const imageUrl = spotImages[spot.id] ?? spot.imageUrl;
            const spotCollaborations = collaborationsForSpot(spot);
            return (
            <article
              className={`spot-card${imageUrl ? " has-image" : ""}${
                selectedId === spot.id ? " is-selected" : ""
              }`}
              key={spot.id}
              style={
                imageUrl
                  ? ({
                      "--spot-image": `url("${imageUrl}")`,
                      "--spot-image-position":
                        spotImages[spot.id]
                          ? "center center"
                          : spot.imagePosition ?? "center center",
                    } as CSSProperties)
                  : undefined
              }
            >
              <button
                type="button"
                className="spot-card__main"
                onClick={() => {
                  setSelectedId(spot.id);
                  document
                    .querySelector("#map")
                    ?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                <div className="spot-card__topline">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <small>
                    {spot.area} · {spot.category}
                  </small>
                </div>
                {spotCollaborations.length ? (
                  <div className="spot-card__collaborations">
                    {spotCollaborations.map(({ collaboration, role, members }) => (
                      <span key={collaboration.id}>
                        <b>コラボ</b>
                        {collaboration.name}
                        {role ? <small>{role}</small> : null}
                        {members?.length ? (
                          <small className="spot-card__panel-members">
                            等身パネル：{members.join("、")}
                          </small>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                <h3>{spot.name}</h3>
                <p>{spot.description}</p>
                <div className={`spot-card__hours${spot.openingTime && spot.closingTime ? " is-known" : ""}`}>
                  <strong>{formatOpeningHours(spot)}</strong>
                  {spot.openingHoursNote ? <span>{spot.openingHoursNote}</span> : null}
                  {spot.openingHoursCheckedAt ? (
                    <small>{spot.openingHoursCheckedAt.replaceAll("-", ".")} 確認</small>
                  ) : null}
                </div>
                {spot.activityRecords?.length || spot.sehasEpisodes?.length ? (
                  <dl className="spot-card__episodes">
                    {spot.activityRecords?.length ? (
                      <div>
                        <dt>活動記録</dt>
                        <dd>{spot.activityRecords.join("・")}</dd>
                      </div>
                    ) : null}
                    {spot.sehasEpisodes?.length ? (
                      <div>
                        <dt>せーはす！</dt>
                        <dd>{spot.sehasEpisodes.join("・")}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
                {spot.appearances?.length ? (
                  <div className="spot-card__appearances">
                    {spot.appearances.map((appearance) => (
                      <span key={appearance}>{appearance}</span>
                    ))}
                  </div>
                ) : null}
                <div className="spot-card__meta">
                  <span>{spot.accessNote}</span>
                  <span aria-hidden="true">↗</span>
                </div>
              </button>
              <a href={spot.sourceUrl} target="_blank" rel="noreferrer">
                場所・公式情報
                <span aria-hidden="true">↗</span>
              </a>
            </article>
          )})}
        </div>
        {!filteredSpots.length && (
          <p className="spot-empty">条件に合うスポットがありません。検索語かエリアを変更してください。</p>
        )}
      </section>

      <section className="card-models-section" id="card-models">
        <div className="section-heading">
          <div>
            <p className="section-number">04 — CARD MODEL LOCATIONS</p>
            <h2>カードに描かれた、{cardModels.length}の景色</h2>
          </div>
          <p>
            現実の地点まで特定できたカードイラストを整理しています。
            B判定は公式明記を確認できていない候補地です。
          </p>
        </div>
        <div className="card-model-filter" aria-label="カードイラストのキャラクター絞り込み">
          <label>
            <span>キャラクター</span>
            <select
              value={cardCharacterFilter}
              onChange={(event) => setCardCharacterFilter(event.target.value as CardCharacter | "すべて")}
            >
              <option value="すべて">すべてのキャラクター</option>
              {cardCharacters.map((character) => (
                <option value={character} key={character}>{character}</option>
              ))}
            </select>
          </label>
          <p><strong>{filteredCardModels.length}</strong> / {cardModels.length} CARDS</p>
        </div>
        <div className="card-model-grid">
          {filteredCardModels.map((card) => {
            const index = cardModels.findIndex((item) => item.id === card.id);
            return (
            <article className="card-model" key={card.id}>
              <div className="card-model__topline">
                <span>C{String(index + 1).padStart(2, "0")}</span>
                <small className={`confidence confidence--${card.confidence.toLocaleLowerCase()}`}>
                  判定 {card.confidence}
                </small>
              </div>
              <h3>{card.card}</h3>
              <div className="card-model__characters" aria-label="登場キャラクター">
                {card.characters.map((character) => <span key={character}>{character}</span>)}
              </div>
              <strong>{card.model}</strong>
              <p>{card.address}</p>
              {card.note && <small className="card-model__note">{card.note}</small>}
              {card.spotId ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(card.spotId!);
                    document.querySelector("#map")?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  地図の登録スポットを見る <span aria-hidden="true">→</span>
                </button>
              ) : (
                <a href={card.sourceUrl} target="_blank" rel="noreferrer">
                  Google マップで場所を見る <span aria-hidden="true">↗</span>
                </a>
              )}
            </article>
          )})}
        </div>
      </section>

      <section className="guide-section" id="guide">
        <div className="guide-intro">
          <p className="section-number">05 — PILGRIMAGE NOTES</p>
          <h2>
            好きな場所を、
            <br />
            <em>大切な場所</em>のままに。
          </h2>
          <p>
            聖地巡礼は、地域の日常へお邪魔する旅でもあります。
            作品への気持ちと同じくらい、そこで暮らす方への配慮も大切にしましょう。
          </p>
        </div>
        <div className="guide-list">
          <article>
            <span>01</span>
            <div>
              <h3>通行を優先する</h3>
              <p>
                撮影のために道をふさいだり、私有地へ入ったりしないでください。
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <h3>撮影前に確認する</h3>
              <p>
                店内や施設では撮影ルールを確認し、人物の写り込みにも配慮しましょう。
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <h3>最新情報を確かめる</h3>
              <p>
                営業時間・交通・天候は変わります。出発前に公式情報を確認してください。
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className="site-disclaimer" id="site-notice" aria-labelledby="site-notice-title">
        <div className="site-disclaimer__heading">
          <p className="section-number">06 — SITE NOTICE</p>
          <h2 id="site-notice-title">ご利用上の注意</h2>
          <p>
            本サイトを使って巡礼計画を立てる際は、次の内容をご確認ください。
          </p>
        </div>
        <div className="site-disclaimer__content">
          <ul>
            <li>
              通行・営業・地域の日常を優先し、私有地への立入りや無断撮影をせず、各施設のルールを守ってください。
            </li>
            <li>
              営業時間、休業日、交通機関、道路状況、天候などは、出発前と移動中に公式情報をご確認ください。
            </li>
            <li>
              掲載する旅程、所要時間、ルートは参考情報です。予定どおりの移動や到着を保証するものではありません。
            </li>
            <li>
              本サイトの利用に伴う遅延、予定変更、費用その他の損害について、サイト運営者は責任を負いません。
              安全確認と最終的な判断は利用者ご自身でお願いいたします。
            </li>
          </ul>
          <button
            type="button"
            className="site-disclaimer__review"
            onClick={reviewVisitorNotice}
          >
            同意画面をもう一度確認する
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </section>

      <footer>
        <div className="brand brand--footer">
          <span className="brand-mark" aria-hidden="true">
            蓮
          </span>
          <span>
            <strong>蓮ノ旅</strong>
            <small>HASUNOSORA PILGRIMAGE GUIDE</small>
          </span>
        </div>
        <p>
          本サイトはファンによる非公式の試作サイトです。作品・施設・地域の公式運営とは関係ありません。
        </p>
        <span>© 2026 Yukachiii・写真の無断転載／二次利用禁止</span>
      </footer>
      </main>

      {isTodayModeOpen && schedule ? (
        <div className="today-mode" role="presentation">
          <section
            className="today-mode__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="today-mode-title"
          >
            <header className="today-mode__header">
              <div>
                <small>TODAY&apos;S JOURNEY</small>
                <h2 id="today-mode-title">当日用モード</h2>
                <p>
                  {visitDate === japanDate()
                    ? `${visitDate.replaceAll("-", ".")} · 現在 ${displayClock(currentJapanMinutes)}`
                    : `${visitDate.replaceAll("-", ".")} の予定を確認中`}
                </p>
              </div>
              <button type="button" onClick={() => setIsTodayModeOpen(false)} aria-label="当日用モードを閉じる">×</button>
            </header>

            <div className="today-mode__progress">
              <div>
                <strong>{completedScheduledSpotIds.length} / {schedule.entries.length}</strong>
                <span>訪問済み</span>
              </div>
              <progress value={completedScheduledSpotIds.length} max={schedule.entries.length} />
            </div>

            {nextTodayEntry ? (
              <article className="today-mode__next">
                <small>NEXT SPOT · {displayClock(nextTodayEntry.arrival + todayOffsetMinutes)} 到着予定</small>
                <h3>{nextTodayEntry.spot.name}</h3>
                <p>{nextTodayEntry.spot.address}</p>
                <div className={`opening-status opening-status--${openingHoursStatus(nextTodayEntry.spot, visitDate, nextTodayEntry.arrival + todayOffsetMinutes).kind}`}>
                  {openingHoursStatus(nextTodayEntry.spot, visitDate, nextTodayEntry.arrival + todayOffsetMinutes).label}
                </div>
                <div className="today-mode__next-actions">
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${nextTodayEntry.spot.lat},${nextTodayEntry.spot.lng}&travelmode=${navigationTravelMode(travelMode)}&dir_action=navigate`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    現在地からGoogle Mapsで向かう
                    <span aria-hidden="true">↗</span>
                  </a>
                  <button type="button" onClick={() => toggleCompletedSpot(nextTodayEntry.spot.id)}>訪問済みにする</button>
                </div>
              </article>
            ) : (
              <article className="today-mode__complete">
                <strong>本日の予定はすべて訪問済みです</strong>
                <p>お疲れさまでした。帰路も安全に気をつけてください。</p>
              </article>
            )}

            <div className="today-mode__tools">
              <button
                type="button"
                onClick={alignRemainingScheduleToNow}
                disabled={!nextTodayEntry || visitDate !== japanDate()}
              >
                残りを現在時刻に合わせる
              </button>
              <button type="button" onClick={() => setTodayOffsetMinutes(0)} disabled={!todayOffsetMinutes}>
                時刻補正を戻す
              </button>
              <button type="button" onClick={() => setCompletedSpotIds([])} disabled={!completedScheduledSpotIds.length}>
                訪問済みをリセット
              </button>
              <p>
                {visitDate === japanDate()
                  ? `時刻補正 ${todayOffsetMinutes >= 0 ? "+" : ""}${todayOffsetMinutes}分 · 補正は通信せず表示だけを調整します。`
                  : "現在時刻への補正は、訪問日当日に利用できます。"}
              </p>
            </div>

            <ol className="today-mode__list">
              {schedule.entries.map((entry) => {
                const isComplete = completedSpotIds.includes(entry.spot.id);
                const adjustedArrival = entry.arrival + todayOffsetMinutes;
                const adjustedDeparture = entry.departure + todayOffsetMinutes;
                const hoursStatus = openingHoursStatus(entry.spot, visitDate, adjustedArrival);
                return (
                  <li key={entry.spot.id} className={isComplete ? "is-complete" : ""}>
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
              })}
            </ol>

            <p className="today-mode__notice">
              営業時間・交通状況は変わる場合があります。現地と公式案内を優先してください。
              進捗と時刻補正はこの端末へ自動保存されます。
            </p>
          </section>
        </div>
      ) : null}
    </>
  );
}
