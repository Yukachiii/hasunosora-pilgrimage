"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
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
const CARD_MODEL_SPOT_IDS = Array.from(new Set(
  cardModels.flatMap((card) => card.spotId ? [card.spotId] : []),
));

type AppPage = "explore" | "planner" | "today" | "guide";
type ExplorePanel = "spots" | "card-models";
type SpotSourceFilter = "すべて" | "activity-records" | "sehas" | "with-meets";

const appPageLabels: Record<AppPage, string> = {
  explore: "探す",
  planner: "予定",
  today: "当日",
  guide: "ガイド",
};

function pageFromHash(hash: string): AppPage {
  const page = hash.replace(/^#\/?/, "").split("/")[0];
  return page === "planner" || page === "today" || page === "guide" ? page : "explore";
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

function japanDate(daysFromToday = 0) {
  const date = new Date(Date.now() + daysFromToday * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dateAfter(value: string, days: number) {
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
  spotPhotoGroups: Record<string, string[]>;
  heroImages: string[];
  initialHeroIndex?: number;
  siteVersion: string;
};

export function PilgrimageApp({
  mapboxConfig,
  routeServiceUrl = "",
  spots,
  spotPhotoGroups,
  heroImages,
  initialHeroIndex = 0,
  siteVersion,
}: Props) {
  const heroImage = heroImages[initialHeroIndex] ?? heroImages[0] ?? null;
  const [hasAcceptedVisitorNotice, setHasAcceptedVisitorNotice] = useState(false);
  const [visitorNoticeChecks, setVisitorNoticeChecks] = useState([false, false, false]);
  const [selectedId, setSelectedId] = useState(spots[0].id);
  const [plannerDays, setPlannerDays] = useState<PlannerDaySnapshot[]>(() => [
    createPlannerDay(0, japanDate()),
  ]);
  const [activeDayIndex, setActiveDayIndex] = useState(0);
  const [stayMinutes, setStayMinutes] = useState<Record<string, number>>(() =>
    Object.fromEntries(spots.map((spot) => [spot.id, recommendedStayMinutes(spot)])),
  );
  const [travelMode, setTravelMode] = useState<TravelMode>("WALKING");
  const [optimizeOrder, setOptimizeOrder] = useState(false);
  const [sourceStationId, setSourceStationId] = useState("");
  const [routeRequest, setRouteRequest] = useState<RouteRequest | null>(null);
  const [routeResult, setRouteResult] = useState<RouteResult>({ state: "idle" });
  const [dayRouteCache, setDayRouteCache] = useState<Record<string, {
    request: RouteRequest;
    result: RouteResult;
  }>>({});
  const [spotQuery, setSpotQuery] = useState("");
  const [isSpotFilterExpanded, setIsSpotFilterExpanded] = useState(false);
  const [mapSearchQuery, setMapSearchQuery] = useState("");
  const [selectedCardModelId, setSelectedCardModelId] = useState<string | null>(null);
  const [areaFilter, setAreaFilter] = useState("すべて");
  const [collaborationFilter, setCollaborationFilter] = useState<CollaborationId | "すべて">("すべて");
  const [spotSourceFilter, setSpotSourceFilter] = useState<SpotSourceFilter>("すべて");
  const [itineraryCollaborationId, setItineraryCollaborationId] = useState<CollaborationId | "">("");
  const [cardCharacterFilter, setCardCharacterFilter] = useState<CardCharacter | "すべて">("すべて");
  const [hasRestoredPlannerStorage, setHasRestoredPlannerStorage] = useState(false);
  const [completedSpotIds, setCompletedSpotIds] = useState<string[]>([]);
  const [todayOffsetMinutes, setTodayOffsetMinutes] = useState(0);
  const [currentJapanMinutes, setCurrentJapanMinutes] = useState(() => japanClockMinutes());
  const [transitLegProgress, setTransitLegProgress] = useState<TransitLegProgress>({});
  const [activePage, setActivePage] = useState<AppPage>("explore");
  const [isEditingItineraryOrder, setIsEditingItineraryOrder] = useState(false);
  const [mapReturnSection, setMapReturnSection] = useState<"explore-menu" | "spots" | "card-models">("explore-menu");
  const [activeExplorePanel, setActiveExplorePanel] = useState<ExplorePanel | null>(null);
  const [isExplorePickerOpen, setIsExplorePickerOpen] = useState(false);
  const [isExploreSheetClosing, setIsExploreSheetClosing] = useState(false);
  const [isExploreSheetExpanded, setIsExploreSheetExpanded] = useState(false);
  const [activeGuideImage, setActiveGuideImage] = useState<{
    src: string;
    alt: string;
    variant?: "guide" | "card" | "spot";
  } | null>(null);
  const [mapFocusRequest, setMapFocusRequest] = useState<{
    spotId: string;
    requestId: number;
  } | null>(null);
  const exploreSheetCloseButtonRef = useRef<HTMLButtonElement>(null);
  const exploreSheetSwipeStartYRef = useRef<number | null>(null);
  const exploreSheetPanelRef = useRef<HTMLDivElement>(null);
  const exploreSheetCollapsedHeightRef = useRef(0);
  const exploreSheetDragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    collapsedHeight: number;
    maxHeight: number;
    startedExpanded: boolean;
    dragged: boolean;
  } | null>(null);
  const exploreSheetCloseTimerRef = useRef<number | null>(null);
  const exploreSheetSettleTimerRef = useRef<number | null>(null);
  const guideImageCloseButtonRef = useRef<HTMLButtonElement>(null);
  const automaticRouteAttemptRef = useRef("");
  const activePlannerDay = plannerDays[activeDayIndex] ?? plannerDays[0];
  const itineraryIds = activePlannerDay.itineraryIds;
  const visitDate = activePlannerDay.visitDate;
  const startTime = activePlannerDay.startTime;
  const activeDayId = activePlannerDay.id;

  function updateActivePlannerDay(
    update: Partial<PlannerDaySnapshot> | ((day: PlannerDaySnapshot) => PlannerDaySnapshot),
  ) {
    setPlannerDays((current) => current.map((day, index) => {
      if (index !== activeDayIndex) return day;
      return typeof update === "function" ? update(day) : { ...day, ...update };
    }));
  }

  function setItineraryIds(value: SetStateAction<string[]>) {
    updateActivePlannerDay((day) => ({
      ...day,
      itineraryIds: typeof value === "function" ? value(day.itineraryIds) : value,
    }));
  }

  function setVisitDate(value: string) {
    updateActivePlannerDay({ visitDate: value });
  }

  function setStartTime(value: string) {
    updateActivePlannerDay({ startTime: value });
  }

  const cancelExploreSheetClose = useCallback(() => {
    if (exploreSheetCloseTimerRef.current !== null) {
      window.clearTimeout(exploreSheetCloseTimerRef.current);
      exploreSheetCloseTimerRef.current = null;
    }
    const panel = exploreSheetPanelRef.current;
    panel?.classList.remove("is-dragging");
    panel?.style.removeProperty("height");
    panel?.style.removeProperty("transform");
    panel?.style.removeProperty("--explore-sheet-close-offset");
    setIsExploreSheetClosing(false);
  }, []);

  const closeExplorePanel = useCallback(() => {
    if (exploreSheetCloseTimerRef.current !== null) return;
    const panel = exploreSheetPanelRef.current;
    if (panel) {
      const dragOffset = panel.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? "0";
      panel.style.setProperty("--explore-sheet-close-offset", `${Math.max(0, Number(dragOffset))}px`);
      panel.classList.remove("is-dragging");
    }
    setIsExploreSheetClosing(true);
    exploreSheetCloseTimerRef.current = window.setTimeout(() => {
      exploreSheetCloseTimerRef.current = null;
      setActiveExplorePanel(null);
      setIsExploreSheetClosing(false);
      setIsExploreSheetExpanded(false);
      exploreSheetCollapsedHeightRef.current = 0;
      exploreSheetDragRef.current = null;
      if (panel) {
        panel.style.removeProperty("height");
        panel.style.removeProperty("transform");
        panel.style.removeProperty("--explore-sheet-close-offset");
      }
      if (/^#\/explore\/(?:spots|card-models)$/.test(window.location.hash)) {
        window.history.replaceState(null, "", "#/explore");
      }
    }, 180);
  }, []);

  useEffect(() => () => {
    if (exploreSheetCloseTimerRef.current !== null) {
      window.clearTimeout(exploreSheetCloseTimerRef.current);
    }
    if (exploreSheetSettleTimerRef.current !== null) {
      window.clearTimeout(exploreSheetSettleTimerRef.current);
    }
  }, []);

  const settleExploreSheet = useCallback((expanded: boolean) => {
    const panel = exploreSheetPanelRef.current;
    const drag = exploreSheetDragRef.current;
    if (!panel || !drag) return;

    if (exploreSheetSettleTimerRef.current !== null) {
      window.clearTimeout(exploreSheetSettleTimerRef.current);
    }
    setIsExploreSheetExpanded(expanded);
    panel.classList.remove("is-dragging");
    panel.style.height = `${expanded ? drag.maxHeight : drag.collapsedHeight}px`;
    panel.style.transform = "translateY(0px)";
    exploreSheetDragRef.current = null;
    exploreSheetSwipeStartYRef.current = null;
    exploreSheetSettleTimerRef.current = window.setTimeout(() => {
      exploreSheetSettleTimerRef.current = null;
      panel.style.removeProperty("height");
      panel.style.removeProperty("transform");
    }, 220);
  }, []);

  function startExploreSheetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || isExploreSheetClosing) return;
    const panel = exploreSheetPanelRef.current;
    const overlay = panel?.parentElement;
    if (!panel || !overlay) return;

    if (exploreSheetSettleTimerRef.current !== null) {
      window.clearTimeout(exploreSheetSettleTimerRef.current);
      exploreSheetSettleTimerRef.current = null;
    }
    panel.style.removeProperty("height");
    panel.style.removeProperty("transform");

    const panelRect = panel.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const overlayStyle = window.getComputedStyle(overlay);
    const maximumHeight = panelRect.bottom - overlayRect.top - Number.parseFloat(overlayStyle.paddingTop || "0");
    if (!isExploreSheetExpanded || exploreSheetCollapsedHeightRef.current === 0) {
      exploreSheetCollapsedHeightRef.current = panelRect.height;
    }
    const collapsedHeight = Math.min(exploreSheetCollapsedHeightRef.current, maximumHeight);
    exploreSheetSwipeStartYRef.current = event.clientY;
    exploreSheetDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: panelRect.height,
      collapsedHeight,
      maxHeight: maximumHeight,
      startedExpanded: isExploreSheetExpanded,
      dragged: false,
    };
  }

  function moveExploreSheetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = exploreSheetPanelRef.current;
    const drag = exploreSheetDragRef.current;
    if (!panel || !drag || drag.pointerId !== event.pointerId) return;

    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) < 4) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    drag.dragged = true;
    panel.classList.add("is-dragging");

    let nextHeight = drag.startHeight;
    let translateY = 0;
    if (drag.startedExpanded) {
      if (deltaY > 0) {
        const collapsibleDistance = Math.max(0, drag.startHeight - drag.collapsedHeight);
        nextHeight = drag.startHeight - Math.min(deltaY, collapsibleDistance);
        translateY = Math.max(0, deltaY - collapsibleDistance);
      }
    } else if (deltaY < 0) {
      nextHeight = Math.min(drag.maxHeight, drag.startHeight - deltaY);
    } else {
      translateY = deltaY;
    }

    panel.style.height = `${nextHeight}px`;
    panel.style.transform = `translateY(${translateY}px)`;
  }

  function finishExploreSheetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = exploreSheetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const deltaY = event.clientY - drag.startY;
    if (!drag.dragged) {
      exploreSheetDragRef.current = null;
      exploreSheetSwipeStartYRef.current = null;
      return;
    }

    const collapsedDistance = Math.max(0, drag.startHeight - drag.collapsedHeight);
    if (deltaY >= collapsedDistance + 96) {
      closeExplorePanel();
      return;
    }
    if (drag.startedExpanded) {
      settleExploreSheet(deltaY < 40);
      return;
    }
    settleExploreSheet(deltaY <= -36);
  }

  function cancelExploreSheetDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = exploreSheetDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    settleExploreSheet(drag.startedExpanded);
  }

  useEffect(() => {
    const syncPage = () => {
      const nextPage = pageFromHash(window.location.hash);
      setActivePage(nextPage);
      setIsExplorePickerOpen(false);
      const sectionId = window.location.hash.replace(/^#\/?[^/]+\/?/, "");
      const nextExplorePanel =
        nextPage === "explore" && (sectionId === "spots" || sectionId === "card-models")
          ? sectionId
          : null;
      setActiveExplorePanel(nextExplorePanel);
      if (!nextExplorePanel) {
        setIsExploreSheetExpanded(false);
        exploreSheetCollapsedHeightRef.current = 0;
        exploreSheetDragRef.current = null;
        exploreSheetSwipeStartYRef.current = null;
      }
      window.setTimeout(() => {
        if (sectionId && sectionId !== "spots" && sectionId !== "card-models") {
          document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
        } else if (!sectionId) {
          window.scrollTo({ top: 0 });
        }
        if (nextPage === "explore") window.dispatchEvent(new Event("resize"));
      }, 0);
    };
    syncPage();
    window.addEventListener("hashchange", syncPage);
    return () => window.removeEventListener("hashchange", syncPage);
  }, []);

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
    if (!activeExplorePanel) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => exploreSheetCloseButtonRef.current?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeExplorePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeExplorePanel, closeExplorePanel]);

  useEffect(() => {
    if (!activeGuideImage) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => guideImageCloseButtonRef.current?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveGuideImage(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeGuideImage]);

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
          const firstDraftDate = draft.plannerDays[0]?.visitDate ?? japanDate();
          const restoredPastPlan = firstDraftDate < japanDate();
          const restoredPlannerDays = restoredPastPlan
            ? draft.plannerDays.map((day, index) => ({
                ...day,
                visitDate: dateAfter(japanDate(), index),
              }))
            : draft.plannerDays;
          setPlannerDays(restoredPlannerDays);
          setActiveDayIndex(draft.activeDayIndex);
          setStayMinutes((current) => ({ ...current, ...draft.stayMinutes }));
          setTravelMode(draft.travelMode);
          setOptimizeOrder(draft.optimizeOrder);
          setSourceStationId(draft.sourceStationId);
          setItineraryCollaborationId(draft.itineraryCollaborationId as CollaborationId | "");
          setCompletedSpotIds(restoredPastPlan ? [] : draft.completedSpotIds);
          setTodayOffsetMinutes(restoredPastPlan ? 0 : draft.todayOffsetMinutes);
          setTransitLegProgress(draft.transitLegProgress);
          if (draft.itineraryIds[0]) setSelectedId(draft.itineraryIds[0]);
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
      plannerDays,
      activeDayIndex,
    };
    try {
      const encoded = serializePlannerDraftCookie(snapshot);
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${PLANNER_DRAFT_COOKIE_KEY}=${encoded}; Max-Age=${PLANNER_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
    } catch {
      // 自動保存に失敗しても、画面上の編集中データは維持します。
    }
  }, [activeDayIndex, completedSpotIds, hasRestoredPlannerStorage, itineraryCollaborationId, itineraryIds, optimizeOrder, plannerDays, sourceStationId, startTime, stayMinutes, todayOffsetMinutes, transitLegProgress, travelMode, visitDate]);

  useEffect(() => {
    if (activePage !== "today") return undefined;
    const initialTimer = window.setTimeout(() => setCurrentJapanMinutes(japanClockMinutes()), 0);
    const timer = window.setInterval(() => setCurrentJapanMinutes(japanClockMinutes()), 60_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [activePage]);

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
      if (spotSourceFilter === "activity-records" && !spot.activityRecords?.length) return false;
      if (spotSourceFilter === "sehas" && !spot.sehasEpisodes?.length) return false;
      if (spotSourceFilter === "with-meets" && !spot.withMeetsEpisodes?.length) return false;
      if (!normalizedQuery) return true;
      return [
        spot.name,
        spot.shortName,
        spot.address,
        spot.category,
        ...(spot.activityRecords ?? []),
        ...(spot.sehasEpisodes ?? []),
        ...(spot.withMeetsEpisodes ?? []),
        ...(spot.appearances ?? []),
        ...collaborationsForSpot(spot).flatMap(({ collaboration, role, members }) => [
          collaboration.name,
          collaboration.subtitle,
          role ?? "",
          ...(members ?? []),
        ]),
      ].some((value) => value.toLocaleLowerCase("ja").includes(normalizedQuery));
    });
  }, [areaFilter, collaborationFilter, spotQuery, spotSourceFilter, spots]);
  const filteredCardModels = useMemo(
    () => cardModels.filter((card) =>
      cardCharacterFilter === "すべて" || card.characters.includes(cardCharacterFilter),
    ),
    [cardCharacterFilter],
  );

  const spotById = (id: string) => spots.find((spot) => spot.id === id);
  const selectedSpot = spotById(selectedId) ?? spots[0];
  const selectedCardModel = selectedCardModelId
    ? cardModels.find((card) => card.id === selectedCardModelId) ?? null
    : null;
  const selectedSpotCards = useMemo(() => {
    const relatedCards = cardModels.filter((card) => card.spotId === selectedSpot.id);
    if (!selectedCardModel || selectedCardModel.spotId !== selectedSpot.id) return relatedCards;
    return [selectedCardModel, ...relatedCards.filter((card) => card.id !== selectedCardModel.id)];
  }, [selectedCardModel, selectedSpot.id]);
  const selectedSpotPhotos = useMemo(
    () => Array.from(new Set([
      ...(spotPhotoGroups[selectedSpot.id] ?? []),
      ...(selectedSpot.imageUrl ? [selectedSpot.imageUrl] : []),
    ])),
    [selectedSpot.id, selectedSpot.imageUrl, spotPhotoGroups],
  );
  const mapSearchResults = useMemo(() => {
    const query = mapSearchQuery.trim().toLocaleLowerCase("ja");
    if (!query) return [];

    const matchingSpots = spots.flatMap((spot) => {
      const values = [
        spot.name,
        spot.shortName,
        spot.address,
        spot.area,
        spot.category,
        spot.description,
        ...(spot.activityRecords ?? []),
        ...(spot.sehasEpisodes ?? []),
        ...(spot.withMeetsEpisodes ?? []),
        ...(spot.appearances ?? []),
      ];
      return values.some((value) => value.toLocaleLowerCase("ja").includes(query))
        ? [{ kind: "spot" as const, id: spot.id, spot, card: null }]
        : [];
    });
    const matchingCards = cardModels.flatMap((card) => {
      if (!card.spotId) return [];
      const spot = spots.find((item) => item.id === card.spotId);
      if (!spot) return [];
      const values = [card.card, card.model, card.address, card.note, ...card.characters];
      return values.some((value) => value.toLocaleLowerCase("ja").includes(query))
        ? [{ kind: "card" as const, id: card.id, spot, card }]
        : [];
    });
    return [...matchingSpots, ...matchingCards].slice(0, 12);
  }, [mapSearchQuery, spots]);
  const itinerarySpots = useMemo(
    () => itineraryIds.map((id) => spots.find((spot) => spot.id === id)).filter((spot): spot is PilgrimageSpot => Boolean(spot)),
    [itineraryIds, spots],
  );
  const allPlannedSpotCount = useMemo(
    () => plannerDays.reduce((total, day) => total + day.itineraryIds.length, 0),
    [plannerDays],
  );
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
  const scheduleOverrunMinutes = schedule
    ? Math.max(0, schedule.finish - timeToMinutes(activePlannerDay.endTime))
    : 0;
  const dayTimeWindowInvalid = timeToMinutes(activePlannerDay.endTime) <= timeToMinutes(startTime);
  const fixedAppointments = [...activePlannerDay.appointments].sort(
    (left, right) => timeToMinutes(left.time) - timeToMinutes(right.time),
  );
  const appointmentConflictIds = new Set(schedule
    ? fixedAppointments
      .filter((appointment) => {
        const appointmentStart = timeToMinutes(appointment.time);
        const appointmentEnd = appointmentStart + appointment.durationMinutes;
        return appointmentStart < schedule.finish && appointmentEnd > schedule.start;
      })
      .map((appointment) => appointment.id)
    : []);
  const previousHotelName = activeDayIndex > 0 ? plannerDays[activeDayIndex - 1]?.hotelName ?? "" : "";
  const optionalPlannerSettingCount = activePlannerDay.appointments.length
    + (activePlannerDay.hotelName.trim() ? 1 : 0)
    + (activePlannerDay.endTime !== "18:00" ? 1 : 0);

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
    setDayRouteCache((current) => {
      if (!current[activeDayId]) return current;
      const next = { ...current };
      delete next[activeDayId];
      return next;
    });
    setTodayOffsetMinutes(0);
    setTransitLegProgress({});
  }

  function navigateToPage(page: AppPage, sectionId?: string) {
    cancelExploreSheetClose();
    setIsExplorePickerOpen(false);
    if (page === "explore" && (sectionId === "spots" || sectionId === "card-models")) {
      setActiveExplorePanel(sectionId);
      return;
    }
    setActiveExplorePanel(null);
    setIsExploreSheetExpanded(false);
    exploreSheetCollapsedHeightRef.current = 0;
    exploreSheetDragRef.current = null;
    exploreSheetSwipeStartYRef.current = null;
    const hash = `#/${page}${sectionId ? `/${sectionId}` : ""}`;
    setActivePage(page);
    if (window.location.hash === hash) {
      if (sectionId) document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      else window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    window.location.hash = hash;
  }

  function navigateToMapSpot(
    spotId: string,
    returnSection: "spots" | "card-models",
    cardModelId: string | null = null,
  ) {
    setSelectedId(spotId);
    setSelectedCardModelId(cardModelId);
    setMapReturnSection(returnSection);
    navigateToPage("explore", "map");

    if (window.matchMedia("(max-width: 1080px)").matches) {
      window.setTimeout(() => {
        const detailHeading = document.querySelector<HTMLElement>(".selected-map-detail__heading");
        if (!detailHeading) return;

        const mobileNav = document.querySelector<HTMLElement>(".mobile-nav");
        const navIsVisible = mobileNav && window.getComputedStyle(mobileNav).display !== "none";
        const visibleBottom = navIsVisible
          ? mobileNav.getBoundingClientRect().top - 16
          : window.innerHeight - 24;
        const detailRect = detailHeading.getBoundingClientRect();
        const scrollOffset = detailRect.bottom - visibleBottom;

        if (scrollOffset > 0) {
          window.scrollBy({ top: scrollOffset, behavior: "smooth" });
        }
      }, 360);
    }
  }

  const handleRouteResult = useCallback((result: RouteResult) => {
    setRouteResult(result);
    if (routeRequest && result.state === "success") {
      setDayRouteCache((current) => ({
        ...current,
        [activeDayId]: { request: routeRequest, result },
      }));
    }
  }, [activeDayId, routeRequest]);

  const searchRoute = useCallback(() => {
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
      const externalResult: RouteResult = {
        state: "external",
        message: "訪問順にYahoo!乗換案内の区間検索を用意しました。",
      };
      setRouteResult(externalResult);
      setDayRouteCache((current) => ({
        ...current,
        [activeDayId]: { request, result: externalResult },
      }));
    }
    setSelectedId(itinerarySpots.at(-1)!.id);
  }, [activeDayId, itinerarySpots, optimizeOrder, routeIsCurrent, sourceStationId, startTime, stayMinutes, travelMode, visitDate]);

  useEffect(() => {
    if (activePage !== "planner") {
      automaticRouteAttemptRef.current = "";
      return undefined;
    }
    if (
      !hasRestoredPlannerStorage ||
      activeExplorePanel !== null ||
      itinerarySpots.length < 2 ||
      dayTimeWindowInvalid ||
      routeIsCurrent ||
      routeResult.state === "loading"
    ) return undefined;

    const attemptKey = `${activeDayId}:${currentRouteSignature}`;
    if (automaticRouteAttemptRef.current === attemptKey) return undefined;
    const timer = window.setTimeout(() => {
      automaticRouteAttemptRef.current = attemptKey;
      searchRoute();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [activeDayId, activeExplorePanel, activePage, currentRouteSignature, dayTimeWindowInvalid, hasRestoredPlannerStorage, itinerarySpots.length, routeIsCurrent, routeResult.state, searchRoute]);

  function focusItinerarySpot(spotId: string) {
    setSelectedId(spotId);
    setMapFocusRequest({ spotId, requestId: Date.now() });
  }

  function handlePlannerPrimaryAction() {
    if (routeIsCurrent && routeResult.state === "success") {
      navigateToPage("today");
      return;
    }
    if (routeIsCurrent && routeResult.state === "external") {
      const panel = document.getElementById("transit-search-panel") as HTMLDetailsElement | null;
      if (panel) panel.open = true;
      panel?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    automaticRouteAttemptRef.current = "";
    searchRoute();
  }

  function addSpot(id: string) {
    if (!id || itineraryIds.includes(id) || itineraryIds.length >= maximumItineraryStops) return;
    setItineraryIds((current) => [...current, id]);
    invalidateRoute();
  }

  function toggleItinerarySpot(id: string) {
    const currentIndex = itineraryIds.indexOf(id);
    if (currentIndex >= 0) {
      removeSpot(currentIndex);
      return;
    }
    addSpot(id);
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
    invalidateRoute();
  }

  function removeSpot(index: number) {
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

  function selectPlannerDay(index: number) {
    if (index < 0 || index >= plannerDays.length || index === activeDayIndex) return;
    setActiveDayIndex(index);
    const cachedRoute = dayRouteCache[plannerDays[index].id];
    setRouteRequest(cachedRoute?.request ?? null);
    setRouteResult(cachedRoute?.result ?? { state: "idle" });
    const nextSpotId = plannerDays[index].itineraryIds[0];
    if (nextSpotId) setSelectedId(nextSpotId);
    setTodayOffsetMinutes(0);
    setTransitLegProgress({});
  }

  function addPlannerDay() {
    if (plannerDays.length >= 7) return;
    const previousDay = plannerDays.at(-1)!;
    const nextDay = createPlannerDay(plannerDays.length, dateAfter(previousDay.visitDate, 1));
    setPlannerDays((current) => [...current, nextDay]);
    setActiveDayIndex(plannerDays.length);
    setRouteRequest(null);
    setRouteResult({ state: "idle" });
    setTodayOffsetMinutes(0);
    setTransitLegProgress({});
  }

  function removeActivePlannerDay() {
    if (plannerDays.length <= 1) return;
    const removedDayId = plannerDays[activeDayIndex].id;
    const nextIndex = Math.max(0, activeDayIndex - 1);
    const remainingDays = plannerDays.filter((_, index) => index !== activeDayIndex);
    setPlannerDays(remainingDays);
    setDayRouteCache((current) => {
      const next = { ...current };
      delete next[removedDayId];
      return next;
    });
    setActiveDayIndex(nextIndex);
    const nextSpotId = remainingDays[nextIndex]?.itineraryIds[0];
    if (nextSpotId) setSelectedId(nextSpotId);
    setRouteRequest(null);
    setRouteResult({ state: "idle" });
    setTodayOffsetMinutes(0);
    setTransitLegProgress({});
  }

  function addAppointment() {
    const appointment: PlannerAppointment = {
      id: `appointment-${Date.now()}`,
      title: "予定を入力",
      time: "12:00",
      durationMinutes: 60,
    };
    updateActivePlannerDay((day) => ({
      ...day,
      appointments: [...day.appointments, appointment],
    }));
  }

  function updateAppointment(id: string, update: Partial<PlannerAppointment>) {
    updateActivePlannerDay((day) => ({
      ...day,
      appointments: day.appointments.map((appointment) => appointment.id === id
        ? { ...appointment, ...update }
        : appointment),
    }));
  }

  function removeAppointment(id: string) {
    updateActivePlannerDay((day) => ({
      ...day,
      appointments: day.appointments.filter((appointment) => appointment.id !== id),
    }));
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
            <h2 id="visitor-notice-title">利用前の確認</h2>
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

      <main className={`app-shell app-page--${activePage}${heroImage ? " has-managed-hero" : ""}`} data-page={activePage}>
      <header className="site-header">
        <a className="brand" href="#/explore" aria-label="蓮ノ旅 探すページ" onClick={(event) => { event.preventDefault(); navigateToPage("explore"); }}>
          <span className="brand-mark" aria-hidden="true">
            蓮
          </span>
          <span>
            <strong>蓮ノ旅</strong>
            <small>HASUNOSORA PILGRIMAGE GUIDE</small>
          </span>
        </a>
        <nav className="desktop-nav" aria-label="メインナビゲーション">
          {(Object.keys(appPageLabels) as AppPage[]).map((page) => (
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

      {isExplorePickerOpen ? (
        <nav
          className="mobile-explore-picker"
          id="mobile-explore-picker"
          aria-label="スポット・カード一覧"
        >
          <button
            type="button"
            aria-pressed={activeExplorePanel === "spots"}
            onClick={() => {
              navigateToPage("explore", "spots");
            }}
          >
            スポット
          </button>
          <button
            type="button"
            aria-pressed={activeExplorePanel === "card-models"}
            onClick={() => {
              navigateToPage("explore", "card-models");
            }}
          >
            カード
          </button>
        </nav>
      ) : null}

      <nav
        className={`mobile-nav${activeExplorePanel ? " mobile-nav--sheet-open" : ""}`}
        aria-label="スマートフォン用メニュー"
      >
        <a
          href="#/explore"
          aria-current={activePage === "explore" && !activeExplorePanel ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigateToPage("explore"); }}
        >
          <span>ホーム</span>
        </a>
        <button
          type="button"
          aria-pressed={isExplorePickerOpen || Boolean(activeExplorePanel)}
          aria-expanded={isExplorePickerOpen}
          aria-controls="mobile-explore-picker"
          onClick={() => {
            if (activeExplorePanel) {
              closeExplorePanel();
              setIsExplorePickerOpen(true);
              return;
            }
            setIsExplorePickerOpen((current) => !current);
          }}
        >
          <span>
            {activeExplorePanel === "spots"
              ? "スポット"
              : activeExplorePanel === "card-models"
                ? "カード"
                : "探す"}
          </span>
        </button>
        {(["planner", "today", "guide"] as AppPage[]).map((page) => (
          <a
            href={`#/${page}`}
            key={page}
            aria-current={activePage === page ? "page" : undefined}
            onClick={(event) => { event.preventDefault(); navigateToPage(page); }}
          >
            <span>{appPageLabels[page]}</span>
            {page === "planner" && allPlannedSpotCount ? <b>{allPlannedSpotCount}</b> : null}
          </a>
        ))}
      </nav>

      <section
        className={`hero hero--magazine${heroImage ? " has-managed-image" : ""}`}
        id="top"
        hidden={activePage !== "explore"}
        style={
          heroImage
            ? ({ "--hero-image": `url("${heroImage}")` } as CSSProperties)
            : undefined
        }
      >
        <div className="hero-magazine-grid" aria-hidden="true" />
        <div className="hero-magazine-number" aria-hidden="true">01</div>
        <div className="hero-copy hero-magazine-copy">
          <div className="eyebrow">ISHIKAWA / KANAZAWA</div>
          <p className="hero-kicker">蓮ノ空女学院<br />スクールアイドルクラブ</p>
          <div className="hero-magazine-rule" aria-label={`${spots.length}スポット、${areas.length}エリア`}>
            <span>{spots.length} SPOTS</span>
            <span>{areas.length} AREAS</span>
          </div>
          <p className="hero-lead">
            作品に関連するスポットを検索し、訪問予定を作成できます。
          </p>
          <div className="hero-actions hero-magazine-actions">
            <a href="#/explore/explore-menu" onClick={(event) => { event.preventDefault(); navigateToPage("explore", "explore-menu"); }}>
              <small>01</small>
              <strong>探し方を選ぶ</strong>
              <span aria-hidden="true">↓</span>
            </a>
            <a href="#/explore/spots" onClick={(event) => { event.preventDefault(); navigateToPage("explore", "spots"); }}>
              <small>02</small>
              <strong>スポット一覧</strong>
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
        <div className="hero-magazine-side" aria-hidden="true">
          HASUNOSORA PILGRIMAGE · VER. {siteVersion}
        </div>
      </section>

      <section className="explore-menu" id="explore-menu" hidden={activePage !== "explore"} aria-labelledby="explore-menu-title">
        <div>
          <h2 id="explore-menu-title">探し方を選ぶ</h2>
          <p>目的に合う入口を選んでください。</p>
        </div>
        <div className="explore-menu__grid">
          <button type="button" onClick={() => navigateToPage("explore", "spots")}>
            <strong>定番</strong>
            <span>登録スポットから選ぶ</span>
          </button>
          <button type="button" onClick={() => navigateToPage("explore", "collaborations")}>
            <strong>コラボ</strong>
            <span>対象スポットをまとめて選ぶ</span>
          </button>
          <button type="button" onClick={() => {
            setMapReturnSection("explore-menu");
            navigateToPage("explore", "map");
          }}>
            <strong>地図</strong>
            <span>場所を確認しながら選ぶ</span>
          </button>
          <button type="button" onClick={() => navigateToPage("explore", "card-models")}>
            <strong>カード</strong>
            <span>キャラクターからモデル地を探す</span>
          </button>
        </div>
      </section>

      <section className="map-section" id="map" hidden={activePage !== "explore" && activePage !== "planner"}>
        <div className="section-heading">
          <div>
            <h2>{activePage === "planner" ? "予定を作る" : "スポットを地図から探す"}</h2>
            {activePage === "explore" ? (
              <button
                type="button"
                className="map-return-link"
                onClick={() => navigateToPage("explore", mapReturnSection)}
              >
                <span aria-hidden="true">←</span>
                {mapReturnSection === "spots"
                  ? "スポット一覧へ戻る"
                  : mapReturnSection === "card-models"
                    ? "カードモデル地へ戻る"
                    : "探し方へ戻る"}
              </button>
            ) : null}
          </div>
          <p>
            {activePage === "planner"
              ? "訪問日・出発時刻・移動手段は、下の項目を押して変更できます。"
              : "ピンを選択すると、スポット情報の確認と予定への追加ができます。"}
          </p>
        </div>

        {activePage === "planner" && plannerDays.length > 1 ? (
          <section className="planner-days" aria-labelledby="planner-days-title">
            <div className="planner-days__heading">
              <div>
                <strong id="planner-days-title">旅行日程</strong>
                <span>{plannerDays.length}日間</span>
              </div>
              <button type="button" onClick={addPlannerDay} disabled={plannerDays.length >= 7}>
                日程を追加
              </button>
            </div>
            <div className="planner-days__tabs" role="tablist" aria-label="編集する日を選択">
              {plannerDays.map((day, index) => (
                <button
                  type="button"
                  role="tab"
                  key={day.id}
                  aria-selected={index === activeDayIndex}
                  className={index === activeDayIndex ? "is-current" : undefined}
                  onClick={() => selectPlannerDay(index)}
                >
                  <strong>{index + 1}日目</strong>
                  <span>{day.visitDate.replaceAll("-", "/")}</span>
                  <small>{day.itineraryIds.length}か所</small>
                </button>
              ))}
            </div>
            <div className="planner-days__active-note">
              {previousHotelName ? <span>前日の宿泊地：{previousHotelName}</span> : <span />}
              <button type="button" onClick={removeActivePlannerDay} disabled={plannerDays.length <= 1}>
                この日を削除
              </button>
            </div>
          </section>
        ) : null}

        {activePage === "planner" ? (
          <div className="planner-overview" aria-label="現在の予定概要">
            <span className="planner-overview__static">
              <small>訪問先</small>
              <strong>{itineraryIds.length}か所</strong>
            </span>
            <label className="planner-overview__control">
              <small>訪問日</small>
              <input
                type="date"
                min={japanDate()}
                max={japanDate(99)}
                value={visitDate}
                aria-label="訪問日"
                onChange={(event) => {
                  setVisitDate(event.target.value);
                  if (travelMode === "TRANSIT" || sourceStationId) invalidateRoute();
                }}
              />
            </label>
            <label className="planner-overview__control">
              <small>出発時刻</small>
              <input
                type="time"
                value={startTime}
                aria-label="出発時刻"
                onChange={(event) => {
                  setStartTime(event.target.value);
                  if (travelMode === "TRANSIT" || sourceStationId) invalidateRoute();
                }}
              />
            </label>
            <label className="planner-overview__control">
              <small>移動手段</small>
              <select
                value={travelMode}
                aria-label="移動手段"
                onChange={(event) => {
                  setTravelMode(event.target.value as TravelMode);
                  invalidateRoute();
                }}
              >
                {travelModes.filter((mode) => !mode.disabled).map((mode) => (
                  <option key={mode.value} value={mode.value}>{mode.label}</option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <div className="map-layout">
          <div
            className={`map-column${activePage === "planner" ? " map-column--route" : ""}`}
            hidden={activePage !== "explore" && activePage !== "planner"}
          >
            {activePage === "explore" ? (
            <div className="map-search">
              <label htmlFor="map-freeword-search">地図から検索</label>
              <div className="map-search__field">
                <span aria-hidden="true">⌕</span>
                <input
                  id="map-freeword-search"
                  type="search"
                  value={mapSearchQuery}
                  onChange={(event) => setMapSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setMapSearchQuery("");
                  }}
                  placeholder="施設名・住所・カード・キャラクターで検索"
                  autoComplete="off"
                />
              </div>
              {mapSearchQuery.trim() ? (
                <div className="map-search__results" role="listbox" aria-label="地図の検索結果">
                  {mapSearchResults.length ? mapSearchResults.map((result) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={result.kind === "card" && selectedCardModelId === result.id}
                      key={`${result.kind}-${result.id}`}
                      onClick={() => {
                        setSelectedId(result.spot.id);
                        setSelectedCardModelId(result.card?.id ?? null);
                        setMapSearchQuery("");
                      }}
                    >
                      <span>{result.kind === "card" ? "カード" : "スポット"}</span>
                      <strong>{result.kind === "card" ? result.card.card : result.spot.name}</strong>
                      <small>{result.kind === "card" ? result.card.model : result.spot.address}</small>
                    </button>
                  )) : (
                    <p>登録済みのスポット・カードに一致する場所がありません。</p>
                  )}
                </div>
              ) : null}
            </div>
            ) : (
              <div className="planner-route-map__heading">
                <div>
                  <small>ROUTE MAP</small>
                  <strong>予定の経路</strong>
                </div>
                <span>{itinerarySpots.length}か所</span>
              </div>
            )}
            <MapboxPilgrimageMap
              spots={activePage === "planner" ? itinerarySpots : spots}
              selectedId={selectedId}
              focusSpotRequest={mapFocusRequest}
              plannedSpotIds={itineraryIds}
              cardModelSpotIds={CARD_MODEL_SPOT_IDS}
              onSelect={(id) => {
                setSelectedId(id);
                setSelectedCardModelId(null);
              }}
              routeRequest={routeRequest}
              onRouteResult={handleRouteResult}
              accessToken={mapboxConfig.accessToken}
              routeServiceUrl={routeServiceUrl}
              isVisible={activePage === "explore" || activePage === "planner"}
              viewMode={activePage === "planner" ? "planner" : "explore"}
            />
          </div>
          <div className="selected-map-detail" hidden={activePage !== "explore"}>
              <div className="selected-map-detail__heading">
                <div>
                  <small>
                    {selectedSpot.area} · {selectedSpot.category}
                  </small>
                  <strong>{selectedSpot.name}</strong>
                  <span>{selectedSpot.address}</span>
                </div>
                <button
                  type="button"
                  disabled={!itineraryIds.includes(selectedSpot.id) && itineraryIds.length >= maximumItineraryStops}
                  onClick={() => {
                    const selectedIndex = itineraryIds.indexOf(selectedSpot.id);
                    if (selectedIndex >= 0) removeSpot(selectedIndex);
                    else addSpot(selectedSpot.id);
                  }}
                >
                  {itineraryIds.includes(selectedSpot.id) ? "予定から外す" : "予定に追加する"}
                  <span aria-hidden="true">→</span>
                </button>
              </div>
              {selectedSpot.description ? (
                <p className="selected-map-detail__description">{selectedSpot.description}</p>
              ) : null}
              {selectedSpotPhotos.length ? (
                <div className="selected-map-detail__photos">
                  <div className="selected-map-detail__cards-heading">
                    <strong>この場所の写真</strong>
                    <span>{selectedSpotPhotos.length}枚</span>
                  </div>
                  <div className="selected-map-detail__photo-grid">
                    {selectedSpotPhotos.map((imageUrl, index) => (
                      <button
                        type="button"
                        key={imageUrl}
                        aria-label={`${selectedSpot.name}の写真${index + 1}を拡大表示`}
                        onClick={() => setActiveGuideImage({
                          src: imageUrl,
                          alt: `${selectedSpot.name}の写真 ${index + 1}`,
                          variant: "spot",
                        })}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={imageUrl} alt="" loading="lazy" decoding="async" />
                        <span>{String(index + 1).padStart(2, "0")}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {selectedSpotCards.length ? (
                <div className="selected-map-detail__cards">
                  <div className="selected-map-detail__cards-heading">
                    <strong>この場所に関連するカード</strong>
                    <span>{selectedSpotCards.length}件</span>
                  </div>
                  <div className="selected-map-detail__card-grid">
                    {selectedSpotCards.map((card) => (
                      <article
                        key={card.id}
                        className={`${card.imageUrl ? "has-image" : ""}${selectedCardModel?.id === card.id ? " is-selected" : ""}`.trim() || undefined}
                      >
                        {card.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={card.imageUrl} alt="" loading="lazy" decoding="async" />
                        ) : null}
                        <div>
                          <small>カードモデル地</small>
                          <strong>{card.card}</strong>
                          <span>{card.model}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
          </div>

          <aside className="route-planner" aria-label="訪問するスポット" hidden={activePage !== "planner"}>
            <div className="itinerary-editor">
              <div className="itinerary-editor__heading">
                <div>
                  <strong>訪問するスポット</strong>
                  <span>{itineraryIds.length} / {maximumItineraryStops}</span>
                </div>
                {itineraryIds.length > 1 ? (
                  <button
                    type="button"
                    className={isEditingItineraryOrder ? "is-active" : undefined}
                    aria-pressed={isEditingItineraryOrder}
                    onClick={() => setIsEditingItineraryOrder((current) => !current)}
                  >
                    {isEditingItineraryOrder ? "順序変更を完了" : "順序を変更"}
                  </button>
                ) : null}
              </div>
              <ol>
                {!itinerarySpots.length ? (
                  <li className="itinerary-editor__empty">下の「探す」からスポットを追加してください。</li>
                ) : null}
                {itinerarySpots.map((spot, index) => (
                  <li key={spot.id}>
                    <button
                      type="button"
                      className="itinerary-spot-focus"
                      onClick={() => focusItinerarySpot(spot.id)}
                      aria-label={`${spot.name}を地図で拡大表示`}
                    >
                      <span className={`route-point ${index === 0 ? "route-point--start" : index === itinerarySpots.length - 1 ? "route-point--goal" : ""}`}>
                        {index === 0 ? "S" : index === itinerarySpots.length - 1 ? "G" : index + 1}
                      </span>
                      <span>
                        <strong>{spot.shortName}</strong>
                        <small>地図で見る</small>
                      </span>
                    </button>
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
                    {isEditingItineraryOrder ? (
                      <div className="itinerary-actions">
                        <button type="button" disabled={index === 0} onClick={() => moveSpot(index, -1)} aria-label={`${spot.name}を一つ前へ`}>↑</button>
                        <button type="button" disabled={index === itinerarySpots.length - 1} onClick={() => moveSpot(index, 1)} aria-label={`${spot.name}を一つ後ろへ`}>↓</button>
                        <button type="button" onClick={() => removeSpot(index)} aria-label={`${spot.name}を予定から外す`}>×</button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        </div>

        <section className="route-workspace" id="planner" aria-label="予定の詳細と一日の予定" hidden={activePage !== "planner"}>
          <div className="route-workspace__controls">
            <details className="planner-conditions">
              <summary>
                <span>
                  <small>OPTIONAL</small>
                  <strong>詳細設定</strong>
                </span>
                <em>出発駅・宿泊・予約・訪問順</em>
              </summary>
              <div className="journey-start">
              {travelMode === "TRANSIT" ? (
                <div className="transit-origin">
                  <label>
                    <span>出発駅（任意）</span>
                    <select
                      value={sourceStationId}
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
                    全国の主要駅から最初のスポットまでの検索も追加できます。
                  </p>
                </div>
              ) : null}
              {plannerDays.length === 1 ? (
                <div className="multi-day-prompt">
                  <span>宿泊を伴う旅行ですか？</span>
                  <button type="button" onClick={addPlannerDay}>複数日にする</button>
                </div>
              ) : null}

              <details className="planner-extras">
                <summary>
                  <span>
                    <strong>宿泊・予約を追加</strong>
                    <small>任意</small>
                  </span>
                  <em>{optionalPlannerSettingCount ? `${optionalPlannerSettingCount}件設定中` : "必要な場合のみ"}</em>
                </summary>
                <div className="planner-extras__body">
                  <div className="day-boundaries">
                    <label>
                      <span>その日の終了目安</span>
                      <input
                        type="time"
                        value={activePlannerDay.endTime}
                        onChange={(event) => updateActivePlannerDay({ endTime: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>宿泊地（任意）</span>
                      <input
                        type="text"
                        maxLength={120}
                        value={activePlannerDay.hotelName}
                        placeholder="ホテル名・宿泊施設名"
                        onChange={(event) => updateActivePlannerDay({ hotelName: event.target.value })}
                      />
                    </label>
                    <p>宿泊地は、翌日の開始地点メモにも表示されます。移動時間には含まれません。</p>
                  </div>

                  <section className="planner-appointments" aria-labelledby="planner-appointments-title">
                    <div className="planner-appointments__heading">
                      <div>
                        <strong id="planner-appointments-title">時間を固定する予定</strong>
                        <span>予約・待ち合わせ・食事など</span>
                      </div>
                      <button type="button" onClick={addAppointment} disabled={activePlannerDay.appointments.length >= 12}>
                        予定を追加
                      </button>
                    </div>
                    {activePlannerDay.appointments.length ? (
                      <ol>
                        {activePlannerDay.appointments.map((appointment) => (
                          <li key={appointment.id}>
                            <label className="planner-appointment__title">
                              <span>予定名</span>
                              <input
                                type="text"
                                maxLength={80}
                                value={appointment.title}
                                onChange={(event) => updateAppointment(appointment.id, { title: event.target.value })}
                              />
                            </label>
                            <label>
                              <span>開始</span>
                              <input
                                type="time"
                                value={appointment.time}
                                onChange={(event) => updateAppointment(appointment.id, { time: event.target.value })}
                              />
                            </label>
                            <label>
                              <span>所要</span>
                              <span className="planner-appointment__duration">
                                <input
                                  type="number"
                                  min="0"
                                  max="720"
                                  step="5"
                                  value={appointment.durationMinutes}
                                  onChange={(event) => updateAppointment(appointment.id, {
                                    durationMinutes: Math.max(0, Math.min(720, Number(event.target.value) || 0)),
                                  })}
                                />
                                分
                              </span>
                            </label>
                            <button
                              type="button"
                              className="planner-appointment__remove"
                              onClick={() => removeAppointment(appointment.id)}
                              aria-label={`${appointment.title || "予定"}を削除`}
                            >
                              ×
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>時間が決まっている予定があれば追加してください。</p>
                    )}
                  </section>
                </div>
              </details>

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
              </div>
            </details>

            <div className="route-workspace__options">
            {previousHotelName || activePlannerDay.hotelName ? (
              <p className="planner-review__note">
                {previousHotelName ? `前泊：${previousHotelName}` : ""}
                {previousHotelName && activePlannerDay.hotelName ? " ／ " : ""}
                {activePlannerDay.hotelName ? `宿泊：${activePlannerDay.hotelName}` : ""}
              </p>
            ) : null}

            {fixedAppointments.length ? (
              <section className="planner-fixed-review" aria-label="時間を固定した予定">
                <strong>時間を固定した予定</strong>
                <ol>
                  {fixedAppointments.map((appointment) => (
                    <li key={appointment.id} className={appointmentConflictIds.has(appointment.id) ? "has-conflict" : undefined}>
                      <time>{appointment.time}</time>
                      <span>{appointment.title || "名称未入力"}</span>
                      <small>{appointment.durationMinutes}分</small>
                      {appointmentConflictIds.has(appointment.id) ? <em>計算した訪問予定と時間が重なります</em> : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {dayTimeWindowInvalid ? (
              <p className="planner-window-warning">
                終了目安は出発時刻より後に設定してください。
              </p>
            ) : null}

            <div className={`planner-create-bar${routeIsCurrent ? " is-complete" : ""}`}>
              <button
                className="route-search-button"
                type="button"
                onClick={handlePlannerPrimaryAction}
                disabled={itineraryIds.length < 2 || dayTimeWindowInvalid || routeResult.state === "loading" || (!routeIsCurrent && routeResult.state === "idle")}
              >
                {itineraryIds.length < 2
                  ? "訪問先を2か所以上選んでください"
                  : dayTimeWindowInvalid
                    ? "日時を修正してください"
                    : routeResult.state === "loading"
                      ? "作成しています…"
                      : routeIsCurrent
                        ? travelMode === "TRANSIT" ? "乗換検索を確認する" : "当日の予定を見る"
                        : routeResult.state === "error" || routeResult.state === "fallback"
                          ? "もう一度計算する"
                          : "自動で予定を作成します"}
                <span aria-hidden="true">→</span>
              </button>
              <p className="route-api-note">
                {routeIsCurrent
                  ? travelMode === "TRANSIT"
                    ? "区間検索を作成しました。内容を確認してください。"
                    : "予定を作成しました。当日タブからいつでも確認できます。"
                  : travelMode === "TRANSIT"
                    ? "予定タブを開くと、指定順の区間検索を自動で作ります。"
                    : "予定タブを開くと、移動時間と訪問順を自動で計算します。"}
              </p>
            </div>
            </div>
          </div>

            <div
              className={`route-result route-result--${routeResult.state}`}
              aria-live="polite"
            >
              {routeResult.state === "idle" && (
                <>
                  <span className="result-symbol">＋</span>
                  <p>
                    {itineraryIds.length < 2
                      ? "訪問先を2か所以上選び、滞在時間と訪問順を決めてください。"
                      : "選んだ訪問先から予定を自動で作成します。"}
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
              <details className="transit-search-panel" id="transit-search-panel">
                <summary className="transit-search-panel__heading">
                  <div>
                    <small>PUBLIC TRANSIT</small>
                    <strong>Yahoo!乗換案内の区間検索</strong>
                  </div>
                  <span>{confirmedTransitLegCount} / {transitLegs.length} 確認済み</span>
                </summary>
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
              </details>
            ) : null}

            {schedule && routeResult.state === "success" && (
              <section className="day-schedule" id="created-plan" aria-label="作成した一日予定">
                <div className="day-schedule__heading">
                  <div>
                    <small>YOUR DAY</small>
                    <strong>{visitDate.replaceAll("-", ".")}</strong>
                  </div>
                  <span>{displayClock(schedule.finish)} 終了予定</span>
                </div>
                {scheduleOverrunMinutes ? (
                  <p className="day-schedule__warning">
                    終了目安の{activePlannerDay.endTime}を約{formatDuration(scheduleOverrunMinutes)}超えます。
                    滞在時間、訪問先、出発時刻を調整してください。
                  </p>
                ) : null}
                {routeRequest?.accessOrigin && (
                  <div className="access-schedule">
                    <time>{displayClock(schedule.start)}</time>
                    <p><strong>{routeRequest.accessOrigin.name}</strong>を出発</p>
                    <small>公共交通 約{formatDuration(schedule.accessDuration)}</small>
                  </div>
                )}
                {fixedAppointments.length ? (
                  <div className="day-schedule__fixed">
                    <strong>時間を固定した予定</strong>
                    <ol>
                      {fixedAppointments.map((appointment) => (
                        <li key={appointment.id} className={appointmentConflictIds.has(appointment.id) ? "has-conflict" : undefined}>
                          <time>{appointment.time}</time>
                          <div>
                            <strong>{appointment.title || "名称未入力"}</strong>
                            <small>{appointment.durationMinutes}分</small>
                            {appointmentConflictIds.has(appointment.id) ? <span>訪問予定と重なるため調整が必要です</span> : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
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
                {activePlannerDay.hotelName ? (
                  <div className="day-schedule__hotel">
                    <time>{displayClock(schedule.finish)}</time>
                    <div>
                      <strong>宿泊地：{activePlannerDay.hotelName}</strong>
                      <small>宿泊地までの移動時間は計算に含まれていません</small>
                    </div>
                  </div>
                ) : null}
                <p>
                  滞在込み <strong>{formatDuration(schedule.finish - schedule.start)}</strong>
                  {routeResult.orderedStopIds?.join("|") !== routeRequest?.stops.map((spot) => spot.id).join("|") ? " · 最適化した順で表示" : ""}
                </p>
                <button
                  type="button"
                  className="today-mode-open"
                  onClick={() => navigateToPage("today")}
                >
                  当日ページを開く
                  <span aria-hidden="true">→</span>
                </button>
              </section>
            )}
        </section>
      </section>

      <section className="collaborations-section" id="collaborations" hidden={activePage !== "explore"}>
        <div className="section-heading">
          <div>
            <h2>コラボ</h2>
          </div>
          <p>
            コラボ企画の開催情報と対象スポットを掲載しています。
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
                      navigateToPage("planner");
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
                      navigateToPage("explore", "spots");
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

        <div
          className={`explore-sheet${isExploreSheetClosing ? " is-closing" : ""}`}
          hidden={!activeExplorePanel}
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeExplorePanel();
          }}
        >
          <div
            ref={exploreSheetPanelRef}
            className={`explore-sheet__panel${isExploreSheetExpanded ? " is-expanded" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="explore-sheet-title"
          >
            <div
              className="explore-sheet__swipe-zone"
              onPointerDown={startExploreSheetDrag}
              onPointerMove={moveExploreSheetDrag}
              onPointerUp={finishExploreSheetDrag}
              onPointerCancel={cancelExploreSheetDrag}
            >
              <div className="explore-sheet__grab-zone">
                <div className="explore-sheet__handle" aria-hidden="true" />
                <header className="explore-sheet__header">
                  <strong id="explore-sheet-title">探す</strong>
                  <button
                    type="button"
                    ref={exploreSheetCloseButtonRef}
                    aria-label="閉じる"
                    title="閉じる"
                    onClick={closeExplorePanel}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </header>
              </div>
              <nav className="explore-sheet__tabs" role="tablist" aria-label="一覧を切り替える">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeExplorePanel === "spots"}
                  onClick={() => navigateToPage("explore", "spots")}
                >
                  スポット <small>{spots.length}</small>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeExplorePanel === "card-models"}
                  onClick={() => navigateToPage("explore", "card-models")}
                >
                  カード <small>{cardModels.length}</small>
                </button>
              </nav>
            </div>
            <div className="explore-sheet__body">
      <section className="spots-section" id="spots" hidden={activeExplorePanel !== "spots"}>
        <div className="section-heading">
          <div>
            <h2>スポット一覧（{spots.length}件）</h2>
          </div>
          <p>
            活動記録・せーはす！・関連映像等から整理した一覧です。
            名称や営業情報は、訪問前に各施設の最新案内も確認してください。
          </p>
        </div>

        <div className="spot-filters" aria-label="スポットの絞り込み">
          <label className="spot-filters__query">
            <span>キーワード</span>
            <input
              type="search"
              value={spotQuery}
              onChange={(event) => setSpotQuery(event.target.value)}
              placeholder="施設名・住所・登場回で検索"
            />
          </label>
          <button
            type="button"
            className={`spot-filters__toggle${areaFilter !== "すべて" || collaborationFilter !== "すべて" || spotSourceFilter !== "すべて" ? " is-active" : ""}`}
            aria-expanded={isSpotFilterExpanded}
            aria-controls="spot-advanced-filters"
            onClick={() => setIsSpotFilterExpanded((current) => !current)}
          >
            <span>{isSpotFilterExpanded ? "閉じる" : "絞り込み"}</span>
            <small>{filteredSpots.length}件</small>
          </button>
          <div
            className={`spot-filters__advanced${isSpotFilterExpanded ? " is-expanded" : ""}`}
            id="spot-advanced-filters"
          >
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
            <label>
              <span>出典</span>
              <select
                value={spotSourceFilter}
                onChange={(event) => setSpotSourceFilter(event.target.value as SpotSourceFilter)}
              >
                <option value="すべて">すべて</option>
                <option value="sehas">せーはす！</option>
                <option value="activity-records">活動記録</option>
                <option value="with-meets">With×MEETS</option>
              </select>
            </label>
          </div>
          <p><strong>{filteredSpots.length}</strong> / {spots.length} SPOTS</p>
        </div>

        <div
          className="spot-grid"
          role="region"
          aria-label="スポット一覧"
        >
          {filteredSpots.map((spot) => {
            const index = spots.findIndex((item) => item.id === spot.id);
            const imageUrl = spotPhotoGroups[spot.id]?.[0] ?? spot.imageUrl;
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
                        spotPhotoGroups[spot.id]?.[0]
                          ? "center center"
                          : spot.imagePosition ?? "center center",
                    } as CSSProperties)
                  : undefined
              }
            >
              <button
                type="button"
                className="spot-card__main"
                onClick={() => navigateToMapSpot(spot.id, "spots")}
              >
                <div className="spot-card__topline">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <small>
                    {spot.area} · {spot.category}
                  </small>
                </div>
                <h3>{spot.name}</h3>
                <p>{spot.description}</p>
                <div className={`spot-card__hours${spot.openingTime && spot.closingTime ? " is-known" : ""}`}>
                  <strong>{formatOpeningHours(spot)}</strong>
                  {spot.openingHoursNote ? <span>{spot.openingHoursNote}</span> : null}
                  {spot.openingHoursCheckedAt ? (
                    <small>{spot.openingHoursCheckedAt.replaceAll("-", ".")} 確認</small>
                  ) : null}
                </div>
                {spot.activityRecords?.length || spot.sehasEpisodes?.length || spot.withMeetsEpisodes?.length ? (
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
                    {spot.withMeetsEpisodes?.length ? (
                      <div>
                        <dt>With×MEETS</dt>
                        <dd>{spot.withMeetsEpisodes.join("・")}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
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
                {spot.appearances?.length ? (
                  <div className="spot-card__appearances">
                    {spot.appearances.map((appearance) => (
                      <span key={appearance}>{appearance}</span>
                    ))}
                  </div>
                ) : null}
                <div className="spot-card__meta">
                  <span>{spot.accessNote}</span>
                  <strong>
                    地図で表示 <span aria-hidden="true">→</span>
                  </strong>
                </div>
              </button>
              <button
                type="button"
                className={`spot-card__select${itineraryIds.includes(spot.id) ? " is-selected" : ""}`}
                onClick={() => toggleItinerarySpot(spot.id)}
                aria-pressed={itineraryIds.includes(spot.id)}
              >
                {itineraryIds.includes(spot.id) ? "予定から外す" : "予定に追加"}
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

      <section className="card-models-section" id="card-models" hidden={activeExplorePanel !== "card-models"}>
        <div className="section-heading">
          <div>
            <h2>カードモデル地（{cardModels.length}件）</h2>
          </div>
          <p>
            現実の地点まで特定できたカードイラストを整理しています。
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
        <div
          className="card-model-grid"
          role="region"
          aria-label="カードモデル地一覧"
        >
          {filteredCardModels.map((card) => {
            const index = cardModels.findIndex((item) => item.id === card.id);
            return (
            <article className={`card-model${card.imageUrl ? " has-image" : ""}`} key={card.id}>
              {card.imageUrl ? (
                <figure className="card-model__image">
                  <button
                    type="button"
                    className="card-model__image-button"
                    aria-label={`${card.card}のカードイラストを拡大表示`}
                    onClick={() => setActiveGuideImage({
                      src: card.imageUrl!,
                      alt: `${card.card}のカードイラスト`,
                      variant: "card",
                    })}
                  >
                    {/* Static GitHub Pages assets avoid an external image-optimization request. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={card.imageUrl}
                      alt={`${card.card}のカードイラスト`}
                      loading="lazy"
                      decoding="async"
                    />
                  </button>
                  <figcaption>
                    画像：<a
                      href="https://www.lovelive-anime.jp/hasunosora/"
                      target="_blank"
                      rel="noreferrer"
                      aria-label="©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ"
                      title="©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ"
                    >
                      ©PL!HS
                    </a>
                  </figcaption>
                </figure>
              ) : null}
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
              {card.spotId ? (
                <div className="card-model__actions">
                  <button
                    type="button"
                    onClick={() => navigateToMapSpot(card.spotId!, "card-models", card.id)}
                  >
                    地図で見る <span aria-hidden="true">→</span>
                  </button>
                  <button
                    type="button"
                    className={itineraryIds.includes(card.spotId) ? "is-selected" : ""}
                    onClick={() => toggleItinerarySpot(card.spotId!)}
                    aria-pressed={itineraryIds.includes(card.spotId)}
                  >
                    {itineraryIds.includes(card.spotId) ? "予定から外す" : "予定に追加"}
                  </button>
                </div>
              ) : (
                <a href={card.sourceUrl} target="_blank" rel="noreferrer">
                  Google マップで場所を見る <span aria-hidden="true">↗</span>
                </a>
              )}
            </article>
          )})}
        </div>
      </section>
            </div>
          </div>
        </div>

      <section className="guide-section" id="guide" hidden={activePage !== "guide"}>
        <div className="guide-intro">
          <span>USER GUIDE</span>
          <h2>このサイトの使い方</h2>
          <p>
            下のメニューを「探す」「予定」「当日」の順に使います。画像を押すと大きく表示できます。
          </p>
        </div>

        <div className="guide-walkthrough" aria-label="基本的な使い方">
          <article className="guide-step">
            <div className="guide-step__copy">
              <span className="guide-step__number">01</span>
              <h3>探し方を選ぶ</h3>
              <p>「探す」では、目的に合う方法でスポットやカードを探せます。</p>
            </div>
            <div className="guide-step__screens">
              <button
                type="button"
                className="guide-step__screen"
                onClick={() => setActiveGuideImage({ src: "./guide/02-choose-method.png", alt: "探し方を選ぶ画面" })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="./guide/02-choose-method.png" alt="探し方を選ぶ画面" loading="lazy" decoding="async" />
                <span>大きく見る</span>
              </button>
            </div>
          </article>

          <article className="guide-step">
            <div className="guide-step__copy">
              <span className="guide-step__number">02</span>
              <h3>行きたい場所を追加する</h3>
              <p>スポットまたはカードを開き、「予定に追加」を押します。追加した件数は下の「予定」に表示されます。</p>
            </div>
            <div className="guide-step__screens guide-step__screens--double">
              <button
                type="button"
                className="guide-step__screen guide-step__screen--spots"
                onClick={() => setActiveGuideImage({ src: "./guide/03-add-spots.png", alt: "スポット一覧から場所を選ぶ画面" })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="./guide/03-add-spots.png" alt="スポット一覧から場所を選ぶ画面" loading="lazy" decoding="async" />
                <span>スポット</span>
              </button>
              <button
                type="button"
                className="guide-step__screen"
                onClick={() => setActiveGuideImage({ src: "./guide/07-card-search.png", alt: "カードからモデル地を選ぶ画面" })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="./guide/07-card-search.png" alt="カードからモデル地を選ぶ画面" loading="lazy" decoding="async" />
                <span>カード</span>
              </button>
            </div>
          </article>

          <article className="guide-step">
            <div className="guide-step__copy">
              <span className="guide-step__number">03</span>
              <h3>場所と日時を整える</h3>
              <p>「予定」で訪問順と滞在時間を調整し、移動手段、訪問日、出発時刻を設定します。</p>
            </div>
            <div className="guide-step__screens guide-step__screens--double">
              <button
                type="button"
                className="guide-step__screen"
                onClick={() => setActiveGuideImage({ src: "./guide/04-plan-stops.png", alt: "訪問するスポットと滞在時間を編集する画面" })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="./guide/04-plan-stops.png" alt="訪問するスポットと滞在時間を編集する画面" loading="lazy" decoding="async" />
                <span>場所</span>
              </button>
              <button
                type="button"
                className="guide-step__screen"
                onClick={() => setActiveGuideImage({ src: "./guide/05-plan-time.png", alt: "移動手段と訪問日時を設定する画面" })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="./guide/05-plan-time.png" alt="移動手段と訪問日時を設定する画面" loading="lazy" decoding="async" />
                <span>日時</span>
              </button>
            </div>
          </article>

          <article className="guide-step">
            <div className="guide-step__copy">
              <span className="guide-step__number">04</span>
              <h3>計算して当日に使う</h3>
              <p>内容を確認して予定を計算します。計算後は「当日」で次の訪問先、時刻、進捗を確認できます。</p>
            </div>
            <div className="guide-step__screens">
              <button
                type="button"
                className="guide-step__screen"
                onClick={() => setActiveGuideImage({ src: "./guide/06-plan-check.png", alt: "予定内容を確認して計算する画面" })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="./guide/06-plan-check.png" alt="予定内容を確認して計算する画面" loading="lazy" decoding="async" />
                <span>大きく見る</span>
              </button>
            </div>
          </article>
        </div>

        <p className="guide-source-note">
          画面内のカード画像：<a href="https://www.lovelive-anime.jp/hasunosora/" target="_blank" rel="noreferrer">©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ</a>
        </p>
      </section>

      <section className="site-disclaimer" id="site-notice" aria-labelledby="site-notice-title" hidden={activePage !== "guide"}>
        <div className="site-disclaimer__heading">
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
          <div className="site-data-note" aria-labelledby="site-data-note-title">
            <h3 id="site-data-note-title">端末内の保存と外部サービス</h3>
            <p>
              利用前確認と作成した予定は、この端末のブラウザ（Cookie・localStorage）に保存されます。
              運営者のサーバーには保存されず、ブラウザのデータを削除すると消去されます。
            </p>
            <p>
              地図の表示・ルート作成では、表示範囲や選択した地点などがMapboxへ送信されます。
              サーバー経由のルート検索を利用できる環境では、出発地・目的地・移動条件がGoogle Routesへ送信されます。
            </p>
            <p>本サイトはアクセス解析および広告トラッキングを導入していません。</p>
          </div>
        </div>
      </section>

      <footer hidden={activePage === "today"}>
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
          本サイトはファンによる非公式ファンサイトです。作品・施設・地域の公式運営とは関係ありません。
        </p>
        <span>Ver. {siteVersion} · © 2026 Yukachiii・写真の無断転載／二次利用禁止</span>
      </footer>
      </main>

      {activeGuideImage ? (
        <div
          className={`guide-image-modal${
            activeGuideImage.variant === "card" ? " guide-image-modal--card" : ""
          }`}
          role="presentation"
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            event.stopPropagation();
            setActiveGuideImage(null);
          }}
        >
          <section
            className="guide-image-modal__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-image-modal-title"
          >
            <header>
              <strong id="guide-image-modal-title">{activeGuideImage.alt}</strong>
              <button
                type="button"
                ref={guideImageCloseButtonRef}
                onClick={() => setActiveGuideImage(null)}
                aria-label="画像を閉じる"
              >
                閉じる <span aria-hidden="true">×</span>
              </button>
            </header>
            <figure>
              <div className="guide-image-modal__image-frame">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={activeGuideImage.src} alt={activeGuideImage.alt} />
                {activeGuideImage.variant === "card" ? (
                  <span className="guide-image-modal__copyright">
                    <a
                      href="https://www.lovelive-anime.jp/hasunosora/"
                      target="_blank"
                      rel="noreferrer"
                      aria-label="©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ"
                    >
                      ©PL!HS
                    </a>
                  </span>
                ) : null}
              </div>
            </figure>
          </section>
        </div>
      ) : null}

      {activePage === "today" ? (
        <div className="today-mode today-mode--page">
          {plannerDays.length > 1 ? (
            <nav className="today-day-switch" aria-label="確認する日を選択">
              {plannerDays.map((day, index) => (
                <button
                  type="button"
                  key={day.id}
                  className={index === activeDayIndex ? "is-current" : undefined}
                  aria-current={index === activeDayIndex ? "date" : undefined}
                  onClick={() => selectPlannerDay(index)}
                >
                  <strong>{index + 1}日目</strong>
                  <span>{day.visitDate.replaceAll("-", "/")}</span>
                </button>
              ))}
            </nav>
          ) : null}
          {schedule ? (
          <section
            className="today-mode__dialog"
            aria-labelledby="today-mode-title"
          >
            <header className="today-mode__header">
              <div>
                <h2 id="today-mode-title">{activeDayIndex + 1}日目の予定</h2>
                <p>
                  {visitDate === japanDate()
                    ? `${visitDate.replaceAll("-", ".")} · 現在 ${displayClock(currentJapanMinutes)}`
                  : `${visitDate.replaceAll("-", ".")} の予定を確認中`}
                </p>
              </div>
            </header>

            <div className="today-mode__progress">
              <div>
                <strong>{completedScheduledSpotIds.length} / {schedule.entries.length}</strong>
                <span>訪問済み</span>
              </div>
              <progress value={completedScheduledSpotIds.length} max={schedule.entries.length} />
            </div>

            {fixedAppointments.length ? (
              <section className="today-mode__fixed" aria-label="時間を固定した予定">
                <strong>時間を固定した予定</strong>
                <ol>
                  {fixedAppointments.map((appointment) => (
                    <li key={appointment.id}>
                      <time>{appointment.time}</time>
                      <span>{appointment.title || "名称未入力"}</span>
                      <small>{appointment.durationMinutes}分</small>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

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
                <p>訪問済みの記録は下のボタンからリセットできます。</p>
              </article>
            )}

            <details className="today-mode__tools">
              <summary>
                <span>当日の調整</span>
                <small>{todayOffsetMinutes ? `時刻補正 ${todayOffsetMinutes >= 0 ? "+" : ""}${todayOffsetMinutes}分` : "必要な場合のみ"}</small>
              </summary>
              <div>
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
                    ? `時刻補正 ${todayOffsetMinutes >= 0 ? "+" : ""}${todayOffsetMinutes}分。表示時刻だけを調整します。`
                    : "現在時刻への補正は、訪問日当日に利用できます。"}
                </p>
              </div>
            </details>

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
            {activePlannerDay.hotelName ? (
              <p className="today-mode__hotel">
                宿泊地：<strong>{activePlannerDay.hotelName}</strong>
                <span>宿泊地までの移動時間は予定に含まれていません。</span>
              </p>
            ) : null}
          </section>
          ) : (
            <section className="today-page__empty" aria-labelledby="today-page-empty-title">
              <h2 id="today-page-empty-title">当日の予定</h2>
              <p>確認できる予定がまだありません。先に訪問スポットと日時を設定し、移動時間を計算してください。</p>
              <button
                type="button"
                onClick={() => {
                  navigateToPage("planner");
                }}
              >
                予定を作る <span aria-hidden="true">→</span>
              </button>
            </section>
          )}
        </div>
      ) : null}
    </>
  );
}
