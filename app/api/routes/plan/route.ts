import { majorStations, type RouteLocation, type TravelMode } from "@/app/route-planner";
import type {
  ServerRoutePlanRequest,
  ServerRoutePlanResponse,
} from "@/app/route-api";
import { spots } from "@/app/spots";

export const dynamic = "force-dynamic";

const googleRoutesUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";
const fieldMask = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.legs.duration",
  "routes.polyline.encodedPolyline",
  "routes.optimizedIntermediateWaypointIndex",
].join(",");
const allowedModes = new Set<TravelMode>(["WALKING", "DRIVING", "TRANSIT", "BICYCLING"]);
const maximumRequestBytes = 16 * 1024;
const maximumStops = 10;
const requestWindowMs = 60_000;
const requestsPerWindow = 10;
const inFlightPlans = new Map<string, Promise<ServerRoutePlanResponse>>();
const requestCounters = new Map<string, { count: number; startedAt: number }>();

class RoutePlanError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "INVALID_REQUEST",
  ) {
    super(message);
  }
}

type GoogleRoute = {
  distanceMeters?: number;
  duration?: string;
  legs?: Array<{ duration?: string }>;
  polyline?: { encodedPolyline?: string };
  optimizedIntermediateWaypointIndex?: number[];
};

type GoogleRoutesResponse = {
  routes?: GoogleRoute[];
  error?: { message?: string };
};

type NormalizedPlan = ServerRoutePlanRequest & {
  stops: RouteLocation[];
  accessOrigin?: RouteLocation;
};

function requestOrigin(request: Request) {
  const origin = request.headers.get("origin")?.trim() ?? "";
  const configured = (process.env.ROUTE_API_ALLOWED_ORIGINS ?? "https://yukachiii.github.io")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origin) return "";
  return configured.includes(origin) || origin === new URL(request.url).origin ? origin : "";
}

function responseHeaders(request: Request) {
  const origin = requestOrigin(request);
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(origin
      ? {
          "access-control-allow-origin": origin,
          vary: "Origin",
        }
      : {}),
  };
}

function clientIdentifier(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function consumeRequestAllowance(request: Request) {
  const now = Date.now();
  const identifier = clientIdentifier(request);
  const current = requestCounters.get(identifier);
  if (!current || now - current.startedAt >= requestWindowMs) {
    requestCounters.set(identifier, { count: 1, startedAt: now });
    return;
  }
  if (current.count >= requestsPerWindow) {
    throw new RoutePlanError(
      "短時間に検索が集中しています。1分ほど待ってから再度お試しください。",
      429,
      "RATE_LIMITED",
    );
  }
  current.count += 1;
  if (requestCounters.size > 500) {
    for (const [key, value] of requestCounters) {
      if (now - value.startedAt >= requestWindowMs) requestCounters.delete(key);
    }
  }
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RoutePlanError(`${label}が正しくありません。`);
  }
  return value.trim();
}

function normalizeRequest(value: unknown): NormalizedPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutePlanError("ルート条件が正しくありません。");
  }
  const body = value as Partial<ServerRoutePlanRequest>;
  if (!Array.isArray(body.stopIds) || body.stopIds.length < 2 || body.stopIds.length > maximumStops) {
    throw new RoutePlanError(`スポットは2～${maximumStops}か所で指定してください。`);
  }
  const stopIds = body.stopIds.map((id) => requiredString(id, "スポット"));
  if (new Set(stopIds).size !== stopIds.length) {
    throw new RoutePlanError("同じスポットを重複して指定できません。");
  }
  const resolvedStops = stopIds.map((id) => spots.find((spot) => spot.id === id));
  if (resolvedStops.some((spot) => !spot)) {
    throw new RoutePlanError("登録されていないスポットが含まれています。");
  }
  if (!allowedModes.has(body.travelMode as TravelMode)) {
    throw new RoutePlanError("移動手段が正しくありません。");
  }
  const travelMode = body.travelMode as TravelMode;
  const departureTime = requiredString(body.departureTime, "出発日時");
  const departure = new Date(departureTime);
  if (Number.isNaN(departure.getTime())) {
    throw new RoutePlanError("出発日時が正しくありません。");
  }
  const maximumDeparture = Date.now() + 100 * 86_400_000;
  if (departure.getTime() > maximumDeparture || departure.getTime() < Date.now() - 86_400_000) {
    throw new RoutePlanError("出発日時は本日から100日以内で指定してください。");
  }
  const rawStayMinutes = body.stayMinutes;
  if (!rawStayMinutes || typeof rawStayMinutes !== "object" || Array.isArray(rawStayMinutes)) {
    throw new RoutePlanError("滞在時間が正しくありません。");
  }
  const stayMinutes = Object.fromEntries(stopIds.map((id) => {
    const minutes = Number(rawStayMinutes[id]);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 480) {
      throw new RoutePlanError("滞在時間は0～480分で指定してください。");
    }
    return [id, minutes];
  }));
  const sourceStationId = typeof body.sourceStationId === "string" && body.sourceStationId
    ? body.sourceStationId
    : undefined;
  const accessOrigin = sourceStationId
    ? majorStations.find((station) => station.id === sourceStationId)
    : undefined;
  if (sourceStationId && !accessOrigin) {
    throw new RoutePlanError("出発駅が正しくありません。");
  }
  return {
    stopIds,
    stops: resolvedStops as RouteLocation[],
    travelMode,
    optimizeWaypointOrder: travelMode !== "TRANSIT" && body.optimizeWaypointOrder === true,
    stayMinutes,
    sourceStationId,
    accessOrigin,
    departureTime: departure.toISOString(),
  };
}

function googleTravelMode(mode: TravelMode) {
  return new Map<TravelMode, string>([
    ["WALKING", "WALK"],
    ["DRIVING", "DRIVE"],
    ["TRANSIT", "TRANSIT"],
    ["BICYCLING", "BICYCLE"],
  ]).get(mode)!;
}

function waypoint(location: RouteLocation) {
  return {
    location: {
      latLng: {
        latitude: location.lat,
        longitude: location.lng,
      },
    },
  };
}

function durationSeconds(value?: string) {
  if (!value?.endsWith("s")) return 0;
  const seconds = Number(value.slice(0, -1));
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

async function computeGoogleRoute(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const response = await fetch(googleRoutesUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "x-goog-fieldmask": fieldMask,
    },
    body: JSON.stringify(body),
    signal,
  });
  const result = await response.json() as GoogleRoutesResponse;
  if (!response.ok) {
    console.error("Google Routes API error", response.status, result.error?.message ?? "unknown");
    throw new RoutePlanError(
      "Google Mapsからこの条件のルートを取得できませんでした。",
      response.status === 429 ? 429 : 502,
      response.status === 429 ? "GOOGLE_RATE_LIMITED" : "ROUTES_UNAVAILABLE",
    );
  }
  const route = result.routes?.[0];
  if (!route) {
    throw new RoutePlanError("この条件に合うルートが見つかりませんでした。", 404, "NO_ROUTE");
  }
  return route;
}

async function buildRoutePlan(plan: NormalizedPlan, apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18_000);
  const routes: GoogleRoute[] = [];
  let apiRequestCount = 0;
  let cursor = new Date(plan.departureTime);
  let accessDurationMinutes = 0;
  let orderedStopIds = [...plan.stopIds];
  let legDurationMinutes: number[] = [];

  async function compute(body: Record<string, unknown>) {
    apiRequestCount += 1;
    const route = await computeGoogleRoute(apiKey, body, controller.signal);
    routes.push(route);
    return route;
  }

  try {
    if (plan.accessOrigin) {
      const access = await compute({
        origin: waypoint(plan.accessOrigin),
        destination: waypoint(plan.stops[0]),
        travelMode: "TRANSIT",
        departureTime: cursor.toISOString(),
        languageCode: "ja",
        regionCode: "jp",
      });
      accessDurationMinutes = Math.max(1, Math.round(durationSeconds(access.duration) / 60));
      cursor = new Date(cursor.getTime() + accessDurationMinutes * 60_000);
    }

    if (plan.travelMode === "TRANSIT") {
      for (let index = 0; index < plan.stops.length - 1; index += 1) {
        const current = plan.stops[index];
        cursor = new Date(cursor.getTime() + plan.stayMinutes[current.id] * 60_000);
        const segment = await compute({
          origin: waypoint(current),
          destination: waypoint(plan.stops[index + 1]),
          travelMode: "TRANSIT",
          departureTime: cursor.toISOString(),
          languageCode: "ja",
          regionCode: "jp",
        });
        const minutes = Math.max(1, Math.round(durationSeconds(segment.duration) / 60));
        legDurationMinutes.push(minutes);
        cursor = new Date(cursor.getTime() + minutes * 60_000);
      }
    } else {
      const intermediates = plan.stops.slice(1, -1);
      const local = await compute({
        origin: waypoint(plan.stops[0]),
        destination: waypoint(plan.stops.at(-1)!),
        intermediates: intermediates.map(waypoint),
        travelMode: googleTravelMode(plan.travelMode),
        optimizeWaypointOrder: plan.optimizeWaypointOrder && intermediates.length > 0,
        languageCode: "ja",
        regionCode: "jp",
      });
      const order = local.optimizedIntermediateWaypointIndex;
      if (plan.optimizeWaypointOrder && order?.length === intermediates.length) {
        orderedStopIds = [
          plan.stops[0].id,
          ...order.map((index) => intermediates[index].id),
          plan.stops.at(-1)!.id,
        ];
      }
      legDurationMinutes = (local.legs ?? []).map((leg) =>
        Math.max(1, Math.round(durationSeconds(leg.duration) / 60)),
      );
    }

    const distanceMeters = routes.reduce((total, route) => total + (route.distanceMeters ?? 0), 0);
    const travelDurationMinutes = routes.reduce(
      (total, route) => total + Math.max(0, Math.round(durationSeconds(route.duration) / 60)),
      0,
    );
    return {
      source: "server" as const,
      distanceMeters,
      travelDurationMinutes,
      accessDurationMinutes,
      legDurationMinutes,
      orderedStopIds,
      encodedPolylines: routes.flatMap((route) => route.polyline?.encodedPolyline ?? []),
      apiRequestCount,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new RoutePlanError("ルート検索がタイムアウトしました。", 504, "TIMEOUT");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function OPTIONS(request: Request) {
  const origin = requestOrigin(request);
  return new Response(null, {
    status: origin ? 204 : 403,
    headers: {
      ...responseHeaders(request),
      ...(origin
        ? {
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "3600",
          }
        : {}),
    },
  });
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > maximumRequestBytes) {
      throw new RoutePlanError("ルート条件のサイズが大きすぎます。", 413, "REQUEST_TOO_LARGE");
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new RoutePlanError("JSON形式で送信してください。", 415, "UNSUPPORTED_MEDIA_TYPE");
    }
    if (request.headers.get("origin") && !requestOrigin(request)) {
      throw new RoutePlanError("このサイトからはルート検索を利用できません。", 403, "ORIGIN_DENIED");
    }
    consumeRequestAllowance(request);
    let requestBody: unknown;
    try {
      requestBody = await request.json();
    } catch {
      throw new RoutePlanError("送信されたルート条件を読み込めません。", 400, "INVALID_JSON");
    }
    const plan = normalizeRequest(requestBody);
    const apiKey = process.env.GOOGLE_ROUTES_SERVER_API_KEY?.trim() ?? "";
    if (!apiKey) {
      throw new RoutePlanError(
        "サーバー側のルート検索は現在準備中です。",
        503,
        "SERVER_KEY_MISSING",
      );
    }
    const cacheKey = JSON.stringify({
      stopIds: plan.stopIds,
      travelMode: plan.travelMode,
      optimizeWaypointOrder: plan.optimizeWaypointOrder,
      stayMinutes: plan.stayMinutes,
      sourceStationId: plan.sourceStationId,
      departureTime: plan.departureTime,
    });
    let pending = inFlightPlans.get(cacheKey);
    if (!pending) {
      pending = buildRoutePlan(plan, apiKey);
      inFlightPlans.set(cacheKey, pending);
      void pending.then(
        () => inFlightPlans.delete(cacheKey),
        () => inFlightPlans.delete(cacheKey),
      );
    }
    return Response.json(await pending, { headers: responseHeaders(request) });
  } catch (error) {
    if (error instanceof RoutePlanError) {
      return Response.json(
        { error: error.message, code: error.code },
        {
          status: error.status,
          headers: {
            ...responseHeaders(request),
            ...(error.status === 429 ? { "retry-after": "60" } : {}),
          },
        },
      );
    }
    console.error("Failed to create route plan", error);
    return Response.json(
      { error: "ルート検索に失敗しました。少し待ってから再度お試しください。" },
      { status: 500, headers: responseHeaders(request) },
    );
  }
}
