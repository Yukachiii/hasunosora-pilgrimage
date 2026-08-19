import type { RouteLocation } from "./route-planner";
import type { PilgrimageSpot } from "./spots";

export type YahooTransitLeg = {
  id: string;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  date: string;
  time: string;
};

const assumedTravelMinutes = 60;

function clockMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 9) * 60
    + (Number.isFinite(minutes) ? minutes : 0);
}

function dateAfterDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function provisionalDeparture(value: string, totalMinutes: number) {
  const dayOffset = Math.floor(totalMinutes / 1440);
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  return {
    date: dateAfterDays(value, dayOffset),
    time: `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`,
  };
}

export function createYahooTransitLegs(
  stops: PilgrimageSpot[],
  accessOrigin: RouteLocation | undefined,
  visitDate: string,
  startTime: string,
  stayMinutes: Record<string, number>,
) {
  if (stops.length < 2) return [];

  const points = [
    ...(accessOrigin
      ? [{
          id: `station:${accessOrigin.id}`,
          label: accessOrigin.name,
          searchName: accessOrigin.name,
          stay: 0,
        }]
      : []),
    ...stops.map((spot) => ({
      id: `spot:${spot.id}`,
      label: spot.shortName,
      searchName: spot.transitSearchName,
      stay: stayMinutes[spot.id] ?? 0,
    })),
  ];

  let cursor = clockMinutes(startTime);
  if (!accessOrigin) cursor += points[0].stay;

  return points.slice(0, -1).map((point, index): YahooTransitLeg => {
    const next = points[index + 1];
    const departure = provisionalDeparture(visitDate, cursor);
    const leg = {
      id: `${point.id}>${next.id}`,
      from: point.searchName,
      to: next.searchName,
      fromLabel: point.label,
      toLabel: next.label,
      ...departure,
    };
    cursor += assumedTravelMinutes + next.stay;
    return leg;
  });
}

export function buildYahooTransitUrl(
  leg: Pick<YahooTransitLeg, "from" | "to" | "date" | "time">,
) {
  const [year, month, day] = leg.date.split("-");
  const [hour, minute = "00"] = leg.time.split(":");
  const paddedMinute = minute.padStart(2, "0").slice(0, 2);
  const params = new URLSearchParams({
    from: leg.from,
    to: leg.to,
    y: year,
    m: month,
    d: day,
    hh: hour.padStart(2, "0"),
    m1: paddedMinute[0],
    m2: paddedMinute[1],
    type: "1",
    ticket: "ic",
    expkind: "1",
    userpass: "1",
    ws: "3",
    s: "0",
    al: "1",
    shin: "1",
    ex: "1",
    hb: "1",
    lb: "1",
    sr: "1",
  });
  return `https://transit.yahoo.co.jp/search/result?${params.toString()}`;
}
