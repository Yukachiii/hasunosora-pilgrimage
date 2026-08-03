import { Suspense } from "react";
import { chatGPTSignOutPath } from "@/app/chatgpt-auth";
import { spots as baseSpots } from "@/app/spots";
import {
  applySpotOverrides,
  listAdminMedia,
  listSpotOverrides,
} from "@/db/content";
import { requireAdminPage } from "@/lib/admin-auth";
import { AdminApp } from "./AdminApp";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminGate />
    </Suspense>
  );
}

function AdminLoading() {
  return (
    <main className="admin-shell admin-shell--centered">
      <p className="admin-loading">管理画面を準備しています…</p>
    </main>
  );
}

async function AdminGate() {
  const { user, allowed } = await requireAdminPage("/admin");

  if (!allowed) {
    return (
      <main className="admin-shell admin-shell--centered">
        <section className="admin-denied">
          <span>403</span>
          <h1>この管理画面は利用できません</h1>
          <p>公開サイトの管理者として登録されたアカウントで入り直してください。</p>
          <a href={chatGPTSignOutPath("/admin")}>別のアカウントで入り直す</a>
        </section>
      </main>
    );
  }

  let overrides: Awaited<ReturnType<typeof listSpotOverrides>>;
  let media: Awaited<ReturnType<typeof listAdminMedia>>;
  try {
    [overrides, media] = await Promise.all([
      listSpotOverrides(),
      listAdminMedia(),
    ]);
  } catch (error) {
    console.error("Failed to prepare admin page", error);
    return (
      <main className="admin-shell admin-shell--centered">
        <section className="admin-denied">
          <span>STORAGE</span>
          <h1>保存領域を準備できませんでした</h1>
          <p>初回デプロイの直後は準備に少し時間がかかる場合があります。ページを再読み込みしてください。</p>
          <a href="/admin">再読み込み</a>
        </section>
      </main>
    );
  }

  const resolvedSpots = applySpotOverrides(baseSpots, overrides);
  return (
    <AdminApp
      userName={user.displayName}
      signOutPath={chatGPTSignOutPath("/")}
      baseSpots={baseSpots}
      initialSpots={resolvedSpots}
      overriddenSpotIds={overrides.map((override) => override.spotId)}
      initialAssets={media.map((asset) => ({
        id: asset.id,
        originalName: asset.originalName,
        placement: asset.placement,
        spotId: asset.spotId,
        createdAt: asset.createdAt,
        imageUrl: `/api/media/${asset.id}`,
      }))}
    />
  );
}
