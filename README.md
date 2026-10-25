# Pi TinyChat

**Tiny UI. Full Pi. Zero Bloat.**

English | [日本語](docs/README.ja.md)

Pi TinyChat is a small, local web UI for the [Pi coding agent](https://pi.dev). It adds a wide screen, multiple sessions, and a readable plan view to Pi's terminal workflow — without rebuilding Pi.

![Pi TinyChat](https://raw.githubusercontent.com/VarYUvrc/pi-tinychat/main/docs/images/pi-tinychat.png)

> Pi TinyChat is an independent community project. It is not an official Pi project and is not affiliated with the Pi maintainers.

## Who it is for

You already use Pi in a terminal and want to:

- see the conversation and the current plan on one screen
- switch to another conversation while a session keeps running
- review plan items as checkboxes instead of scrolling back
- send messages with Ctrl+Enter without accidentally submitting while an IME is composing
- keep using Pi's own authentication, models, settings, and session history

Pi TinyChat is not a replacement for Pi's TUI. It is a thin UI that adds space, visibility, and session handling.

## Features

- **Plan panel** — shows status, checkboxes, and progress. The bundled Plan tool writes plans into Pi's session as custom entries, and the panel updates as soon as the agent changes them. Plan items never advance from guessed tool activity.
- **Independent sessions** — each session keeps its own Pi process, so switching conversations does not stop work in progress.
- **Conversation view** — streaming output, compact thinking and tool cards, Markdown, image attachments, and extension dialogs.
- **Models and context** — model, reasoning effort, context usage, and the auto-compaction threshold shown as a percentage of the current model's context window.
- **History** — list, resume, rename, and delete Pi sessions.
- **Notifications** — English and Japanese toasts and dialogs, light/dark/system themes, a resizable plan panel, and IME-safe submit.

## Before you start

Node.js **22.19 or newer** is required. Node 20 is not supported. You also need Pi itself:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

### Authentication

Pi TinyChat cannot run `/login` for you. Authenticate once in a terminal:

```bash
pi
# then run /login
```

Alternatively, set a provider key in the shell that launches Pi TinyChat, for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`. Local models are configured in `models.json`.

### Models

Choose a model with `/model` in Pi, or set `defaultProvider` / `defaultModel` in Pi's `settings.json`.

### Check the setup

```bash
pi -p "Reply with exactly: ok"
# or
pi auth check --provider <provider>
```

### Project `.pi` settings

If a project has its own `.pi` settings, extensions, or skills, run `pi` once in that project and execute `/trust`. RPC mode does not show the trust prompt, so untrusted project configuration is not loaded. Pi TinyChat never approves trust on your behalf.

If you change `PI_CODING_AGENT_DIR`, use the same value in the environment that launches Pi TinyChat. Credentials stay in Pi's `~/.pi/agent`; Pi TinyChat does not keep its own credentials.

## Run

**The package is not published on npm yet.** Clone the repository for now:

```bash
git clone https://github.com/VarYUvrc/pi-tinychat.git
cd pi-tinychat
npm install
npm start -- --cwd /path/to/project
```

To install locally:

```bash
npm install -g .
pi-tinychat --cwd /path/to/project
```

Once published, the intended command is:

```bash
npx pi-tinychat --cwd /path/to/project
```

## Options

```text
--cwd <path>    Working directory for Pi (default: current directory)
--port <port>   Port on 127.0.0.1 (default: $PI_TINYCHAT_PORT or 4310)
--no-open       Do not open the browser automatically
--pi <path>     Path to the pi executable or CLI entry point
--continue      Resume the most recent Pi session in the directory
--help          Show help
--version       Show the version
```

## How it differs

Other Pi web UIs are useful, and Pi TinyChat does not compete with them on feature count:

- **[pi-web](https://github.com/agegr/pi-web)** — a full web workspace built with Next.js, React, and the Pi SDK. It includes session branching, Git worktrees, file browsing, MCP/model/skill management, subagents, and mobile support.
- **[pi-web-simple](https://pi.dev/packages/pi-web-simple)** — a web UI built on Pi's official RPC, with Git and file management.
- **[pipane](https://github.com/mike-heunher/pipane)** — another browser UI that talks to Pi over RPC.

Pi TinyChat deliberately stays smaller. Instead of reimplementing Pi's capabilities, it connects to Pi and gives the chat and plan experience more room.

## Design

- **Zero runtime dependencies.** No React, Next.js, bundler, or build step. The browser loads plain ES modules.
- **Official RPC.** Pi TinyChat starts Pi with `pi --mode rpc` as a separate process and speaks JSONL. Agent behavior remains Pi's responsibility.
- **Pi-native state.** Conversations and settings use Pi's files. There is no separate database, log store, or settings file; UI preferences live in `localStorage`.
- **Independent sessions.** Each session keeps a Pi process alive, so switching conversations does not interrupt running work.
- **Local-first.** The server binds to localhost and validates Host, Origin, and a per-launch token. Markdown rendering prioritizes escaping.
- **Focused UI.** Thinking and tool calls are compact, and the plan panel shows exactly what the agent published. Pi TinyChat does not infer progress from tool calls.
- **Compatibility over renaming.** The internal Plan tool and session entry keep their historical `dock_plan` / `dock_plan_state` names so plans stored in existing Pi sessions remain readable.

"Lightweight" here means a small stack with few dependencies and responsibilities. It is not a claim about minimum memory use or feature count.

## Troubleshooting

- **`pi` is not found** — pass `--pi /path/to/pi` or set `PI_TINYCHAT_PI`.
- **The model is `unknown` or sending fails** — run `/login` in a terminal, or set an API key in the shell that launches Pi TinyChat. Check with `pi auth check --provider <provider>`.
- **Project `.pi` settings have no effect** — run `pi` once in that project and execute `/trust`.
- **History is empty or shows another project** — make sure `--cwd` matches the directory you used with Pi. `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` must also be visible to Pi TinyChat.
- **The port is in use** — pass another port, for example `--port 4311`.

## Compatibility and limitations

- Tested with Pi **1.4.0**. CI checks 1.4.0 and the latest weekly Pi release. No strict semver guarantee is implied; Pi changes may require follow-up work.
- TUI-only custom UI (`custom()` and similar) is not reproduced. Only RPC dialogs are supported.
- TUI-only commands such as `/login`, `/tree`, `/fork`, and `/clone` cannot run from Pi TinyChat.
- Project `.pi` configuration follows Pi's trust rules and requires `/trust` beforehand.
- A custom `sessionDir` setting may not appear in the history list unless `PI_CODING_AGENT_SESSION_DIR` is set.
- Turning the Plan setting off hides Pi TinyChat's Plan UI; it does not remove the Plan extension from an already running Pi process.
- Background sessions keep Pi processes alive, so memory and CPU use grow with the number of open sessions.
- Session switching is not synchronized across multiple tabs.
- Fork, clone, and branch-tree views are not implemented.

## Development

```bash
npm ci
npm run lint
npm run typecheck      # src + extension
npm run check:i18n
npm test               # Playwright E2E
npm run test:pi        # real Pi, offline, no authentication
npm run pack:check     # tarball contents and CLI startup
npm run check          # all of the above
```

Manual smoke test with a real model (network and billing; not run in CI):

```bash
npm run smoke -- --cwd /path/to/project "Reply with exactly: pong"
```

Use the repository's `tmp/` directory for temporary files. CI runs on Node 22.19 on Ubuntu and Windows, with a weekly check against the latest Pi. There is no release workflow yet.

## License

MIT
