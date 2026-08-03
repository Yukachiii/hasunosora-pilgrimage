"use client";

import {
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  GooglePilgrimageMap,
  type RouteResult,
} from "./GooglePilgrimageMap";
import type { PilgrimageSpot } from "./spots";

type TravelMode = "WALKING" | "DRIVING" | "TRANSIT" | "BICYCLING";

const travelModes: Array<{
  value: TravelMode;
  label: string;
  icon: string;
}> = [
  { value: "WALKING", label: "徒歩", icon: "歩" },
  { value: "DRIVING", label: "車", icon: "車" },
  { value: "TRANSIT", label: "公共交通", icon: "交" },
  { value: "BICYCLING", label: "自転車", icon: "自" },
];

type Props = {
  googleMapsConfig: {
    apiKey: string;
    mapId: string;
  };
  spots: PilgrimageSpot[];
  spotImages: Record<string, string>;
  heroImage: string | null;
};

export function PilgrimageApp({
  googleMapsConfig,
  spots,
  spotImages,
  heroImage,
}: Props) {
  const [selectedId, setSelectedId] = useState(spots[0].id);
  const [originId, setOriginId] = useState(spots[0].id);
  const [destinationId, setDestinationId] = useState(spots[1].id);
  const [travelMode, setTravelMode] = useState<TravelMode>("WALKING");
  const [routeRequestId, setRouteRequestId] = useState(0);
  const [hasRequestedRoute, setHasRequestedRoute] = useState(false);
  const [routeResult, setRouteResult] = useState<RouteResult>({ state: "idle" });

  const spotById = (id: string) => spots.find((spot) => spot.id === id);
  const selectedSpot = spotById(selectedId) ?? spots[0];
  const origin = spotById(originId) ?? spots[0];
  const destination = spotById(destinationId) ?? spots[1];

  const routeRequest = useMemo(
    () =>
      hasRequestedRoute
        ? {
            requestId: routeRequestId,
            origin,
            destination,
            travelMode,
          }
        : null,
    [
      destination,
      hasRequestedRoute,
      origin,
      routeRequestId,
      travelMode,
    ],
  );

  const handleRouteResult = useCallback((result: RouteResult) => {
    setRouteResult(result);
  }, []);

  function searchRoute() {
    if (originId === destinationId) {
      setRouteResult({
        state: "error",
        message: "出発地と目的地には、別のスポットを選んでください。",
      });
      return;
    }
    setHasRequestedRoute(true);
    setRouteRequestId((current) => current + 1);
    setSelectedId(destinationId);
  }

  function swapRoute() {
    setOriginId(destinationId);
    setDestinationId(originId);
    setRouteResult({ state: "idle" });
    setHasRequestedRoute(false);
  }

  return (
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
          <a href="#spots">スポット</a>
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
          <h1>
            好きな物語と、
            <br />
            <em>同じ景色</em>を歩こう。
          </h1>
          <p className="hero-lead">
            金沢から加賀まで、作品にまつわる場所をひとつの地図に。
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
          <div className="vertical-copy">ONE STORY · SEVEN PLACES</div>
        </div>
        <div className="hero-stats">
          <div>
            <strong>{spots.length}</strong>
            <span>SPOTS</span>
          </div>
          <div>
            <strong>4</strong>
            <span>AREAS</span>
          </div>
          <div>
            <strong>ROUTE</strong>
            <span>BY GOOGLE MAPS</span>
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
            出発地と目的地を指定すると、移動ルートを確認できます。
          </p>
        </div>

        <div className="map-layout">
          <div className="map-column">
            <GooglePilgrimageMap
              spots={spots}
              selectedId={selectedId}
              onSelect={setSelectedId}
              routeRequest={routeRequest}
              onRouteResult={handleRouteResult}
              apiKey={googleMapsConfig.apiKey}
              mapId={googleMapsConfig.mapId}
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
              </div>
              <button
                type="button"
                onClick={() => {
                  setDestinationId(selectedSpot.id);
                  document
                    .querySelector(".route-planner")
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              >
                目的地にする
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>

          <aside className="route-planner" aria-label="ルート検索">
            <div className="route-planner__heading">
              <div>
                <p>ROUTE PLANNER</p>
                <h3>巡礼ルートを検索</h3>
              </div>
              <span className="route-badge">Google Maps</span>
            </div>

            <div className="route-fields">
              <label>
                <span className="route-point route-point--start">S</span>
                <span className="field-copy">
                  <small>出発地</small>
                  <select
                    value={originId}
                    onChange={(event) => {
                      setOriginId(event.target.value);
                      setHasRequestedRoute(false);
                      setRouteResult({ state: "idle" });
                    }}
                  >
                    {spots.map((spot) => (
                      <option key={spot.id} value={spot.id}>
                        {spot.shortName}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <button
                className="swap-button"
                type="button"
                onClick={swapRoute}
                aria-label="出発地と目的地を入れ替える"
              >
                ⇅
              </button>
              <label>
                <span className="route-point route-point--goal">G</span>
                <span className="field-copy">
                  <small>目的地</small>
                  <select
                    value={destinationId}
                    onChange={(event) => {
                      setDestinationId(event.target.value);
                      setHasRequestedRoute(false);
                      setRouteResult({ state: "idle" });
                    }}
                  >
                    {spots.map((spot) => (
                      <option key={spot.id} value={spot.id}>
                        {spot.shortName}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            </div>

            <fieldset className="travel-modes">
              <legend>移動手段</legend>
              <div>
                {travelModes.map((mode) => (
                  <label key={mode.value}>
                    <input
                      type="radio"
                      name="travel-mode"
                      value={mode.value}
                      checked={travelMode === mode.value}
                      onChange={() => {
                        setTravelMode(mode.value);
                        setHasRequestedRoute(false);
                        setRouteResult({ state: "idle" });
                      }}
                    />
                    <span className="mode-icon">{mode.icon}</span>
                    <span>{mode.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <button
              className="route-search-button"
              type="button"
              onClick={searchRoute}
            >
              ルートを検索する
              <span aria-hidden="true">→</span>
            </button>

            <div
              className={`route-result route-result--${routeResult.state}`}
              aria-live="polite"
            >
              {routeResult.state === "idle" && (
                <>
                  <span className="result-symbol">＋</span>
                  <p>
                    2つのスポットを選ぶと、距離と所要時間を表示します。
                  </p>
                </>
              )}
              {routeResult.state === "loading" && (
                <>
                  <span className="result-symbol is-loading">◌</span>
                  <p>最適なルートを探しています…</p>
                </>
              )}
              {routeResult.state === "success" && (
                <>
                  <span className="result-symbol">✓</span>
                  <div className="result-metrics">
                    <span>
                      <small>距離</small>
                      <strong>{routeResult.distance ?? "—"}</strong>
                    </span>
                    <span>
                      <small>所要時間</small>
                      <strong>{routeResult.duration ?? "—"}</strong>
                    </span>
                  </div>
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
          </aside>
        </div>
      </section>

      <section className="spots-section" id="spots">
        <div className="section-heading">
          <div>
            <p className="section-number">02 — SPOT LIST</p>
            <h2>物語をたどる、{spots.length}つの場所</h2>
          </div>
          <p>
            今回はMVP用の初期スポットです。作品内の登場場面や比較写真は、
            場所リスト確定後に追加できます。
          </p>
        </div>

        <div className="spot-grid">
          {spots.map((spot, index) => {
            const imageUrl = spotImages[spot.id] ?? spot.imageUrl;
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
                <h3>{spot.name}</h3>
                <p>{spot.description}</p>
                <div className="spot-card__meta">
                  <span>{spot.accessNote}</span>
                  <span aria-hidden="true">↗</span>
                </div>
              </button>
              <a href={spot.sourceUrl} target="_blank" rel="noreferrer">
                施設・観光公式情報
                <span aria-hidden="true">↗</span>
              </a>
            </article>
          )})}
        </div>
      </section>

      <section className="guide-section" id="guide">
        <div className="guide-intro">
          <p className="section-number">03 — PILGRIMAGE NOTES</p>
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
  );
}
