# Pi Dock

Pi Coding Agent をブラウザから使うための、薄いローカル Web UI。

- Pi の公式 RPC モードに接続するだけで、エージェントやセッションを再実装しない
- モデル・思考レベル・Skills・Extensions・履歴はすべて Pi の設定に追従
- 日本語 IME の変換確定 Enter で誤送信しない
- Dock 独自の DB・設定ファイル・ログを作らない（UI 設定は localStorage のみ）

```bash
npx pi-dock      # 公開前: ローカルの tarball / リポジトリから
pi-dock --cwd C:\path\to\project
```

起動すると `http://127.0.0.1:4310/?token=...` が表示され、ブラウザが開きます。
URL のトークンはこの起動限りの認証情報です。

## 必要条件

- Node.js 20 以上
- Pi (`@earendil-works/pi-coding-agent`) がインストール済みで、`pi` が PATH にあること
  - 見つからない場合は `--pi <path>` または `PI_DOCK_PI` で CLI の場所を指定できます

## 使い方

| 操作 | キー |
| --- | --- |
| 送信 | `Ctrl + Enter`（設定で無効化可能） |
| 送信（ボタン） | 右下の矢印 |
| 改行 | `Enter` / `Shift + Enter` |
| 中断 | `Esc` または停止ボタン |
| コマンド検索 | `/` で開始 |
| 新規会話 | ヘッダーの `+` |
| 履歴 | ヘッダーの時計アイコン |

- 実行中に送信すると、Pi の steering キューに入ります。中断時は入力欄へ戻ります。
- モデル・思考レベル・コンテキスト使用量はヘッダーから確認・変更できます。
- 設定からテーマ（システム / ライト / ダーク）と Ctrl+Enter 送信を切り替えられます。
- Extensions の確認・選択・入力ダイアログ、通知、ステータス、ウィジェットに対応します。

## オプション

```text
--cwd <path>     Pi の作業ディレクトリ（既定: カレントディレクトリ）
--port <port>    127.0.0.1 のポート（既定: 4310 / PI_DOCK_PORT）
--no-open        ブラウザを自動で開かない
--pi <path>      pi 実行ファイルまたは CLI エントリポイント
--continue       直近の Pi セッションを再開して起動
```

## 設計上の判断

- **Pi を再実装しない**: `pi --mode rpc` のサブプロセスと JSONL で通信します。
  Dock が持つのは表示・入力・接続だけです。
- **セッションは Pi の JSONL が唯一の保存先**: Dock は会話を保存しません。
  履歴一覧は `~/.pi/agent/sessions/--<cwd>--/` を読み取り専用で参照します。
- **書き込みを増やさない**: ストリーミングは RAM 上で処理し、Dock 由来の
  ログ・DB・設定ファイルは作りません。`localStorage` への書き込みは設定変更時のみです。
  テーマは `system` を既定とし、OS の切り替えに追従します。
- **安全側のローカル UI**: `127.0.0.1` のみで待ち受け、Host / Origin / 起動トークンを検証。
  API は許可した RPC コマンドだけを中継します。Markdown は全文字をエスケープして描画します。
- **依存ゼロ**: 実行時依存はありません（Markdown レンダラも同梱の小さな実装）。

## 開発

```bash
npm install
npm test          # Playwright E2E（実際の Pi の代わりに RPC フィクスチャを使用）
npm start -- --cwd <path>
```

E2E は `test/fixtures/fake-pi.js` に対して、送信・IME・履歴・拡張ダイアログ・
再起動・XSS・認証などを検証します。実 Pi との接続確認は次で行えます。

```bash
npm run smoke -- --cwd <path> "Reply with exactly: pong"
```


## 既知の制約

- TUI 専用のカスタム UI（`custom()` など）は再現しません。RPC で提供される
  ダイアログ（select / confirm / input / editor）のみ対応します。
- 画像付きプロンプトは API では受け取れますが、UI からの添付は未対応です。
- 会話の fork / clone、ブランチツリー表示は未対応です。
- 複数タブで同時に開くと、セッション切り替えが他のタブへ即時反映されません。

## 公開について

`package.json` は `private: true` です。npm への公開は、パッケージ名・scope と
Trusted Publishing の設定を確認したうえで別途行います。
