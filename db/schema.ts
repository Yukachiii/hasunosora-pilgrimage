import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mediaAssets = sqliteTable("media_assets", {
  id: text("id").primaryKey(),
  originalKey: text("original_key").notNull(),
  publicKey: text("public_key").notNull(),
  originalName: text("original_name").notNull(),
  originalContentType: text("original_content_type").notNull(),
  publicContentType: text("public_content_type").notNull(),
  placement: text("placement").notNull(),
  spotId: text("spot_id"),
  cropX: real("crop_x").notNull().default(50),
  cropY: real("crop_y").notNull().default(50),
  zoom: real("zoom").notNull().default(1),
  gpsLat: real("gps_lat"),
  gpsLng: real("gps_lng"),
  nearestSpotId: text("nearest_spot_id"),
  status: text("status").notNull().default("published"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const spotOverrides = sqliteTable("spot_overrides", {
  spotId: text("spot_id").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  area: text("area").notNull(),
  category: text("category").notNull(),
  address: text("address").notNull(),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  description: text("description").notNull(),
  accessNote: text("access_note").notNull(),
  sourceUrl: text("source_url").notNull(),
  updatedBy: text("updated_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const routeApiUsage = sqliteTable(
  "route_api_usage",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull(),
    dayKey: text("day_key").notNull(),
    monthKey: text("month_key").notNull(),
    travelMode: text("travel_mode").notNull(),
    status: text("status").notNull(),
    googleRequestCount: integer("google_request_count").notNull(),
    responseTimeMs: integer("response_time_ms").notNull(),
    errorCode: text("error_code"),
  },
  (table) => [
    index("route_api_usage_day_idx").on(table.dayKey),
    index("route_api_usage_month_mode_idx").on(
      table.monthKey,
      table.travelMode,
    ),
  ],
);
