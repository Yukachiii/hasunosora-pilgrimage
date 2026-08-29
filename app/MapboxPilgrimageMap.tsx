"use client";

import mapboxgl from "mapbox-gl";
import { useCallback, useEffect, useRef, useState } from "react";
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
  onSelect: (id: string) => void;
  routeRequest: RouteRequest | null;
  onRouteResult: (result: RouteResult) => void;
  accessToken: string;
  routeServiceUrl: string;
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
const SPOT_MARKER_IMAGE_ID = "pilgrimage-spot-marker";
const COLLABORATION_MARKER_IMAGE_ID = "pilgrimage-collaboration-marker";

function ensureMapImage(map: mapboxgl.Map, id: string, url: string) {
  return new Promise<void>((resolve, reject) => {
    if (map.hasImage(id)) {
      resolve();
      return;
    }
    map.loadImage(url, (error, image) => {
      if (error || !image) {
        reject(error ?? new Error(`地図ピン画像を読み込めませんでした: ${url}`));
        return;
      }
      if (!map.hasImage(id)) map.addImage(id, image);
      resolve();
    });
  });
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

function spotFeatureCollection(spots: PilgrimageSpot[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: spots.map((spot, index) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [spot.lng, spot.lat] },
      properties: {
        spotId: spot.id,
        indexLabel: String(index + 1).padStart(2, "0"),
        collaboration: spot.collaborationIds?.length ? 1 : 0,
      },
    })),
  };
}

export function MapboxPilgrimageMap({
  spots,
  selectedId,
  onSelect,
  routeRequest,
  onRouteResult,
  accessToken,
  routeServiceUrl,
}: Props) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const onSelectRef = useRef(onSelect);
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

  useEffect(() => {
    if (!token || !mapElementRef.current) return;
    let cancelled = false;
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: mapElementRef.current,
      style: "mapbox://styles/mapbox/standard",
      language: "ja",
      config: {
        basemap: {
          theme: "faded",
          lightPreset: "day",
          showPlaceLabels: true,
          showRoadLabels: true,
          showPointOfInterestLabels: true,
          densityPointOfInterestLabels: 4,
          showTransitLabels: true,
          showLandmarkIcons: true,
          showLandmarkIconLabels: true,
          showPedestrianRoads: true,
          show3dObjects: false,
        },
      },
      center: [136.6562, 36.5708],
      zoom: 12.4,
      attributionControl: true,
      cooperativeGestures: true,
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
    const data = spotFeatureCollection(spots);
    const handleSpotClick = (event: mapboxgl.MapLayerMouseEvent) => {
      const spotId = event.features?.[0]?.properties?.spotId;
      if (typeof spotId === "string") onSelectRef.current(spotId);
    };
    const showPointer = () => { map.getCanvas().style.cursor = "pointer"; };
    const clearPointer = () => { map.getCanvas().style.cursor = ""; };

    void Promise.all([
      ensureMapImage(map, SPOT_MARKER_IMAGE_ID, "./map-markers/spot.png"),
      ensureMapImage(map, COLLABORATION_MARKER_IMAGE_ID, "./map-markers/collaboration.png"),
    ]).then(() => {
      if (cancelled) return;
      const existingSource = map.getSource(SPOT_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
      if (existingSource) {
        existingSource.setData(data);
      } else {
        map.addSource(SPOT_SOURCE_ID, { type: "geojson", data });
        const markerImage = [
          "case",
          ["==", ["get", "collaboration"], 1],
          COLLABORATION_MARKER_IMAGE_ID,
          SPOT_MARKER_IMAGE_ID,
        ] as mapboxgl.Expression;
        map.addLayer({
          id: SPOT_LAYER_ID,
          type: "symbol",
          source: SPOT_SOURCE_ID,
          layout: {
            "icon-image": markerImage,
            "icon-size": ["interpolate", ["linear"], ["zoom"], 6, 0.09, 10, 0.13, 14, 0.18],
            "icon-anchor": "bottom",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "text-field": ["get", "indexLabel"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 6, 5, 10, 7, 14, 9],
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-offset": [0, -2],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#263446",
            "text-halo-width": 1.5,
          },
        });
        map.addLayer({
          id: SELECTED_SPOT_LAYER_ID,
          type: "symbol",
          source: SPOT_SOURCE_ID,
          filter: ["==", ["get", "spotId"], selectedId],
          layout: {
            "icon-image": markerImage,
            "icon-size": 0.23,
            "icon-anchor": "bottom",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "text-field": ["get", "indexLabel"],
            "text-size": 10,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-offset": [0, -2.2],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#263446",
            "text-halo-width": 1.8,
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
  }, [mapState, selectedId, spots]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready" || !map.getLayer(SELECTED_SPOT_LAYER_ID)) return;
    map.setFilter(SELECTED_SPOT_LAYER_ID, ["==", ["get", "spotId"], selectedId]);
  }, [mapState, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapState !== "ready") return;
    const selected = spots.find((spot) => spot.id === selectedId);
    if (!selected) return;
    map.easeTo({ center: [selected.lng, selected.lat], zoom: 16.2, duration: 450 });
  }, [mapState, selectedId, spots]);

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

          if (serverResponse && ![404, 503].includes(serverResponse.status)) {
            const result = await serverResponse.json().catch(() => ({})) as ServerRoutePlanError;
            throw new Error(result.error || "ルートを計算できませんでした。");
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
            return (
              <button
                type="button"
                key={spot.id}
                className={`fallback-pin${spot.collaborationIds?.length ? " fallback-pin--collaboration" : ""}${selectedId === spot.id ? " is-active" : ""}`}
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
