# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-03-22

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

[1.0.0]: https://github.com/alexnodeland/claude-telegram/releases/tag/v1.0.0
