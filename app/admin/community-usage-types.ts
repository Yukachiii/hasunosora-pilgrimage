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

type CommunityRetainedSubmissions = {
  pending: number;
  accepted: number;
  rejected: number;
};

type CommunityUsageSummary = {
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

type CommunityUsageUnavailable = {
  available: false;
  message: string;
  receiver?: CommunityReceiverStatus;
};

export type CommunityUsageResponse =
  | CommunityUsageSummary
  | CommunityUsageUnavailable;
