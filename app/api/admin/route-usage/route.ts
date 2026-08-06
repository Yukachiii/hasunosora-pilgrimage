import { getRouteApiUsageSummary } from "@/db/route-usage";
import {
  adminApiError,
  getAdminUser,
  hasRouteUsageAdminToken,
} from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const [user, hasToken] = await Promise.all([
    getAdminUser(),
    hasRouteUsageAdminToken(request),
  ]);
  if (!user && !hasToken) return adminApiError();

  try {
    return Response.json(await getRouteApiUsageSummary(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to load Routes API usage", error);
    return Response.json(
      { error: "API使用状況を読み込めませんでした。" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
