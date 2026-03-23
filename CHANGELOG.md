# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-03-23

### Added

- **Job scheduler** — persistent scheduling system with two complementary paths:
  - **User-facing**: `/schedule "prompt" every 30m`, `/jobs`, `/cancel`, `/pause` Telegram commands with natural syntax (`every Nm/Nh`, `at 9am weekdays`, `cron */15 * * * *`, `once at 2pm`)
  - **Claude-facing**: `telegram_scheduler` MCP sidecar injected into every Claude subprocess with `schedule_job`, `list_jobs`, `cancel_job` tools — Claude can self-schedule work that outlives its session
- **Schedule persistence** — jobs survive orchestrator restarts via `~/.claude/channels/telegram/schedules.json`
- **Natural schedule expressions** — `parseScheduleExpression()` converts user-friendly syntax to 5-field cron; `croner` library handles next-run computation
- **Inline job management** — `/jobs` shows jobs with inline pause/cancel buttons; callback queries handle `job:pause:<id>` and `job:cancel:<id>`
- **Scheduler relay endpoints** — `POST /relay/schedule`, `GET /relay/schedules`, `DELETE /relay/schedule/:id` on the relay HTTP server for the MCP sidecar

### Fixed

- Resolved all pre-existing `noNonNullAssertion` lint warnings in `orchestrator.ts`, `relay-server.ts`, and `telegram.ts`

## [0.3.0] - 2026-03-22

### Added

- **Project MCP server loading** — orchestrator reads the target directory's `.mcp.json` and merges project MCP servers into spawned Claude CLI sessions. Projects with MCP servers (e.g., Slack, Jira, Confluence) now work out of the box via `/new`.
- **Explicit setting sources** — passes `--setting-sources user,project,local` to ensure project hooks and permissions are loaded in `-p` mode.
- **PATH augmentation** — spawned Claude CLI processes include `/opt/homebrew/bin` in PATH, fixing MCP server startup failures when running as a launchd daemon with a restricted PATH.

## [0.2.1] - 2026-03-22

### Fixed

- **`claude` not found in daemon** — orchestrator now reads `CLAUDE_BIN` env var for the CLI path, falling back to `"claude"` from `$PATH`. Fixes "Executable not found" when launchd/systemd don't inherit the user's full `$PATH`.
- Daemon install script (`daemon.sh`) auto-detects the `claude` binary path and passes `CLAUDE_BIN` into the launchd plist / systemd unit.

## [0.2.0] - 2025-03-22

### Added

- **npm distribution** — install via `bun add -g @alexnodeland/claude-telegram`
- **Daemon script** — `claude-telegram-daemon install` sets up launchd (macOS) or systemd (Linux) automatically
- **CONTRIBUTING.md** — development setup, code style, testing, and PR guidelines
- **GitHub Release workflow** — tag-triggered CI, GitHub Release, and npm publish with provenance

### Changed

- Quick start defaults to npm install instead of git clone
- Orchestrator and channel mode docs updated for npm install path

## [0.1.0] - 2025-03-22

### Added

- **Orchestrator mode** — standalone process that spawns and manages Claude CLI subprocesses
- **Channel mode** — MCP channel plugin that attaches Telegram to a running Claude Code session
- **Real-time streaming** — tool calls, text, and errors stream as they happen with live status bar
- **Session management** — create, resume, list, and stop sessions across multiple projects
- **Navigable directory browser** — drill into folders, bookmark shortcuts, pick project roots
- **Permission relay** — approve/deny/always prompts forwarded to Telegram with granular options
- **Slash command pass-through** — `/cc commit`, `/cc review-pr`, etc.
- **Mode switching** — normal, plan, and auto-accept permission modes
- **Model switching** — sonnet, opus, haiku via `/model`
- **Pairing-code access control** — 6-character codes, 10-minute expiry, persistent allowlist
- **Cost tracking** — per-session token usage and cost display
- **HTML formatting** — all output uses Telegram HTML parse mode for reliable rendering
- **Zero Telegram SDK** — all API calls use native `fetch`

[0.4.0]: https://github.com/alexnodeland/claude-telegram/releases/tag/v0.4.0
[0.2.1]: https://github.com/alexnodeland/claude-telegram/releases/tag/v0.2.1
[0.2.0]: https://github.com/alexnodeland/claude-telegram/releases/tag/v0.2.0
[0.1.0]: https://github.com/alexnodeland/claude-telegram/releases/tag/v0.1.0
