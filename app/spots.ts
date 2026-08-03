import spotData from "../content/spots.json";

export type SpotCategory =
  | "交通"
  | "まち歩き"
  | "眺望"
  | "宿泊"
  | "甘味"
  | "海辺"
  | "文化";

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
  accessNote: string;
  sourceUrl: string;
  imageUrl?: string;
  imagePosition?: string;
};

export const spots = spotData as PilgrimageSpot[];

export const spotById = (id: string) => spots.find((spot) => spot.id === id);
