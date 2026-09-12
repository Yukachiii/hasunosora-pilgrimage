import mapboxgl from "mapbox-gl";
import type * as GeoJSON from "geojson";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
} from "react";
import type { PilgrimageSpot } from "./spots";
import type { RouteLocation, TravelMode } from "./route-planner";

export type RouteRequest = {
  requestId: number;
  stops: PilgrimageSpot[];
  travelMode: TravelMode;
  optimizeWaypointOrder: boolean;
  stayMinutes: Record<string, number>;
  accessOrigin?: RouteLocation;
  departureTime: string;
};

export type RouteResult = {
  state: "idle" | "loading" | "success" | "external" | "fallback" | "error";
  distance?: string;
  duration?: string;
  travelDurationMinutes?: number;
  accessDurationMinutes?: number;
  legDurationMinutes?: number[];
  orderedStopIds?: string[];
  message?: string;
};

type Props = {
  spots: PilgrimageSpot[];
  selectedId: string;
  focusSpotRequest?: { spotId: string; requestId: number } | null;
  plannedSpotIds: string[];
  cardModelSpotIds: string[];
  onSelect: (id: string) => void;
  routeRequest: RouteRequest | null;
  onRouteResult: (result: RouteResult) => void;
  accessToken: string;
  isVisible?: boolean;
  viewMode?: "explore" | "planner";
};

type MapboxRoute = {
  distance: number;
  duration: number;
  geometry: GeoJSON.LineString;
  legs: Array<{ duration: number }>;
};

type MapState = "fallback" | "loading" | "ready" | "error";
type RouteLine = Array<[number, number]>;
type MapboxRoutePayload = {
  code?: string;
  message?: string;
  trips?: MapboxRoute[];
  routes?: MapboxRoute[];
  waypoints?: Array<{ waypoint_index?: number }>;
};

const TOKEN_STORAGE_KEY = "hasunosora-mapbox-public-token";
const ROUTE_SOURCE_ID = "pilgrimage-route";
const ROUTE_SHADOW_LAYER_ID = "pilgrimage-route-shadow";
const ROUTE_LAYER_ID = "pilgrimage-route-line";
const SPOT_SOURCE_ID = "pilgrimage-spots";
const SPOT_LAYER_ID = "pilgrimage-spot-points";
const SELECTED_SPOT_LAYER_ID = "pilgrimage-selected-spot";
const NUMBERED_MARKER_IMAGE_PREFIX = "pilgrimage-numbered-marker";
const MARKER_IMAGE_WIDTH = 64;
const MARKER_IMAGE_HEIGHT = 102;
const MARKER_IMAGE_PIXEL_RATIO = 3;

function markerIconSize(): mapboxgl.Expression {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    6, 0.45,
    10, 0.7,
    14, 1,
  ] as mapboxgl.Expression;
}

function buildGoogleMapsUrl(request: RouteRequest): string {
  const params = new URLSearchParams({
    api: "1",
    origin: request.stops[0].address,
    destination: request.stops.at(-1)!.address,
    travelmode: request.travelMode.toLowerCase(),
  });
  const intermediates = request.stops.slice(1, -1);
  if (intermediates.length) {
    params.set("waypoints", intermediates.map((stop) => stop.address).join("|"));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

function formatTravelTime(minutes: number): string {
  const roundedMinutes = Math.max(1, Math.round(minutes));
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = roundedMinutes % 60;
  if (!hours) return `${remainder}分`;
  return remainder ? `${hours}時間${remainder}分` : `${hours}時間`;
}

function mapboxProfile(mode: TravelMode): string {
  if (mode === "DRIVING") return "mapbox/driving-traffic";
  if (mode === "BICYCLING") return "mapbox/cycling";
  return "mapbox/walking";
}

type MarkerKind = "standard" | "collaboration" | "card" | "planned";

const markerAssetByKind: Record<MarkerKind, string> = {
  standard: `${import.meta.env.BASE_URL}map-markers/red.png`,
  collaboration: `${import.meta.env.BASE_URL}map-markers/yellow.png`,
  card: `${import.meta.env.BASE_URL}map-markers/blue.png`,
  planned: `${import.meta.env.BASE_URL}map-markers/green.png`,
};

const markerAssetCache = new Map<MarkerKind, Promise<HTMLImageElement>>();

function numberedMarkerImageId(kind: MarkerKind, label: string): string {
  return `${NUMBERED_MARKER_IMAGE_PREFIX}-${kind}-${label}`;
}

function loadMarkerAsset(kind: MarkerKind): Promise<HTMLImageElement> {
  const cached = markerAssetCache.get(kind);
  if (cached) return cached;
  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`地図ピン画像を読み込めませんでした: ${markerAssetByKind[kind]}`));
    image.src = markerAssetByKind[kind];
  });
  markerAssetCache.set(kind, request);
  return request;
}

function createNumberedMarkerImage(image: HTMLImageElement, label: string): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = MARKER_IMAGE_WIDTH;
  canvas.height = MARKER_IMAGE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("地図ピンを描画できませんでした。");

  context.drawImage(image, 0, 0, MARKER_IMAGE_WIDTH, MARKER_IMAGE_HEIGHT);
  context.beginPath();
  context.ellipse(32, 33, 24, 15, 0, 0, Math.PI * 2);
  context.fillStyle = "#fffdf7";
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "#6a370f";
  context.stroke();

  context.fillStyle = "#4b270e";
  context.font = `800 ${label.length >= 3 ? 21 : 26}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, 32, 34, 43);
  return context.getImageData(0, 0, MARKER_IMAGE_WIDTH, MARKER_IMAGE_HEIGHT);
}

async function ensureNumberedMarkerImages(
  map: mapboxgl.Map,
  features: GeoJSON.Feature<GeoJSON.Point>[],
  isCancelled: () => boolean,
): Promise<boolean> {
  const kinds = [...new Set(features.map((feature) => feature.properties?.markerKind as MarkerKind))];
  const assets = new Map(await Promise.all(kinds.map(async (kind) => [kind, await loadMarkerAsset(kind)] as const)));
  if (isCancelled()) return false;
  for (const feature of features) {
    if (isCancelled()) return false;
    const kind = feature.properties?.markerKind as MarkerKind;
    const label = String(feature.properties?.indexLabel ?? "");
    const imageId = numberedMarkerImageId(kind, label);
    if (!map.hasImage(imageId)) {
      map.addImage(imageId, createNumberedMarkerImage(assets.get(kind)!, label), {
        pixelRatio: MARKER_IMAGE_PIXEL_RATIO,
      });
    }
  }
  return true;
}

function markerKindForSpot(
  spot: PilgrimageSpot,
  plannedSpotIds: ReadonlySet<string>,
  cardModelSpotIds: ReadonlySet<string>,
): MarkerKind {
  if (plannedSpotIds.has(spot.id)) return "planned";
  if (cardModelSpotIds.has(spot.id)) return "card";
  if (spot.collaborationIds?.length) return "collaboration";
  return "standard";
}

function spotFeatureCollection(
  spots: PilgrimageSpot[],
  plannedSpotIds: ReadonlySet<string>,
  cardModelSpotIds: ReadonlySet<string>,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: spots.map((spot, index) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [spot.lng, spot.lat] },
      properties: {
        spotId: spot.id,
        indexLabel: String(index + 1).padStart(2, "0"),
        markerKind: markerKindForSpot(spot, plannedSpotIds, cardModelSpotIds),
        markerImageId: numberedMarkerImageId(
          markerKindForSpot(spot, plannedSpotIds, cardModelSpotIds),
          String(index + 1).padStart(2, "0"),
        ),
      },
    })),
  };
}

type MapRuntimeState = {
  token: string;
  mapState: MapState;
  setMapState: Dispatch<SetStateAction<MapState>>;
};

type RouteDrawing = {
  clearRoute: () => void;
  drawRoute: (lines: RouteLine[]) => void;
};

function useMapRuntime(accessToken: string): MapRuntimeState {
  const [token, setToken] = useState(accessToken.trim());
  const [mapState, setMapState] = useState<MapState>(accessToken.trim() ? "loading" : "fallback");

  useEffect(() => {
    if (accessToken.trim()) return;
    let cancelled = false;
    queueMicrotask(() => {
      try {
        const savedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? "";
        if (!savedToken.startsWith("pk.") || cancelled) return;
        setToken(savedToken);
        setMapState("loading");
      } catch {
        // The static fallback remains usable when browser storage is unavailable.
      }
    });
    return () => { cancelled = true; };
  }, [accessToken]);

  return { token, mapState, setMapState };
}

function useMapboxInstance(
  token: string,
  mapElementRef: RefObject<HTMLDivElement | null>,
  mapRef: RefObject<mapboxgl.Map | null>,
  setMapState: Dispatch<SetStateAction<MapState>>,
): void {
  useEffect(() => {
    if (!token || !mapElementRef.current) return;
    let cancelled = false;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: mapElementRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [136.6562, 36.5708],
      zoom: 12.4,
      attributionControl: true,
      cooperativeGestures: true,
    });
    map.on("style.load", () => {
      if (!cancelled) map.setLanguage("ja");
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), "top-right");
    map.on("load", () => { if (!cancelled) setMapState("ready"); });
    map.on("error", (event) => {
      const message = event.error?.message ?? "";
      if (!cancelled && /401|403|token|unauthorized|forbidden/i.test(message)) setMapState("error");
    });
    mapRef.current = map;
    return () => {
      cancelled = true;
      if (mapRef.current === map) mapRef.current = null;
      map.remove();
    };
  }, [mapElementRef, mapRef, setMapState, token]);
}

function removeRouteLayers(map: mapboxgl.Map): void {
  if (!map.isStyleLoaded()) return;
  if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
  if (map.getLayer(ROUTE_SHADOW_LAYER_ID)) map.removeLayer(ROUTE_SHADOW_LAYER_ID);
  if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);
}

function addRouteLayers(map: mapboxgl.Map, lines: RouteLine[]): void {
  const feature: GeoJSON.Feature<GeoJSON.MultiLineString> = {
    type: "Feature",
    properties: {},
    geometry: { type: "MultiLineString", coordinates: lines },
  };
  map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: feature });
  map.addLayer({
    id: ROUTE_SHADOW_LAYER_ID,
    type: "line",
    source: ROUTE_SOURCE_ID,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.88 },
  });
  map.addLayer({
    id: ROUTE_LAYER_ID,
    type: "line",
    source: ROUTE_SOURCE_ID,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#6eb7c6", "line-width": 5, "line-opacity": 0.96 },
  });
}

function fitMapToRoute(map: mapboxgl.Map, lines: RouteLine[]): void {
  const bounds = new mapboxgl.LngLatBounds();
  lines.flat().forEach(([lng, lat]) => bounds.extend([lng, lat]));
  map.fitBounds(bounds, { padding: 64, maxZoom: 15, duration: 650 });
}

function useRouteDrawing(
  mapRef: RefObject<mapboxgl.Map | null>,
  routeLinesRef: RefObject<RouteLine[]>,
  mapState: MapState,
): RouteDrawing {
  const clearRoute = useCallback(() => {
    routeLinesRef.current = [];
    const map = mapRef.current;
    if (map) removeRouteLayers(map);
  }, [mapRef, routeLinesRef]);
  const drawRoute = useCallback((lines: RouteLine[]) => {
    const usableLines = lines.filter((line) => line.length > 1);
    clearRoute();
    routeLinesRef.current = usableLines;
    const map = mapRef.current;
    if (!map?.isStyleLoaded() || !usableLines.length) return;
    addRouteLayers(map, usableLines);
    fitMapToRoute(map, usableLines);
  }, [clearRoute, mapRef, routeLinesRef]);
  useEffect(() => {
    if (mapState === "ready" && routeLinesRef.current.length) drawRoute(routeLinesRef.current);
  }, [drawRoute, mapState, routeLinesRef]);
  return { clearRoute, drawRoute };
}

function fitPlannerMap(
  map: mapboxgl.Map,
  lines: RouteLine[],
  spots: PilgrimageSpot[],
  duration: number,
): void {
  const bounds = new mapboxgl.LngLatBounds();
  if (lines.length) lines.flat().forEach(([lng, lat]) => bounds.extend([lng, lat]));
  else spots.forEach((spot) => bounds.extend([spot.lng, spot.lat]));
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 64, maxZoom: 15, duration });
}

function usePlannerMapViewport(
  mapRef: RefObject<mapboxgl.Map | null>,
  routeLinesRef: RefObject<RouteLine[]>,
  spots: PilgrimageSpot[],
  mapState: MapState,
  isVisible: boolean,
  viewMode: NonNullable<Props["viewMode"]>,
): void {
  const fitPlannerView = useCallback((duration: number) => {
    const map = mapRef.current;
    if (map && mapState === "ready") fitPlannerMap(map, routeLinesRef.current, spots, duration);
  }, [mapRef, mapState, routeLinesRef, spots]);
  useEffect(() => {
    if (!isVisible || mapState !== "ready") return;
    const frame = window.requestAnimationFrame(() => {
      mapRef.current?.resize();
      if (viewMode === "planner") fitPlannerView(0);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitPlannerView, isVisible, mapRef, mapState, viewMode]);
  useEffect(() => {
    if (viewMode !== "planner" || mapState !== "ready") return;
    const frame = window.requestAnimationFrame(() => {
      mapRef.current?.resize();
      fitPlannerView(500);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitPlannerView, mapRef, mapState, viewMode]);
}

function upsertSpotSource(
  map: mapboxgl.Map,
  data: GeoJSON.FeatureCollection<GeoJSON.Point>,
): void {
  const source = map.getSource(SPOT_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(SPOT_SOURCE_ID, { type: "geojson", data });
}

function upsertDefaultSpotLayer(map: mapboxgl.Map, selectedId: string): void {
  if (map.getLayer(SPOT_LAYER_ID)) {
    map.setLayoutProperty(SPOT_LAYER_ID, "icon-size", markerIconSize());
    return;
  }
  map.addLayer({
    id: SPOT_LAYER_ID,
    type: "symbol",
    source: SPOT_SOURCE_ID,
    filter: ["!=", ["get", "spotId"], selectedId],
    layout: {
      "icon-image": ["get", "markerImageId"],
      "icon-size": markerIconSize(),
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
}

function upsertSelectedSpotLayer(map: mapboxgl.Map, selectedId: string): void {
  if (map.getLayer(SELECTED_SPOT_LAYER_ID)) {
    map.setLayoutProperty(SELECTED_SPOT_LAYER_ID, "icon-size", 1.3);
    return;
  }
  map.addLayer({
    id: SELECTED_SPOT_LAYER_ID,
    type: "symbol",
    source: SPOT_SOURCE_ID,
    filter: ["==", ["get", "spotId"], selectedId],
    layout: {
      "icon-image": ["get", "markerImageId"],
      "icon-size": 1.3,
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
}

function useSpotLayers(
  mapRef: RefObject<mapboxgl.Map | null>,
  onSelectRef: RefObject<Props["onSelect"]>,
  spots: PilgrimageSpot[],
  plannedSpotIds: ReadonlySet<string>,
  cardModelSpotIds: ReadonlySet<string>,
  selectedId: string,
  mapState: MapState,
  setMapState: Dispatch<SetStateAction<MapState>>,
): void {
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready") return;
    let cancelled = false;
    let listenersAttached = false;
    const data = spotFeatureCollection(spots, plannedSpotIds, cardModelSpotIds);
    const handleSpotClick = (event: mapboxgl.MapLayerMouseEvent) => {
      const spotId = event.features?.[0]?.properties?.spotId;
      if (typeof spotId === "string") onSelectRef.current(spotId);
    };
    const showPointer = () => { map.getCanvas().style.cursor = "pointer"; };
    const clearPointer = () => { map.getCanvas().style.cursor = ""; };
    void ensureNumberedMarkerImages(map, data.features, () => cancelled || mapRef.current !== map)
      .then((imagesReady) => {
        if (!imagesReady || cancelled || mapRef.current !== map) return;
        upsertSpotSource(map, data);
        upsertDefaultSpotLayer(map, selectedId);
        upsertSelectedSpotLayer(map, selectedId);
        map.on("click", SPOT_LAYER_ID, handleSpotClick);
        map.on("mouseenter", SPOT_LAYER_ID, showPointer);
        map.on("mouseleave", SPOT_LAYER_ID, clearPointer);
        listenersAttached = true;
      })
      .catch(() => { if (!cancelled && mapRef.current === map) setMapState("error"); });
    return () => {
      cancelled = true;
      if (!listenersAttached) return;
      map.off("click", SPOT_LAYER_ID, handleSpotClick);
      map.off("mouseenter", SPOT_LAYER_ID, showPointer);
      map.off("mouseleave", SPOT_LAYER_ID, clearPointer);
    };
  }, [cardModelSpotIds, mapRef, mapState, onSelectRef, plannedSpotIds, selectedId, setMapState, spots]);
}

function useSpotSelection(
  mapRef: RefObject<mapboxgl.Map | null>,
  spots: PilgrimageSpot[],
  selectedId: string,
  focusSpotRequest: Props["focusSpotRequest"],
  mapState: MapState,
): void {
  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready" || !map.getLayer(SELECTED_SPOT_LAYER_ID)) return;
    map.setFilter(SPOT_LAYER_ID, ["!=", ["get", "spotId"], selectedId]);
    map.setFilter(SELECTED_SPOT_LAYER_ID, ["==", ["get", "spotId"], selectedId]);
  }, [mapRef, mapState, selectedId]);
  useEffect(() => {
    const map = mapRef.current;
    const selected = spots.find((spot) => spot.id === selectedId);
    if (map && mapState === "ready" && selected) map.easeTo({ center: [selected.lng, selected.lat], duration: 450 });
  }, [mapRef, mapState, selectedId, spots]);
  useEffect(() => {
    const map = mapRef.current;
    const focused = focusSpotRequest
      ? spots.find((spot) => spot.id === focusSpotRequest.spotId)
      : undefined;
    if (!map || mapState !== "ready" || !focused) return;
    map.easeTo({ center: [focused.lng, focused.lat], zoom: Math.max(map.getZoom(), 15.5), duration: 550 });
  }, [focusSpotRequest, mapRef, mapState, spots]);
}

function prepareMapboxRouteRequest(request: RouteRequest, token: string): {
  url: string;
  shouldOptimize: boolean;
} {
  const coordinates = request.stops.map((spot) => `${spot.lng},${spot.lat}`).join(";");
  const shouldOptimize = request.optimizeWaypointOrder && request.stops.length <= 12;
  const params = new URLSearchParams({
    access_token: token,
    geometries: "geojson",
    overview: "full",
    steps: "false",
  });
  if (shouldOptimize) {
    params.set("roundtrip", "false");
    params.set("source", "first");
    params.set("destination", "last");
  }
  const endpoint = shouldOptimize
    ? `https://api.mapbox.com/optimized-trips/v1/${mapboxProfile(request.travelMode)}/${coordinates}`
    : `https://api.mapbox.com/directions/v5/${mapboxProfile(request.travelMode)}/${coordinates}`;
  return { url: `${endpoint}?${params.toString()}`, shouldOptimize };
}

function orderedRouteStopIds(
  request: RouteRequest,
  payload: MapboxRoutePayload,
  shouldOptimize: boolean,
): string[] {
  if (!shouldOptimize || payload.waypoints?.length !== request.stops.length) {
    return request.stops.map((spot) => spot.id);
  }
  return payload.waypoints
    .map((waypoint, inputIndex) => ({
      id: request.stops[inputIndex].id,
      order: waypoint.waypoint_index ?? inputIndex,
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ id }) => id);
}

async function fetchMapboxRoute(
  request: RouteRequest,
  token: string,
  signal: AbortSignal,
): Promise<{ route: MapboxRoute; orderedStopIds: string[] }> {
  const { url, shouldOptimize } = prepareMapboxRouteRequest(request, token);
  const response = await fetch(url, { signal });
  const payload = await response.json() as MapboxRoutePayload;
  if (!response.ok || payload.code === "NoRoute") {
    throw new Error(payload.message || "この組み合わせのルートを作成できませんでした。");
  }
  const route = shouldOptimize ? payload.trips?.[0] : payload.routes?.[0];
  if (!route) throw new Error("ルートを見つけられませんでした。条件を変えてお試しください。");
  return { route, orderedStopIds: orderedRouteStopIds(request, payload, shouldOptimize) };
}

function successfulRouteResult(route: MapboxRoute, orderedStopIds: string[]): RouteResult {
  return {
    state: "success",
    distance: formatDistance(route.distance),
    duration: formatTravelTime(route.duration / 60),
    travelDurationMinutes: Math.max(1, Math.round(route.duration / 60)),
    accessDurationMinutes: 0,
    legDurationMinutes: route.legs.map((leg) => Math.max(1, Math.round(leg.duration / 60))),
    orderedStopIds,
  };
}

function useMapboxRouteRequest(
  routeRequest: RouteRequest | null,
  token: string,
  clearRoute: () => void,
  drawRoute: (lines: RouteLine[]) => void,
  onRouteResult: Props["onRouteResult"],
): void {
  useEffect(() => {
    if (!routeRequest) {
      clearRoute();
      return;
    }
    const requestedRoute = routeRequest;
    let cancelled = false;
    const controller = new AbortController();
    async function calculateRoute(): Promise<void> {
      if (requestedRoute.travelMode === "TRANSIT") return clearRoute();
      onRouteResult({ state: "loading" });
      clearRoute();
      if (!token) {
        onRouteResult({ state: "fallback", message: "地図を準備しています。少し待ってから、もう一度お試しください。" });
        return;
      }
      try {
        const { route, orderedStopIds } = await fetchMapboxRoute(requestedRoute, token, controller.signal);
        drawRoute([route.geometry.coordinates as RouteLine]);
        onRouteResult(successfulRouteResult(route, orderedStopIds));
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        onRouteResult({ state: "error", message: error instanceof Error ? error.message : "ルートの作成に失敗しました。" });
      }
    }
    void calculateRoute();
    return () => { cancelled = true; controller.abort(); };
  }, [clearRoute, drawRoute, onRouteResult, routeRequest, token]);
}

function FallbackPin({
  spot,
  index,
  selectedId,
  plannedSpotIds,
  cardModelSpotIds,
  onSelect,
}: {
  spot: PilgrimageSpot;
  index: number;
  selectedId: string;
  plannedSpotIds: ReadonlySet<string>;
  cardModelSpotIds: ReadonlySet<string>;
  onSelect: Props["onSelect"];
}): ReactElement {
  const x = 12 + ((spot.lng - 136.34) / 0.36) * 76;
  const y = 84 - ((spot.lat - 36.27) / 0.37) * 70;
  const markerKind = markerKindForSpot(spot, plannedSpotIds, cardModelSpotIds);
  return (
    <button
      type="button"
      className={`fallback-pin fallback-pin--${markerKind}${index >= 99 ? " is-three-digits" : ""}${selectedId === spot.id ? " is-active" : ""}`}
      style={{ left: `${Math.max(8, Math.min(90, x))}%`, top: `${Math.max(10, Math.min(86, y))}%` }}
      onClick={() => onSelect(spot.id)}
      aria-label={`${spot.name}を選択`}
    >
      <span>{String(index + 1).padStart(2, "0")}</span>
    </button>
  );
}

function MapFallback({
  spots,
  selectedId,
  plannedSpotIds,
  cardModelSpotIds,
  mapState,
  onSelect,
}: {
  spots: PilgrimageSpot[];
  selectedId: string;
  plannedSpotIds: ReadonlySet<string>;
  cardModelSpotIds: ReadonlySet<string>;
  mapState: MapState;
  onSelect: Props["onSelect"];
}): ReactElement {
  return (
    <div className="map-fallback" aria-label="巡礼スポット地図プレビュー">
      <div className="map-road map-road--one" />
      <div className="map-road map-road--two" />
      <div className="map-river" />
      <div className="map-coast">JAPAN SEA</div>
      {spots.map((spot, index) => (
        <FallbackPin
          key={spot.id}
          spot={spot}
          index={index}
          selectedId={selectedId}
          plannedSpotIds={plannedSpotIds}
          cardModelSpotIds={cardModelSpotIds}
          onSelect={onSelect}
        />
      ))}
      <div className="map-fallback__note">
        <span className="status-dot" />
        {mapState === "error" ? "地図を読み込めませんでした" : "地図を準備中"}
      </div>
    </div>
  );
}

function MapDisplay({
  mapElementRef,
  mapState,
  spots,
  selectedId,
  plannedSpotIds,
  cardModelSpotIds,
  routeRequest,
  onSelect,
}: {
  mapElementRef: RefObject<HTMLDivElement | null>;
  mapState: MapState;
  spots: PilgrimageSpot[];
  selectedId: string;
  plannedSpotIds: ReadonlySet<string>;
  cardModelSpotIds: ReadonlySet<string>;
  routeRequest: RouteRequest | null;
  onSelect: Props["onSelect"];
}): ReactElement {
  const fallbackMode = mapState === "fallback" || mapState === "error";
  return (
    <div className="map-shell">
      <div ref={mapElementRef} className={`mapbox-map ${fallbackMode ? "mapbox-map--hidden" : ""}`} aria-label="巡礼スポット地図" />
      {fallbackMode ? <MapFallback {...{ spots, selectedId, plannedSpotIds, cardModelSpotIds, mapState, onSelect }} /> : null}
      {mapState === "loading" ? <div className="map-loading">地図を読み込んでいます…</div> : null}
      {routeRequest && routeRequest.travelMode !== "TRANSIT" ? (
        <div className="open-maps-links">
          <a href={buildGoogleMapsUrl(routeRequest)} target="_blank" rel="noreferrer">
            現地ルートを開く <span aria-hidden="true">↗</span>
          </a>
        </div>
      ) : null}
    </div>
  );
}

export function MapboxPilgrimageMap({
  spots,
  selectedId,
  focusSpotRequest = null,
  plannedSpotIds,
  cardModelSpotIds,
  onSelect,
  routeRequest,
  onRouteResult,
  accessToken,
  isVisible = true,
  viewMode = "explore",
}: Props): ReactElement {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const routeLinesRef = useRef<RouteLine[]>([]);
  const onSelectRef = useRef(onSelect);
  const plannedSpotIdSet = useMemo(() => new Set(plannedSpotIds), [plannedSpotIds]);
  const cardModelSpotIdSet = useMemo(() => new Set(cardModelSpotIds), [cardModelSpotIds]);
  const { token, mapState, setMapState } = useMapRuntime(accessToken);
  const { clearRoute, drawRoute } = useRouteDrawing(mapRef, routeLinesRef, mapState);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useMapboxInstance(token, mapElementRef, mapRef, setMapState);
  usePlannerMapViewport(mapRef, routeLinesRef, spots, mapState, isVisible, viewMode);
  useSpotLayers(mapRef, onSelectRef, spots, plannedSpotIdSet, cardModelSpotIdSet, selectedId, mapState, setMapState);
  useSpotSelection(mapRef, spots, selectedId, focusSpotRequest, mapState);
  useMapboxRouteRequest(routeRequest, token, clearRoute, drawRoute, onRouteResult);
  return <MapDisplay {...{
    mapElementRef,
    mapState,
    spots,
    selectedId,
    plannedSpotIds: plannedSpotIdSet,
    cardModelSpotIds: cardModelSpotIdSet,
    routeRequest,
    onSelect,
  }} />;
}
