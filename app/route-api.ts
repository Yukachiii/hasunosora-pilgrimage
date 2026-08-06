import type { TravelMode } from "./route-planner";

export type ServerRoutePlanRequest = {
  stopIds: string[];
  travelMode: TravelMode;
  optimizeWaypointOrder: boolean;
  stayMinutes: Record<string, number>;
  sourceStationId?: string;
  departureTime: string;
};

export type ServerRoutePlanResponse = {
  source: "server";
  distanceMeters: number;
  travelDurationMinutes: number;
  accessDurationMinutes: number;
  legDurationMinutes: number[];
  orderedStopIds: string[];
  encodedPolylines: string[];
  apiRequestCount: number;
};

export type ServerRoutePlanError = {
  error: string;
  code?: string;
};
