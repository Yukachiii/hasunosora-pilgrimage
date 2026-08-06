import spotData from "../content/spots.json";
import cardModelData from "../content/card-models.json";

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
  appearances?: string[];
  imageUrl?: string;
  imagePosition?: string;
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

export const spotById = (id: string) => spots.find((spot) => spot.id === id);
