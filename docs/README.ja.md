# Pi TinyChat

**Tiny UI. Full Pi. Zero Bloat.**

[English](../README.md) | 日本語

Pi TinyChat は、[Pi coding agent](https://pi.dev) をブラウザから使うための小さなローカル Web UI です。Pi のターミナル操作に、広い画面・複数セッション・読みやすい Plan 表示を足します。Pi 自体を作り直すことはしません。

![Pi TinyChat](https://raw.githubusercontent.com/VarYUvrc/pi-tinychat/main/docs/images/pi-tinychat.png)

> Pi TinyChat は独立したコミュニティプロジェクトです。Pi の公式プロジェクトではなく、Pi のメンテナとは関係ありません。

## こんな人向け

Pi をターミナルで使っていて、次のように感じている人へ。

- 会話と現在の Plan を 1 画面で見たい
- 実行中のセッションを残したまま、別の会話を開きたい
- Plan の項目をチェックボックスで確認したい
- 日本語 IME の変換確定 Enter で誤送信したくない
- Pi の認証・モデル・設定・履歴をそのまま使いたい

Pi TinyChat は Pi の TUI を置き換えるものではありません。画面の広さ、見通しのよさ、セッションの扱いを足すための薄い UI です。

## できること

- **Plan パネル** — 状態・チェックボックス・進捗を表示します。同梱の Plan ツールが Plan を Pi セッションの custom entry として保存し、エージェントが変更した内容をそのまま即時反映します。ツール実行から進捗を推測して項目を進めることはありません。
- **独立したセッション** — セッションごとに Pi プロセスを保持するため、会話を切り替えても実行中の処理は止まりません。
- **会話表示** — ストリーミング、思考・ツールのコンパクトなカード、Markdown、画像添付、拡張ダイアログ。
- **モデル / コンテキスト** — モデル、推論強度、コンテキスト使用量、自動圧縮しきい値。しきい値は現在のモデルのコンテキストに対する % で表示します。
- **履歴** — Pi セッションの一覧・再開・名前変更・削除。
- **通知** — 英語 / 日本語のトーストとダイアログ、ライト・ダーク・システムテーマ、幅を変えられる Plan パネル、IME 確定 Enter 対策。

## 使い始める前に

Node.js **22.19 以上**が必要です。Node 20 はサポートしません。Pi 本体もインストールしてください。

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### 認証

Pi TinyChat から `/login` を実行することはできません。初回認証はターミナルで済ませてください。

```bash
pi
# 起動したら /login
```

または、Pi TinyChat を起動するシェルでプロバイダの API キーを設定します。例: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENCODE_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`。ローカルモデルは `models.json` で設定します。

### モデル

ターミナルの `/model`、または Pi の `settings.json` にある `defaultProvider` / `defaultModel` で選択します。

### 動作確認

```bash
pi -p "Reply with exactly: ok"
# または
pi auth check --provider <provider>
```

### プロジェクトの `.pi` を使う場合

プロジェクト独自の `.pi` 設定・拡張・skills を使う場合は、そのプロジェクトで一度 `pi` を起動し、`/trust` を実行してください。RPC モードでは trust プロンプトが出ないため、未 trust のプロジェクト設定は読み込まれません。Pi TinyChat が自動で trust することはありません。

`PI_CODING_AGENT_DIR` を変更している場合は、Pi TinyChat を起動する環境でも同じ値を設定してください。認証情報は Pi の `~/.pi/agent` に保存され、Pi TinyChat 独自の認証情報は作りません。

## 起動

**npm ではまだ公開していません。** 現時点ではリポジトリを clone して起動してください。

```bash
git clone https://github.com/VarYUvrc/pi-tinychat.git
cd pi-tinychat
npm install
npm start -- --cwd /path/to/project
```

ローカルにインストールする場合:

```bash
npm install -g .
pi-tinychat --cwd /path/to/project
```

公開後の起動コマンドは次の形を予定しています。

```bash
npx pi-tinychat --cwd /path/to/project
```

## オプション

```text
--cwd <path>    Pi の作業ディレクトリ（既定: カレント）
--port <port>   127.0.0.1 のポート（既定: $PI_TINYCHAT_PORT または 4310）
--no-open       ブラウザを自動で開かない
--pi <path>     pi 実行ファイルまたは CLI エントリポイント
--continue      そのディレクトリの直近セッションを再開
--help          ヘルプ
--version       バージョン
```

## 他の Pi Web UI との違い

Pi の Web UI には有用な選択肢があり、Pi TinyChat は機能の数で競争しません。

- **[pi-web](https://github.com/agegr/pi-web)** — Next.js・React・Pi SDK を使う高機能な Web ワークスペース。セッション分岐、Git Worktree、ファイル閲覧、MCP・モデル・Skills 管理、サブエージェント、モバイル対応などを備えます。
- **[pi-web-simple](https://pi.dev/packages/pi-web-simple)** — Pi 公式 RPC を使う Web UI。Git 操作やファイル管理も備えます。
- **[pipane](https://github.com/mike-heunher/pipane)** — Pi RPC を使うもう 1 つのブラウザ UI。

Pi TinyChat は意図的に小さく留まります。Pi の機能を再実装するのではなく Pi に接続し、会話と Plan の体験に画面を割り当てます。

## 設計

- **実行時依存ゼロ。** React、Next.js、バンドラ、ビルド工程はありません。ブラウザは素の ES Module を読みます。
- **公式 RPC。** `pi --mode rpc` で Pi を独立プロセスとして起動し、JSONL で通信します。エージェントの動作は Pi 本体に委ねます。
- **Pi ネイティブな状態。** 会話と設定は Pi のファイルを使います。独自の DB・ログ・設定ファイルは持たず、UI 設定は `localStorage` に置きます。
- **独立したセッション。** セッションごとに Pi プロセスを保持するため、会話を切り替えても実行中の処理は止まりません。
- **ローカルファースト。** localhost にのみ待ち受け、Host・Origin・起動ごとのトークンを検証します。Markdown はエスケープを優先します。
- **集中した UI。** 思考とツール呼び出しはコンパクトにまとめ、Plan はエージェントが公開した内容だけを表示します。Pi TinyChat がツール実行から進捗を推測することはありません。
- **互換性を優先した内部名。** Plan ツールとセッション entry は、既存の Pi セッションに保存された Plan を読めるよう、歴史的な `dock_plan` / `dock_plan_state` の名前を維持しています。

ここでの「軽量」は、構成・依存・責務が少ないことを指します。メモリ使用量や機能数の最小性を保証するものではありません。

## うまく動かないとき

- **`pi` が見つからない** — `--pi /path/to/pi` または `PI_TINYCHAT_PI` を指定します。
- **モデルが `unknown`、送信に失敗する** — ターミナルで `/login` するか、Pi TinyChat を起動するシェルに API キーを設定します。`pi auth check --provider <provider>` で確認できます。
- **プロジェクトの `.pi` 設定が効かない** — そのプロジェクトで一度 `pi` を起動し、`/trust` を実行します。
- **履歴が空 / 別プロジェクトの履歴が出る** — `--cwd` が Pi で使ったディレクトリと一致しているか確認します。`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` も Pi TinyChat 側に必要です。
- **ポートが使用中** — `--port 4311` など別のポートを指定します。

## 対応 Pi バージョン / 既知の制約

- Pi **1.4.0** で動作確認しています。CI では 1.4.0 と週次の最新 Pi を検証します。厳密な semver 保証はせず、Pi の更新に追従が必要になる場合があります。
- TUI 専用のカスタム UI（`custom()` など）は再現しません。RPC ダイアログのみ対応します。
- `/login` `/tree` `/fork` `/clone` など TUI 専用コマンドは Pi TinyChat から実行できません。
- プロジェクトの `.pi` 設定は Pi の trust に従います。事前の `/trust` が必要です。
- `sessionDir` 設定（`PI_CODING_AGENT_SESSION_DIR` 以外）は履歴一覧に反映されない場合があります。
- Plan 設定を OFF にしても、起動済みの Pi プロセスから Plan 拡張は外れません。OFF は Pi TinyChat の Plan UI のみを無効化します。
- バックグラウンドセッションは Pi プロセスを保持するため、同時数に比例してメモリ/CPU を使います。
- 複数タブ間のセッション切替は即時同期しません。
- fork / clone / ブランチツリー表示は未対応です。

## 開発

```bash
npm ci
npm run lint
npm run typecheck      # src + extension
npm run check:i18n
npm test               # Playwright E2E
npm run test:pi        # 実 Pi（オフライン、認証不要）
npm run pack:check     # tarball の内容と CLI 起動
npm run check          # 上記をまとめて実行
```

実モデルを使う手動スモーク（ネットワーク・課金あり。CI では実行しません）:

```bash
npm run smoke -- --cwd /path/to/project "Reply with exactly: pong"
```

一時ファイルはリポジトリ内の `tmp/` を使います。CI は Ubuntu / Windows の Node 22.19 で実行し、週次で最新 Pi との互換性を確認します。公開用の release workflow はまだありません。

## ライセンス

MIT
