import { getChatGPTUser, requireChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import { headers } from "next/headers";

async function localDevelopmentAdmin(): Promise<ChatGPTUser | null> {
  if (process.env.ADMIN_LOCAL_DEV !== "1") {
    return null;
  }
  const host = (await headers()).get("host")?.toLowerCase() ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return null;
  return {
    userId: "local-development-admin",
    displayName: "ローカル管理者",
    email: "local-admin@example.invalid",
    fullName: "ローカル管理者",
  };
}

function configuredAdminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAIL ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminUser(user: ChatGPTUser): boolean {
  return configuredAdminEmails().has(user.email.trim().toLowerCase());
}

export async function getAdminUser(): Promise<ChatGPTUser | null> {
  const local = await localDevelopmentAdmin();
  if (local) return local;
  const user = await getChatGPTUser();
  return user && isAdminUser(user) ? user : null;
}

async function secretDigest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export async function hasRouteUsageAdminToken(request: Request) {
  const expected = process.env.ROUTE_USAGE_ADMIN_TOKEN?.trim() ?? "";
  const supplied = request.headers.get("x-route-usage-admin-token")?.trim() ?? "";
  if (!expected || !supplied) return false;

  const [expectedDigest, suppliedDigest] = await Promise.all([
    secretDigest(expected),
    secretDigest(supplied),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= expectedDigest[index] ^ suppliedDigest[index];
  }
  return difference === 0;
}

export async function requireAdminPage(returnTo: string) {
  const local = await localDevelopmentAdmin();
  if (local) return { user: local, allowed: true };
  const user = await requireChatGPTUser(returnTo);
  return { user, allowed: isAdminUser(user) };
}

export function adminApiError() {
  return Response.json(
    { error: "この操作を行う管理者権限がありません。" },
    { status: 403 },
  );
}
