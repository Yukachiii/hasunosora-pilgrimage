import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { spots, type PilgrimageSpot } from "../../app/spots";

type TrialPage = "explore" | "planner" | "today" | "guide";

type ModalState =
  | { kind: "guide"; src: string; alt: string }
  | { kind: "share" }
  | null;

const baseUrl = import.meta.env.BASE_URL;
const fallbackSpotIds = ["kanazawa-station", "ohmicho-market", "oyama-shrine", "kenrokuen"];
const fallbackDurations = [30, 55, 35, 75];
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
    description: "定番・コラボ・地図・カードから入口を選ぶ。",
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

function routeSpots() {
  return fallbackSpotIds
    .map((id) => spots.find((spot) => spot.id === id))
    .filter((spot): spot is PilgrimageSpot => Boolean(spot));
}

function spotPhoto(spot?: PilgrimageSpot) {
  return spot?.imageUrl ? assetUrl(spot.imageUrl) : assetUrl("photos/hero/20260806-074048-78b958e5201d8916-watermarked.webp");
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

function TrialHeader({ page, itineraryCount, onNavigate, onOpenShare }: {
  page: TrialPage;
  itineraryCount: number;
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
            <small>{page === "planner" ? "2026.09.12 / DAY 01" : page === "today" ? "TODAY / 09.12" : "USER GUIDE / JOURNEY 00"}</small>
          </div>
        )}
      </div>
      <nav className="ui-trial__desktop-nav" aria-label="テスト版メインナビゲーション">
        {(Object.keys(pageLabels) as TrialPage[]).map((navPage) => (
          <PageLink page={navPage} currentPage={page} onNavigate={onNavigate} key={navPage}>
            {pageLabels[navPage]}
            {navPage === "planner" && itineraryCount > 0 ? <b>{itineraryCount}</b> : null}
          </PageLink>
        ))}
      </nav>
      {page === "planner" ? (
        <button className="ui-trial__mobile-share" type="button" onClick={onOpenShare}>共有する <span aria-hidden="true">↗</span></button>
      ) : null}
      {page === "today" ? <strong className="ui-trial__mobile-progress">1 / {itineraryCount}</strong> : null}
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
    <nav className="ui-trial__mobile-nav" aria-label="テスト版スマートフォン用メニュー">
      {(Object.keys(pageLabels) as TrialPage[]).map((navPage) => (
        <PageLink page={navPage} currentPage={page} onNavigate={onNavigate} key={navPage}>
          {pageLabels[navPage]}
          {navPage === "planner" && itineraryCount > 0 ? <b>{itineraryCount}</b> : null}
        </PageLink>
      ))}
    </nav>
  );
}

function ExplorePage({ planned, onTogglePlanned, onNavigate }: {
  planned: PilgrimageSpot[];
  onTogglePlanned: (spot: PilgrimageSpot) => void;
  onNavigate: (page: TrialPage) => void;
}) {
  const featured = spots.find((spot) => spot.id === "kanazawa-station") ?? planned[0];
  const featuredIsPlanned = planned.some((spot) => spot.id === featured?.id);
  const [feedback, setFeedback] = useState("");
  const choices = [
    ["01", "定番", "登録スポット"],
    ["02", "コラボ", "開催中から"],
    ["03", "地図", "場所から"],
    ["04", "カード", "モデル地から"],
  ];

  return (
    <section className="ui-trial__page ui-trial__explore" aria-labelledby="ui-trial-explore-title">
      <div className="ui-trial__explore-copy">
        <p className="ui-trial__eyebrow">ISHIKAWA / KANAZAWA</p>
        <h1 id="ui-trial-explore-title">作品の景色を、<br />旅の予定へ。</h1>
        <p className="ui-trial__explore-lead">蓮ノ空に関連するスポットから、行きたい場所を見つけて、そのまま予定へ追加できます。</p>
        <label className="ui-trial__search">
          <span className="ui-trial__visually-hidden">スポットを検索</span>
          <input placeholder="場所・エリア・キーワードで探す" onChange={(event) => setFeedback(event.target.value ? `「${event.target.value}」で検索できます` : "")} />
          <span aria-hidden="true">⌕</span>
        </label>
        <h2>探し方を選ぶ</h2>
        <div className="ui-trial__choices">
          {choices.map(([number, label, note], index) => (
            <button
              className={index === 0 ? "is-active" : ""}
              type="button"
              key={number}
              onClick={() => setFeedback(`${label}の一覧を開く想定です`)}
            >
              <small>{number}</small>
              <strong>{label}</strong>
              <span>{note}</span>
              <i aria-hidden="true">→</i>
            </button>
          ))}
        </div>
        <div className="ui-trial__collaboration">
          <small>NOW IN ISHIKAWA</small>
          <h2>石川県コラボ第5弾</h2>
          <p>おいでよ！石川大観光Ⅱ　/　2026.08.10 → 12.06</p>
          <button type="button" onClick={() => setFeedback("対象スポットを表示する想定です")}>対象スポットを見る <span aria-hidden="true">→</span></button>
        </div>
        {feedback ? <p className="ui-trial__feedback" role="status">{feedback}</p> : null}
      </div>

      <div className="ui-trial__feature">
        <img src={assetUrl("photos/hero/20260806-074048-78b958e5201d8916-watermarked.webp")} alt="金沢の神社にある鳥居と階段" />
        <div className="ui-trial__feature-title">
          <small>ISHIKAWA / KANAZAWA</small>
          <h2>景色を、旅の予定へ。</h2>
        </div>
        {featured ? (
          <article>
            <small>FEATURED SPOT / 01</small>
            <h2>{featured.name}</h2>
            <p>{featured.area}　·　{featured.category}</p>
            <p>{featured.description}</p>
            <button type="button" onClick={() => onTogglePlanned(featured)}>
              {featuredIsPlanned ? "予定から外す" : "予定に追加"} <span aria-hidden="true">{featuredIsPlanned ? "−" : "+"}</span>
            </button>
          </article>
        ) : null}
      </div>
      <button className="ui-trial__explore-plan-link" type="button" onClick={() => onNavigate("planner")}>予定を確認する</button>
    </section>
  );
}

function AbstractRouteMap({ stopCount }: { stopCount: number }) {
  return (
    <div className="ui-trial__route-map" aria-label={`${stopCount}地点のルート地図イメージ`}>
      <small>ROUTE MAP</small>
      <div className="ui-trial__map-grid" aria-hidden="true" />
      <div className="ui-trial__map-river" aria-hidden="true" />
      <svg viewBox="0 0 100 70" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="12,16 42,34 69,22 90,52" />
      </svg>
      {[1, 2, 3, 4].slice(0, Math.max(1, Math.min(4, stopCount))).map((number) => (
        <span className={`ui-trial__map-pin ui-trial__map-pin--${number}`} key={number}>{number}</span>
      ))}
    </div>
  );
}

function PlannerStops({ planned, onReorder }: {
  planned: PilgrimageSpot[];
  onReorder: (from: number, to: number) => void;
}) {
  const draggedIndex = useRef<number | null>(null);
  return (
    <ol className="ui-trial__stop-list">
      {planned.map((spot, index) => (
        <li
          key={spot.id}
          draggable
          onDragStart={() => { draggedIndex.current = index; }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            if (draggedIndex.current !== null) onReorder(draggedIndex.current, index);
            draggedIndex.current = null;
          }}
        >
          <span>{index + 1}</span>
          <time>{["10:00", "10:42", "12:18", "14:05"][index] ?? "15:30"}</time>
          <div>
            <strong>{spot.name}</strong>
            <small>{index === 0 ? "START" : `${fallbackDurations[index] ?? 45}分`}</small>
          </div>
          <button type="button" aria-label={`${spot.name}を並べ替え`} title="ドラッグして並べ替え">☷</button>
        </li>
      ))}
    </ol>
  );
}

function PlannerPage({ planned, onReorder, onOpenShare }: {
  planned: PilgrimageSpot[];
  onReorder: (from: number, to: number) => void;
  onOpenShare: () => void;
}) {
  const [calculated, setCalculated] = useState(false);
  return (
    <section className="ui-trial__page ui-trial__planner" aria-labelledby="ui-trial-planner-title">
      <div className="ui-trial__planner-summary">
        <p className="ui-trial__eyebrow">JOURNEY PLAN / DAY 01</p>
        <h1 id="ui-trial-planner-title">9月12日の旅程</h1>
        <p>{planned.length}スポット　·　10:00 → 16:20</p>
        <article className="ui-trial__planner-list-card">
          <h2>訪問順</h2>
          <PlannerStops planned={planned} onReorder={onReorder} />
          <button type="button">＋ スポットを追加</button>
        </article>
      </div>

      <AbstractRouteMap stopCount={planned.length} />

      <aside className="ui-trial__planner-controls">
        <div className="ui-trial__mobile-sheet-handle" aria-hidden="true" />
        <small>{planned.length}スポット　·　10:00 → 16:20</small>
        <h2>予定を整える</h2>
        <p>必要なところだけ変更できます。</p>
        <div className="ui-trial__mobile-planner-stops">
          <PlannerStops planned={planned} onReorder={onReorder} />
        </div>
        <div className="ui-trial__planner-fields">
          <label><span>訪問日</span><input type="date" defaultValue="2026-09-12" /></label>
          <label><span>出発時刻</span><input type="time" defaultValue="10:00" /></label>
          <label><span>移動手段</span><select defaultValue="TRANSIT"><option value="TRANSIT">公共交通</option><option value="WALKING">徒歩</option><option value="DRIVING">車</option></select></label>
          <label><span>出発駅</span><select defaultValue="kanazawa"><option value="kanazawa">金沢駅</option></select></label>
        </div>
        <button className="ui-trial__calculate" type="button" onClick={() => setCalculated(true)}>移動時間を計算する <span aria-hidden="true">→</span></button>
        {calculated ? <p className="ui-trial__calculated" role="status"><small>予想</small><strong>移動 1時間42分</strong><span>滞在込み　6時間20分</span></p> : null}
        <button className="ui-trial__planner-share-link" type="button" onClick={onOpenShare}>この予定を共有</button>
      </aside>
    </section>
  );
}

function TodayPage({ planned }: { planned: PilgrimageSpot[] }) {
  const [activeIndex, setActiveIndex] = useState(Math.min(2, Math.max(0, planned.length - 1)));
  const activeSpot = planned[activeIndex];
  const completedCount = Math.min(activeIndex, planned.length);
  const mapsUrl = activeSpot
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(activeSpot.address)}`
    : "https://www.google.com/maps";

  return (
    <section className="ui-trial__page ui-trial__today" aria-labelledby="ui-trial-today-title">
      <div className="ui-trial__today-main">
        <p className="ui-trial__eyebrow">TODAY / 2026.09.12</p>
        <h1 id="ui-trial-today-title">今日の巡礼</h1>
        <p>現在 11:38　·　{Math.min(completedCount, planned.length)} / {planned.length} 訪問済み</p>
        <div className="ui-trial__progress"><span style={{ width: `${planned.length ? (completedCount / planned.length) * 100 : 0}%` }} /></div>
        {activeSpot ? (
          <article className="ui-trial__next-spot">
            <small>NEXT SPOT / 12:18到着予定</small>
            <h2>{activeSpot.name}</h2>
            <p>{activeSpot.address}</p>
            <span>営業時間内</span>
            <img src={spotPhoto(activeSpot)} alt={`${activeSpot.name}の写真`} />
            <div>
              <a href={mapsUrl} target="_blank" rel="noreferrer">Google Mapsで向かう <span aria-hidden="true">↗</span></a>
              <button
                type="button"
                onClick={() => setActiveIndex((current) => Math.min(planned.length - 1, current + 1))}
                disabled={activeIndex >= planned.length - 1}
              >
                {activeIndex >= planned.length - 1 ? "最後のスポットです" : "訪問済みにする ✓"}
              </button>
              <small>滞在 {fallbackDurations[activeIndex] ?? 45}分　/　13:03 出発</small>
            </div>
          </article>
        ) : <p>予定にスポットがありません。</p>}
      </div>

      <aside className="ui-trial__today-route">
        <h2>本日のルート</h2>
        <ol>
          {planned.map((spot, index) => (
            <li className={index < activeIndex ? "is-complete" : index === activeIndex ? "is-current" : ""} key={spot.id}>
              <span>{index < activeIndex ? "✓" : index + 1}</span>
              <time>{["10:00", "10:42", "12:18", "14:05"][index] ?? "15:30"}</time>
              <strong>{spot.name}</strong>
              <small>{index < activeIndex ? "訪問済み" : `${fallbackDurations[index] ?? 45}分`}</small>
            </li>
          ))}
        </ol>
        <div><strong>当日の調整</strong><p>遅れた分だけ、この予定を現在時刻に合わせられます。</p></div>
      </aside>
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

function TrialModal({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!modal) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
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
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [modal, onClose]);
  if (!modal) return null;
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
            <p>この画面はテスト版です。共有時は本番の予定URLが生成されます。</p>
            <label><span>共有URL</span><input readOnly value="https://example.test/shared-plan" /></label>
            <button type="button" onClick={onClose}>確認しました</button>
          </div>
        )}
      </section>
    </div>
  );
}

export function UiTrialApp() {
  const [page, setPage] = useState<TrialPage>("explore");
  const [planned, setPlanned] = useState(routeSpots);
  const [modal, setModal] = useState<ModalState>(null);
  const closeModal = useMemo(() => () => setModal(null), []);

  const navigate = (nextPage: TrialPage) => {
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const togglePlanned = (spot: PilgrimageSpot) => {
    setPlanned((current) => current.some((item) => item.id === spot.id)
      ? current.filter((item) => item.id !== spot.id)
      : [...current, spot]);
  };
  const reorder = (from: number, to: number) => {
    setPlanned((current) => {
      if (from === to || !current[from] || !current[to]) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  return (
    <div className={`ui-trial ui-trial--${page}`}>
      <TrialHeader page={page} itineraryCount={planned.length} onNavigate={navigate} onOpenShare={() => setModal({ kind: "share" })} />
      <main>
        {page === "explore" ? <ExplorePage planned={planned} onTogglePlanned={togglePlanned} onNavigate={navigate} /> : null}
        {page === "planner" ? <PlannerPage planned={planned} onReorder={reorder} onOpenShare={() => setModal({ kind: "share" })} /> : null}
        {page === "today" ? <TodayPage planned={planned} /> : null}
        {page === "guide" ? <GuidePage onNavigate={navigate} onOpenImage={(src, alt) => setModal({ kind: "guide", src, alt })} /> : null}
      </main>
      <TrialNavigation page={page} itineraryCount={planned.length} onNavigate={navigate} />
      <TrialModal modal={modal} onClose={closeModal} />
    </div>
  );
}
