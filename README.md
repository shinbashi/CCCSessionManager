# CCCSessionManager

cmux で Claude Code のセッションを大量に動かしていると、どのタブで何をしていたのか分からなくなります。CCCSessionManager は、ローカルにある Claude Code のセッションを一覧・検索し、cmux のタブへのジャンプや休止・終了までを 1 つのウィンドウで行う macOS アプリです。

## できること

- **セッション一覧**: 過去分を含むすべてのセッションを、一覧またはフォルダ別のツリーで表示します。タイトル・最後の指示・フォルダ・最終更新・実行状態が一目で分かります
- **並べ替えと絞り込み**: 最終更新・作成日時・タイトル・実行状態・フォルダ・メモリ使用量で並べ替え、通常セッション / サブエージェント、実行中のみで絞り込めます
- **会話ビューア**: 発言を「ユーザー」「Claude」「思考」「ツール使用」「ツール結果」の種類ごとに色分けして表示し、種類で表示を切り替えられます
- **全文検索**: すべての会話を対象に、発言の種類を指定して検索できます（索引を作らない並列走査で、数 GB の履歴でも 1 秒以内）
- **実行中セッションの操作**
  - PID とメモリ使用量（MCP サーバーなどの子プロセスを含む）を表示
  - そのセッションが動いている cmux のタブへジャンプ
  - 休止: 会話を保持したままプロセスを止めてメモリを空け、あとで同じタブで再開
  - 終了: Claude Code のプロセスに SIGTERM を送る（タブとシェルは残ります）
  - `claude --resume` 用のコマンドをコピー

## 動作環境

- macOS（Apple Silicon）
- Claude Code
- cmux（タブへのジャンプ・休止・再開に使います。無くても一覧・検索・会話表示は使えます）

## インストール

[Releases](https://github.com/shinbashi/CCCSessionManager/releases/latest) から `CCCSessionManager_<バージョン>_aarch64.dmg`（Apple Silicon 用）をダウンロードし、アプリを「アプリケーション」フォルダにドラッグしてください。

このアプリは Apple の公証（notarization）を受けていないため、初回起動時に「開発元を確認できない」として macOS に止められます。一度だけ次の操作で開けるようになります。

1. アプリを開こうとして、警告が出たら「完了」で閉じる
2. 「システム設定 → プライバシーとセキュリティ」の下部に出る「このまま開く」を押す

v0.2.2 以前の dmg で「壊れているため開けません」と表示される場合は、最新版をダウンロードし直してください（署名を修正しました）。それでも開けない場合は、ターミナルで次を実行します。

```sh
xattr -cr /Applications/CCCSessionManager.app
```

### 自動アップデート

起動時に新しいバージョンがあるかを確認し、あれば画面上部に「更新して再起動」が表示されます。更新ファイルは署名を検証してからインストールします。

## ビルド

Rust と Node.js が必要です。

```sh
npm install
npm run tauri build -- --bundles app
cp -R "src-tauri/target/release/bundle/macos/CCCSessionManager.app" /Applications/
```

開発中は `npm run tauri dev` で起動できます。テストは `npm test` と `cd src-tauri && cargo test --lib` で実行します。

### リリース

1. `package.json`・`src-tauri/Cargo.toml`・`src-tauri/tauri.conf.json` の `version` を上げてコミットする
2. `git tag v<バージョン> && git push origin v<バージョン>` でタグを push する

GitHub Actions（`.github/workflows/release.yml`）が dmg と自動アップデート用のファイル（`latest.json` など）をビルドし、Releases に公開します。Actions の画面から手動で実行すると、下書きのリリースを作ります。

自動アップデートの署名には、リポジトリの Secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` を使います。秘密鍵を失うと、配布済みのアプリに更新を届けられなくなります。

## 仕組み

アプリはローカルのファイルとプロセス情報だけを読み、外部への通信は行いません。

| 情報 | 読み取り元 |
| --- | --- |
| 会話・タイトル・サブエージェント | `~/.claude/projects/<フォルダ>/<セッションID>.jsonl` と `<セッションID>/subagents/` |
| 実行中のセッション | `~/.claude/sessions/<PID>.json` と `ps` |
| セッションが動いている cmux のタブ | claude プロセスの環境変数 `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` |
| 休止させたセッションの記録 | `~/Library/Application Support/io.github.shinbashi.cccsessionmanager/suspended.json` |

### 休止について

まず cmux の Agent Hibernation（`cmux agent-hibernation hibernate`）を試します。cmux が休止を受け付けなかった場合は、セッションが idle のときに限りアプリがプロセスを SIGTERM で止め、どのタブで動いていたかを記録します。「このタブで再開」を押すと、同じタブに `claude --resume <セッションID>` を送って再開します。作業中（idle 以外）のセッションは止めません。

## クレジット

履歴の読み方・全文検索の方式・配色は [Claude Code History Viewer](https://github.com/jhlee0409/claude-code-history-viewer) （MIT License）を参考にしています。
