import type { PilgrimageSpot, SpotCategory } from "./spots";

export type TravelMode = "WALKING" | "DRIVING" | "TRANSIT" | "BICYCLING";

// Compute Routes supports an origin, a destination, and up to 25 intermediates.
export const maximumItineraryStops = 27;

export type RouteLocation = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
};

export type MajorStation = RouteLocation & {
  region: string;
};

export const majorStations: MajorStation[] = [
  { id: "tokyo", name: "東京駅", region: "関東", address: "東京都千代田区丸の内1丁目 東京駅", lat: 35.681236, lng: 139.767125 },
  { id: "omiya", name: "大宮駅", region: "関東", address: "埼玉県さいたま市大宮区錦町 大宮駅", lat: 35.906357, lng: 139.623181 },
  { id: "sendai", name: "仙台駅", region: "東北", address: "宮城県仙台市青葉区中央1丁目 仙台駅", lat: 38.260132, lng: 140.882438 },
  { id: "nagoya", name: "名古屋駅", region: "東海", address: "愛知県名古屋市中村区名駅1丁目 名古屋駅", lat: 35.170915, lng: 136.881537 },
  { id: "kyoto", name: "京都駅", region: "関西", address: "京都府京都市下京区東塩小路釜殿町 京都駅", lat: 34.985849, lng: 135.758767 },
  { id: "osaka", name: "大阪駅", region: "関西", address: "大阪府大阪市北区梅田3丁目 大阪駅", lat: 34.702485, lng: 135.495951 },
  { id: "shin-osaka", name: "新大阪駅", region: "関西", address: "大阪府大阪市淀川区西中島5丁目 新大阪駅", lat: 34.733465, lng: 135.500247 },
  { id: "toyama", name: "富山駅", region: "北陸", address: "富山県富山市明輪町 富山駅", lat: 36.701384, lng: 137.213091 },
  { id: "fukui", name: "福井駅", region: "北陸", address: "福井県福井市中央1丁目 福井駅", lat: 36.062139, lng: 136.223394 },
  { id: "hiroshima", name: "広島駅", region: "中国", address: "広島県広島市南区松原町 広島駅", lat: 34.397385, lng: 132.475993 },
  { id: "hakata", name: "博多駅", region: "九州", address: "福岡県福岡市博多区博多駅中央街 博多駅", lat: 33.590241, lng: 130.420622 },
];

const categoryStayMinutes: Record<SpotCategory, number> = {
  "交通": 15,
  "まち歩き": 30,
  "眺望": 25,
  "宿泊": 60,
  "甘味": 40,
  "海辺": 30,
  "文化": 60,
  "飲食": 60,
  "買い物": 35,
  "レジャー": 90,
  "寺社": 35,
};

export function recommendedStayMinutes(spot: PilgrimageSpot) {
  const configured = spot.recommendedStayMinutes;
  if (Number.isFinite(configured) && configured! >= 0) {
    return Math.min(480, Math.round(configured!));
  }
  return categoryStayMinutes[spot.category];
}

export function formatDuration(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (!hours) return `${remainder}分`;
  if (!remainder) return `${hours}時間`;
  return `${hours}時間${remainder}分`;
}

const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];

export type OpeningHoursStatus = {
  kind: "open" | "warning" | "unknown";
  label: string;
};

export function formatOpeningHours(spot: PilgrimageSpot) {
  const hours = spot.openingTime && spot.closingTime
    ? `${spot.openingTime}–${spot.closingTime}`
    : "営業時間 要公式確認";
  const closed = spot.closedWeekdays?.length
    ? `休：${spot.closedWeekdays.map((day) => weekdayLabels[day]).filter(Boolean).join("・")}`
    : "";
  return [hours, closed].filter(Boolean).join(" / ");
}

export function openingHoursStatus(
  spot: PilgrimageSpot,
  visitDate: string,
  arrivalMinutes: number,
): OpeningHoursStatus {
  const [year, month, day] = visitDate.split("-").map(Number);
  const dayOffset = Math.floor(arrivalMinutes / 1440);
  const arrivalDate = new Date(Date.UTC(year, month - 1, day + dayOffset));
  const weekday = arrivalDate.getUTCDay();

  if (spot.closedWeekdays?.includes(weekday)) {
    return { kind: "warning", label: "設定上の休業日です" };
  }
  if (!spot.openingTime || !spot.closingTime) {
    return { kind: "unknown", label: "営業時間は公式情報を確認" };
  }

  const normalizedArrival = ((arrivalMinutes % 1440) + 1440) % 1440;
  const opening = timeValueToMinutes(spot.openingTime);
  const closing = timeValueToMinutes(spot.closingTime);
  if (normalizedArrival < opening) {
    return { kind: "warning", label: `${spot.openingTime}の営業開始前です` };
  }
  if (normalizedArrival >= closing) {
    return { kind: "warning", label: `${spot.closingTime}の営業終了後です` };
  }
  return { kind: "open", label: "営業時間内の予定です" };
}

function timeValueToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}
