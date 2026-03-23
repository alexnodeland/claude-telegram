# claude-telegram

Telegram-to-Claude-Code bridge with two operating modes.

## Architecture

Two entry points, shared modules:
- `src/index.ts` — **Channel mode**: MCP server with `claude/channel` capability, attaches to a running Claude Code session
- `src/orchestrator.ts` — **Orchestrator mode**: standalone process that spawns and manages Claude CLI subprocesses

Shared: `telegram.ts` (API client), `html.ts` (HTML formatting), `access.ts` (pairing/allowlist), `config.ts`, `types.ts`, `commands.ts`, `sessions.ts`, `streaming.ts`

Sidecar: `permission-relay.ts` + `relay-server.ts` handle permission prompts in orchestrator mode via local HTTP relay.

Sidecar: `scheduler-relay.ts` exposes scheduling MCP tools to Claude sessions, relaying to `relay-server.ts`. Scheduler state managed by `scheduler.ts` (`ScheduleManager`).

## Runtime

- **Bun >= 1.1** — not Node. Uses Bun APIs (`Bun.spawn`, `Bun.serve`).
- **Zero Telegram SDK** — all Telegram API calls use native `fetch` in `src/telegram.ts`.
- **Dependencies**: `@modelcontextprotocol/sdk`, `zod`, `croner` (cron expression evaluation).

## Commands

Use [`just`](https://github.com/casey/just) for all tasks. Run `just` to see available recipes.

```bash
just setup             # Install deps + configure git hooks
just dev               # Channel mode (watch)
just dev-orchestrator  # Orchestrator mode (watch)
just ci                # Run all checks (typecheck + lint + test)
just typecheck         # tsc --noEmit
just check             # Biome lint + format check
just fix               # Biome auto-fix
just test              # Run tests
just test-watch        # Watch mode
```

## Key Design Decisions

### HTML parse mode
All Telegram messages use `parse_mode: "HTML"` (not Markdown). Telegram's legacy Markdown is fragile — `_`, `*`, `[`, `` ` `` in code output silently break formatting. HTML only requires escaping `&`, `<`, `>`. The `src/html.ts` module provides `escapeHtml()` and a `fmt` helper object (`fmt.bold()`, `fmt.code()`, `fmt.pre()`, etc.) that auto-escape content.

### Navigable directory browser
`/new` with no path shows a paginated file browser. Users can drill into subdirectories, go up, and confirm with "Start here". Bookmarks (`/bookmark`) and recent session dirs are shown as shortcuts. Telegram `callback_data` is limited to 64 bytes, so the browser uses an in-memory index map (`dirBrowserState`) instead of embedding paths in button data.

### Permission modes
`/mode` switches between normal (relay prompts), plan (Claude plans first), and auto-accept (skip prompts). Stored per-session and passed as `--permission-mode` or `--dangerously-skip-permissions` to the Claude CLI subprocess.

### Session titles
Sessions capture auto-generated titles from Claude's first text response (or `conversation_name` from the init message). `/sessions` and `/resume` display titles instead of opaque UUIDs. `findByTitle()` enables fuzzy resume by title substring.

### Project MCP server loading
When spawning a session via `/new`, the orchestrator reads the target directory's `.mcp.json` and merges those MCP servers into the `--mcp-config` passed to the Claude CLI subprocess. This ensures project-level MCP servers are available even in `-p` mode where the workspace trust dialog is skipped. The `--setting-sources user,project,local` flag is also passed explicitly to load all settings layers (hooks, permissions). The spawned process PATH is augmented with `/opt/homebrew/bin` to handle launchd's restricted PATH.

### `/cc` slash command pass-through
`/cc <command>` forwards Claude Code slash commands (commit, review-pr, plan, etc.) to the active session. `/cc` alone shows an interactive menu of common commands.

### Job scheduling
Two complementary scheduling paths:

**User-facing** — Telegram commands create persistent scheduled jobs:
- `/schedule "prompt" every 30m` — natural syntax (`every Nm/Nh`, `at 9am weekdays`, `cron */15 * * * *`, `once at 2pm`)
- `/jobs` — list with inline pause/cancel buttons
- `/cancel <id>`, `/pause <id>` — manage jobs

**Claude-facing** — Every Claude subprocess gets a `telegram_scheduler` MCP sidecar (injected via `--mcp-config` alongside `telegram_relay`). Tools: `schedule_job`, `list_jobs`, `cancel_job`. Claude can self-schedule work that outlives its session (e.g. "check the deploy every 30 minutes").

Both paths write to the same `ScheduleManager` (persisted at `~/.claude/channels/telegram/schedules.json`). The orchestrator runs a 30-second `setInterval` tick that calls `getDueJobs()` and executes them via the existing `handlePrompt` → `runQuery` pipeline. Jobs that fire while a chat is busy are skipped (not queued). Execution is recorded *before* spawning to prevent crash → infinite retry. One-shot jobs auto-delete after firing.

`parseScheduleExpression()` in `src/scheduler.ts` converts natural language to 5-field cron. The `croner` library handles next-run computation. Max 25 jobs per chat.

## Testing

Tests in `tests/` using Bun's built-in test runner.

- `tests/commands.test.ts` — command parser (covers /cc, /mode, /dirs, /bookmark, /schedule, /jobs, /cancel, /pause, unknown commands)
- `tests/access.test.ts` — pairing codes, allowlist, persistence
- `tests/sessions.test.ts` — SessionManager CRUD, cost tracking
- `tests/scheduler.test.ts` — ScheduleManager CRUD, cron parsing, getDueJobs, `parseScheduleExpression`, persistence
- `tests/streaming.test.ts` — message chunking, HTML tool formatting, step counter, error indication
- `tests/html.test.ts` — escapeHtml, fmt helpers

Mock `TelegramClient` as a duck-typed object; don't mock `fetch` globally.

## Code Style

Biome handles lint + format. Run `just fix` to auto-fix.
- 2-space indent, 120 char line width
- ESM imports with `.js` extensions (TypeScript ESM convention)
- Errors to `process.stderr.write()` — never `console.log` (preserves stdio transport)

## Git Hooks

Pre-commit runs `just ci` (typecheck + lint + test). Auto-configured on `just setup`.
