import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "蓮ノ旅｜蓮ノ空・金沢 聖地巡礼ガイド",
    description:
      "蓮ノ空女学院スクールアイドルクラブの舞台をめぐる、非公式の聖地巡礼マップ。スポット探しからルート検索まで。",
    applicationName: "蓮ノ旅",
    metadataBase: new URL(origin),
    openGraph: {
      title: "蓮ノ旅｜蓮ノ空・金沢 聖地巡礼ガイド",
      description: "好きな物語と、同じ景色を歩こう。",
      type: "website",
      locale: "ja_JP",
      url: origin,
      images: [
        {
          url: `${origin}/og.png`,
          width: 1734,
          height: 907,
          alt: "蓮ノ旅 — 好きな物語と、同じ景色を歩こう。",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "蓮ノ旅｜蓮ノ空・金沢 聖地巡礼ガイド",
      description: "好きな物語と、同じ景色を歩こう。",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
