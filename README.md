# Pi Dock Web

Pi Coding Agent をブラウザから使うためのローカル Web UI。Pi のセッション・認証・モデル・履歴をそのまま使い、会話と Plan の進捗を 1 画面で確認できます。

![Pi Dock Web](https://raw.githubusercontent.com/VarYUvrc/pi-dock/main/docs/images/pi-dock-web.png)

## こんな人向け

Pi をターミナルで使っている人へ。

- 会話と Plan の進捗を、1 画面で見たい
- 実行中のセッションを残したまま、別の会話を開きたい
- Plan をチェックボックスで確認しながら作業したい
- 日本語 IME の変換確定 Enter で誤送信したくない
- Pi の設定・認証・履歴をそのまま使いたい

Pi Dock Web は Pi の TUI を置き換えるものではありません。広い画面、複数セッション、Plan の見やすさを足すための薄い UI です。

### できること

- **Plan パネル** — チェックボックス・状態・進捗を表示。Pi 標準 TUI にはない Web UI 特有の機能で、エージェントの `dock_plan` 更新を即時反映します。トップバーの Plan ボタンで通常幅でも表示/非表示を切り替えられ、現在の状態がボタンの押下状態で分かります。
- **セッション** — セッションごとに Pi プロセスを持ち、実行中でも別の会話へ切り替えられます。
- **会話表示** — ストリーミング、思考/ツールの作業カード、Markdown、画像添付、拡張ダイアログ。
- **モデル / コンテキスト** — モデル、推論強度、コンテキスト使用量、自動圧縮しきい値。しきい値は現在モデルのコンテキストに対する % で表示します。
- **履歴** — 一覧・再開・名前・削除。
- **UI** — English / 日本語、テーマ、IME 確定 Enter 対策。

## 使い始める前に（Pi の準備）

Node.js **22.19 以上**が必要です。Pi 本体もインストールしてください。

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### 認証

Dock から `/login` は実行できません。初回認証はターミナルで済ませてください。

```bash
pi
# 起動したら /login でプロバイダを選択
```

または、Dock を起動するシェルで環境変数を設定します。例: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENCODE_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`。ローカルモデルは `models.json` で設定します。

### モデル

ターミナルの `/model`、または Pi の `settings.json` にある `defaultProvider` / `defaultModel` で選択します。

### 動作確認

```bash
pi -p "Reply with exactly: ok"
# または
pi auth check --provider <provider>
```

### プロジェクトの `.pi` を使う場合

そのプロジェクトで一度 `pi` を起動し、`/trust` を実行してください。RPC モードでは trust プロンプトが出ないため、未 trust のプロジェクト設定・拡張・skills は読み込まれません。Dock が自動 approve することはありません。

`PI_CODING_AGENT_DIR` を変更している場合は、Dock を起動する環境でも同じ値を設定してください。認証情報は Pi の `~/.pi/agent` に保存され、Dock 独自の認証情報は作りません。

## インストール / 起動

**現在は npm 公開前です。** リポジトリを clone して起動してください。

```bash
git clone https://github.com/VarYUvrc/pi-dock.git
cd pi-dock
npm install
npm start -- --cwd /path/to/project
```

ローカルに global install する場合:

```bash
npm install -g .
pi-dock-web --cwd /path/to/project
```

npm 公開後は `npx pi-dock-web --cwd /path/to/project` で起動できる形に整えています。公開予定であり、現時点では `npx` では動きません。`npx pi-dock` は別プロジェクトのパッケージを指すため使用しないでください。

## オプション

```text
--cwd <path>    Pi の作業ディレクトリ（既定: カレント）
--port <port>   127.0.0.1 のポート（既定: $PI_DOCK_PORT または 4310）
--no-open       ブラウザを自動で開かない
--pi <path>     pi 実行ファイルまたは CLI エントリポイント
--continue      そのディレクトリの直近セッションを再開
--help          ヘルプ
--version       バージョン
```

## うまく動かないとき

- **`pi` が見つからない** — `--pi /path/to/pi` または `PI_DOCK_PI` を指定します。
- **モデルが `unknown`、送信に失敗する** — ターミナルで `/login` するか、Dock を起動するシェルに API キーを設定します。`pi auth check --provider <provider>` で確認できます。
- **プロジェクトの `.pi` 設定が効かない** — そのプロジェクトで一度 `pi` を起動し `/trust` を実行します。
- **履歴が空 / 別プロジェクトの履歴が出る** — `--cwd` が Pi で使ったディレクトリと一致しているか確認します。`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` も Dock 側に必要です。
- **ポートが使用中** — `--port 4311` など別のポートを指定します。

## 設計上の判断

- Pi の RPC モードに接続し、エージェントやセッション機構を再実装しません。
- セッションごとに Pi プロセスを 1 つ持ちます。実行中のセッションを止めずに別のセッションへ切り替えます。
- モデル・推論強度・コマンド・履歴は Pi から取得/参照します。
- **Plan だけは意図的な追加**です。`dock_plan` 拡張を読み込み、Plan を Pi のセッション JSONL に custom entry として保存します。Dock がツール実行から進捗を推測することはありません。エージェントが `set` / `update` / `clear` した内容だけを表示します。
- Dock 独自の DB・ログ・設定ファイルは作りません。UI 設定は `localStorage` のみです。Pi の `settings.json` はユーザー操作時（自動圧縮しきい値・有効/無効）だけ更新します。
- 127.0.0.1 限定で待ち受け、Host / Origin / 起動トークンを検証します。Markdown はエスケープ優先でレンダリングします。
- runtime 依存はゼロです。Pi の公式型は devDependency として取り込み、`npm run typecheck` で境界と拡張を検査します。
- 多言語の文言は `public/i18n.js` に集約し、`npm run check:i18n` でキー欠落を検査します。
- ビルド工程はありません。ブラウザは素の ES Module を読みます。

## 対応 Pi バージョン / 既知の制約

- Pi **1.4.0** で動作確認しています。CI では 1.4.0 と週次の最新 Pi を検証します。厳密な semver 保証はせず、Pi の更新に追従が必要になる場合があります。
- TUI 専用のカスタム UI（`custom()` など）は再現しません。RPC ダイアログのみ対応します。
- `/login` `/tree` `/fork` `/clone` など TUI 専用コマンドは Dock から実行できません。
- プロジェクトの `.pi` 設定は Pi の trust に従います。事前の `/trust` が必要です。
- `sessionDir` 設定（`PI_CODING_AGENT_SESSION_DIR` 以外）は履歴一覧に反映されない場合があります。
- Plan 設定を OFF にしても、起動済み Pi プロセスから `dock_plan` 拡張は外れません。OFF は Dock の Plan UI のみを無効化します。
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

実モデルを使う手動スモーク（課金・ネットワークあり。CI では実行しません）:

```bash
npm run smoke -- --cwd /path/to/project "Reply with exactly: pong"
```

一時ファイルはリポジトリ内の `tmp/` を使います。CI は Ubuntu / Windows の Node 22.19 で実行し、週次で最新 Pi との互換性を確認します。公開用の release workflow はまだありません。

## ライセンス

MIT
