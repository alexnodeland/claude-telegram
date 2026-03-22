<div align="center">

# 📱 claude-telegram

**Bridge Telegram to Claude Code — control your codebase from your phone**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun_%3E%3D1.1-f9f1e1?logo=bun)](https://bun.sh)
[![Claude Code](https://img.shields.io/badge/Claude_Code-%3E%3D2.1.80-cc785c?logo=anthropic)](https://code.claude.com)
[![MCP](https://img.shields.io/badge/MCP-Channel_Plugin-blue)](https://modelcontextprotocol.io)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram)](https://core.telegram.org/bots/api)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Zero SDKs](https://img.shields.io/badge/Telegram_SDK-None_(native_fetch)-green)]()

</div>

---

A two-way bridge between Telegram and [Claude Code](https://code.claude.com). Send messages from your phone, get responses from Claude with full access to your codebase, files, and tools — nothing leaves your machine.

Two modes:

- **Channel mode** — attach Telegram to an existing Claude Code session
- **Orchestrator mode** — standalone process that spawns and manages Claude Code sessions from Telegram, with real-time streaming, permission prompts, and session management

```
Phone (Telegram)
   ↕
Telegram Bot API
   ↕
claude-telegram (Bun, runs locally)
   ↕
Claude Code (your machine — reads/edits files, runs commands, replies)
```

---

## Features

**Channel mode:**
- Live two-way messaging between Telegram and a running Claude Code session
- File and image uploads from Claude to Telegram
- Message reactions, edits, and typing indicators
- Pairing-code access control with persistent allowlist

**Orchestrator mode:**
- Start Claude Code sessions in any directory from Telegram
- Navigable directory browser — browse folders, tap to select, bookmark shortcuts
- `/cc` command menu — run Claude Code slash commands (`/cc commit`, `/cc review-pr`, etc.)
- Permission modes — switch between normal, plan, and auto-accept from Telegram
- Real-time streaming — each response is a separate message bubble with step counter
- Tool call visibility — see what Claude is reading, editing, running
- Permission prompts with tool descriptions, timeout indicator, and Allow/Deny buttons
- Session management with auto-generated titles — create, resume, switch, stop
- Interactive session picker with inline keyboards
- Cost tracking per session
- Bot menu commands for discoverability

**Both modes:**
- Zero external SDKs — uses native `fetch` against the Telegram Bot API
- Secure by default — pairing codes + allowlist, no inbound ports
- Bun runtime, TypeScript, minimal dependencies

---

## Quick Start

### Prerequisites

| Requirement | Version |
|---|---|
| [Bun](https://bun.sh) | >= 1.1 |
| [Claude Code](https://code.claude.com) | >= 2.1.80 |
| Telegram account | any |

### 1. Create a Telegram bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`, follow the prompts
3. Copy the token (looks like `123456789:AAHfiqksKZ8WmH...`)

### 2. Install

```bash
git clone https://github.com/yourname/claude-telegram.git
cd claude-telegram
bun install
```

### 3. Set your bot token

```bash
# Option A: environment variable
export TELEGRAM_BOT_TOKEN=123456789:AAH...

# Option B: persistent .env file
mkdir -p ~/.claude/channels/telegram
echo "TELEGRAM_BOT_TOKEN=123456789:AAH..." > ~/.claude/channels/telegram/.env
```

### 4. Choose your mode

**Channel mode** — attach to an existing Claude Code session:

```bash
claude --dangerously-load-development-channels server:telegram
```

**Orchestrator mode** — standalone, manages its own sessions:

```bash
bun run start:orchestrator
```

---

## Channel Mode

Runs as an MCP channel plugin inside a Claude Code session. Messages from Telegram appear as channel events that Claude can read and respond to.

### Setup

Add to `.mcp.json` in your project root (or `~/.claude.json` globally):

```json
{
  "mcpServers": {
    "telegram": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/claude-telegram/src/index.ts"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "123456789:AAH..."
      }
    }
  }
}
```

Then start Claude Code with the channel flag:

```bash
claude --dangerously-load-development-channels server:telegram
```

### Pairing

1. Send `/start` to your bot in Telegram
2. The bot replies with a 6-character pairing code
3. In Claude Code, run: `/telegram:access pair <CODE>`
4. Lock down: `/telegram:access policy allowlist`

### Access Commands

Run these inside Claude Code:

| Command | Description |
|---|---|
| `/telegram:access pair <CODE>` | Approve a pairing request |
| `/telegram:access policy pairing` | Allow new pairings (default) |
| `/telegram:access policy allowlist` | Locked — only paired users |
| `/telegram:access policy open` | Anyone can message (testing only) |
| `/telegram:access remove <USER_ID>` | Revoke a user |
| `/telegram:access status` | Show bot info, policy, allowlist |

### MCP Tools

These are the tools Claude uses internally — you don't call them directly:

| Tool | Description |
|---|---|
| `telegram_reply` | Send text reply (HTML, max 4096 chars) |
| `telegram_react` | Add emoji reaction to a message |
| `telegram_edit_message` | Edit a previous bot message |
| `telegram_send_file` | Upload a local file or image (max 50 MB) |
| `telegram_send_typing` | Show typing indicator |

---

## Orchestrator Mode

Runs as a standalone process. Spawns Claude Code subprocesses per session, streams output to Telegram in real time, and relays permission prompts for user approval.

### Running

```bash
bun run start:orchestrator
```

Or with watch mode for development:

```bash
bun run dev:orchestrator
```

### First-time setup

1. Start the orchestrator
2. Send `/start` to your bot in Telegram
3. An approved user sends `/approve <CODE>` to pair new users
4. Or pre-approve users via environment variable:
   ```bash
   TELEGRAM_ALLOWED_USERS=783772449,123456 bun run start:orchestrator
   ```

### Telegram Commands

Commands are registered in Telegram's bot menu for autocomplete.

**Session Management:**

| Command | Description |
|---|---|
| `/new [path]` | Start a new session (shows directory browser if no path) |
| `/new [path] --name foo` | Start a named session |
| `/resume [name\|id\|title]` | Resume a previous session (shows picker) |
| `/sessions` | List all sessions with tap-to-resume buttons |
| `/stop` | Stop current task / end session |
| `/compact` | Fresh session in the same directory |

**Claude Code:**

| Command | Description |
|---|---|
| `/cc [command]` | Run a Claude Code slash command (shows menu if no command) |
| `/mode [normal\|plan\|auto]` | Switch permission mode (shows picker) |
| `/model [name]` | View or change the model (shows picker) |
| `/cost` | Show accumulated session cost |
| `/status` | Full session info — directory, model, mode, cost, state |

**Directories:**

| Command | Description |
|---|---|
| `/dirs` | Browse bookmarks and recent directories |
| `/bookmark /path --name alias` | Save a directory shortcut |

**Admin:**

| Command | Description |
|---|---|
| `/approve <CODE>` | Approve a pairing code |
| `/help` | Show all commands with current session context |

Any text that isn't a command is sent as a prompt to the active Claude session.

### How It Works

```
Telegram message
   ↓
Orchestrator (poll loop)
   ↓ parse command or route to session
Bun.spawn(["claude", "-p", "--output-format", "stream-json", ...])
   ↓ NDJSON stream
   ├─ assistant text  → separate Telegram message bubble
   ├─ tool_use        → formatted tool call message (📖 Read, 💻 Bash, etc.)
   ├─ tool_result     → appended to tool call as code block
   └─ result          → status updated with cost
```

### Permission Prompts

When Claude needs permission to run a tool (e.g. Bash commands, file edits), it's relayed to Telegram:

1. An inline keyboard appears: **Allow** / **Deny**
2. The full tool name and input parameters are shown
3. You tap a button → the response flows back to Claude
4. If no response within 2 minutes, the action is auto-denied

This uses a sidecar MCP server (`permission-relay.ts`) that communicates with the orchestrator via a local HTTP relay. No data leaves your machine.

### Real-time Streaming

Instead of waiting for Claude to finish, you see output as it happens:

- Each text response from Claude → separate message bubble
- Tool calls → formatted messages with icons:
  - `📖 Read` with file path
  - `✏️ Edit` / `📝 Write` with file path
  - `💻 Bash` with command in code block + output
  - `🔍 Glob` / `🔎 Grep` with pattern in code block
  - `🤖 Agent` with description
- Status message at the bottom tracks current activity and final cost

### Session Management

Sessions are persisted to `~/.claude/channels/telegram/sessions.json`. You can:

- Run multiple sessions across different directories
- Resume previous sessions by name or ID prefix
- Track cost per session
- Use `/compact` to start fresh while keeping the old session resumable

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot token |
| `ORCHESTRATOR_DEFAULT_CWD` | `$HOME` | Default directory for `/new` without a path |
| `ORCHESTRATOR_MAX_TURNS` | `50` | Max agentic turns per prompt |
| `ORCHESTRATOR_MODEL` | (system default) | Claude model override |
| `TELEGRAM_ALLOWED_USERS` | (none) | Comma-separated user IDs to pre-approve |

---

## Usage Patterns

### Quick question from your phone

```
what does the parseConfig function do?
```

Claude reads your codebase and replies in Telegram.

### Long-running task — start it, walk away

```
refactor the auth module to use JWT, run the tests, commit if they pass
```

Watch tool calls stream in. Come back to a commit message.

### Work across multiple projects

```
/new ~/projects/frontend --name frontend
```

```
/new ~/projects/api --name api
```

```
/sessions
/resume frontend
```

### Always-on with tmux

```bash
tmux new-session -d -s orch 'bun run start:orchestrator'
tmux attach -t orch   # re-attach any time
```

### Screenshot debugging

Attach a photo of a UI bug in Telegram → Claude receives it and reasons about it with your codebase context.

---

## Architecture

```
claude-telegram/
├── src/
│   ├── index.ts              # Channel mode entry point (MCP server)
│   ├── orchestrator.ts       # Orchestrator mode entry point (standalone)
│   ├── telegram.ts           # Telegram Bot API client (native fetch)
│   ├── html.ts               # HTML escape + formatting helpers
│   ├── access.ts             # Pairing codes + allowlist persistence
│   ├── config.ts             # Configuration loading
│   ├── types.ts              # TypeScript interfaces
│   ├── commands.ts           # Telegram command parser
│   ├── sessions.ts           # Session state management
│   ├── streaming.ts          # Multi-bubble Telegram renderer
│   ├── relay-server.ts       # HTTP relay for permission prompts
│   └── permission-relay.ts   # Sidecar MCP server for --permission-prompt-tool
├── tests/                    # Bun test runner
├── .env.example              # Environment variable documentation
├── .mcp.json.example         # MCP server config template
├── package.json
├── tsconfig.json
└── README.md
```

**Channel mode** (`index.ts`):
- MCP server with `claude/channel` experimental capability
- Registers 9 tools (5 reply/output + 4 access management)
- Long-polls Telegram, pushes events to Claude Code via MCP notifications

**Orchestrator mode** (`orchestrator.ts`):
- Standalone Bun process, no MCP — directly manages Claude CLI subprocesses
- Parses NDJSON from `claude -p --output-format stream-json`
- Permission relay: spawns a sidecar MCP server per subprocess that calls back to the orchestrator's HTTP server, which sends Telegram inline keyboards

**Shared modules**: `telegram.ts`, `access.ts`, `config.ts`, `types.ts` are used by both modes.

### Security Model

- **No inbound ports** — the plugin polls outbound to Telegram's API only
- **Pairing codes** — 6-character alphanumeric, 10-minute expiry, one-time use
- **Allowlist** — persisted at `~/.claude/channels/telegram/allowlist.json`
- **Local relay** — the permission HTTP server binds to `127.0.0.1` only
- **No data exfiltration** — tool inputs/outputs are shown in Telegram but never sent to third parties

---

## Troubleshooting

**Bot doesn't respond to `/start`**
Claude Code (channel mode) or the orchestrator must be running. Check terminal output for the startup message.

**`TELEGRAM_BOT_TOKEN not set`**
Ensure the token is exported in your shell or written to `~/.claude/channels/telegram/.env`.

**409 Conflict: terminated by other getUpdates request**
Two processes are polling the same bot. Only one can run at a time per bot token — either channel mode or orchestrator mode, not both. Create a second bot via @BotFather if you need both.

**Pairing code rejected**
Codes expire after 10 minutes. Send `/start` again for a fresh code.

**Messages stop after a while (channel mode)**
The Claude Code session must stay open. Use `tmux` or `screen`.

**Permission prompt times out**
Auto-denied after 2 minutes. Re-send your message to retry.

**Team / Enterprise: channels flag ignored**
An admin must enable channels at `claude.ai → Admin settings → Claude Code → Channels`.

---

## Development

```bash
# Channel mode with watch
bun run dev

# Orchestrator mode with watch
bun run dev:orchestrator

# Type check
bun run typecheck
```

---

## License

MIT
