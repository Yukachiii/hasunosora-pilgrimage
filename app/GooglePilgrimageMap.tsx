"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  state: "idle" | "loading" | "success" | "fallback" | "error";
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
  onSelect: (id: string) => void;
  routeRequest: RouteRequest | null;
  onRouteResult: (result: RouteResult) => void;
  apiKey: string;
  mapId: string;
};

type GoogleWindow = Window & {
  google?: {
    maps: {
      importLibrary: (library: string) => Promise<Record<string, unknown>>;
    };
  };
  __hasunotabiMapReady?: () => void;
  gm_authFailure?: () => void;
};

type ComputedRoute = {
  path?: Array<{ lat: number; lng: number }>;
  distanceMeters?: number;
  durationMillis?: number;
  optimizedIntermediateWaypointIndices?: number[];
  legs?: Array<{ distanceMeters?: number; durationMillis?: number }>;
  createPolylines: () => Array<{ setMap: (map: unknown) => void }>;
};

type RouteComputer = {
  computeRoutes: (request: Record<string, unknown>) => Promise<{ routes?: ComputedRoute[] }>;
};

let mapsLoaderPromise: Promise<void> | null = null;
const routeComputationCache = new Map<string, Promise<ComputedRoute>>();

function computeRouteOnce(RouteClass: RouteComputer, request: Record<string, unknown>) {
  const cacheKey = JSON.stringify(request);
  const cached = routeComputationCache.get(cacheKey);
  if (cached) return cached;

  const computation = RouteClass.computeRoutes(request).then((response) => {
    const route = response.routes?.[0];
    if (!route) throw new Error("no-route");
    return route;
  });
  routeComputationCache.set(cacheKey, computation);
  void computation.catch(() => routeComputationCache.delete(cacheKey));
  if (routeComputationCache.size > 60) {
    routeComputationCache.delete(routeComputationCache.keys().next().value!);
  }
  return computation;
}

function loadGoogleMaps(apiKey: string): Promise<void> {
  const googleWindow = window as GoogleWindow;
  if (googleWindow.google?.maps?.importLibrary) return Promise.resolve();
  if (mapsLoaderPromise) return mapsLoaderPromise;

  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = { id: undefined as number | undefined };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout.id) window.clearTimeout(timeout.id);
      callback();
    };
    const resolveOnce = () => finish(resolve);
    const rejectOnce = (reason: string) => finish(() => reject(new Error(reason)));

    googleWindow.__hasunotabiMapReady = resolveOnce;
    googleWindow.gm_authFailure = () => rejectOnce("map-auth");
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-hasunotabi-map="true"]',
    );
    if (existing) {
      existing.addEventListener("load", resolveOnce, { once: true });
      existing.addEventListener("error", () => rejectOnce("map-load"), { once: true });
    } else {
      const script = document.createElement("script");
      script.dataset.hasunotabiMap = "true";
      script.async = true;
      script.src =
        "https://maps.googleapis.com/maps/api/js" +
        `?key=${encodeURIComponent(apiKey)}` +
        "&loading=async&v=weekly&language=ja&region=JP" +
        "&auth_referrer_policy=origin" +
        "&callback=__hasunotabiMapReady";
      script.onerror = () => rejectOnce("map-load");
      document.head.appendChild(script);
    }
    timeout.id = window.setTimeout(() => rejectOnce("map-timeout"), 20_000);
  });

  mapsLoaderPromise = promise;
  void promise.catch(() => {
    if (mapsLoaderPromise === promise) mapsLoaderPromise = null;
  });
  return promise;
}

function point(location: RouteLocation) {
  return { lat: location.lat, lng: location.lng };
}

function buildGoogleMapsUrl(request: RouteRequest) {
  const transitDraft = request.travelMode === "TRANSIT";
  const params = new URLSearchParams({
    api: "1",
    origin: request.stops[0].address,
    destination: (transitDraft ? request.stops[1] : request.stops.at(-1)!).address,
    travelmode: request.travelMode.toLowerCase(),
  });
  const intermediates = transitDraft ? [] : request.stops.slice(1, -1);
  if (intermediates.length) {
    params.set("waypoints", intermediates.map((stop) => stop.address).join("|"));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function buildAccessMapsUrl(request: RouteRequest) {
  if (!request.accessOrigin) return "";
  const params = new URLSearchParams({
    api: "1",
    origin: request.accessOrigin.address,
    destination: request.stops[0].address,
    travelmode: "transit",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

function formatTravelTime(milliseconds: number) {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}分`;
  return remainder ? `${hours}時間${remainder}分` : `${hours}時間`;
}

function legMinutes(route: ComputedRoute, count: number) {
  if (route.legs?.length === count) {
    return route.legs.map((leg) => Math.max(1, Math.round((leg.durationMillis ?? 0) / 60_000)));
  }
  const total = Math.max(count, Math.round((route.durationMillis ?? 0) / 60_000));
  return Array.from({ length: count }, (_, index) =>
    Math.floor(total / count) + (index < total % count ? 1 : 0),
  );
}

export function GooglePilgrimageMap({
  spots,
  selectedId,
  onSelect,
  routeRequest,
  onRouteResult,
  apiKey,
  mapId,
}: Props) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<unknown>(null);
  const markersRef = useRef<Array<{ map: unknown | null }>>([]);
  const routePolylinesRef = useRef<Array<{ setMap: (map: unknown) => void }>>([]);
  const [mapState, setMapState] = useState<"fallback" | "loading" | "ready" | "error">(
    apiKey ? "loading" : "fallback",
  );

  const clearRoute = useCallback(() => {
    routePolylinesRef.current.forEach((polyline) => polyline.setMap(null));
    routePolylinesRef.current = [];
  }, []);

  useEffect(() => {
    if (!apiKey || !mapElementRef.current) return;
    let cancelled = false;

    async function initializeMap() {
      try {
        await loadGoogleMaps(apiKey);
        const maps = (window as GoogleWindow).google?.maps;
        if (!maps || !mapElementRef.current || cancelled) return;
        const [{ Map }, { AdvancedMarkerElement }] = await Promise.all([
          maps.importLibrary("maps"),
          maps.importLibrary("marker"),
        ]);
        const MapConstructor = Map as new (
          element: HTMLElement,
          options: Record<string, unknown>,
        ) => {
          panTo: (location: { lat: number; lng: number }) => void;
          setZoom: (zoom: number) => void;
          fitBounds: (bounds: unknown, padding?: number) => void;
        };
        const MarkerConstructor = AdvancedMarkerElement as new (options: {
          map: unknown;
          position: { lat: number; lng: number };
          title: string;
          content: HTMLElement;
          gmpClickable: boolean;
        }) => {
          map: unknown | null;
          addListener: (event: string, handler: () => void) => void;
        };

        const map = new MapConstructor(mapElementRef.current, {
          center: { lat: 36.74, lng: 136.72 },
          zoom: 8,
          mapId,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: false,
          gestureHandling: "greedy",
        });
        mapRef.current = map;
        markersRef.current = spots.map((spot, index) => {
          const content = document.createElement("div");
          content.className = `map-marker${spot.collaborationIds?.length ? " map-marker--collaboration" : ""}`;
          const label = document.createElement("span");
          label.textContent = String(index + 1).padStart(2, "0");
          content.appendChild(label);
          content.setAttribute("aria-label", spot.name);
          const marker = new MarkerConstructor({
            map,
            position: point(spot),
            title: spot.name,
            content,
            gmpClickable: true,
          });
          marker.addListener("click", () => onSelect(spot.id));
          return marker;
        });
        if (!cancelled) setMapState("ready");
      } catch {
        if (!cancelled) setMapState("error");
      }
    }

    void initializeMap();
    return () => {
      cancelled = true;
      markersRef.current.forEach((marker) => {
        marker.map = null;
      });
      clearRoute();
    };
  }, [apiKey, clearRoute, mapId, onSelect, spots]);

  useEffect(() => {
    if (mapState !== "ready" || !mapRef.current) return;
    const selected = spots.find((spot) => spot.id === selectedId);
    if (!selected) return;
    const map = mapRef.current as {
      panTo: (location: { lat: number; lng: number }) => void;
      setZoom: (zoom: number) => void;
    };
    map.panTo(point(selected));
    map.setZoom(14);
  }, [mapState, selectedId, spots]);

  useEffect(() => {
    if (!routeRequest) return;
    if (!apiKey || mapState === "fallback" || mapState === "error") {
      onRouteResult({
        state: "fallback",
        message: apiKey
          ? "現在Google Maps APIを利用できません。地図内のリンクからGoogle マップを開いてください。"
          : "APIキーを設定すると、複数地点のルートと一日予定を計算できます。",
      });
      return;
    }
    if (mapState !== "ready" || !mapRef.current) return;

    const requestedRoute = routeRequest;
    let cancelled = false;

    async function calculateRoute() {
      onRouteResult({ state: "loading" });
      clearRoute();
      try {
        const maps = (window as GoogleWindow).google?.maps;
        if (!maps) throw new Error("maps-unavailable");
        const [{ Route }, { LatLngBounds }] = await Promise.all([
          maps.importLibrary("routes"),
          maps.importLibrary("core"),
        ]);
        const RouteClass = Route as RouteComputer;
        const BoundsConstructor = LatLngBounds as new () => {
          extend: (location: { lat: number; lng: number }) => void;
        };
        const computedRoutes: ComputedRoute[] = [];
        const departure = new Date(requestedRoute.departureTime);
        let cursor = Number.isNaN(departure.getTime()) ? new Date() : departure;
        let accessDurationMillis = 0;

        async function compute(request: Record<string, unknown>) {
          const route = await computeRouteOnce(RouteClass, request);
          computedRoutes.push(route);
          return route;
        }

        if (requestedRoute.accessOrigin) {
          const access = await compute({
            origin: point(requestedRoute.accessOrigin),
            destination: point(requestedRoute.stops[0]),
            travelMode: "TRANSIT",
            departureTime: cursor,
            language: "ja",
            region: "jp",
            fields: ["path", "distanceMeters", "durationMillis"],
          });
          accessDurationMillis = access.durationMillis ?? 0;
          cursor = new Date(cursor.getTime() + accessDurationMillis);
        }

        let orderedStopIds = requestedRoute.stops.map((stop) => stop.id);
        let localLegMinutes: number[] = [];

        if (requestedRoute.travelMode === "TRANSIT") {
          for (let index = 0; index < requestedRoute.stops.length - 1; index += 1) {
            const current = requestedRoute.stops[index];
            cursor = new Date(
              cursor.getTime() + (requestedRoute.stayMinutes[current.id] ?? 0) * 60_000,
            );
            const segment = await compute({
              origin: point(current),
              destination: point(requestedRoute.stops[index + 1]),
              travelMode: "TRANSIT",
              departureTime: cursor,
              language: "ja",
              region: "jp",
              fields: ["path", "distanceMeters", "durationMillis"],
            });
            const segmentMinutes = Math.max(1, Math.round((segment.durationMillis ?? 0) / 60_000));
            localLegMinutes.push(segmentMinutes);
            cursor = new Date(cursor.getTime() + (segment.durationMillis ?? 0));
          }
        } else {
          const intermediates = requestedRoute.stops.slice(1, -1);
          const local = await compute({
            origin: point(requestedRoute.stops[0]),
            destination: point(requestedRoute.stops.at(-1)!),
            intermediates: intermediates.map((stop) => ({ location: point(stop) })),
            travelMode: requestedRoute.travelMode,
            optimizeWaypointOrder:
              requestedRoute.optimizeWaypointOrder && intermediates.length > 0,
            language: "ja",
            region: "jp",
            fields: [
              "path",
              "distanceMeters",
              "durationMillis",
              "legs",
              "optimizedIntermediateWaypointIndices",
            ],
          });
          const order = local.optimizedIntermediateWaypointIndices;
          if (requestedRoute.optimizeWaypointOrder && order?.length === intermediates.length) {
            orderedStopIds = [
              requestedRoute.stops[0].id,
              ...order.map((index) => intermediates[index].id),
              requestedRoute.stops.at(-1)!.id,
            ];
          }
          localLegMinutes = legMinutes(local, requestedRoute.stops.length - 1);
        }

        if (cancelled) return;
        for (const route of computedRoutes) {
          const polylines = route.createPolylines();
          polylines.forEach((polyline) => polyline.setMap(mapRef.current));
          routePolylinesRef.current.push(...polylines);
        }
        const paths = computedRoutes.flatMap((route) => route.path ?? []);
        if (paths.length) {
          const bounds = new BoundsConstructor();
          paths.forEach((location) => bounds.extend(location));
          (mapRef.current as { fitBounds: (bounds: unknown, padding?: number) => void }).fitBounds(
            bounds,
            64,
          );
        }

        const distanceMeters = computedRoutes.reduce(
          (total, route) => total + (route.distanceMeters ?? 0),
          0,
        );
        const durationMillis = computedRoutes.reduce(
          (total, route) => total + (route.durationMillis ?? 0),
          0,
        );
        onRouteResult({
          state: "success",
          distance: formatDistance(distanceMeters),
          duration: formatTravelTime(durationMillis),
          travelDurationMinutes: Math.max(1, Math.round(durationMillis / 60_000)),
          accessDurationMinutes: Math.round(accessDurationMillis / 60_000),
          legDurationMinutes: localLegMinutes,
          orderedStopIds,
        });
      } catch {
        if (!cancelled) {
          onRouteResult({
            state: "error",
            message:
              "この条件ではルートを取得できませんでした。地点数・日付・移動手段を確認して、もう一度お試しください。",
          });
        }
      }
    }

    void calculateRoute();
    return () => {
      cancelled = true;
    };
  }, [apiKey, clearRoute, mapState, onRouteResult, routeRequest]);

  const fallbackMode = mapState === "fallback" || mapState === "error";

  return (
    <div className="map-shell">
      <div
        ref={mapElementRef}
        className={`google-map ${fallbackMode ? "google-map--hidden" : ""}`}
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
            {mapState === "fallback"
              ? "Google Maps API 接続前のプレビュー"
              : "Google Mapsを利用できないため簡易地図を表示中"}
          </div>
        </div>
      )}
      {mapState === "loading" && <div className="map-loading">地図を読み込んでいます…</div>}
      {routeRequest && (
        <div className="open-maps-links">
          {routeRequest.accessOrigin && (
            <a href={buildAccessMapsUrl(routeRequest)} target="_blank" rel="noreferrer">
              主要駅からの経路 <span aria-hidden="true">↗</span>
            </a>
          )}
          <a href={buildGoogleMapsUrl(routeRequest)} target="_blank" rel="noreferrer">
            {routeRequest.travelMode === "TRANSIT" ? "最初の区間を開く" : "現地ルートを開く"} <span aria-hidden="true">↗</span>
          </a>
        </div>
      )}
    </div>
  );
}
