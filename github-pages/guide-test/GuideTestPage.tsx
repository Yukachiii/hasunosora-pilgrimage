import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { parsePlannerDraftCookie } from "../../app/planner-storage";
import { spots } from "../../app/spots";

type GuideImage = {
  src: string;
  alt: string;
  label: string;
};

type GuideStep = {
  number: string;
  title: string;
  description: string;
  detail: string;
  images: GuideImage[];
};

const baseUrl = import.meta.env.BASE_URL;

const guideSteps: GuideStep[] = [
  {
    number: "01",
    title: "探し方を選ぶ",
    description: "定番スポット、開催中のコラボ、地図、カード。目的に合う入口から、行きたい場所を見つけます。",
    detail: "探す",
    images: [
      {
        src: `${baseUrl}guide/02-choose-method.png`,
        alt: "探し方を選ぶ画面",
        label: "入口",
      },
    ],
  },
  {
    number: "02",
    title: "行きたい場所を追加する",
    description: "スポットやカードで気になる場所を見つけたら、「予定に追加」。件数は下の予定タブで確認できます。",
    detail: "追加",
    images: [
      {
        src: `${baseUrl}guide/03-add-spots.png`,
        alt: "スポット一覧から場所を選ぶ画面",
        label: "スポット",
      },
      {
        src: `${baseUrl}guide/07-card-search.png`,
        alt: "カードからモデル地を選ぶ画面",
        label: "カード",
      },
    ],
  },
  {
    number: "03",
    title: "場所と時間を整える",
    description: "訪問順、滞在時間、移動手段、訪問日を調整。無理のない一日の形に整えます。",
    detail: "予定",
    images: [
      {
        src: `${baseUrl}guide/04-plan-stops.png`,
        alt: "訪問するスポットと滞在時間を編集する画面",
        label: "場所",
      },
      {
        src: `${baseUrl}guide/05-plan-time.png`,
        alt: "移動手段と訪問日時を設定する画面",
        label: "日時",
      },
    ],
  },
  {
    number: "04",
    title: "計算して、当日は見るだけ",
    description: "予定を計算したら準備完了。当日は次の訪問先と時刻を確認しながら進みます。",
    detail: "当日",
    images: [
      {
        src: `${baseUrl}guide/06-plan-check.png`,
        alt: "予定内容を確認して計算する画面",
        label: "確認",
      },
    ],
  },
];

function currentItineraryCount(): number {
  const snapshot = parsePlannerDraftCookie(
    document.cookie,
    new Set(spots.map((spot) => spot.id)),
  );
  if (!snapshot) return 0;
  return new Set(snapshot.plannerDays.flatMap((day) => day.itineraryIds)).size;
}

function AppLink({ page, children, className }: {
  page: "explore" | "planner" | "today" | "guide";
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <a className={className} href={`${baseUrl}#/${page}`}>
      {children}
    </a>
  );
}

function GuideHeader({ itineraryCount }: { itineraryCount: number }): ReactElement {
  return (
    <header className="guide-test__header">
      <AppLink page="explore" className="guide-test__brand">
        <span className="guide-test__brand-mark" aria-hidden="true">蓮</span>
        <span>
          <strong>蓮ノ旅</strong>
          <small>HASUNOSORA PILGRIMAGE GUIDE</small>
        </span>
      </AppLink>

      <nav className="guide-test__desktop-nav" aria-label="メインナビゲーション">
        <AppLink page="explore">探す</AppLink>
        <AppLink page="planner">
          予定
          {itineraryCount > 0 ? <b>{itineraryCount}</b> : null}
        </AppLink>
        <AppLink page="today">当日</AppLink>
        <a href="#guide-test-main" aria-current="page">ガイド</a>
      </nav>

      <a
        className="guide-test__official"
        href="https://www.lovelive-anime.jp/hasunosora/"
        target="_blank"
        rel="noreferrer"
      >
        作品公式サイト <span aria-hidden="true">↗</span>
      </a>
    </header>
  );
}

function GuideHero(): ReactElement {
  return (
    <section className="guide-test__hero" aria-labelledby="guide-test-title">
      <div className="guide-test__hero-copy">
        <p className="guide-test__eyebrow">USER GUIDE <i /> JOURNEY 00</p>
        <h1 id="guide-test-title">旅の準備は、<br />4つだけ。</h1>
        <strong>探す → 予定を組む → 当日使う。</strong>
        <p>迷わないための最短ルートを、旅のしおりのようにまとめました。</p>
      </div>

      <aside className="guide-test__start" aria-label="ガイドの概要">
        <small>KANAZAWA / HASUNOSORA</small>
        <h2>START HERE</h2>
        <ol aria-label="4つの準備">
          <li><span>01</span><em>探す</em></li>
          <li><span>02</span><em>追加</em></li>
          <li><span>03</span><em>整える</em></li>
          <li><span>04</span><em>出発</em></li>
        </ol>
        <AppLink page="explore" className="guide-test__start-cta">
          探すから始める <span aria-hidden="true">→</span>
        </AppLink>
      </aside>
    </section>
  );
}

function GuideJourney({ onSelectImage }: {
  onSelectImage: (image: GuideImage) => void;
}): ReactElement {
  return (
    <section className="guide-test__journey" aria-label="基本的な使い方">
      <div className="guide-test__route" aria-hidden="true" />
      {guideSteps.map((step, index) => (
        <article
          className={`guide-test__step${index % 2 === 1 ? " guide-test__step--reverse" : ""}`}
          key={step.number}
        >
          <span className="guide-test__number" aria-hidden="true">{step.number}</span>
          <div className="guide-test__step-copy">
            <small>STEP {step.number}</small>
            <h2>{step.title}</h2>
            <p>{step.description}</p>
            <span>詳しく見る <i aria-hidden="true">↗</i></span>
          </div>
          <div className={`guide-test__screens${step.images.length > 1 ? " guide-test__screens--double" : ""}`}>
            {step.images.map((image) => (
              <button
                type="button"
                className="guide-test__screen"
                key={image.src}
                onClick={() => onSelectImage(image)}
                aria-label={`${image.alt}を拡大表示`}
              >
                <img src={image.src} alt={image.alt} loading="lazy" decoding="async" />
                <span>{image.label}</span>
              </button>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

function GuideNotice(): ReactElement {
  return (
    <section className="guide-test__notice" aria-labelledby="guide-test-notice-title">
      <div>
        <small>BEFORE YOUR VISIT</small>
        <h2 id="guide-test-notice-title">訪れるときのお願い</h2>
      </div>
      <ul>
        <li>地域の方やお店、通行する方への配慮を忘れず、立入りや撮影は各施設の案内に従ってください。</li>
        <li>営業時間・交通・天候などは変わるため、出発前に公式情報も確認してください。</li>
        <li>旅程と所要時間は目安です。現地の状況に合わせて、無理のない予定でお楽しみください。</li>
      </ul>
    </section>
  );
}

function GuideMobileNavigation({ itineraryCount }: { itineraryCount: number }): ReactElement {
  return (
    <nav className="guide-test__mobile-nav" aria-label="スマートフォン用メニュー">
      <AppLink page="explore">探す</AppLink>
      <AppLink page="planner">
        予定
        {itineraryCount > 0 ? <b>{itineraryCount}</b> : null}
      </AppLink>
      <AppLink page="today">当日</AppLink>
      <a href="#guide-test-main" aria-current="page">ガイド</a>
    </nav>
  );
}

function GuideImageModal({ image, closeButtonRef, onClose }: {
  image: GuideImage;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}): ReactElement {
  return (
    <div
      className="guide-test__modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="guide-test__modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-test-modal-title"
      >
        <header>
          <strong id="guide-test-modal-title">{image.alt}</strong>
          <button ref={closeButtonRef} type="button" onClick={onClose}>
            <span aria-hidden="true">×</span>
            <span className="guide-test__visually-hidden">閉じる</span>
          </button>
        </header>
        <figure>
          <img src={image.src} alt={image.alt} />
        </figure>
      </section>
    </div>
  );
}

type GuideImageModalState = {
  activeImage: GuideImage | null;
  setActiveImage: Dispatch<SetStateAction<GuideImage | null>>;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
};

function useGuideImageModal(): GuideImageModalState {
  const [activeImage, setActiveImage] = useState<GuideImage | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!activeImage) return undefined;
    const previousOverflow = document.body.style.overflow;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveImage(null);
      if (event.key === "Tab") {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [activeImage]);

  return { activeImage, setActiveImage, closeButtonRef };
}

export function GuideTestPage(): ReactElement {
  const { activeImage, setActiveImage, closeButtonRef } = useGuideImageModal();
  const [itineraryCount] = useState(currentItineraryCount);

  return (
    <div className="guide-test">
      <GuideHeader itineraryCount={itineraryCount} />

      <main id="guide-test-main">
        <GuideHero />
        <GuideJourney onSelectImage={setActiveImage} />
        <GuideNotice />

        <p className="guide-test__source">
          画面内のカード画像：©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ
        </p>
      </main>

      <GuideMobileNavigation itineraryCount={itineraryCount} />

      {activeImage ? (
        <GuideImageModal
          image={activeImage}
          closeButtonRef={closeButtonRef}
          onClose={() => setActiveImage(null)}
        />
      ) : null}
    </div>
  );
}
