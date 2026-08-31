# 蓮ノ旅

「蓮ノ空女学院スクールアイドルクラブ」の舞台を巡る、非公式の聖地巡礼マップです。

- 公開サイト: https://yukachiii.github.io/hasunosora-pilgrimage/
- ローカル管理画面: `http://127.0.0.1:8765/admin/`

## 管理画面を起動する

普段はプロジェクト直下の `start-admin.bat` をダブルクリックしてください。管理画面を準備してブラウザで開きます。停止するときは、起動した画面で `Ctrl+C` を押すかウィンドウを閉じます。

PowerShellから起動する場合は次のとおりです。

```powershell
.\start-admin.ps1
```

管理サーバーは `127.0.0.1` にだけ接続し、外部には公開されません。

## 編集と公開の流れ

1. 管理画面でスポット情報を修正、または写真を選択する
2. 「保存」でプロジェクト内のJSON・透かし済み画像へ反映する
3. 内容を確認する
4. 右上の「GitHub Pagesへ公開」を押す
5. GitHub Actionsの完了後、公開サイトへ反映される

編集の保存とGitHubへの公開は分かれています。「保存」しただけでは外部公開されません。公開ボタンは `content/` と `public/photos/` だけをコミット対象にします。

スポット情報は `content/spots.json`、画像一覧は `content/media.json`、タイトル背景は `content/site.json` に保存します。公開ページはこれらのファイルをビルド時に読み込みます。

## 写真の扱い

- 選択した元写真はプロジェクト内へ保存しない
- ブラウザ内でトリミングする
- GPS・端末名・ISO・撮影日時などのEXIFを除去する
- `© Yukachiii` の透かしを焼き込む
- 透かし済みWebP/JPEGだけを `public/photos/` へ保存する

## GitHub Pages用ビルド

```powershell
npm.cmd run build:pages
```

出力先は `pages-dist/` です。`main` ブランチへプッシュすると `.github/workflows/deploy-pages.yml` が公開ページを自動更新します。管理画面、ローカルサーバー、元写真、環境変数はPagesの配信物に含まれません。

Mapboxの公開トークンは、GitHub ActionsのSecret `MAPBOX_ACCESS_TOKEN` からビルド時に設定します。トークンは公開ページのURLだけを許可するサイト専用トークンにしてください。

### 公開前の最終確認

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run build:admin
npm.cmd run build:pages
git diff --check
```

- GitHub ActionsのSecret `MAPBOX_ACCESS_TOKEN` が設定され、公開URLだけを許可している
- 必要な場合だけ `ROUTE_API_URL` を設定し、許可Originを公開サイトへ限定している
- `.env.local` と `.env.pages.local` がGitの追跡対象に入っていない
- 公開サイトで地図、スポット・カード一覧、予定作成、当日表示、ガイドをスマートフォンとPCの両方で確認する
- SNSへURLを貼り、タイトル・説明・OG画像が表示されることを確認する

## サーバー側ルート検索

サーバー版では `/api/routes/plan` がルート条件を検証し、専用の
`GOOGLE_ROUTES_SERVER_API_KEY` を使ってGoogle Routes APIへ問い合わせます。
APIキーはブラウザへ配信されません。短時間の重複検索をまとめ、1利用元あたり
1分10回までに制限しています。

- 徒歩・車・自転車: 最初と最後を固定し、中間地点を最適化可能
- 公共交通: 現在は公開画面で無効化
- 主要駅: 公共交通検索の再設計まで一時停止
- 手動調整: 画面で並べ替えた順序をサーバーがそのまま使用

GitHub Pagesだけではサーバー処理を実行できません。サーバー版を別途公開した後、
GitHub ActionsのSecret `ROUTE_API_URL` に
`https://サーバーのドメイン/api/routes/plan` を設定すると、Pages版もそのAPIを利用します。
未設定時はMapbox Directions APIを使うブラウザ内ルート検索へ自動的に戻ります。

サーバー用キーはブラウザ用と分け、Google Cloud側でRoutes APIのみに制限してください。

## API使用状況

サーバー版のルート検索は、Google Routes APIへ実際に送ったリクエスト数を
D1の`route_api_usage`へ記録します。管理画面の「API使用状況」では次を確認できます。

- 今日・今月のGoogle APIリクエスト数
- ルート計算回数、失敗回数、平均応答時間
- 直近14日の日別推移
- 今月の移動手段別内訳

IPアドレス、出発駅、選択したスポットは記録しません。この数値はサイトの
サーバーが記録した値であり、Google Cloudの請求確定値やクォータ画面とは
集計時刻などにより差が出る場合があります。

ローカル管理画面から本番サーバーの集計を見る場合は、`.env.local`へ次を設定します。

```dotenv
ROUTE_USAGE_API_URL=https://サーバーのドメイン/api/admin/route-usage
ROUTE_USAGE_ADMIN_TOKEN=十分に長いランダムな共有トークン
```

`VITE_ROUTE_API_URL`が設定済みなら、`ROUTE_USAGE_API_URL`は同じサーバーから
自動推測できます。`ROUTE_USAGE_ADMIN_TOKEN`はルートAPIサーバー側にも同じ値を
秘密の環境変数として設定してください。トークンはGitへ追加せず、GitHub Pagesや
ブラウザ用環境変数にも設定しません。

## 開発用ビルド

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd test
npm.cmd run build:admin
npm.cmd run build:pages
```
