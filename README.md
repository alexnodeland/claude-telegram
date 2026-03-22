<div align="center">

# 📱 claude-telegram

**Control Claude Code from Telegram — run tasks, review diffs, commit code, all from your phone.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun_%3E%3D1.1-f9f1e1?logo=bun)](https://bun.sh)
[![Claude Code](https://img.shields.io/badge/Claude_Code-%3E%3D2.1.80-cc785c?logo=anthropic)](https://code.claude.com)
[![MCP](https://img.shields.io/badge/MCP-Channel_Plugin-blue)](https://modelcontextprotocol.io)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram)](https://core.telegram.org/bots/api)

</div>

---

A local bridge between Telegram and [Claude Code](https://code.claude.com). Send a message from your phone, Claude reads your codebase, edits files, runs commands, and replies — everything stays on your machine.

```
You (Telegram)  →  claude-telegram (local)  →  Claude Code (your machine)
    "fix the auth bug,       polls Telegram,          reads code, edits files,
     run tests, commit"      streams results          runs tests, commits
```

## What you can do

- **Ask questions** about your codebase from anywhere
- **Run tasks** — refactor code, fix bugs, add features — and watch tool calls stream in real time
- **Manage sessions** across multiple projects with a navigable directory browser
- **Run Claude Code slash commands** — `/cc commit`, `/cc review-pr 123`, `/cc diff`
- **Control permissions** — approve once, for the session, or always for the project
- **Switch modes** — normal, plan, or auto-accept — right from the chat

## Quick start

**1. Create a Telegram bot** — message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.

**2. Install and run:**

```bash
git clone https://github.com/alexnodeland/claude-telegram.git
cd claude-telegram
bun install
export TELEGRAM_BOT_TOKEN=your_token_here
bun run start:orchestrator
```

**3. Pair your Telegram account** — send `/start` to your bot, then `/approve <CODE>` from an approved user. Done.

> **Two modes:** The orchestrator mode above is standalone and manages its own Claude sessions. There's also a [channel mode](docs/channel-mode.md) that attaches Telegram to an existing Claude Code session as an MCP plugin.

## Commands

All commands register in Telegram's bot menu for autocomplete.

| Command | What it does |
|---|---|
| `/new` | Start a session — shows a directory browser to pick your project |
| `/resume` | Resume a previous session — shows interactive picker with titles |
| `/sessions` | List all sessions with tap-to-resume buttons |
| `/cc` | Claude Code slash commands — shows a menu, or `/cc commit` directly |
| `/mode` | Switch between normal / plan / auto-accept permission modes |
| `/model` | Switch between sonnet / opus / haiku |
| `/stop` | Stop current task or end session |
| `/dirs` | Browse bookmarked and recent directories |
| `/bookmark` | Save a directory shortcut: `/bookmark /path --name alias` |
| `/cost` | Show session cost |
| `/status` | Full session info |
| `/help` | Show all commands with current session context |

Anything that isn't a command is sent as a prompt to Claude.

## How it looks

**Real-time streaming** — each tool call is a separate message:

```
⚙️ Step 3 · Read · …/src/auth.ts       ← status updates in place

📖 Read
src/auth.ts                              ← tool call with result preview
┌─────────────────────────────┐
│ export function verify...   │
└─────────────────────────────┘

💻 Bash
npm test                                 ← command + output
┌─────────────────────────────┐
│ 47 passed, 0 failed         │
└─────────────────────────────┘

✅ Done · $0.0042 · 3 turns              ← final cost
```

**Permission prompts** with granular options:

```
🔒 Permission required
Tool: Bash — Run a shell command
┌─────────────────────────────┐
│ command: npm test            │
└─────────────────────────────┘
Expires in 2 min

[✅ Allow once]  [❌ Deny]
[✅ Allow Bash for session]
[✅ Always allow Bash in project]
```

## Security

- **Runs locally** — no cloud relay, no data exfiltration, no inbound ports
- **Pairing codes** — 6-character, 10-minute expiry, one-time use
- **Allowlist** — only paired Telegram users can interact
- **Permission relay** — HTTP server binds to `127.0.0.1` only
- **Zero Telegram SDK** — just native `fetch`, minimal attack surface

## Documentation

| Doc | Contents |
|---|---|
| [Orchestrator Mode](docs/orchestrator-mode.md) | Full orchestrator docs — setup, commands, permissions, streaming, sessions, env vars |
| [Channel Mode](docs/channel-mode.md) | MCP channel plugin docs — setup, pairing, access commands, tools |
| [Architecture](docs/architecture.md) | System design, module map, security model, data flow |

## Development

```bash
just setup             # Install deps + configure git hooks
just dev-orchestrator  # Watch mode
just ci                # Typecheck + lint + test (112 tests)
just fix               # Auto-fix lint/format
```

See [CLAUDE.md](CLAUDE.md) for contributor guidelines and design decisions.

## License

[MIT](LICENSE)
