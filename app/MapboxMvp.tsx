"use client";

import mapboxgl from "mapbox-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PilgrimageSpot } from "./spots";
import styles from "./MapboxMvp.module.css";

type TravelProfile =
  | "mapbox/walking"
  | "mapbox/cycling"
  | "mapbox/driving"
  | "mapbox/driving-traffic";

type MapboxMvpProps = {
  initialToken?: string;
  spots: PilgrimageSpot[];
};

type RouteResult = {
  orderedSpots: PilgrimageSpot[];
  legDurations: number[];
  distanceMeters: number;
  travelSeconds: number;
  geometry: GeoJSON.LineString;
};

type ScheduleEntry = {
  spot: PilgrimageSpot;
  arrival: number;
  departure: number;
  stayMinutes: number;
  nextTravelSeconds: number | null;
};

const TOKEN_STORAGE_KEY = "hasunosora-mapbox-public-token";
const MAX_OPTIMIZATION_STOPS = 12;
const DEFAULT_SPOT_IDS = [
  "kanazawa-station",
  "ohmicho-market",
  "kanazawa-phonograph-museum",
];

const travelProfiles: Array<{ value: TravelProfile; label: string }> = [
  { value: "mapbox/walking", label: "徒歩" },
  { value: "mapbox/cycling", label: "自転車" },
  { value: "mapbox/driving", label: "車" },
  { value: "mapbox/driving-traffic", label: "車（交通状況を考慮）" },
];

function formatClock(totalMinutes: number) {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function startMinutesFromTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return (Number.isFinite(hour) ? hour : 9) * 60 +
    (Number.isFinite(minute) ? minute : 0);
}

function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)} km`;
}

function formatDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}時間${rest}分` : `${hours}時間`;
}

function defaultStayMinutes(spot: PilgrimageSpot) {
  return spot.recommendedStayMinutes ?? 30;
}

function buildSchedule(
  result: RouteResult | null,
  stays: Record<string, number>,
  startTime: string,
): ScheduleEntry[] {
  if (!result) return [];
  let cursor = startMinutesFromTime(startTime);

  return result.orderedSpots.map((spot, index) => {
    const stayMinutes = stays[spot.id] ?? defaultStayMinutes(spot);
    const arrival = cursor;
    const departure = arrival + stayMinutes;
    const nextTravelSeconds = result.legDurations[index] ?? null;
    if (nextTravelSeconds !== null) {
      cursor = departure + nextTravelSeconds / 60;
    }
    return { spot, arrival, departure, stayMinutes, nextTravelSeconds };
  });
}

export function MapboxMvp({ initialToken = "", spots }: MapboxMvpProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const [token, setToken] = useState(initialToken.trim());
  const [tokenDraft, setTokenDraft] = useState(initialToken.trim());
  const [showTokenSetup, setShowTokenSetup] = useState(!initialToken.trim());
  const [mapReady, setMapReady] = useState(false);
  const [mapMessage, setMapMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const available = new Set(spots.map((spot) => spot.id));
    return DEFAULT_SPOT_IDS.filter((id) => available.has(id));
  });
  const [stays, setStays] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      spots.map((spot) => [spot.id, defaultStayMinutes(spot)]),
    ),
  );
  const [profile, setProfile] = useState<TravelProfile>("mapbox/walking");
  const [startTime, setStartTime] = useState("09:00");
  const [optimizeOrder, setOptimizeOrder] = useState(true);
  const [search, setSearch] = useState("");
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null);
  const [routeError, setRouteError] = useState("");
  const [isCalculating, setIsCalculating] = useState(false);

  const spotMap = useMemo(
    () => new Map(spots.map((spot) => [spot.id, spot])),
    [spots],
  );
  const selectedSpots = useMemo(
    () => selectedIds.map((id) => spotMap.get(id)).filter(Boolean) as PilgrimageSpot[],
    [selectedIds, spotMap],
  );
  const schedule = useMemo(
    () => buildSchedule(routeResult, stays, startTime),
    [routeResult, stays, startTime],
  );
  const searchResults = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase("ja");
    const candidates = normalized
      ? spots.filter((spot) =>
          `${spot.name} ${spot.area} ${spot.address}`
            .toLocaleLowerCase("ja")
            .includes(normalized),
        )
      : spots;
    return candidates.slice(0, 12);
  }, [search, spots]);

  useEffect(() => {
    if (initialToken.trim()) return;
    let cancelled = false;
    queueMicrotask(() => {
      try {
        const savedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY)?.trim();
        if (savedToken && !cancelled) {
          setToken(savedToken);
          setTokenDraft(savedToken);
          setShowTokenSetup(false);
        }
      } catch {
        // Storage can be unavailable in privacy-focused browsers.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialToken]);

  useEffect(() => {
    if (!token || !mapContainerRef.current) return;

    mapboxgl.accessToken = token;
    setMapMessage("");
    setMapReady(false);
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/standard",
      center: [136.6562, 36.5708],
      zoom: 12.6,
      attributionControl: true,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => setMapReady(true));
    map.on("error", (event) => {
      const message = event.error?.message ?? "Mapboxの地図を読み込めませんでした。";
      if (/401|403|token|unauthorized|forbidden/i.test(message)) {
        setMapMessage("トークンまたは許可URLを確認してください。");
      }
    });
    mapRef.current = map;

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [token]);

  const toggleSpot = useCallback((spotId: string) => {
    setRouteResult(null);
    setRouteError("");
    setSelectedIds((current) => {
      if (current.includes(spotId)) {
        return current.filter((id) => id !== spotId);
      }
      if (current.length >= MAX_OPTIMIZATION_STOPS) return current;
      return [...current, spotId];
    });
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = spots.map((spot) => {
      const order = selectedIds.indexOf(spot.id);
      const markerButton = document.createElement("button");
      markerButton.type = "button";
      markerButton.className = `${styles.marker} ${order >= 0 ? styles.markerSelected : ""}`;
      if (order >= 0) {
        const markerLabel = document.createElement("span");
        markerLabel.textContent = String(order + 1);
        markerButton.append(markerLabel);
      }
      markerButton.title = `${spot.name}${order >= 0 ? "（予定に追加済み）" : "を予定に追加"}`;
      markerButton.setAttribute("aria-label", markerButton.title);
      markerButton.addEventListener("click", () => toggleSpot(spot.id));
      return new mapboxgl.Marker({ element: markerButton, anchor: "bottom" })
        .setLngLat([spot.lng, spot.lat])
        .addTo(map);
    });
  }, [mapReady, selectedIds, spots, toggleSpot]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !routeResult) return;

    const data: GeoJSON.Feature<GeoJSON.LineString> = {
      type: "Feature",
      properties: {},
      geometry: routeResult.geometry,
    };
    const source = map.getSource("mvp-route") as mapboxgl.GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
    } else {
      map.addSource("mvp-route", { type: "geojson", data });
      map.addLayer({
        id: "mvp-route-shadow",
        type: "line",
        source: "mvp-route",
        paint: {
          "line-color": "#ffffff",
          "line-width": 8,
          "line-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "mvp-route-line",
        type: "line",
        source: "mvp-route",
        paint: {
          "line-color": "#6eb7c6",
          "line-width": 5,
          "line-opacity": 0.95,
        },
      });
    }

    const bounds = new mapboxgl.LngLatBounds();
    routeResult.geometry.coordinates.forEach(([lng, lat]) => bounds.extend([lng, lat]));
    map.fitBounds(bounds, { padding: 70, maxZoom: 15, duration: 700 });
  }, [mapReady, routeResult]);

  function applyToken() {
    const nextToken = tokenDraft.trim();
    if (!nextToken.startsWith("pk.")) {
      setMapMessage("Mapboxの公開トークン（pk.から始まる文字列）を入力してください。");
      return;
    }
    try {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
    } catch {
      // The token still works for the current session when storage is blocked.
    }
    setMapMessage("");
    setToken(nextToken);
    setShowTokenSetup(false);
  }

  function clearToken() {
    try {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // No cleanup is needed when storage is unavailable.
    }
    setToken("");
    setTokenDraft("");
    setRouteResult(null);
    setShowTokenSetup(true);
  }

  function moveSpot(index: number, direction: -1 | 1) {
    setRouteResult(null);
    setSelectedIds((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function calculateRoute() {
    if (!token) {
      setShowTokenSetup(true);
      setRouteError("先にMapboxの公開トークンを設定してください。");
      return;
    }
    if (selectedSpots.length < 2) {
      setRouteError("2か所以上のスポットを選んでください。");
      return;
    }

    setIsCalculating(true);
    setRouteError("");
    try {
      const coordinates = selectedSpots
        .map((spot) => `${spot.lng},${spot.lat}`)
        .join(";");
      const shouldOptimize = optimizeOrder && selectedSpots.length > 2;
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
        ? `https://api.mapbox.com/optimized-trips/v1/${profile}/${coordinates}`
        : `https://api.mapbox.com/directions/v5/${profile}/${coordinates}`;
      const response = await fetch(`${endpoint}?${params.toString()}`);
      const payload = (await response.json()) as {
        code?: string;
        message?: string;
        trips?: Array<{
          distance: number;
          duration: number;
          geometry: GeoJSON.LineString;
          legs: Array<{ duration: number }>;
        }>;
        routes?: Array<{
          distance: number;
          duration: number;
          geometry: GeoJSON.LineString;
          legs: Array<{ duration: number }>;
        }>;
        waypoints?: Array<{ waypoint_index?: number }>;
      };
      if (!response.ok || payload.code === "NoRoute") {
        throw new Error(payload.message || "この組み合わせのルートを作成できませんでした。");
      }

      const route = shouldOptimize ? payload.trips?.[0] : payload.routes?.[0];
      if (!route?.geometry || !route.legs) {
        throw new Error("Mapboxからルートが返されませんでした。");
      }
      let orderedSpots = selectedSpots;
      if (shouldOptimize && payload.waypoints?.length === selectedSpots.length) {
        orderedSpots = payload.waypoints
          .map((waypoint, inputIndex) => ({
            spot: selectedSpots[inputIndex],
            order: waypoint.waypoint_index ?? inputIndex,
          }))
          .sort((a, b) => a.order - b.order)
          .map(({ spot }) => spot);
      }

      setSelectedIds(orderedSpots.map((spot) => spot.id));
      setRouteResult({
        orderedSpots,
        legDurations: route.legs.map((leg) => leg.duration),
        distanceMeters: route.distance,
        travelSeconds: route.duration,
        geometry: route.geometry,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ルート作成に失敗しました。";
      setRouteError(
        /401|403|token|forbidden|unauthorized/i.test(message)
          ? "トークンまたは許可URLを確認してください。"
          : message,
      );
      setRouteResult(null);
    } finally {
      setIsCalculating(false);
    }
  }

  const totalStayMinutes = schedule.reduce((sum, entry) => sum + entry.stayMinutes, 0);
  const endTime = schedule.at(-1)?.departure ?? startMinutesFromTime(startTime);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <a className={styles.backLink} href="../">← 蓮ノ旅へ戻る</a>
          <p className={styles.eyebrow}>MAPBOX COMPARISON MVP</p>
          <h1>金沢の一日を、別の地図で組み立てる。</h1>
          <p className={styles.lead}>
            登録済みスポットを使い、徒歩・自転車・車の訪問順と時刻表を試せる比較版です。
          </p>
        </div>
        <div className={styles.meter} aria-label="MVPの対応範囲">
          <span>最大</span>
          <strong>12</strong>
          <small>SPOTS</small>
        </div>
      </header>

      <section className={styles.notice}>
        <strong>比較用MVP</strong>
        <span>公共交通と東京・大阪からの経路は対象外です。現地での徒歩・自転車・車を比較します。</span>
        <button type="button" onClick={() => setShowTokenSetup((current) => !current)}>
          接続設定
        </button>
      </section>

      {showTokenSetup && (
        <section className={styles.tokenPanel} aria-label="Mapbox接続設定">
          <div>
            <p className={styles.sectionLabel}>FIRST SETUP</p>
            <h2>Mapboxの公開トークンを設定</h2>
            <p>
              <code>pk.</code>から始まる公開トークンを入力してください。このブラウザ内だけに保存されます。
            </p>
          </div>
          <div className={styles.tokenForm}>
            <input
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="pk.eyJ1..."
              autoComplete="off"
              aria-label="Mapbox公開トークン"
            />
            <button type="button" onClick={applyToken}>このブラウザで使う</button>
            {token && <button type="button" className={styles.secondaryButton} onClick={clearToken}>削除</button>}
          </div>
          {mapMessage && <p className={styles.errorText}>{mapMessage}</p>}
        </section>
      )}

      <div className={styles.workspace}>
        <section className={styles.mapPanel} aria-label="Mapbox地図">
          <div ref={mapContainerRef} className={styles.map} />
          {!token && (
            <div className={styles.mapPlaceholder}>
              <span>MAPBOX</span>
              <strong>公開トークンを設定すると地図が表示されます</strong>
              <button type="button" onClick={() => setShowTokenSetup(true)}>接続設定を開く</button>
            </div>
          )}
          {mapMessage && token && <div className={styles.mapError}>{mapMessage}</div>}
          <div className={styles.mapLegend}>
            <span><i className={styles.legendAvailable} />候補</span>
            <span><i className={styles.legendSelected} />予定に追加済み</span>
          </div>
        </section>

        <aside className={styles.planner} aria-label="Mapbox一日予定作成">
          <div className={styles.plannerHeading}>
            <div>
              <p className={styles.sectionLabel}>DAY PLANNER</p>
              <h2>一日の予定</h2>
            </div>
            <span>{selectedSpots.length} / {MAX_OPTIMIZATION_STOPS}</span>
          </div>

          <label className={styles.field}>
            <span>移動手段</span>
            <select value={profile} onChange={(event) => {
              setProfile(event.target.value as TravelProfile);
              setRouteResult(null);
            }}>
              {travelProfiles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>出発時刻</span>
            <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
          </label>
          <label className={styles.optimizeToggle}>
            <input
              type="checkbox"
              checked={optimizeOrder}
              onChange={(event) => {
                setOptimizeOrder(event.target.checked);
                setRouteResult(null);
              }}
            />
            <span>
              <strong>途中の訪問順を自動で整える</strong>
              <small>最初と最後のスポットは固定します</small>
            </span>
          </label>

          <div className={styles.selectedList}>
            {selectedSpots.map((spot, index) => (
              <article key={spot.id} className={styles.selectedSpot}>
                <span className={styles.order}>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{spot.name}</strong>
                  <small>{spot.area}</small>
                  <label>
                    滞在
                    <input
                      type="number"
                      min="5"
                      max="360"
                      step="5"
                      value={stays[spot.id] ?? defaultStayMinutes(spot)}
                      onChange={(event) => {
                        setStays((current) => ({
                          ...current,
                          [spot.id]: Math.max(5, Number(event.target.value) || 5),
                        }));
                      }}
                    />
                    分
                  </label>
                </div>
                <div className={styles.orderButtons}>
                  <button type="button" disabled={index === 0} onClick={() => moveSpot(index, -1)} aria-label={`${spot.name}を前へ`}>↑</button>
                  <button type="button" disabled={index === selectedSpots.length - 1} onClick={() => moveSpot(index, 1)} aria-label={`${spot.name}を後ろへ`}>↓</button>
                  <button type="button" onClick={() => toggleSpot(spot.id)} aria-label={`${spot.name}を削除`}>×</button>
                </div>
              </article>
            ))}
          </div>

          <button
            type="button"
            className={styles.calculateButton}
            onClick={calculateRoute}
            disabled={isCalculating || selectedSpots.length < 2}
          >
            {isCalculating ? "ルートを作成中…" : routeResult ? "条件を変えて再作成" : "この内容で一日を作る"}
            <span aria-hidden="true">→</span>
          </button>
          {routeError && <p className={styles.errorText}>{routeError}</p>}
        </aside>
      </div>

      <section className={styles.spotSearch}>
        <div>
          <p className={styles.sectionLabel}>ADD SPOTS</p>
          <h2>登録スポットから追加</h2>
        </div>
        <label>
          <span>スポット検索</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="施設名・エリア・住所"
          />
        </label>
        <div className={styles.searchResults}>
          {searchResults.map((spot) => {
            const selected = selectedIds.includes(spot.id);
            return (
              <button
                key={spot.id}
                type="button"
                className={selected ? styles.searchSelected : ""}
                onClick={() => toggleSpot(spot.id)}
                disabled={!selected && selectedIds.length >= MAX_OPTIMIZATION_STOPS}
              >
                <span>{spot.area}</span>
                <strong>{spot.name}</strong>
                <small>{selected ? "予定から外す" : "予定に追加"}</small>
              </button>
            );
          })}
        </div>
      </section>

      {routeResult && (
        <section className={styles.result} aria-label="Mapboxで作成した一日予定">
          <div className={styles.resultHeading}>
            <div>
              <p className={styles.sectionLabel}>YOUR DAY</p>
              <h2>{startTime}からの巡礼予定</h2>
            </div>
            <div className={styles.resultSummary}>
              <span><small>距離</small><strong>{formatDistance(routeResult.distanceMeters)}</strong></span>
              <span><small>移動</small><strong>{formatDuration(routeResult.travelSeconds)}</strong></span>
              <span><small>滞在</small><strong>{totalStayMinutes}分</strong></span>
              <span><small>終了</small><strong>{formatClock(endTime)}</strong></span>
            </div>
          </div>
          <ol className={styles.schedule}>
            {schedule.map((entry, index) => (
              <li key={entry.spot.id}>
                <time>{formatClock(entry.arrival)}</time>
                <div>
                  <span>SPOT {String(index + 1).padStart(2, "0")}</span>
                  <h3>{entry.spot.name}</h3>
                  <p>{entry.stayMinutes}分滞在・{formatClock(entry.departure)}出発</p>
                  {entry.nextTravelSeconds !== null && <small>次へ 約{formatDuration(entry.nextTravelSeconds)}</small>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className={styles.footer}>
        <p>Mapbox比較用MVP・登録地点は蓮ノ旅の公開データを使用</p>
        <a href="../">通常版へ戻る</a>
      </footer>
    </main>
  );
}
