"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PilgrimageSpot } from "./spots";

type TravelMode = "WALKING" | "DRIVING" | "TRANSIT" | "BICYCLING";

type RouteRequest = {
  requestId: number;
  origin: PilgrimageSpot;
  destination: PilgrimageSpot;
  travelMode: TravelMode;
};

export type RouteResult = {
  state: "idle" | "loading" | "success" | "fallback" | "error";
  distance?: string;
  duration?: string;
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

let mapsLoaderPromise: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
  const googleWindow = window as GoogleWindow;

  if (googleWindow.google?.maps?.importLibrary) {
    return Promise.resolve();
  }

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
    const rejectOnce = (reason: string) =>
      finish(() => reject(new Error(reason)));

    googleWindow.__hasunotabiMapReady = resolveOnce;
    googleWindow.gm_authFailure = () => rejectOnce("map-auth");

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-hasunotabi-map="true"]',
    );
    if (existing) {
      existing.addEventListener("load", resolveOnce, { once: true });
      existing.addEventListener("error", () => rejectOnce("map-load"), {
        once: true,
      });
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

function buildGoogleMapsUrl(request: RouteRequest) {
  const params = new URLSearchParams({
    api: "1",
    origin: request.origin.address,
    destination: request.destination.address,
    travelmode: request.travelMode.toLowerCase(),
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
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
  const routePolylinesRef = useRef<Array<{ setMap: (map: unknown) => void }>>(
    [],
  );
  const routeMarkersRef = useRef<Array<{ map: unknown | null }>>([]);
  const [mapState, setMapState] = useState<
    "fallback" | "loading" | "ready" | "error"
  >(apiKey ? "loading" : "fallback");

  const clearRoute = useCallback(() => {
    routePolylinesRef.current.forEach((polyline) => polyline.setMap(null));
    routePolylinesRef.current = [];
    routeMarkersRef.current.forEach((marker) => {
      marker.map = null;
    });
    routeMarkersRef.current = [];
  }, []);

  useEffect(() => {
    if (!apiKey || !mapElementRef.current) return;
    let cancelled = false;

    async function initializeMap() {
      try {
        await loadGoogleMaps(apiKey);
        const googleWindow = window as GoogleWindow;
        const maps = googleWindow.google?.maps;
        if (!maps || !mapElementRef.current || cancelled) return;

        const [{ Map }, { AdvancedMarkerElement }] = await Promise.all([
          maps.importLibrary("maps"),
          maps.importLibrary("marker"),
        ]);

        const MapConstructor = Map as new (
          element: HTMLElement,
          options: Record<string, unknown>,
        ) => {
          panTo: (point: { lat: number; lng: number }) => void;
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
          center: { lat: 36.49, lng: 136.55 },
          zoom: 9,
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
          content.className = "map-marker";
          const markerLabel = document.createElement("span");
          markerLabel.textContent = String(index + 1).padStart(2, "0");
          content.appendChild(markerLabel);
          content.setAttribute("aria-label", spot.name);
          const marker = new MarkerConstructor({
            map,
            position: { lat: spot.lat, lng: spot.lng },
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
    const map = mapRef.current as {
      panTo: (point: { lat: number; lng: number }) => void;
      setZoom: (zoom: number) => void;
    };
    const selected = spots.find((spot) => spot.id === selectedId);
    if (selected) {
      map.panTo({ lat: selected.lat, lng: selected.lng });
      map.setZoom(selected.area === "加賀" || selected.area === "小松" ? 11 : 13);
    }
  }, [mapState, selectedId, spots]);

  useEffect(() => {
    if (!routeRequest) return;
    if (!apiKey || mapState === "fallback" || mapState === "error") {
      onRouteResult({
        state: "fallback",
        message: apiKey
          ? "現在Google Maps APIを利用できません。下のリンクからGoogle マップを開いてください。"
          : "APIキーを設定すると、この画面内にルート・距離・所要時間を表示できます。",
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
        const googleWindow = window as GoogleWindow;
        const maps = googleWindow.google?.maps;
        if (!maps) throw new Error("maps-unavailable");
        const [{ Route }, { LatLngBounds }] = await Promise.all([
          maps.importLibrary("routes"),
          maps.importLibrary("core"),
        ]);
        const RouteClass = Route as {
          computeRoutes: (request: Record<string, unknown>) => Promise<{
            routes?: Array<{
              path?: Array<{ lat: number; lng: number }>;
              localizedValues?: { distance?: string; duration?: string };
              createPolylines: () => Array<{
                setMap: (map: unknown) => void;
              }>;
              createWaypointAdvancedMarkers: () => Promise<
                Array<{ map: unknown | null }>
              >;
            }>;
          }>;
        };
        const BoundsConstructor = LatLngBounds as new () => {
          extend: (point: { lat: number; lng: number }) => void;
        };

        const { routes } = await RouteClass.computeRoutes({
          origin: {
            lat: requestedRoute.origin.lat,
            lng: requestedRoute.origin.lng,
          },
          destination: {
            lat: requestedRoute.destination.lat,
            lng: requestedRoute.destination.lng,
          },
          travelMode: requestedRoute.travelMode,
          language: "ja",
          region: "jp",
          fields: [
            "path",
            "localizedValues",
            "distanceMeters",
            "durationMillis",
          ],
        });
        if (!routes?.length) throw new Error("no-route");
        const route = routes[0];
        routePolylinesRef.current = route.createPolylines();
        routePolylinesRef.current.forEach((polyline) =>
          polyline.setMap(mapRef.current),
        );
        routeMarkersRef.current = await route.createWaypointAdvancedMarkers();
        routeMarkersRef.current.forEach((marker) => {
          marker.map = mapRef.current;
        });

        if (route.path?.length) {
          const bounds = new BoundsConstructor();
          route.path.forEach((point) => bounds.extend(point));
          (
            mapRef.current as {
              fitBounds: (bounds: unknown, padding?: number) => void;
            }
          ).fitBounds(bounds, 64);
        }

        if (!cancelled) {
          onRouteResult({
            state: "success",
            distance: route.localizedValues?.distance,
            duration: route.localizedValues?.duration,
          });
        }
      } catch {
        if (!cancelled) {
          onRouteResult({
            state: "error",
            message:
              "この条件ではルートを取得できませんでした。移動手段を変えて、もう一度お試しください。",
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
                className={`fallback-pin ${
                  selectedId === spot.id ? "is-active" : ""
                }`}
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
      {mapState === "loading" && (
        <div className="map-loading">地図を読み込んでいます…</div>
      )}
      {routeRequest && (
        <a
          className="open-maps-link"
          href={buildGoogleMapsUrl(routeRequest)}
          target="_blank"
          rel="noreferrer"
        >
          Google マップで開く
          <span aria-hidden="true">↗</span>
        </a>
      )}
    </div>
  );
}
