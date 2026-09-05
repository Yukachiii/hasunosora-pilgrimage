"use client";

import mapboxgl from "mapbox-gl";
import type * as GeoJSON from "geojson";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerRoutePlanError, ServerRoutePlanResponse } from "./route-api";
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
  source?: "server" | "browser";
  apiRequestCount?: number;
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
  routeServiceUrl: string;
  isVisible?: boolean;
  viewMode?: "explore" | "planner";
};

type MapboxRoute = {
  distance: number;
  duration: number;
  geometry: GeoJSON.LineString;
  legs: Array<{ duration: number }>;
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

function markerIconSize() {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    6, 0.45,
    10, 0.7,
    14, 1,
  ] as mapboxgl.Expression;
}

function buildGoogleMapsUrl(request: RouteRequest) {
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

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

function formatTravelTime(minutes: number) {
  const roundedMinutes = Math.max(1, Math.round(minutes));
  const hours = Math.floor(roundedMinutes / 60);
  const remainder = roundedMinutes % 60;
  if (!hours) return `${remainder}分`;
  return remainder ? `${hours}時間${remainder}分` : `${hours}時間`;
}

function decodeEncodedPolyline(encoded: string) {
  const coordinates: Array<[number, number]> = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length) {
    const deltas = [0, 0];
    for (let coordinate = 0; coordinate < 2; coordinate += 1) {
      let result = 0;
      let shift = 0;
      let byte = 0;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index <= encoded.length);
      deltas[coordinate] = result & 1 ? ~(result >> 1) : result >> 1;
    }
    latitude += deltas[0];
    longitude += deltas[1];
    coordinates.push([longitude / 1e5, latitude / 1e5]);
  }
  return coordinates;
}

function mapboxProfile(mode: TravelMode) {
  if (mode === "DRIVING") return "mapbox/driving-traffic";
  if (mode === "BICYCLING") return "mapbox/cycling";
  return "mapbox/walking";
}

type MarkerKind = "standard" | "collaboration" | "card" | "planned";

const markerAssetByKind: Record<MarkerKind, string> = {
  standard: "./map-markers/red.png",
  collaboration: "./map-markers/yellow.png",
  card: "./map-markers/blue.png",
  planned: "./map-markers/green.png",
};

const markerAssetCache = new Map<MarkerKind, Promise<HTMLImageElement>>();

function numberedMarkerImageId(kind: MarkerKind, label: string) {
  return `${NUMBERED_MARKER_IMAGE_PREFIX}-${kind}-${label}`;
}

function loadMarkerAsset(kind: MarkerKind) {
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

function createNumberedMarkerImage(image: HTMLImageElement, label: string) {
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
) {
  const kinds = [...new Set(features.map((feature) => feature.properties?.markerKind as MarkerKind))];
  const assets = new Map(await Promise.all(kinds.map(async (kind) => [kind, await loadMarkerAsset(kind)] as const)));
  for (const feature of features) {
    const kind = feature.properties?.markerKind as MarkerKind;
    const label = String(feature.properties?.indexLabel ?? "");
    const imageId = numberedMarkerImageId(kind, label);
    if (!map.hasImage(imageId)) {
      map.addImage(imageId, createNumberedMarkerImage(assets.get(kind)!, label), {
        pixelRatio: MARKER_IMAGE_PIXEL_RATIO,
      });
    }
  }
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
  routeServiceUrl,
  isVisible = true,
  viewMode = "explore",
}: Props) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const routeLinesRef = useRef<Array<Array<[number, number]>>>([]);
  const onSelectRef = useRef(onSelect);
  const plannedSpotIdSet = useMemo(() => new Set(plannedSpotIds), [plannedSpotIds]);
  const cardModelSpotIdSet = useMemo(() => new Set(cardModelSpotIds), [cardModelSpotIds]);
  const [token, setToken] = useState(accessToken.trim());
  const [mapState, setMapState] = useState<"fallback" | "loading" | "ready" | "error">(
    accessToken.trim() ? "loading" : "fallback",
  );

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (accessToken.trim()) return;
    let cancelled = false;
    queueMicrotask(() => {
      try {
        const savedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? "";
        if (savedToken.startsWith("pk.") && !cancelled) {
          setToken(savedToken);
          setMapState("loading");
        }
      } catch {
        // The static fallback remains usable when browser storage is unavailable.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const clearRoute = useCallback(() => {
    const map = mapRef.current;
    routeLinesRef.current = [];
    if (!map?.isStyleLoaded()) return;
    if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
    if (map.getLayer(ROUTE_SHADOW_LAYER_ID)) map.removeLayer(ROUTE_SHADOW_LAYER_ID);
    if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);
  }, []);

  const drawRoute = useCallback((lines: Array<Array<[number, number]>>) => {
    const map = mapRef.current;
    const usableLines = lines.filter((line) => line.length > 1);
    if (!map?.isStyleLoaded() || !usableLines.length) return;
    clearRoute();
    routeLinesRef.current = usableLines;
    const feature: GeoJSON.Feature<GeoJSON.MultiLineString> = {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiLineString", coordinates: usableLines },
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
    const bounds = new mapboxgl.LngLatBounds();
    usableLines.flat().forEach(([lng, lat]) => bounds.extend([lng, lat]));
    map.fitBounds(bounds, { padding: 64, maxZoom: 15, duration: 650 });
  }, [clearRoute]);

  const fitPlannerView = useCallback((duration: number) => {
    const map = mapRef.current;
    if (!map || mapState !== "ready") return;
    const bounds = new mapboxgl.LngLatBounds();
    const lines = routeLinesRef.current;
    if (lines.length) {
      lines.flat().forEach(([lng, lat]) => bounds.extend([lng, lat]));
    } else {
      spots.forEach((spot) => bounds.extend([spot.lng, spot.lat]));
    }
    if (bounds.isEmpty()) return;
    map.fitBounds(bounds, { padding: 64, maxZoom: 15, duration });
  }, [mapState, spots]);

  useEffect(() => {
    if (!isVisible || mapState !== "ready") return;
    const frame = window.requestAnimationFrame(() => {
      const map = mapRef.current;
      if (!map) return;
      map.resize();
      if (viewMode === "planner") fitPlannerView(0);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitPlannerView, isVisible, mapState, viewMode]);

  useEffect(() => {
    if (viewMode !== "planner" || mapState !== "ready") return;
    const frame = window.requestAnimationFrame(() => {
      mapRef.current?.resize();
      fitPlannerView(500);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitPlannerView, mapState, viewMode]);

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
      if (cancelled) return;
      // Apply localization after every style load so all zoom-dependent label
      // layers use Japanese where the Streets source provides it.
      map.setLanguage("ja");
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), "top-right");
    map.on("load", () => {
      if (!cancelled) setMapState("ready");
    });
    map.on("error", (event) => {
      const message = event.error?.message ?? "";
      if (!cancelled && /401|403|token|unauthorized|forbidden/i.test(message)) {
        setMapState("error");
      }
    });
    mapRef.current = map;

    return () => {
      cancelled = true;
      map.remove();
      mapRef.current = null;
    };
  }, [token]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready") return;
    let cancelled = false;
    const data = spotFeatureCollection(spots, plannedSpotIdSet, cardModelSpotIdSet);
    const handleSpotClick = (event: mapboxgl.MapLayerMouseEvent) => {
      const spotId = event.features?.[0]?.properties?.spotId;
      if (typeof spotId === "string") onSelectRef.current(spotId);
    };
    const showPointer = () => { map.getCanvas().style.cursor = "pointer"; };
    const clearPointer = () => { map.getCanvas().style.cursor = ""; };

    void ensureNumberedMarkerImages(map, data.features).then(() => {
      if (cancelled) return;
      const existingSource = map.getSource(SPOT_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
      if (existingSource) {
        existingSource.setData(data);
      } else {
        map.addSource(SPOT_SOURCE_ID, { type: "geojson", data });
      }
      if (map.getLayer(SPOT_LAYER_ID)) {
        map.setLayoutProperty(SPOT_LAYER_ID, "icon-size", markerIconSize());
      } else {
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

      if (map.getLayer(SELECTED_SPOT_LAYER_ID)) {
        map.setLayoutProperty(SELECTED_SPOT_LAYER_ID, "icon-size", 1.3);
      } else {
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

      map.on("click", SPOT_LAYER_ID, handleSpotClick);
      map.on("mouseenter", SPOT_LAYER_ID, showPointer);
      map.on("mouseleave", SPOT_LAYER_ID, clearPointer);
    }).catch(() => {
      if (!cancelled) setMapState("error");
    });

    return () => {
      cancelled = true;
      if (map.getLayer(SPOT_LAYER_ID)) {
        map.off("click", SPOT_LAYER_ID, handleSpotClick);
        map.off("mouseenter", SPOT_LAYER_ID, showPointer);
        map.off("mouseleave", SPOT_LAYER_ID, clearPointer);
      }
    };
  }, [cardModelSpotIdSet, mapState, plannedSpotIdSet, selectedId, spots]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready" || !map.getLayer(SELECTED_SPOT_LAYER_ID)) return;
    map.setFilter(SPOT_LAYER_ID, ["!=", ["get", "spotId"], selectedId]);
    map.setFilter(SELECTED_SPOT_LAYER_ID, ["==", ["get", "spotId"], selectedId]);
  }, [mapState, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready") return;
    const selected = spots.find((spot) => spot.id === selectedId);
    if (!selected) return;
    map.easeTo({ center: [selected.lng, selected.lat], duration: 450 });
  }, [mapState, selectedId, spots]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready" || !focusSpotRequest) return;
    const focused = spots.find((spot) => spot.id === focusSpotRequest.spotId);
    if (!focused) return;
    map.easeTo({
      center: [focused.lng, focused.lat],
      zoom: Math.max(map.getZoom(), 15.5),
      duration: 550,
    });
  }, [focusSpotRequest, mapState, spots]);

  useEffect(() => {
    if (!routeRequest) {
      clearRoute();
      return;
    }
    const requestedRoute = routeRequest;
    let cancelled = false;
    const controller = new AbortController();

    async function calculateRoute() {
      if (requestedRoute.travelMode === "TRANSIT") {
        clearRoute();
        return;
      }
      onRouteResult({ state: "loading" });
      clearRoute();
      try {
        if (routeServiceUrl) {
          let serverResponse: Response | null = null;
          try {
            serverResponse = await fetch(routeServiceUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                stopIds: requestedRoute.stops.map((spot) => spot.id),
                stopLocations: requestedRoute.stops.map((spot) => ({
                  id: spot.id,
                  lat: spot.lat,
                  lng: spot.lng,
                })),
                travelMode: requestedRoute.travelMode,
                optimizeWaypointOrder: requestedRoute.optimizeWaypointOrder,
                stayMinutes: Object.fromEntries(
                  requestedRoute.stops.map((spot) => [
                    spot.id,
                    requestedRoute.stayMinutes[spot.id] ?? 0,
                  ]),
                ),
                departureTime: requestedRoute.departureTime,
              }),
              signal: controller.signal,
            });
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
          }

          if (serverResponse?.ok) {
            const result = await serverResponse.json() as ServerRoutePlanResponse;
            if (cancelled) return;
            drawRoute(result.encodedPolylines.map(decodeEncodedPolyline));
            onRouteResult({
              state: "success",
              distance: formatDistance(result.distanceMeters),
              duration: formatTravelTime(result.travelDurationMinutes),
              travelDurationMinutes: result.travelDurationMinutes,
              accessDurationMinutes: result.accessDurationMinutes,
              legDurationMinutes: result.legDurationMinutes,
              orderedStopIds: result.orderedStopIds,
              source: "server",
              apiRequestCount: result.apiRequestCount,
            });
            return;
          }

          const serverError = serverResponse
            ? await serverResponse.json().catch(() => ({})) as ServerRoutePlanError
            : null;
          const shouldFallbackToMapbox = serverResponse && (
            serverResponse.status === 404 ||
            serverResponse.status >= 500 ||
            serverError?.code === "SPOT_DATA_OUT_OF_DATE" ||
            serverError?.error === "登録されていないスポットが含まれています。"
          );
          if (serverResponse && !shouldFallbackToMapbox) {
            throw new Error(serverError?.error || "ルートを計算できませんでした。");
          }
        }

        if (!token) {
          onRouteResult({
            state: "fallback",
            message: "地図の接続設定を確認しています。しばらくしてからもう一度お試しください。",
          });
          return;
        }

        const coordinates = requestedRoute.stops
          .map((spot) => `${spot.lng},${spot.lat}`)
          .join(";");
        const shouldOptimize = requestedRoute.optimizeWaypointOrder && requestedRoute.stops.length <= 12;
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
          ? `https://api.mapbox.com/optimized-trips/v1/${mapboxProfile(requestedRoute.travelMode)}/${coordinates}`
          : `https://api.mapbox.com/directions/v5/${mapboxProfile(requestedRoute.travelMode)}/${coordinates}`;
        const response = await fetch(`${endpoint}?${params.toString()}`, { signal: controller.signal });
        const payload = await response.json() as {
          code?: string;
          message?: string;
          trips?: MapboxRoute[];
          routes?: MapboxRoute[];
          waypoints?: Array<{ waypoint_index?: number }>;
        };
        if (!response.ok || payload.code === "NoRoute") {
          throw new Error(payload.message || "この組み合わせのルートを作成できませんでした。");
        }
        const route = shouldOptimize ? payload.trips?.[0] : payload.routes?.[0];
        if (!route) throw new Error("Mapboxからルートが返されませんでした。");
        const orderedStopIds = shouldOptimize && payload.waypoints?.length === requestedRoute.stops.length
          ? payload.waypoints
              .map((waypoint, inputIndex) => ({
                id: requestedRoute.stops[inputIndex].id,
                order: waypoint.waypoint_index ?? inputIndex,
              }))
              .sort((a, b) => a.order - b.order)
              .map(({ id }) => id)
          : requestedRoute.stops.map((spot) => spot.id);
        drawRoute([route.geometry.coordinates as Array<[number, number]>]);
        onRouteResult({
          state: "success",
          distance: formatDistance(route.distance),
          duration: formatTravelTime(route.duration / 60),
          travelDurationMinutes: Math.max(1, Math.round(route.duration / 60)),
          accessDurationMinutes: 0,
          legDurationMinutes: route.legs.map((leg) => Math.max(1, Math.round(leg.duration / 60))),
          orderedStopIds,
          source: "browser",
          apiRequestCount: 1,
        });
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        onRouteResult({
          state: "error",
          message: error instanceof Error ? error.message : "ルートの作成に失敗しました。",
        });
      }
    }

    void calculateRoute();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [clearRoute, drawRoute, onRouteResult, routeRequest, routeServiceUrl, token]);

  const fallbackMode = mapState === "fallback" || mapState === "error";

  return (
    <div className="map-shell">
      <div
        ref={mapElementRef}
        className={`mapbox-map ${fallbackMode ? "mapbox-map--hidden" : ""}`}
        aria-label="巡礼スポット地図"
      />
      {fallbackMode && (
        <div className="map-fallback" aria-label="巡礼スポット地図プレビュー">
          <div className="map-road map-road--one" />
          <div className="map-road map-road--two" />
          <div className="map-river" />
          <div className="map-coast">JAPAN SEA</div>
          {spots.map((spot, index) => {
            const x = 12 + ((spot.lng - 136.34) / 0.36) * 76;
            const y = 84 - ((spot.lat - 36.27) / 0.37) * 70;
            const markerKind = markerKindForSpot(spot, plannedSpotIdSet, cardModelSpotIdSet);
            return (
              <button
                type="button"
                key={spot.id}
                className={`fallback-pin fallback-pin--${markerKind}${index >= 99 ? " is-three-digits" : ""}${selectedId === spot.id ? " is-active" : ""}`}
                style={{
                  left: `${Math.max(8, Math.min(90, x))}%`,
                  top: `${Math.max(10, Math.min(86, y))}%`,
                }}
                onClick={() => onSelect(spot.id)}
                aria-label={`${spot.name}を選択`}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
              </button>
            );
          })}
          <div className="map-fallback__note">
            <span className="status-dot" />
            {mapState === "error" ? "地図を読み込めませんでした" : "地図の接続設定を確認中"}
          </div>
        </div>
      )}
      {mapState === "loading" && <div className="map-loading">地図を読み込んでいます…</div>}
      {routeRequest && routeRequest.travelMode !== "TRANSIT" && (
        <div className="open-maps-links">
          <a href={buildGoogleMapsUrl(routeRequest)} target="_blank" rel="noreferrer">
            現地ルートを開く <span aria-hidden="true">↗</span>
          </a>
        </div>
      )}
    </div>
  );
}
