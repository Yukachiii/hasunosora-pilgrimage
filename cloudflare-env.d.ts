declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    MEDIA?: R2Bucket;
    GOOGLE_ROUTES_SERVER_API_KEY?: string;
    ROUTE_API_ALLOWED_ORIGINS?: string;
    ROUTE_USAGE_ADMIN_TOKEN?: string;
  }
}
