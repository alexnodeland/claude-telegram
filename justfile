# telegram-mcp-channel task runner
# Install just: https://github.com/casey/just

# Default: show available recipes
default:
    @just --list

# ─── Development ─────────────────────────────────────────────────────────────

# Run channel mode (attach to Claude Code session)
dev:
    bun --watch run src/index.ts

# Run orchestrator mode (standalone)
dev-orchestrator:
    bun --watch run src/orchestrator.ts

# Run channel mode (production)
start:
    bun run src/index.ts

# Run orchestrator mode (production)
start-orchestrator:
    bun run src/orchestrator.ts

# ─── Quality ─────────────────────────────────────────────────────────────────

# Run all checks (typecheck + lint + format + test)
ci: typecheck check test

# TypeScript type checking
typecheck:
    bun run typecheck

# Biome lint + format check (no writes)
check:
    bunx biome check src/

# Biome lint + format auto-fix
fix:
    bunx biome check --write src/

# Biome lint only
lint:
    bunx biome lint src/

# Biome format (write)
format:
    bunx biome format --write src/

# Biome format check (no writes)
format-check:
    bunx biome format src/

# ─── Testing ─────────────────────────────────────────────────────────────────

# Run all tests
test:
    bun test

# Run tests in watch mode
test-watch:
    bun test --watch

# Run a specific test file
test-file file:
    bun test {{file}}

# ─── Setup ───────────────────────────────────────────────────────────────────

# Install dependencies and configure git hooks
setup:
    bun install
    git config core.hooksPath .githooks
    @echo "✅ Dependencies installed, git hooks configured"

# Install dependencies only
install:
    bun install
