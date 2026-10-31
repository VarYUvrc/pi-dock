<p>
  <img src="https://raw.githubusercontent.com/VarYUvrc/pi-tinychat/main/public/favicon.svg" width="48" height="48" alt="Pi TinyChat アイコン" />
</p>

# Pi TinyChat

**Tiny UI. Full Pi. Zero Bloat.**

[![npm version](https://img.shields.io/npm/v/pi-tinychat)](https://www.npmjs.com/package/pi-tinychat)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/VarYUvrc/pi-tinychat/blob/main/LICENSE)

[English](../README.md) | 日本語

Pi TinyChat は、[Pi coding agent](https://pi.dev) をローカルブラウザで開くための小さな UI です。左に会話、右に Plan。

ターミナルの Pi は好きだけど、長時間の作業はもう少し落ち着いた画面で見たい。そんな人のための、余計なアプリを増やさないローカル UI です。

> Pi TinyChat は独立したコミュニティプロジェクトです。Pi の公式プロジェクトではなく、Pi のメンテナとは関係ありません。

![Pi TinyChat のスクリーンショット](https://raw.githubusercontent.com/VarYUvrc/pi-tinychat/main/docs/images/pi-tinychat.png)

## できること

- **Plan をひと目で。** エージェントがチェックリストを公開し、右パネルに完了・実行中・待機中の項目が表示されます。局面が変わると、ユーザーの言語で書かれた短い進捗メモが実行中の項目の下に積み上がります。
- **体感できるコンテキスト管理。** 自動圧縮をモデルの 25% / 50% / 75%、または Pi の既定から選べます。次の長いターンの前に、コンテキストリングと実際の余裕を確認できます。長いコンテキストのモデルは窓が埋まる前から精度が落ちることが多く、25〜50% あたりが実用的です。リングを開けばプリセットを切り替えられ、手動で圧縮したいときは + ボタンのコマンド一覧から `/compact` を実行できます。
- **セッションを止めずに切り替え。** 実行中の会話を残したまま、別の会話を開けます。セッションごとに Pi プロセスを持ちます。
- **読みやすい会話。** ストリーミング Markdown、コンパクトな思考・ツールカード、画像添付、拡張ダイアログ。
- **使い慣れた Pi の設定。** ログイン、モデル、推論強度、コンテキスト使用量、自動圧縮、履歴は Pi のものをそのまま使います。
- **小さい構成。** ブラウザは素の ES Module、通信は Pi RPC の JSONL。React、バンドラ、データベース、実行時依存はありません。

## クイックスタート

**Node.js 22.19 以上**と Pi が必要です。Pi TinyChat はカレントディレクトリを対象に Pi を起動します。作業したいプロジェクトで実行します。

```bash
npx pi-tinychat
```

別のディレクトリから起動するときは `--cwd /path/to/project` を指定します。

コマンドをグローバルにインストールする場合:

```bash
npm install -g pi-tinychat
pi-tinychat
```

ブラウザが `http://127.0.0.1:4310` で開きます。ポートが埋まっている場合は、空いている次のポートを自動で使います。別のポートから始めるときは `--port`、ブラウザを自動で開かないときは `--no-open` を使います。

認証はターミナルで一度だけ済ませます。Pi TinyChat はそのログインをそのまま使います。

```bash
pi
/login
```

`/login` の代わりに API キーを使う場合は、Pi TinyChat を起動するシェルでプロバイダのキーを設定します。例: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENCODE_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`。

npm パッケージには `pi-package` キーワードが付いており、Pi のパッケージカタログから発見できます。

## Plan パネル

Pi TinyChat には、エージェントに `tiny_plan` ツールを渡す小さな Pi 拡張が同梱されています。複数ステップの作業では、エージェントが最初の実質的なツール呼び出し前に短い暫定計画を書き、作業に合わせて各項目を実行中・完了へ更新します。Plan の粒度は上げず、ステップ間の現在地は1文の `note` で伝えます。

右パネルはその内容をすぐに反映し、Plan は Pi セッションに保存されます。会話を再開したときもチェックリストが戻ります。`note` は実行中の項目の下に箇条書きで積み上がり、実行中のツールは会話側の経過時間の隣に表示されます。パネルで全体像を、会話で細部を追えます。

## オプション

```text
--cwd <path>    Pi の作業ディレクトリ（既定: カレント）
--port <port>   127.0.0.1 の開始ポート（既定: $PI_TINYCHAT_PORT または 4310。使用中なら次の空きポート）
--no-open       ブラウザを自動で開かない
--pi <path>     pi 実行ファイルまたは CLI エントリポイント
--continue      そのディレクトリの直近セッションを再開
--help          ヘルプ
--version       バージョン
```

## セキュリティ

Pi TinyChat はローカル完結を前提にしています。

- **実行時依存もインストールスクリプトもありません。** npm パッケージは素の JavaScript と 1 つの Pi 拡張だけで、依存ツリーをプロジェクトに追加しません。
- **localhost のみ。** `127.0.0.1` にだけ待ち受け、Host・Origin ヘッダーと起動ごとのトークンを検証します。
- **起動トークンは Cookie に交換。** 起動 URL のトークンは `HttpOnly` / `SameSite=Strict` の Cookie に交換し、URL からは取り除かれます。
- **厳しめのブラウザポリシー。** 静的ファイルには Content Security Policy、`nosniff`、no-store を付けます。Markdown は描画前にエスケープします。
- **リリースを検証可能に。** `npm publish` 前に lint、型チェック、i18n、実 Pi のオフライン統合テスト、tarball 検査を実行します。GitHub Actions からは npm provenance 付きで公開します。
- **テレメトリなし。** 利用状況をどこにも送信しません。

## 仕組み

- **ローカル完結。** 会話と設定は Pi のファイルを使います。UI 設定は `localStorage` に置き、独自のデータベースやログストアは作りません。
- **Pi の状態をそのまま。** ログイン、モデル、推論強度、コンテキスト使用量、圧縮設定は Pi のものを読みます。
- **セッションごとに独立したプロセス。** バックグラウンドのセッションは生き続けるため、会話を切り替えても実行中の処理は止まりません。
- **公式 RPC。** Pi を `pi --mode rpc` の独立プロセスとして起動し、JSONL で通信します。エージェントの動作は Pi に任せます。

## 他の Pi UI

| UI | 向いている場面 |
| --- | --- |
| **Pi TinyChat** | Plan パネルと圧縮プリセット付きの小さなローカルチャット。ビルド工程も実行時依存もありません。 |
| [pi-web](https://github.com/agegr/pi-web) | セッション分岐、Git Worktree、ファイル閲覧、MCP・モデル・Skills 管理、サブエージェント、モバイルまで備えたフル Web ワークスペース。 |
| [pi-web-simple](https://pi.dev/packages/pi-web-simple) | Git とファイル管理を備えた、RPC ベースのシンプルな Web UI。 |
| [pipane](https://github.com/mike-heunher/pipane) | Pi を RPC でつなぐもう 1 つのブラウザ UI。 |

## うまく動かないとき

- **`pi` が見つからない** — `--pi /path/to/pi` または `PI_TINYCHAT_PI` を指定します。
- **モデルが `unknown`、送信に失敗する** — ターミナルで `/login` するか、Pi TinyChat を起動するシェルに API キーを設定します。`pi auth check --provider <provider>` で確認できます。
- **プロジェクトの `.pi` 設定が効かない** — そのプロジェクトで一度 `pi` を起動し、`/trust` を実行します。RPC モードも Pi の trust ルールに従います。
- **履歴が空 / 別プロジェクトの履歴が出る** — `--cwd` が Pi で使ったディレクトリと一致しているか確認します。`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` を変更している場合は、Pi TinyChat 側にも同じ値を設定します。
- **ポートが使用中** — 次の 20 ポートまで自動で試します。開始ポートを変えたいときは `--port` を指定します。

## 対応バージョンと制約

| 項目 | 内容 |
| --- | --- |
| Pi のバージョン | **1.4.0** で動作確認済み。CI では週次の最新 Pi も検証します。 |
| Node.js | **22.19** 以上。 |
| OS | Windows 10/11、macOS、Linux（WSL を含む）。 |
| ターミナル向け機能 | `/login` `/tree` `/fork` `/clone` や TUI 専用のカスタム UI は、Pi のターミナルで使います。 |
| プロジェクトの `.pi` | Pi の trust に従います。事前にそのプロジェクトで `/trust` を実行してください。 |
| リソース | セッションを開いている間は Pi プロセスが残るため、同時数に応じてメモリ/CPU を使います。 |
| 複数タブ | タブ間のセッション切替は同期しません。 |

## 開発

```bash
npm ci
npm link                      # ローカルで pi-tinychat コマンドを使えるようにする
pi-tinychat                   # このリポジトリを対象に起動
npm run check                 # lint、型、i18n、E2E、tarball 検査
```

個別のチェックと実モデル用の手動スモークは `package.json` に定義しています。CI は Ubuntu / Windows の Node 22.19 で実行し、週次で最新 Pi との互換性を確認します。

## ライセンス

[MIT](https://github.com/VarYUvrc/pi-tinychat/blob/main/LICENSE)
