# Pi-dock

Pi Coding Agent をブラウザから使うための、薄いローカル Web UI。

- Pi の公式 RPC モードに接続するだけで、エージェントやセッションを再実装しない
- セッションごとに Pi プロセスを分け、切り替えても実行中の会話はバックグラウンドで継続
- モデル・推論強度・Skills・Extensions・履歴はすべて Pi の設定に追従
- 日本語 IME の変換確定 Enter で誤送信しない
- Dock 独自の DB・設定ファイル・ログを作らない（UI 設定は localStorage のみ）

```bash
npx pi-dock      # 公開前: ローカルの tarball / リポジトリから
pi-dock --cwd C:\path\to\project
```

起動すると `http://127.0.0.1:4310/?launch=...` が表示され、ブラウザが開きます。
起動用の認証情報はローカル Cookie と交換され、ブラウザのアドレスバーは
`http://127.0.0.1:4310/` に変わります。

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
| 新規会話 | 履歴の中の `+` |
| 履歴 | ヘッダーの時計アイコン |

- 新規会話や履歴の切り替えで、実行中のセッションは中断されません。
  会話ごとに Pi プロセスが動き続け、履歴の実行中ドットで状態を確認できます。
- コマンド検索には、Pi の Extensions / Skills / Prompt templates に加えて、
  Dock が RPC に対応付けた組み込みコマンド（`/new` `/resume` `/compact`
  `/model` `/thinking` `/settings` `/session` `/copy` `/export` `/name` `/reload`）が
  表示されます。TUI 専用のコマンドは表示されません。

- 実行中に送信すると、Pi の steering キューに入ります。中断時は入力欄へ戻ります。
- モデル・推論強度・コンテキスト使用量はヘッダーから確認・変更できます。
  モデルと推論強度は同じピルの中に並び、どちらもプルダウンで選べます。
- コンテキストメニューから、モデルごとの自動圧縮しきい値を 25% / 50% / 既定で
  切り替えられます。設定は Pi 標準の `~/.pi/agent/settings.json` の
  `compaction.modelOverrides` に書き込むだけで、Dock 独自の設定は持ちません。
- 思考・bash・read・write・edit などの連続した内部処理は「作業」カードにまとまり、
  失敗や実行中の状態は折りたたんだままでも分かります。カードには実行した
  ツール種別のアイコンが並びます。
- 計画パネルは左端の境界をドラッグして幅を変更できます。計画は作成時に全体を登録し、
  作業に合わせて更新されます。モデルの更新が滞っても、ファイル編集やコマンド実行を
  行ったターンごとに次の項目へ自動で進むため、完了状態が最後にまとめて埋まることは
  ありません。
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
- **セッションごとに 1 プロセス**: 新規会話・履歴の切り替えでは、既存プロセスを
  中断せずに別の `pi --mode rpc` を起動します。同じセッションへ複数プロセスから
  同時書き込みしないよう、開いているセッションはランタイムを再利用します。
- **セッションは Pi の JSONL が唯一の保存先**: Dock は会話を保存しません。
  履歴一覧は `~/.pi/agent/sessions/--<cwd>--/` を読み取り専用で参照します。
- **書き込みを増やさない**: ストリーミングは RAM 上で処理し、Dock 由来の
  ログ・DB・設定ファイルは作りません。`localStorage` への書き込みは設定変更時のみです。
  テーマは `system` を既定とし、OS の切り替えに追従します。
- **安全側のローカル UI**: `127.0.0.1` のみで待ち受け、Host / Origin / 起動トークンを検証。
  起動トークンは初回アクセスで HttpOnly / SameSite=Strict の Cookie に交換され、
  以降の URL に認証情報は残りません。API は許可した RPC コマンドだけを中継します。
  Markdown は全文字をエスケープして描画します。
- **依存ゼロ**: 実行時依存はありません（Markdown レンダラも同梱の小さな実装）。
- **型を書くのは Pi との境界だけ**: `src/*.js` が受け取る RPC イベント・セッション entry・
  レスポンスを `src/pi-protocol.d.ts` に写し、`npm run typecheck` で消費側（`src/`）と
  生成側（`test/fixtures/fake-pi.js`）の両方を検査します。Pi 本体の型定義は取り込みません
  （依存を含めて 100MB 超を開発環境に持ち込まないため）。ブラウザ側 `public/*.js` は
  静的配信でビルド工程を持たないため TS 化しません。DOM 型のノイズ（`HTMLElement` の
  キャスト追加など）が検出内容の大半を占め、ビルド工程と dist 管理のコストに見合わないためです。
  UI の振る舞いは E2E で守ります。

## 開発

```bash
npm install
npm test          # Playwright E2E（実際の Pi の代わりに RPC フィクスチャを使用）
npm run lint      # Biome で JS/TS/CSS/JSON を静的検査
npm run format    # Biome で整形（任意）
npm run typecheck # Pi 境界の型検査（src/ と E2E フィクスチャ）
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
- TUI 専用の組み込みコマンド（`/tree` `/fork` `/login` など）は実行できません。
  RPC に対応付けられる一部だけを Dock の組み込みコマンドとして提供します。
- バックグラウンドのセッションはそれぞれ Pi プロセスを保持するため、
  同時に開くセッション数に比例してメモリと CPU を使います。
- 会話の fork / clone、ブランチツリー表示は未対応です。
- 複数タブで同時に開くと、セッション切り替えが他のタブへ即時反映されません。

## 公開について

`package.json` は `private: true` です。npm への公開は、パッケージ名・scope と
Trusted Publishing の設定を確認したうえで別途行います。
