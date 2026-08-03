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

Google MapsのブラウザAPIキーは、GitHub ActionsのSecret `GOOGLE_MAPS_BROWSER_API_KEY` からビルド時に設定します。キーはGitHub Pagesの公開元とMaps JavaScript API・Routes APIに制限してください。

## 開発用ビルド

```powershell
npm.cmd install
npm.cmd run lint
npm.cmd test
npm.cmd run build:admin
npm.cmd run build:pages
```
