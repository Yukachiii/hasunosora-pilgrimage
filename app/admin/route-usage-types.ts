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

export type CommunityUsageTotals = {
  submissionAttempts: number;
  submissionsAccepted: number;
  submissionsFailed: number;
  turnstileRequests: number;
  turnstileSuccessful: number;
  turnstileFailed: number;
  turnstileRetries: number;
};

export type CommunityReceiverStatus = {
  status: "ok" | "unreachable" | "unknown";
  checkedAt: string;
  message?: string;
};

export type CommunityRetainedSubmissions = {
  pending: number;
  accepted: number;
  rejected: number;
};

export type CommunityUsageSummary = {
  available: true;
  generatedAt: string;
  timeZone: "Asia/Tokyo";
  trackingStartedAt: string | null;
  receiver: CommunityReceiverStatus;
  today: CommunityUsageTotals;
  currentMonth: CommunityUsageTotals;
  allTime: CommunityUsageTotals;
  retained: CommunityRetainedSubmissions;
};

export type CommunityUsageUnavailable = {
  available: false;
  message: string;
  receiver?: CommunityReceiverStatus;
};

export type CommunityUsageResponse =
  | CommunityUsageSummary
  | CommunityUsageUnavailable;
