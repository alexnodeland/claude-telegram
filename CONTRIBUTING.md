# Contributing

Thanks for your interest in contributing to claude-telegram! This guide will help you get set up for local development.

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- [just](https://github.com/casey/just) (task runner)
- A Telegram bot token for testing (message [@BotFather](https://t.me/BotFather))

## Getting started

```bash
# Clone the repo
git clone https://github.com/alexnodeland/claude-telegram.git
cd claude-telegram

# Install deps + configure git hooks
just setup

# Set your bot token
export TELEGRAM_BOT_TOKEN=your_token_here

# Run in watch mode
just dev-orchestrator
```

`just setup` installs dependencies and configures the pre-commit hook, which runs `just ci` (typecheck + lint + test) before every commit.

## Project structure

```
src/
├── index.ts             # Channel mode entry point (MCP server)
├── orchestrator.ts      # Orchestrator mode entry point (standalone)
├── telegram.ts          # Telegram Bot API client (native fetch)
├── html.ts              # HTML formatting helpers (escapeHtml, fmt.*)
├── access.ts            # Pairing codes, allowlist, persistence
├── commands.ts          # Command parser
├── sessions.ts          # Session manager (CRUD, cost tracking)
├── streaming.ts         # Message chunking, tool formatting, status bar
├── config.ts            # Configuration constants
├── types.ts             # Shared type definitions
├── permission-relay.ts  # Permission prompt forwarding
└── relay-server.ts      # Local HTTP server for permission relay
tests/
├── access.test.ts       # Pairing codes, allowlist, persistence
├── commands.test.ts     # Command parser
├── html.test.ts         # HTML escaping and formatting
├── sessions.test.ts     # Session manager CRUD, cost tracking
└── streaming.test.ts    # Message chunking, tool formatting
```

## Development commands

Run `just` to see all available recipes. The most common ones:

```bash
just dev-orchestrator  # Orchestrator mode with watch
just dev               # Channel mode with watch
just ci                # Run all checks (typecheck + lint + test)
just typecheck         # TypeScript type checking only
just check             # Biome lint + format check
just fix               # Biome auto-fix lint + format
just test              # Run all tests
just test-watch        # Run tests in watch mode
just test-file <path>  # Run a specific test file
```

## Code style

[Biome](https://biomejs.dev/) handles linting and formatting. Run `just fix` to auto-fix issues.

- 2-space indent, 120 character line width
- ESM imports with `.js` extensions (TypeScript ESM convention)
- Errors to `process.stderr.write()` — never `console.log` (preserves stdio transport)
- HTML parse mode for all Telegram output — use `escapeHtml()` and `fmt.*` helpers from `src/html.ts`

## Testing

Tests use Bun's built-in test runner.

```bash
just test              # Run all 112 tests
just test-watch        # Watch mode
just test-file tests/html.test.ts  # Single file
```

When writing tests:
- Mock `TelegramClient` as a duck-typed object — don't mock `fetch` globally
- Keep tests as pure functions where possible (commands, HTML formatting, streaming)
- See existing tests for patterns

## Key design decisions

- **Zero Telegram SDK** — all API calls use native `fetch` in `src/telegram.ts`. Keep it that way.
- **HTML parse mode** — Telegram's Markdown parser is fragile. All output uses HTML with `escapeHtml()`. Never use `parse_mode: "Markdown"`.
- **Bun runtime** — uses Bun-specific APIs (`Bun.spawn`, `Bun.serve`). Not compatible with Node.js.
- **Two entry points** — `src/index.ts` (channel mode) and `src/orchestrator.ts` (orchestrator mode) share modules but serve different use cases.

## Submitting changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `just ci` to verify everything passes
4. Open a pull request against `main`

The pre-commit hook runs `just ci` automatically, so if your commit succeeds locally, CI should pass too.

## Releases

Releases are automated via GitHub Actions. Maintainers tag releases with:

```bash
just release X.Y.Z    # Bumps version, commits, tags
git push origin main vX.Y.Z  # Triggers CI → GitHub Release → npm publish
```
