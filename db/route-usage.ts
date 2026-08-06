import type { TravelMode } from "@/app/route-planner";
import type {
  RouteUsageByMode,
  RouteUsageDaily,
  RouteUsageSummary,
  RouteUsageTotals,
} from "@/app/admin/route-usage-types";
import { getD1Database } from ".";

type UsageStatus = "success" | "error";

export type RouteUsageEvent = {
  travelMode: TravelMode;
  status: UsageStatus;
  googleRequestCount: number;
  responseTimeMs: number;
  errorCode?: string;
};

type AggregateRow = {
  calculations: number | string | null;
  apiRequests: number | string | null;
  successful: number | string | null;
  failed: number | string | null;
  averageResponseTimeMs: number | string | null;
};

type DailyRow = AggregateRow & { date: string };
type ModeRow = AggregateRow & { travelMode: string };

const tokyoFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function tokyoDayKey(date: Date) {
  const parts = Object.fromEntries(
    tokyoFormatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function lastDayKeys(today: string, count: number) {
  const [year, month, day] = today.split("-").map(Number);
  const anchor = Date.UTC(year, month - 1, day);
  return Array.from({ length: count }, (_, index) =>
    new Date(anchor - (count - index - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
}

function numberValue(value: number | string | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function totals(row?: AggregateRow): RouteUsageTotals {
  return {
    calculations: numberValue(row?.calculations),
    apiRequests: numberValue(row?.apiRequests),
    successful: numberValue(row?.successful),
    failed: numberValue(row?.failed),
    averageResponseTimeMs: Math.round(numberValue(row?.averageResponseTimeMs)),
  };
}

const aggregateColumns = `
  COUNT(*) AS calculations,
  COALESCE(SUM(google_request_count), 0) AS apiRequests,
  COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successful,
  COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS failed,
  COALESCE(AVG(response_time_ms), 0) AS averageResponseTimeMs
`;

export async function recordRouteApiUsage(event: RouteUsageEvent) {
  try {
    const database = await getD1Database();
    const occurredAt = new Date();
    const dayKey = tokyoDayKey(occurredAt);
    await database
      .prepare(`INSERT INTO route_api_usage (
        id, occurred_at, day_key, month_key, travel_mode, status,
        google_request_count, response_time_ms, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        occurredAt.toISOString(),
        dayKey,
        dayKey.slice(0, 7),
        event.travelMode,
        event.status,
        Math.max(0, Math.trunc(event.googleRequestCount)),
        Math.max(0, Math.trunc(event.responseTimeMs)),
        event.errorCode ?? null,
      )
      .run();
  } catch (error) {
    // Usage logging must never turn a successful route search into an error.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_UNSUPPORTED_ESM_URL_SCHEME"
    ) {
      return;
    }
    console.error("Failed to record Routes API usage", error);
  }
}

export async function getRouteApiUsageSummary(): Promise<RouteUsageSummary> {
  const database = await getD1Database();
  const now = new Date();
  const todayKey = tokyoDayKey(now);
  const monthKey = todayKey.slice(0, 7);
  const dayKeys = lastDayKeys(todayKey, 14);

  const [monthResult, dailyResult, modeResult] = await Promise.all([
    database
      .prepare(`SELECT ${aggregateColumns}
        FROM route_api_usage WHERE month_key = ?`)
      .bind(monthKey)
      .first<AggregateRow>(),
    database
      .prepare(`SELECT day_key AS date, ${aggregateColumns}
        FROM route_api_usage
        WHERE day_key >= ? AND day_key <= ?
        GROUP BY day_key ORDER BY day_key ASC`)
      .bind(dayKeys[0], todayKey)
      .all<DailyRow>(),
    database
      .prepare(`SELECT travel_mode AS travelMode, ${aggregateColumns}
        FROM route_api_usage
        WHERE month_key = ?
        GROUP BY travel_mode ORDER BY apiRequests DESC`)
      .bind(monthKey)
      .all<ModeRow>(),
  ]);

  const dailyRows = new Map(
    (dailyResult.results ?? []).map((row) => [row.date, row]),
  );
  const daily: RouteUsageDaily[] = dayKeys.map((date) => ({
    date,
    ...totals(dailyRows.get(date)),
  }));
  const byMode: RouteUsageByMode[] = (modeResult.results ?? []).map((row) => ({
    travelMode: row.travelMode as TravelMode,
    ...totals(row),
  }));

  return {
    available: true,
    generatedAt: now.toISOString(),
    timeZone: "Asia/Tokyo",
    today: totals(dailyRows.get(todayKey)),
    currentMonth: totals(monthResult ?? undefined),
    daily,
    byMode,
  };
}
