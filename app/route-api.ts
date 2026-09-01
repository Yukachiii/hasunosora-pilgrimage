import type { TravelMode } from "./route-planner";

export type ServerRouteStopLocation = {
  id: string;
  lat: number;
  lng: number;
};

export type ServerRoutePlanRequest = {
  stopIds: string[];
  stopLocations?: ServerRouteStopLocation[];
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
