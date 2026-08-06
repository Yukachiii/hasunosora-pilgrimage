import type { TravelMode } from "@/app/route-planner";

export type RouteUsageTotals = {
  calculations: number;
  apiRequests: number;
  successful: number;
  failed: number;
  averageResponseTimeMs: number;
};

export type RouteUsageDaily = RouteUsageTotals & {
  date: string;
};

export type RouteUsageByMode = RouteUsageTotals & {
  travelMode: TravelMode;
};

export type RouteUsageSummary = {
  available: true;
  generatedAt: string;
  timeZone: "Asia/Tokyo";
  today: RouteUsageTotals;
  currentMonth: RouteUsageTotals;
  daily: RouteUsageDaily[];
  byMode: RouteUsageByMode[];
};

export type RouteUsageUnavailable = {
  available: false;
  message: string;
};

export type RouteUsageResponse = RouteUsageSummary | RouteUsageUnavailable;
