export type SpotCategory =
  | "交通"
  | "まち歩き"
  | "眺望"
  | "宿泊"
  | "甘味"
  | "海辺"
  | "文化";

export type PilgrimageSpot = {
  id: string;
  name: string;
  shortName: string;
  area: string;
  category: SpotCategory;
  address: string;
  lat: number;
  lng: number;
  description: string;
  accessNote: string;
  sourceUrl: string;
  imageUrl?: string;
  imagePosition?: string;
};

export const spots: PilgrimageSpot[] = [
  {
    id: "kanazawa-station",
    name: "金沢駅",
    shortName: "金沢駅",
    area: "金沢",
    category: "交通",
    address: "石川県金沢市木ノ新保町1-1",
    lat: 36.5781,
    lng: 136.6481,
    description:
      "旅の起点にしやすい金沢の玄関口。ほかのスポットへ向かう前に、交通手段と帰りの時間を確認しておきましょう。",
    accessNote: "鉄道・路線バス",
    sourceUrl:
      "https://www4.city.kanazawa.lg.jp/soshikikarasagasu/dorokanrika/gyomuannai/30/28323.html",
    imageUrl: "/photos/kanazawa-station/20260724-230203-watermarked.webp",
    imagePosition: "center center",
  },
  {
    id: "ohmicho-market",
    name: "近江町市場",
    shortName: "近江町市場",
    area: "金沢",
    category: "まち歩き",
    address: "石川県金沢市上近江町50",
    lat: 36.571665,
    lng: 136.656146,
    description:
      "金沢の食文化に触れられる市場。通行や営業の妨げにならないよう、撮影時は周囲への配慮を忘れずに。",
    accessNote: "金沢駅から徒歩約12分",
    sourceUrl:
      "https://www.kanazawa-kankoukyoukai.or.jp/spot/detail_10030.html",
  },
  {
    id: "utatsuyama-viewpoint",
    name: "見晴らし台（卯辰山公園）",
    shortName: "卯辰山 見晴らし台",
    area: "金沢",
    category: "眺望",
    address: "石川県金沢市東御影町 卯辰山公園内",
    lat: 36.567969,
    lng: 136.677228,
    description:
      "金沢のまちなかから山並みまで見渡せる展望芝生広場。天候と足元を確認して訪れたいスポットです。",
    accessNote: "卯辰山公園バス停から徒歩約3分",
    sourceUrl:
      "https://www.kanazawa-kankoukyoukai.or.jp/spot/detail_50344.html",
  },
  {
    id: "yunokuni-tensyo",
    name: "加賀 山代温泉 ゆのくに天祥",
    shortName: "ゆのくに天祥",
    area: "加賀",
    category: "宿泊",
    address: "石川県加賀市山代温泉19-49-1",
    lat: 36.2887,
    lng: 136.3604,
    description:
      "山代温泉にある宿泊施設。作品との公式コラボ情報もあるため、訪問前に最新の実施内容を公式サイトで確認しましょう。",
    accessNote: "JR加賀温泉駅から送迎バス約15分",
    sourceUrl: "https://yunokunitensyo.jp/0/",
  },
  {
    id: "matsubaya",
    name: "御菓子司 松葉屋",
    shortName: "松葉屋",
    area: "小松",
    category: "甘味",
    address: "石川県小松市大文字町69",
    lat: 36.4018,
    lng: 136.4494,
    description:
      "栗蒸し羊羹「月よみ山路」で知られる小松の和菓子店。営業時間を確認し、お店の方やほかのお客様へ配慮して訪れましょう。",
    accessNote: "小松駅から徒歩約7分",
    sourceUrl: "https://www.matsubaya.jp/access.html",
  },
  {
    id: "toku-mitsu-coast",
    name: "徳光海岸（徳光海水浴場）",
    shortName: "徳光海岸",
    area: "白山",
    category: "海辺",
    address: "石川県白山市徳光町",
    lat: 36.540829,
    lng: 136.533748,
    description:
      "日本海を望む松任海浜公園に隣接した海岸。季節や天候で状況が変わるため、現地の案内に従って行動してください。",
    accessNote: "車での訪問が便利",
    sourceUrl: "https://www.hot-ishikawa.jp/spot/detail_5910.html",
  },
  {
    id: "ohno-karakuri",
    name: "石川県金沢港 大野からくり記念館",
    shortName: "大野からくり記念館",
    area: "金沢港",
    category: "文化",
    address: "石川県金沢市大野町4丁目甲2番29",
    lat: 36.619005,
    lng: 136.6018,
    description:
      "大野弁吉の業績とからくりの世界に触れられる記念館。開館日と最終入館時刻を確認してから向かいましょう。",
    accessNote: "金沢駅から車で約20分",
    sourceUrl: "https://www.ohno-karakuri.jp/",
  },
];

export const spotById = (id: string) => spots.find((spot) => spot.id === id);
