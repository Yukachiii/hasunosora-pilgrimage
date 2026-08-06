import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

let localSchemaReady: Promise<void> | null = null;

async function ensureLocalSchema(database: D1Database) {
  if (process.env.ADMIN_LOCAL_DEV !== "1") {
    return;
  }
  localSchemaReady ??= database
    .batch([
      database.prepare(`CREATE TABLE IF NOT EXISTS media_assets (
        id text PRIMARY KEY NOT NULL,
        original_key text NOT NULL,
        public_key text NOT NULL,
        original_name text NOT NULL,
        original_content_type text NOT NULL,
        public_content_type text NOT NULL,
        placement text NOT NULL,
        spot_id text,
        crop_x real DEFAULT 50 NOT NULL,
        crop_y real DEFAULT 50 NOT NULL,
        zoom real DEFAULT 1 NOT NULL,
        gps_lat real,
        gps_lng real,
        nearest_spot_id text,
        status text DEFAULT 'published' NOT NULL,
        created_by text NOT NULL,
        created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
      database.prepare(`CREATE TABLE IF NOT EXISTS spot_overrides (
        spot_id text PRIMARY KEY NOT NULL,
        name text NOT NULL,
        short_name text NOT NULL,
        area text NOT NULL,
        category text NOT NULL,
        address text NOT NULL,
        lat real NOT NULL,
        lng real NOT NULL,
        description text NOT NULL,
        access_note text NOT NULL,
        source_url text NOT NULL,
        updated_by text NOT NULL,
        created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
      database.prepare(`CREATE TABLE IF NOT EXISTS route_api_usage (
        id text PRIMARY KEY NOT NULL,
        occurred_at text NOT NULL,
        day_key text NOT NULL,
        month_key text NOT NULL,
        travel_mode text NOT NULL,
        status text NOT NULL,
        google_request_count integer NOT NULL,
        response_time_ms integer NOT NULL,
        error_code text
      )`),
      database.prepare(
        "CREATE INDEX IF NOT EXISTS route_api_usage_day_idx ON route_api_usage (day_key)"
      ),
      database.prepare(
        "CREATE INDEX IF NOT EXISTS route_api_usage_month_mode_idx ON route_api_usage (month_key, travel_mode)"
      ),
    ])
    .then(() => undefined);
  await localSchemaReady;
}

export async function getD1Database() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  await ensureLocalSchema(env.DB);
  return env.DB;
}

export async function getDb() {
  return drizzle(await getD1Database(), { schema });
}
