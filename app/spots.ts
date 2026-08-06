import spotData from "../content/spots.json";
import cardModelData from "../content/card-models.json";
import collaborationData from "../content/collaborations.json";

export type CollaborationId =
  | "ishikawa-dai-kanko-2"
  | "kaga-onsen-2026";

export type SpotCategory =
  | "交通"
  | "まち歩き"
  | "眺望"
  | "宿泊"
  | "甘味"
  | "海辺"
  | "文化"
  | "飲食"
  | "買い物"
  | "レジャー"
  | "寺社";

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
  activityRecords?: string[];
  sehasEpisodes?: string[];
  accessNote: string;
  sourceUrl: string;
  recommendedStayMinutes?: number;
  appearances?: string[];
  collaborationIds?: CollaborationId[];
  imageUrl?: string;
  imagePosition?: string;
};

export type PilgrimageCollaboration = {
  id: CollaborationId;
  name: string;
  subtitle: string;
  startDate: string;
  endDate: string;
  description: string;
  sourceUrl: string;
  locations: Array<{
    spotId: string;
    role: string;
  }>;
};

export type CardModelLocation = {
  id: string;
  card: string;
  model: string;
  address: string;
  confidence: "A" | "B";
  note: string;
  spotId: string | null;
  sourceUrl: string;
};

export const spots = spotData as PilgrimageSpot[];
export const cardModels = cardModelData as CardModelLocation[];
export const collaborations = collaborationData as PilgrimageCollaboration[];

export const spotById = (id: string) => spots.find((spot) => spot.id === id);
export const collaborationById = (id: CollaborationId) =>
  collaborations.find((collaboration) => collaboration.id === id);
