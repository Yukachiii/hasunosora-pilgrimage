# 蓮ノ旅

「蓮ノ空女学院スクールアイドルクラブ」の舞台をめぐる、非公式の聖地巡礼マップMVPです。

## ローカル起動

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Google Cloud Consoleで **Maps JavaScript API** と **Routes API** を有効化し、
`.env.local` にAPIキーを設定すると、地図内で距離・所要時間・ルートを表示します。
未設定でもスポット一覧と地図プレビュー、およびGoogle マップへの外部リンクは利用できます。

```env
GOOGLE_MAPS_BROWSER_API_KEY=Webサイト用APIキー
GOOGLE_MAPS_MAP_ID=JavaScript用Map ID
```

APIキーには、開発用の `http://localhost:3000/*` と公開サイトのドメインを
HTTPリファラーとして登録し、利用できるAPIを Maps JavaScript API と Routes API に限定してください。

## スポットの追加

`app/spots.ts` の `spots` 配列へ追加すると、地図・一覧・ルート検索候補へ反映されます。

## 管理画面

公開サイトの `/admin` から、次の操作ができます。

- JPEG・PNG・WebPを複数選択し、1枚ずつ配置先と切り抜きを調整
- EXIF GPSから最寄りスポットを候補表示（配置先は手動変更可能）
- スポットカードまたはタイトル背景へ公開
- スポットの名称・住所・説明・アクセス案内・公式URL・座標を修正
- 管理画面で行ったスポット修正を、登録時の内容へ戻す

元写真は非公開のR2へ保存し、公開用画像はブラウザで再生成してEXIFを除去し、
`© Yukachiii` の透かしを焼き込みます。
画像メタデータとスポットの修正差分はD1へ保存するため、日常的な編集にコミットや
再デプロイは不要です。

管理者はSign in with ChatGPTのメールアドレスで照合します。本番環境の
`ADMIN_EMAIL` に管理者メールアドレスを設定してください。複数人を許可する場合は
カンマ区切りで指定できます。判定はAPIを含めてサーバー側で行います。

## GitHub Pages向け公開ビルド

一般閲覧画面だけを `https://yukachiii.github.io/hasunosora-pilgrimage/` へ公開できます。
公開用のGoogle Maps設定は、Git管理されない `.env.pages.local` に記録します。

```env
VITE_GOOGLE_MAPS_BROWSER_API_KEY=Webサイト用APIキー
VITE_GOOGLE_MAPS_MAP_ID=DEMO_MAP_ID
```

```powershell
npm.cmd run build:pages
```

生成される `pages-dist` には一般画面、透かし済み画像、ブラウザ用コードだけが含まれます。
元写真、管理画面、データベース、サーバー側コード、EXIF、ソースマップは公開しません。
