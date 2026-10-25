<p>
  <img src="public/favicon.svg" width="48" height="48" alt="Pi TinyChat icon" />
</p>

# Pi TinyChat

**Tiny UI. Full Pi. Zero Bloat.**

English | [日本語](docs/README.ja.md)

Pi TinyChat is a local browser window for the [Pi coding agent](https://pi.dev). The conversation stays on the left, the plan stays on the right, and Pi keeps doing the agent work.

It is for people who like Pi in a terminal but want a calmer screen for long tasks — without adding a second app to babysit.

> Pi TinyChat is an independent community project. It is not an official Pi project and is not affiliated with the Pi maintainers.

## What you get

- **A plan you can glance at.** The agent publishes a checklist, and the right panel shows done, current, and pending items while it works.
- **Sessions that keep running.** Open another conversation without stopping the one in flight. Each session has its own Pi process.
- **A conversation made for reading.** Streaming Markdown, compact thinking and tool cards, image attachments, and extension dialogs.
- **Your Pi setup.** Login, models, reasoning effort, context usage, auto-compaction, and session history come from Pi itself.
- **A small stack.** Plain ES modules in the browser, JSONL over Pi RPC, no React, no bundler, no database, and no runtime dependencies.

## Quick start

You need **Node.js 22.19 or newer** and Pi:

```bash
node --version
pi --version
```

Authenticate once in a terminal; Pi TinyChat reuses that login:

```bash
pi
/login
```

Then start from source (the npm package is not published yet):

```bash
git clone https://github.com/VarYUvrc/pi-tinychat.git
cd pi-tinychat
npm install
npm start -- --cwd /path/to/project
```

The browser opens at `http://127.0.0.1:4310`. Use `--port` if that port is taken.

To install the command locally:

```bash
npm install -g .
pi-tinychat --cwd /path/to/project
```

If you use API keys instead of `/login`, set the provider key in the shell that launches Pi TinyChat, for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY`.

## The plan panel

Pi TinyChat includes a small Pi extension that gives the agent a plan tool. For a multi-step task, the agent writes the complete ordered plan in one call, then marks each step in progress and done as it goes.

The right panel mirrors that plan immediately and stores it in the Pi session, so reopening or resuming the conversation brings the checklist back. It is the fastest way to see what the agent is doing, what is finished, and what is left.

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

## How it works

- **Local first.** The server listens on localhost and checks Host, Origin, and a per-launch token. Markdown rendering escapes content first.
- **Pi-native state.** Conversations and settings use Pi's files. UI preferences live in `localStorage`; there is no separate database or log store.
- **One process per session.** Background sessions stay alive, so switching conversations does not interrupt running work.
- **Official RPC.** Pi runs as a separate `pi --mode rpc` process and speaks JSONL. Agent behavior stays with Pi.

## Other Pi UIs

| UI | Best for |
| --- | --- |
| **Pi TinyChat** | A small local chat with a live Plan panel. No build step or runtime dependencies. |
| [pi-web](https://github.com/agegr/pi-web) | A full web workspace: session branching, Git worktrees, file browsing, MCP/model/skill management, subagents, and mobile. |
| [pi-web-simple](https://pi.dev/packages/pi-web-simple) | A simple RPC-based web UI with Git and file management. |
| [pipane](https://github.com/mike-heunher/pipane) | Another RPC-based browser UI for Pi. |

## Troubleshooting

- **`pi` is not found** — pass `--pi /path/to/pi` or set `PI_TINYCHAT_PI`.
- **The model is `unknown` or sending fails** — run `/login` in a terminal, or set a provider API key in the shell that launches Pi TinyChat. Check with `pi auth check --provider <provider>`.
- **Project `.pi` settings have no effect** — run `pi` once in that project and execute `/trust`. RPC mode follows Pi's trust rules.
- **History is empty or shows another project** — make sure `--cwd` matches the directory you use with Pi. Set `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` in the same environment if you customize them.
- **The port is in use** — pass another port, for example `--port 4311`.

## Compatibility

| Item | Detail |
| --- | --- |
| Pi version | Tested with **1.4.0**; CI also checks the latest weekly Pi release. |
| Terminal-first features | `/login`, `/tree`, `/fork`, `/clone`, and TUI-only custom UI stay in the Pi terminal. |
| Project `.pi` | Follows Pi's trust rules. Run `/trust` once in the project before starting Pi TinyChat. |
| Resources | Each open session keeps a Pi process alive, so memory and CPU use grow with the number of sessions. |
| Multiple tabs | Session switching is not synchronized across browser tabs. |

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

Use the repository's `tmp/` directory for temporary files. CI runs on Node 22.19 on Ubuntu and Windows, with a weekly check against the latest Pi.

## License

MIT
