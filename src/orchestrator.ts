#!/usr/bin/env bun

/**
 * claude-telegram orchestrator
 *
 * Standalone process that bridges Telegram to Claude Code sessions.
 * Spawns `claude` CLI as a subprocess for each prompt, streams NDJSON
 * responses back to Telegram with real-time updates. Permission prompts
 * and questions are relayed to Telegram via a sidecar MCP server.
 *
 * Usage:
 *   bun run src/orchestrator.ts
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN          — Required
 *   ORCHESTRATOR_DEFAULT_CWD    — Default working directory (default: $HOME)
 *   ORCHESTRATOR_MAX_TURNS      — Max agentic turns per prompt (default: 50)
 *   ORCHESTRATOR_MODEL          — Claude model to use (optional)
 *   TELEGRAM_ALLOWED_USERS      — Comma-separated user IDs to pre-approve
 *
 * Runtime: Bun ≥ 1.1
 */

import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  addToAllowlist,
  consumePairingCode,
  isAllowed,
  issuePairingCode,
  loadAccessState,
  saveAccessState,
} from "./access.js";
import { parseCommand } from "./commands.js";
import { loadConfig, TYPING_INTERVAL_MS } from "./config.js";
import { escapeHtml, fmt } from "./html.js";
import { type RelayServer, startRelayServer } from "./relay-server.js";
import { SessionManager } from "./sessions.js";
import { StreamingRenderer } from "./streaming.js";
import { TelegramClient } from "./telegram.js";
import type {
  AccessState,
  ClaudeMessage,
  DirectoryBookmark,
  PermissionMode,
  SessionInfo,
  TelegramCallbackQuery,
  TelegramMessage,
} from "./types.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();

if (!config.botToken) {
  process.stderr.write(
    "❌  TELEGRAM_BOT_TOKEN not set.\n\n" + "Set it with:\n  export TELEGRAM_BOT_TOKEN=123456789:AAH...\n\n",
  );
  process.exit(1);
}

const tg = new TelegramClient(config.botToken);

const botInfo = await tg.getMe().catch((err: Error) => {
  process.stderr.write(`❌  Telegram connection failed: ${err.message}\n`);
  process.exit(1);
});

const access: AccessState = await loadAccessState(config.allowlistPath);

// Pre-approve users from env
const preApproved = process.env.TELEGRAM_ALLOWED_USERS;
if (preApproved) {
  for (const id of preApproved.split(",").map((s) => Number(s.trim()))) {
    if (id && !access.allowlist.includes(id)) {
      addToAllowlist(access, id);
    }
  }
  await saveAccessState(config.allowlistPath, access);
}

const sessions = new SessionManager(join(config.dataDir, "sessions.json"));
await sessions.load();

// ─── Directory bookmarks ──────────────────────────────────────────────────────

const bookmarksPath = join(config.dataDir, "bookmarks.json");
let bookmarks: DirectoryBookmark[] = [];

async function loadBookmarks(): Promise<void> {
  try {
    const data = await readFile(bookmarksPath, "utf8");
    bookmarks = JSON.parse(data) as DirectoryBookmark[];
  } catch {
    bookmarks = [];
  }
}

async function saveBookmarks(): Promise<void> {
  await writeFile(bookmarksPath, JSON.stringify(bookmarks, null, 2));
}

await loadBookmarks();

// Also collect recent directories from session history for quick access
function getRecentDirs(chatId: number): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const s of sessions.listForChat(chatId)) {
    if (!seen.has(s.cwd)) {
      seen.add(s.cwd);
      dirs.push(s.cwd);
    }
    if (dirs.length >= 5) break;
  }
  return dirs;
}

// ─── Navigable directory picker ───────────────────────────────────────────────

/**
 * Temporary lookup for directory picker buttons.
 * Telegram callback_data is limited to 64 bytes, so we can't embed full paths.
 * We store the current browsing path and subdirectory list per chat.
 */
const dirBrowserState = new Map<number, { currentPath: string; children: string[] }>();

async function listSubdirs(dirPath: string): Promise<string[]> {
  const { readdirSync, statSync } = await import("node:fs");
  try {
    return readdirSync(dirPath)
      .filter((name) => {
        if (name.startsWith(".")) return false; // hide dotfiles
        try {
          return statSync(join(dirPath, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

const DIR_PAGE_SIZE = 8;

/** Show a directory browser at the given path with pagination. */
async function showDirBrowser(chatId: number, dirPath: string, page = 0): Promise<void> {
  const children = await listSubdirs(dirPath);
  dirBrowserState.set(chatId, { currentPath: dirPath, children });

  const dirName = dirPath.split("/").pop() || dirPath;
  const header = `📂 <b>${escapeHtml(dirName)}</b>\n${fmt.code(dirPath)}`;

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  // "Start here" + "Up" row
  const navRow: Array<{ text: string; callback_data: string }> = [
    { text: "✅ Start here", callback_data: "nav:start" },
  ];
  const parent = resolve(dirPath, "..");
  if (parent !== dirPath) {
    navRow.push({ text: "⬆️ Up", callback_data: "nav:up" });
  }
  buttons.push(navRow);

  // Paginated subdirectory buttons (2 per row)
  const start = page * DIR_PAGE_SIZE;
  const pageItems = children.slice(start, start + DIR_PAGE_SIZE);
  for (let i = 0; i < pageItems.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    const c1 = pageItems[i];
    if (c1) row.push({ text: `📁 ${c1}`, callback_data: `nav:${start + i}` });
    const c2 = pageItems[i + 1];
    if (c2) row.push({ text: `📁 ${c2}`, callback_data: `nav:${start + i + 1}` });
    if (row.length > 0) buttons.push(row);
  }

  // Pagination row
  const hasMore = start + DIR_PAGE_SIZE < children.length;
  const hasPrev = page > 0;
  if (hasPrev || hasMore) {
    const paginationRow: Array<{ text: string; callback_data: string }> = [];
    if (hasPrev) paginationRow.push({ text: "◀ Prev", callback_data: `nav:page_${page - 1}` });
    paginationRow.push({
      text: `${page + 1}/${Math.ceil(children.length / DIR_PAGE_SIZE)}`,
      callback_data: "nav:noop",
    });
    if (hasMore) paginationRow.push({ text: "Next ▶", callback_data: `nav:page_${page + 1}` });
    buttons.push(paginationRow);
  }

  const pageLabel =
    children.length > DIR_PAGE_SIZE
      ? ` (${start + 1}–${Math.min(start + DIR_PAGE_SIZE, children.length)} of ${children.length})`
      : "";
  const text =
    children.length > 0
      ? `${header}${pageLabel}\n\n${pageItems.map((c) => `  📁 ${escapeHtml(c)}`).join("\n")}`
      : `${header}\n\n<i>No subdirectories</i>`;

  await tg.sendMessageWithKeyboard(chatId, text, { inline_keyboard: buttons });
}

/** Show the initial /new picker with bookmarks, recent dirs, and home. */
async function showNewPicker(chatId: number): Promise<void> {
  const recent = getRecentDirs(chatId);
  const shortcuts: Array<{ text: string; buttonText: string; path: string }> = [];

  // Add bookmarks
  for (const b of bookmarks) {
    shortcuts.push({ text: `📌 ${b.name}`, buttonText: `📌 ${b.name}`, path: b.path });
  }

  // Add recent dirs (deduplicated against bookmarks and DEFAULT_CWD)
  for (const d of recent) {
    if (d === DEFAULT_CWD) continue;
    if (shortcuts.some((s) => s.path === d)) continue;
    // Show last 2 path segments for clarity (e.g. "projects/my-app")
    const parts = d.split("/").filter(Boolean);
    const short = parts.length >= 2 ? parts.slice(-2).join("/") : (parts[parts.length - 1] ?? d);
    shortcuts.push({ text: `📂 ${short}`, buttonText: `📂 ${short}`, path: d });
  }

  // Store all paths for index-based lookup
  const allPaths = shortcuts.map((s) => s.path);
  dirBrowserState.set(chatId, { currentPath: DEFAULT_CWD, children: allPaths });

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  // Browse from home — show the actual home path
  const homeName = DEFAULT_CWD.split("/").filter(Boolean).pop() ?? "home";
  buttons.push([{ text: `🏠 Browse ~/${homeName}`, callback_data: "nav:browse_home" }]);

  // Shortcut buttons (1 per row for readability — paths can be long)
  for (let i = 0; i < Math.min(shortcuts.length, 6); i++) {
    const s = shortcuts[i];
    if (s) buttons.push([{ text: s.buttonText, callback_data: `nav:pick_${i}` }]);
  }

  const lines =
    shortcuts.length > 0
      ? shortcuts.map((s) => `${s.text} → ${fmt.code(s.path)}`).join("\n")
      : "<i>No bookmarks or recent sessions</i>";

  await tg.sendMessageWithKeyboard(
    chatId,
    `🆕 <b>New session — choose directory:</b>\n\n${lines}\n\nTap a shortcut or browse:`,
    { inline_keyboard: buttons },
  );
}

// ─── Global session state ─────────────────────────────────────────────────────

let globalPermissionMode: PermissionMode = "normal";

// ─── Permission memory ────────────────────────────────────────────────────────
// Tracks tools the user has approved at broader scope than "once".

/** Session-scoped approvals: cleared when session ends. chatId → Set<toolName> */
const sessionApprovedTools = new Map<number, Set<string>>();

/** Project-scoped approvals: persisted per cwd. cwd → Set<toolName> */
const projectApprovedTools = new Map<string, Set<string>>();

function isToolAutoApproved(chatId: number, toolName: string): boolean {
  // Check session-scoped approvals
  if (sessionApprovedTools.get(chatId)?.has(toolName)) return true;
  // Check project-scoped approvals
  const session = sessions.getActive(chatId);
  if (session && projectApprovedTools.get(session.cwd)?.has(toolName)) return true;
  return false;
}

function approveToolForSession(chatId: number, toolName: string): void {
  let set = sessionApprovedTools.get(chatId);
  if (!set) {
    set = new Set();
    sessionApprovedTools.set(chatId, set);
  }
  set.add(toolName);
}

function approveToolForProject(chatId: number, toolName: string): void {
  const session = sessions.getActive(chatId);
  if (!session) return;
  let set = projectApprovedTools.get(session.cwd);
  if (!set) {
    set = new Set();
    projectApprovedTools.set(session.cwd, set);
  }
  set.add(toolName);
}

// Start the permission relay HTTP server with Telegram notification callback
const relay: RelayServer = await startRelayServer(async (request) => {
  const { chatId, toolName, toolInput } = request;
  const inp = toolInput as Record<string, unknown> | undefined;

  // Auto-approve if the user previously approved this tool at session or project scope
  if (isToolAutoApproved(chatId, toolName)) {
    relay.resolvePrompt(chatId, { behavior: "allow", updatedInput: toolInput });
    return;
  }

  // Format the full tool input as a readable code block
  const toolDesc = TOOL_DESCRIPTIONS[toolName] ?? toolName;
  let detail = `Tool: ${fmt.code(toolName)} — ${escapeHtml(toolDesc)}`;
  if (inp && Object.keys(inp).length > 0) {
    const lines = Object.entries(inp).map(([key, val]) => {
      const valStr = typeof val === "string" ? val : JSON.stringify(val);
      const truncated = valStr.length > 200 ? `${valStr.slice(0, 200)}…` : valStr;
      return `${key}: ${truncated}`;
    });
    detail += `\n<pre>${escapeHtml(lines.join("\n"))}</pre>`;
  }

  // Build button rows with granular options
  const toolShort = toolName.length > 10 ? `${toolName.slice(0, 10)}…` : toolName;
  await tg.sendMessageWithKeyboard(chatId, `🔒 <b>Permission required</b>\n${detail}\n\n<i>Expires in 2 min</i>`, {
    inline_keyboard: [
      [
        { text: "✅ Allow once", callback_data: "permit:allow" },
        { text: "❌ Deny", callback_data: "permit:deny" },
      ],
      [{ text: `✅ Allow ${toolShort} for session`, callback_data: `permit:session:${toolName}` }],
      [{ text: `✅ Always allow ${toolShort} in project`, callback_data: `permit:project:${toolName}` }],
    ],
  });
});

// Human-readable tool descriptions for permission prompts
const TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash: "Run a shell command",
  Read: "Read a file",
  Edit: "Modify a file",
  Write: "Create or overwrite a file",
  Glob: "Search for files",
  Grep: "Search file contents",
  Agent: "Spawn a sub-agent",
  WebFetch: "Fetch a URL",
  WebSearch: "Search the web",
};

const DEFAULT_CWD = process.env.ORCHESTRATOR_DEFAULT_CWD ?? process.env.HOME ?? "/tmp";
const MAX_TURNS = Number(process.env.ORCHESTRATOR_MAX_TURNS ?? "50");
let globalModel = process.env.ORCHESTRATOR_MODEL;

// Absolute path to the sidecar script
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const RELAY_SCRIPT = resolve(import.meta.dir, "permission-relay.ts");

process.stderr.write(
  `✅  Orchestrator @${botInfo.username} ready — policy: ${access.policy}, ` +
    `allowlist: [${access.allowlist.join(", ")}]\n`,
);

// Register bot commands for Telegram menu
await tg
  .setMyCommands([
    { command: "new", description: "Start a new Claude session" },
    { command: "resume", description: "Resume a previous session" },
    { command: "sessions", description: "List all sessions" },
    { command: "stop", description: "Stop current task / end session" },
    { command: "model", description: "View or change the model" },
    { command: "cost", description: "Show session cost" },
    { command: "status", description: "Show current session status" },
    { command: "cc", description: "Run a Claude Code slash command" },
    { command: "mode", description: "Switch permission mode (normal/plan/auto)" },
    { command: "dirs", description: "Bookmarks and recent directories" },
    { command: "compact", description: "Fresh session in same directory" },
    { command: "help", description: "Show all commands" },
    { command: "approve", description: "Approve a pairing code" },
  ])
  .catch((e: Error) => process.stderr.write(`⚠️  setMyCommands failed: ${e.message}\n`));

// ─── Message handling ─────────────────────────────────────────────────────────

let lastUpdateId = 0;

async function handleMessage(message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  if (!userId) return;

  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();

  // Handle /start and /pair — generate pairing code
  if (text === "/start" || text === "/pair") {
    if (isAllowed(access, userId)) {
      await tg.sendMessage(chatId, "✅ Already paired. Send /help for commands.");
      return;
    }

    if (access.policy === "allowlist") return;

    const code = issuePairingCode(
      access,
      {
        userId,
        chatId,
        username: message.from?.username,
        firstName: message.from?.first_name ?? "User",
      },
      config.pairingCodeTtlMs,
    );

    await tg.sendMessage(
      chatId,
      `🔐 <b>Pairing code:</b> ${fmt.code(code)}\n\n` +
        `An approved user can send:\n${fmt.code(`/approve ${code}`)}\n\n` +
        `<i>Expires in 10 minutes.</i>`,
    );
    process.stderr.write(`⏳  Pairing request from @${message.from?.username ?? userId} — code: ${code}\n`);
    return;
  }

  if (!isAllowed(access, userId)) {
    process.stderr.write(`🚫  Dropped msg from user ${userId} (policy=${access.policy})\n`);
    return;
  }

  // Check if this is a response to a pending permission/question prompt
  if (relay.hasPending(chatId)) {
    await handlePendingReply(chatId, text);
    return;
  }

  const cmd = parseCommand(text);

  switch (cmd.type) {
    case "new":
      await handleNew(chatId, cmd.cwd, cmd.name);
      break;
    case "resume":
      await handleResume(chatId, cmd.target);
      break;
    case "sessions":
      await handleListSessions(chatId);
      break;
    case "stop":
      await handleStop(chatId);
      break;
    case "compact":
      await handleCompact(chatId);
      break;
    case "model":
      await handleModel(chatId, cmd.model);
      break;
    case "cost":
      await handleCost(chatId);
      break;
    case "status":
      await handleStatus(chatId);
      break;
    case "help":
      await handleHelp(chatId);
      break;
    case "approve":
      await handleApprove(chatId, userId, cmd.code);
      break;
    case "cc":
      await handleClaudeCommand(chatId, cmd.slashCommand, cmd.args, message.message_id);
      break;
    case "cc_menu":
      await handleCcMenu(chatId);
      break;
    case "mode":
      await handleMode(chatId, cmd.mode);
      break;
    case "dirs":
      await handleDirs(chatId);
      break;
    case "bookmark":
      await handleBookmark(chatId, cmd.path, cmd.name);
      break;
    case "unknown_command":
      await tg.sendMessage(
        chatId,
        `Unknown command: ${fmt.code(cmd.text)}\nUse /help for available commands, or send without / to chat with Claude.`,
      );
      break;
    case "prompt":
      await handlePrompt(chatId, cmd.text, message.message_id);
      break;
  }
}

async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data;
  if (!data) return;

  const chatId = query.message?.chat.id;
  if (!chatId) return;

  // Permission prompt callbacks
  if (data.startsWith("permit:")) {
    const pending = relay.getPending(chatId);

    // "permit:allow" — allow once
    if (data === "permit:allow") {
      relay.resolvePrompt(chatId, {
        behavior: "allow",
        ...(pending ? { updatedInput: pending.toolInput } : {}),
      });
      await tg.answerCallbackQuery(query.id, "✅ Allowed");
      if (query.message) {
        await tg.editMessageText(chatId, query.message.message_id, "✅ Allowed (once)").catch(() => undefined);
      }
      return;
    }

    // "permit:deny" — deny
    if (data === "permit:deny") {
      relay.resolvePrompt(chatId, { behavior: "deny" });
      await tg.answerCallbackQuery(query.id, "❌ Denied");
      if (query.message) {
        await tg.editMessageText(chatId, query.message.message_id, "❌ Denied").catch(() => undefined);
      }
      return;
    }

    // "permit:session:<toolName>" — allow and remember for this session
    const sessionMatch = data.match(/^permit:session:(.+)$/);
    if (sessionMatch?.[1]) {
      const tool = sessionMatch[1];
      approveToolForSession(chatId, tool);
      relay.resolvePrompt(chatId, {
        behavior: "allow",
        ...(pending ? { updatedInput: pending.toolInput } : {}),
      });
      await tg.answerCallbackQuery(query.id, `✅ ${tool} allowed for session`);
      if (query.message) {
        await tg
          .editMessageText(chatId, query.message.message_id, `✅ ${fmt.code(tool)} allowed for this session`)
          .catch(() => undefined);
      }
      return;
    }

    // "permit:project:<toolName>" — allow and remember for this project
    const projectMatch = data.match(/^permit:project:(.+)$/);
    if (projectMatch?.[1]) {
      const tool = projectMatch[1];
      approveToolForProject(chatId, tool);
      approveToolForSession(chatId, tool); // also approve for current session
      relay.resolvePrompt(chatId, {
        behavior: "allow",
        ...(pending ? { updatedInput: pending.toolInput } : {}),
      });
      const session = sessions.getActive(chatId);
      const dir = session?.cwd.split("/").pop() ?? "project";
      await tg.answerCallbackQuery(query.id, `✅ ${tool} always allowed in ${dir}`);
      if (query.message) {
        await tg
          .editMessageText(chatId, query.message.message_id, `✅ ${fmt.code(tool)} always allowed in ${fmt.code(dir)}`)
          .catch(() => undefined);
      }
      return;
    }

    // Unknown permit callback — just acknowledge
    await tg.answerCallbackQuery(query.id);
    return;
  }

  // Session resume: "resume:<id-prefix>"
  const resumeMatch = data.match(/^resume:(.+)$/);
  if (resumeMatch?.[1]) {
    await tg.answerCallbackQuery(query.id, "🔄 Resuming…");
    await handleResume(chatId, resumeMatch[1]);
    return;
  }

  // Model switch: "model:<name>"
  const modelMatch = data.match(/^model:(.+)$/);
  if (modelMatch?.[1]) {
    await tg.answerCallbackQuery(query.id, `✅ Switching to ${modelMatch[1]}`);
    await handleModel(chatId, modelMatch[1]);
    return;
  }

  // Quick-start actions: "quick:<action>"
  const quickMatch = data.match(/^quick:(.+)$/);
  if (quickMatch?.[1]) {
    await tg.answerCallbackQuery(query.id);
    switch (quickMatch[1]) {
      case "new":
        await handleNew(chatId);
        break;
      case "sessions":
        await handleListSessions(chatId);
        break;
      case "help":
        await handleHelp(chatId);
        break;
    }
    return;
  }

  // /cc command picker: "cc:<command>"
  const ccMatch = data.match(/^cc:(.+)$/);
  if (ccMatch?.[1]) {
    await tg.answerCallbackQuery(query.id, `Running /${ccMatch[1]}…`);
    await handleClaudeCommand(chatId, ccMatch[1], "");
    return;
  }

  // Navigable directory browser: "nav:<action>"
  const navMatch = data.match(/^nav:(.+)$/);
  if (navMatch?.[1]) {
    const action = navMatch[1];
    const state = dirBrowserState.get(chatId);

    if (action === "start" && state) {
      // Confirm — create session in current directory
      await tg.answerCallbackQuery(query.id, "🆕 Creating session…");
      await handleNew(chatId, state.currentPath);
      dirBrowserState.delete(chatId);
      return;
    }

    if (action === "up" && state) {
      const parent = resolve(state.currentPath, "..");
      await tg.answerCallbackQuery(query.id, `⬆️ ${parent.split("/").pop() ?? "/"}`);
      await showDirBrowser(chatId, parent);
      return;
    }

    if (action === "browse_home") {
      await tg.answerCallbackQuery(query.id, "🏠 Browsing…");
      await showDirBrowser(chatId, DEFAULT_CWD);
      return;
    }

    if (action === "noop") {
      await tg.answerCallbackQuery(query.id);
      return;
    }

    // Pagination: "page_<n>"
    const pageMatch = action.match(/^page_(\d+)$/);
    if (pageMatch?.[1] && state) {
      await tg.answerCallbackQuery(query.id);
      await showDirBrowser(chatId, state.currentPath, Number(pageMatch[1]));
      return;
    }

    // "pick_<index>" — shortcut from initial picker
    const pickMatch = action.match(/^pick_(\d+)$/);
    if (pickMatch?.[1] && state) {
      const idx = Number(pickMatch[1]);
      const path = state.children[idx];
      if (path) {
        await tg.answerCallbackQuery(query.id, `📂 ${path.split("/").pop()}`);
        await showDirBrowser(chatId, path);
        return;
      }
    }

    // Numeric index — navigate into subdirectory
    const idx = Number(action);
    if (!Number.isNaN(idx) && state) {
      const subdir = state.children[idx];
      if (subdir) {
        const fullPath = subdir.startsWith("/") ? subdir : join(state.currentPath, subdir);
        await tg.answerCallbackQuery(query.id, `📁 ${subdir}`);
        await showDirBrowser(chatId, fullPath);
        return;
      }
    }

    await tg.answerCallbackQuery(query.id);
    return;
  }

  // Mode switch: "mode:<mode>"
  const modeMatch = data.match(/^mode:(.+)$/);
  if (modeMatch?.[1]) {
    await tg.answerCallbackQuery(query.id, `✅ ${modeMatch[1]} mode`);
    await handleMode(chatId, modeMatch[1] as PermissionMode);
    return;
  }

  await tg.answerCallbackQuery(query.id);
}

/** Handle text reply to a pending AskUserQuestion prompt. */
async function handlePendingReply(chatId: number, text: string): Promise<void> {
  const pending = relay.getPending(chatId);
  if (!pending) return;

  // For AskUserQuestion, wrap the answer
  if (pending.toolName === "AskUserQuestion") {
    const questions = (pending.toolInput as { questions?: Array<{ question: string }> })?.questions;
    const firstQuestion = questions?.[0]?.question ?? "";
    relay.resolvePrompt(chatId, {
      behavior: "allow",
      updatedInput: {
        ...(pending.toolInput as Record<string, unknown>),
        answers: { [firstQuestion]: text },
      },
    });
  } else {
    // For other tools, treat as allow/deny
    const isAllow = /^(y|yes|allow|ok|approve)/i.test(text.trim());
    relay.resolvePrompt(chatId, {
      behavior: isAllow ? "allow" : "deny",
      ...(isAllow ? { updatedInput: pending.toolInput } : {}),
    });
  }

  await tg.sendMessage(chatId, `✅ Response recorded.`);
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleNew(chatId: number, cwd?: string, name?: string): Promise<void> {
  if (sessions.isProcessing(chatId)) {
    await tg.sendMessage(chatId, "⏳ A task is still running. Wait for it to finish or /stop first.");
    return;
  }

  // If no path specified, show navigable directory picker
  if (!cwd) {
    await showNewPicker(chatId);
    return;
  }

  const targetCwd = cwd ?? DEFAULT_CWD;

  try {
    const s = await stat(targetCwd);
    if (!s.isDirectory()) {
      await tg.sendMessage(chatId, `❌ Not a directory: ${fmt.code(targetCwd)}`);
      return;
    }
  } catch {
    await tg.sendMessage(chatId, `❌ Directory not found: ${fmt.code(targetCwd)}`);
    return;
  }

  sessions.endActive(chatId);
  sessions.create(chatId, targetCwd, "pending", name);
  await sessions.save();

  await tg.sendMessage(
    chatId,
    `🆕 New session in ${fmt.code(targetCwd)}\n${name ? `Name: <b>${escapeHtml(name)}</b>\n` : ""}\nSend a message to get started.`,
  );
}

async function handleResume(chatId: number, target?: string): Promise<void> {
  if (sessions.isProcessing(chatId)) {
    await tg.sendMessage(chatId, "⏳ A task is still running. Wait for it to finish or /stop first.");
    return;
  }

  const history = sessions.listForChat(chatId);

  if (!target) {
    if (history.length === 0) {
      await tg.sendMessage(chatId, "No previous sessions. Use /new to start one.");
      return;
    }

    // Show interactive picker with recent sessions
    if (history.length > 1) {
      const lines = history.slice(0, 5).map((s) => {
        const label = s.name ?? s.title ?? s.sessionId.slice(0, 8);
        const dir = s.cwd.split("/").pop() ?? s.cwd;
        const age = formatAge(Date.now() - s.lastActiveAt);
        return `• <b>${escapeHtml(label)}</b>\n  📂 ${fmt.code(dir)} · ${age}`;
      });

      const buttonRows: Array<Array<{ text: string; callback_data: string }>> = [];
      const items = history.slice(0, 5);
      for (let i = 0; i < items.length; i += 2) {
        const row: Array<{ text: string; callback_data: string }> = [];
        const s1 = items[i];
        if (s1) {
          const lbl = s1.name ?? s1.title ?? `${s1.sessionId.slice(0, 8)}…`;
          row.push({ text: lbl.slice(0, 20), callback_data: `resume:${s1.sessionId.slice(0, 8)}` });
        }
        const s2 = items[i + 1];
        if (s2) {
          const lbl = s2.name ?? s2.title ?? `${s2.sessionId.slice(0, 8)}…`;
          row.push({ text: lbl.slice(0, 20), callback_data: `resume:${s2.sessionId.slice(0, 8)}` });
        }
        if (row.length > 0) buttonRows.push(row);
      }

      await tg.sendMessageWithKeyboard(chatId, `🔄 <b>Resume which session?</b>\n\n${lines.join("\n")}`, {
        inline_keyboard: buttonRows,
      });
      return;
    }

    // Only one session — resume it directly
    const last = history[0] as SessionInfo;
    sessions.setActive(chatId, last);
    const label = last.name ?? last.title ?? `${last.sessionId.slice(0, 8)}…`;
    await tg.sendMessage(
      chatId,
      `🔄 Resumed <b>${escapeHtml(label)}</b> in ${fmt.code(last.cwd)}\n\nSend a message to continue.`,
    );
    return;
  }

  const match =
    sessions.findByName(chatId, target) ??
    sessions.findByTitle(chatId, target) ??
    sessions.findByIdPrefix(chatId, target);

  if (!match) {
    await tg.sendMessage(chatId, `❌ Session not found: ${fmt.code(target)}\nUse /sessions to see available sessions.`);
    return;
  }

  sessions.setActive(chatId, match);
  const matchLabel = match.name ?? match.title ?? `${match.sessionId.slice(0, 8)}…`;
  await tg.sendMessage(chatId, `🔄 Resumed <b>${escapeHtml(matchLabel)}</b> in ${fmt.code(match.cwd)}`);
}

async function handleListSessions(chatId: number): Promise<void> {
  const history = sessions.listForChat(chatId);
  if (history.length === 0) {
    await tg.sendMessage(chatId, "No sessions yet. Use /new to start one.");
    return;
  }

  const active = sessions.getActive(chatId);
  const lines = history.slice(0, 10).map((s) => {
    const marker = active?.sessionId === s.sessionId ? " 👈" : "";
    const label = s.name ?? s.title ?? s.sessionId.slice(0, 8);
    const dir = s.cwd.split("/").pop() ?? s.cwd;
    const age = formatAge(Date.now() - s.lastActiveAt);
    const cost = (s.totalCost ?? 0) > 0 ? ` · $${(s.totalCost ?? 0).toFixed(3)}` : "";
    return `• <b>${escapeHtml(label)}</b>${marker}\n  📂 ${fmt.code(dir)} · ${age}${cost}`;
  });

  // Build inline keyboard for quick resume — show title/name instead of IDs
  const buttons = history.slice(0, 5).map((s) => {
    const label = s.name ?? s.title ?? `${s.sessionId.slice(0, 8)}…`;
    // Telegram callback_data max 64 bytes
    const truncLabel = label.length > 20 ? `${label.slice(0, 20)}…` : label;
    return {
      text: truncLabel,
      callback_data: `resume:${s.sessionId.slice(0, 8)}`,
    };
  });

  // Split buttons into rows of 2
  const buttonRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    const row = [buttons[i]].filter(Boolean) as Array<{ text: string; callback_data: string }>;
    const b2 = buttons[i + 1];
    if (b2) row.push(b2);
    buttonRows.push(row);
  }

  await tg.sendMessageWithKeyboard(chatId, `📋 <b>Sessions:</b>\n\n${lines.join("\n")}`, {
    inline_keyboard: buttonRows,
  });
}

async function handleStop(chatId: number): Promise<void> {
  const proc = activeProcs.get(chatId);
  if (proc) {
    proc.kill();
    activeProcs.delete(chatId);
  }
  sessions.setProcessing(chatId, false);

  const session = sessions.endActive(chatId);
  sessionApprovedTools.delete(chatId); // clear session-scoped permission memory
  if (session) {
    await sessions.save();
    await tg.sendMessage(
      chatId,
      "🛑 Session ended.\nUse /new to start a new one or /resume to continue a previous session.",
    );
  } else {
    await tg.sendMessage(chatId, "No active session. Use /new to start one or /resume to continue.");
  }
}

async function handleCompact(chatId: number): Promise<void> {
  const session = sessions.getActive(chatId);
  if (!session) {
    await tg.sendMessage(chatId, "No active session. Use /new to start one or /resume to continue.");
    return;
  }
  if (sessions.isProcessing(chatId)) {
    await tg.sendMessage(chatId, "⏳ Wait for the current task to finish first.");
    return;
  }

  const cwd = session.cwd;
  const name = session.name;
  sessions.endActive(chatId);
  sessions.create(chatId, cwd, "pending", name);
  await sessions.save();

  await tg.sendMessage(
    chatId,
    `🔄 Fresh session in ${fmt.code(cwd)}\n` +
      `Previous session preserved — use /resume to switch back.\n\n` +
      `Send a message to get started.`,
  );
}

async function handleModel(chatId: number, model?: string): Promise<void> {
  const session = sessions.getActive(chatId);

  if (!model) {
    const current = session?.model ?? globalModel ?? "(default)";
    await tg.sendMessageWithKeyboard(chatId, `Current model: ${fmt.code(current)}\n\nTap to switch:`, {
      inline_keyboard: [
        [
          { text: "sonnet", callback_data: "model:sonnet" },
          { text: "opus", callback_data: "model:opus" },
          { text: "haiku", callback_data: "model:haiku" },
        ],
      ],
    });
    return;
  }

  if (session) {
    session.model = model;
    await sessions.save();
  }
  globalModel = model;
  await tg.sendMessage(chatId, `✅ Model set to ${fmt.code(model)}`);
}

async function handleCost(chatId: number): Promise<void> {
  const session = sessions.getActive(chatId);
  if (!session) {
    await tg.sendMessage(chatId, "No active session. Start one with /new or /resume.");
    return;
  }

  const cost = (session.totalCost ?? 0).toFixed(4);
  const turns = session.totalTurns ?? 0;
  await tg.sendMessage(chatId, `💰 Session cost: <b>$${cost}</b>\nTotal turns: ${turns}`);
}

async function handleStatus(chatId: number): Promise<void> {
  const session = sessions.getActive(chatId);
  if (!session) {
    await tg.sendMessage(chatId, "No active session. Use /new to start one.");
    return;
  }

  const id =
    session.sessionId === "pending" ? "(new — not yet started)" : fmt.code(`${session.sessionId.slice(0, 12)}…`);
  const model = session.model ?? globalModel ?? "(default)";
  const cost = (session.totalCost ?? 0).toFixed(4);
  const processing = sessions.isProcessing(chatId) ? "🟢 Running" : "⚪ Idle";

  await tg.sendMessage(
    chatId,
    [
      `📊 <b>Session Status</b>`,
      `Session: ${id}`,
      session.name ? `Name: <b>${escapeHtml(session.name)}</b>` : null,
      `Directory: ${fmt.code(session.cwd)}`,
      `Model: ${fmt.code(model)}`,
      `Mode: ${fmt.code(session.permissionMode ?? globalPermissionMode)}`,
      `Cost: $${cost} (${session.totalTurns ?? 0} turns)`,
      `State: ${processing}`,
      `Created: ${new Date(session.createdAt).toLocaleString()}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function handleHelp(chatId: number): Promise<void> {
  const session = sessions.getActive(chatId);
  const headerLines: string[] = [];

  if (session) {
    const id = session.sessionId === "pending" ? "(new)" : `${session.sessionId.slice(0, 8)}…`;
    headerLines.push(
      `Active: ${fmt.code(id)}${session.name ? ` <b>${escapeHtml(session.name)}</b>` : ""} in ${fmt.code(session.cwd)}`,
    );
    if (sessions.isProcessing(chatId)) headerLines.push("🟢 Currently running");
    headerLines.push("");
  } else {
    headerLines.push("<i>No active session — start one with /new</i>", "");
  }

  await tg.sendMessage(
    chatId,
    [
      "🤖 <b>Telegram Claude Orchestrator</b>",
      "",
      ...headerLines,
      "<b>Session Management:</b>",
      `${fmt.code("/new [path] [--name n]")} — New session`,
      `${fmt.code("/resume [name|id]")} — Resume previous`,
      `${fmt.code("/sessions")} — List sessions`,
      `${fmt.code("/stop")} — Stop task / end session`,
      `${fmt.code("/compact")} — Fresh session, same directory`,
      "",
      "<b>Claude Code:</b>",
      `${fmt.code("/cc [command]")} — Slash command menu / run`,
      `${fmt.code("/mode [normal|plan|auto]")} — Permission mode`,
      `${fmt.code("/model [name]")} — View or change model`,
      `${fmt.code("/cost")} — Session cost so far`,
      `${fmt.code("/status")} — Full session info`,
      "",
      "<b>Directories:</b>",
      `${fmt.code("/dirs")} — Bookmarks + recent dirs`,
      `${fmt.code("/bookmark /path --name alias")} — Save shortcut`,
      "",
      "<b>Admin:</b>",
      `${fmt.code("/approve CODE")} — Approve pairing code`,
      "",
      "Send any text to interact with Claude.",
    ].join("\n"),
  );
}

async function handleApprove(chatId: number, approverId: number, code: string): Promise<void> {
  const pairing = consumePairingCode(access, code);
  if (!pairing) {
    await tg.sendMessage(chatId, `❌ Code ${fmt.code(code.toUpperCase())} is invalid or expired.`);
    return;
  }

  addToAllowlist(access, pairing.userId);
  await saveAccessState(config.allowlistPath, access);

  // Send welcome message with quick-start buttons
  await tg
    .sendMessageWithKeyboard(
      pairing.chatId,
      "✅ <b>Paired!</b> You now have access.\n\nGet started by creating a session or exploring commands.",
      {
        inline_keyboard: [
          [
            { text: "🆕 New session", callback_data: "quick:new" },
            { text: "📋 Sessions", callback_data: "quick:sessions" },
            { text: "❓ Help", callback_data: "quick:help" },
          ],
        ],
      },
    )
    .catch(() => undefined);

  await tg.sendMessage(
    chatId,
    `✅ Approved @${escapeHtml(String(pairing.username ?? pairing.userId))}\nAllowlist: [${access.allowlist.join(", ")}]`,
  );

  process.stderr.write(`✅  Approved @${pairing.username ?? pairing.userId} (by ${approverId})\n`);
}

// ─── /cc menu — popular Claude Code slash commands ────────────────────────────

const CC_COMMANDS = [
  { cmd: "commit", desc: "Commit staged changes" },
  { cmd: "review-pr", desc: "Review a pull request" },
  { cmd: "plan", desc: "Enter plan mode" },
  { cmd: "compact", desc: "Compact conversation" },
  { cmd: "init", desc: "Initialize CLAUDE.md" },
  { cmd: "diff", desc: "Show uncommitted changes" },
  { cmd: "simplify", desc: "Simplify changed code" },
  { cmd: "cost", desc: "Show token usage" },
  { cmd: "context", desc: "Show context usage" },
  { cmd: "pr-comments", desc: "Fetch PR comments" },
] as const;

async function handleCcMenu(chatId: number): Promise<void> {
  const lines = CC_COMMANDS.map((c) => `${fmt.code(`/cc ${c.cmd}`)} — ${escapeHtml(c.desc)}`);

  // Build 2-column button grid
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < CC_COMMANDS.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    const c1 = CC_COMMANDS[i];
    if (c1) row.push({ text: c1.cmd, callback_data: `cc:${c1.cmd}` });
    const c2 = CC_COMMANDS[i + 1];
    if (c2) row.push({ text: c2.cmd, callback_data: `cc:${c2.cmd}` });
    if (row.length > 0) buttons.push(row);
  }

  await tg.sendMessageWithKeyboard(
    chatId,
    `🔧 <b>Claude Code Commands</b>\n\n${lines.join("\n")}\n\nTap or type ${fmt.code("/cc <command>")}:`,
    {
      inline_keyboard: buttons,
    },
  );
}

// ─── /mode — permission mode switching ────────────────────────────────────────

const MODE_LABELS: Record<PermissionMode, string> = {
  normal: "🔒 Normal — asks permission for each tool",
  plan: "📋 Plan — shows plan before executing",
  "auto-accept": "⚡ Auto-accept — runs tools without prompting",
};

async function handleMode(chatId: number, mode?: PermissionMode): Promise<void> {
  const session = sessions.getActive(chatId);

  if (!mode) {
    const current = session?.permissionMode ?? globalPermissionMode;
    await tg.sendMessageWithKeyboard(
      chatId,
      `Current mode: <b>${escapeHtml(current)}</b>\n\n${Object.values(MODE_LABELS)
        .map((l) => `• ${escapeHtml(l)}`)
        .join("\n")}`,
      {
        inline_keyboard: [
          [
            { text: "🔒 Normal", callback_data: "mode:normal" },
            { text: "📋 Plan", callback_data: "mode:plan" },
            { text: "⚡ Auto", callback_data: "mode:auto-accept" },
          ],
        ],
      },
    );
    return;
  }

  if (session) {
    session.permissionMode = mode;
    await sessions.save();
  }
  globalPermissionMode = mode;
  await tg.sendMessage(chatId, `✅ Mode: <b>${escapeHtml(mode)}</b>\n${escapeHtml(MODE_LABELS[mode])}`);
}

// ─── /dirs + /bookmark — directory management ─────────────────────────────────

async function handleDirs(chatId: number): Promise<void> {
  // Just show the same navigable picker as /new
  await showNewPicker(chatId);
}

async function handleBookmark(chatId: number, path?: string, name?: string): Promise<void> {
  if (!path) {
    // Show existing bookmarks with instructions
    if (bookmarks.length === 0) {
      await tg.sendMessage(
        chatId,
        `No bookmarks yet.\n\nUsage: ${fmt.code("/bookmark /path/to/project --name alias")}`,
      );
    } else {
      const lines = bookmarks.map((b) => `📌 ${fmt.code(b.name)} → ${fmt.code(b.path)}`);
      await tg.sendMessage(chatId, `<b>Bookmarks:</b>\n${lines.join("\n")}`);
    }
    return;
  }

  // Validate directory exists
  try {
    const s = await stat(path);
    if (!s.isDirectory()) {
      await tg.sendMessage(chatId, `❌ Not a directory: ${fmt.code(path)}`);
      return;
    }
  } catch {
    await tg.sendMessage(chatId, `❌ Directory not found: ${fmt.code(path)}`);
    return;
  }

  const alias = name ?? path.split("/").pop() ?? "project";

  // Update existing or add new
  const existing = bookmarks.findIndex((b) => b.path === path);
  const entry = existing >= 0 ? bookmarks[existing] : undefined;
  if (entry) {
    entry.name = alias;
  } else {
    bookmarks.push({ path, name: alias });
  }
  await saveBookmarks();

  await tg.sendMessage(chatId, `📌 Bookmarked ${fmt.code(alias)} → ${fmt.code(path)}`);
}

// ─── Claude subprocess management ─────────────────────────────────────────────

const activeProcs = new Map<number, { kill: () => void }>();

async function handleClaudeCommand(
  chatId: number,
  slashCommand: string,
  args: string,
  replyToMessageId?: number,
): Promise<void> {
  const prompt = args ? `/${slashCommand} ${args}` : `/${slashCommand}`;
  await handlePrompt(chatId, prompt, replyToMessageId);
}

async function handlePrompt(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
  const session = sessions.getActive(chatId);
  if (!session) {
    await tg.sendMessage(
      chatId,
      "No active session. Start one with:\n" +
        `${fmt.code("/new")} — in default directory\n` +
        `${fmt.code("/new /path/to/project")} — in a specific directory`,
    );
    return;
  }

  if (sessions.isProcessing(chatId)) {
    await tg.sendMessage(chatId, "⏳ Still processing. Please wait or /stop.");
    return;
  }

  sessions.setProcessing(chatId, true);

  // Fire and forget — don't block the poll loop
  runQuery(chatId, session, text, replyToMessageId)
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`❌  Query error (chat ${chatId}): ${msg}\n`);
      tg.sendMessage(chatId, `❌ Error: ${msg}`).catch(() => undefined);
    })
    .finally(() => {
      sessions.setProcessing(chatId, false);
      activeProcs.delete(chatId);
    });
}

async function runQuery(
  chatId: number,
  session: SessionInfo,
  prompt: string,
  replyToMessageId?: number,
): Promise<void> {
  const isResume = session.sessionId !== "pending";
  const model = session.model ?? globalModel;

  // Read project .mcp.json so spawned sessions get the project's MCP servers.
  // In -p mode the workspace trust dialog is skipped, which may prevent
  // .mcp.json servers from being auto-enabled. Merging them here is defensive.
  let projectMcpServers: Record<string, unknown> = {};
  try {
    const raw = await readFile(join(session.cwd, ".mcp.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
      projectMcpServers = parsed.mcpServers;
    }
  } catch {
    // No .mcp.json or invalid — fine, not every project has one
  }

  // Write temp MCP config: project servers + permission relay sidecar.
  // Relay is spread last so a project can't shadow it.
  const mcpConfigPath = `/tmp/telegram-relay-${chatId}-${process.pid}.json`;
  const mcpConfig = {
    mcpServers: {
      ...projectMcpServers,
      telegram_relay: {
        command: "bun",
        args: ["run", RELAY_SCRIPT],
        env: {
          RELAY_HTTP_PORT: String(relay.port),
          RELAY_CHAT_ID: String(chatId),
        },
      },
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig));

  const args = [
    CLAUDE_BIN,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(MAX_TURNS),
    "--setting-sources",
    "user,project,local",
    "--mcp-config",
    mcpConfigPath,
    "--permission-prompt-tool",
    "mcp__telegram_relay__prompt_handler",
  ];

  if (isResume) {
    args.push("--resume", session.sessionId);
  }

  if (model) {
    args.push("--model", model);
  }

  // Permission mode: plan or auto-accept (normal doesn't need a flag — it uses the relay)
  const mode = session.permissionMode ?? globalPermissionMode;
  if (mode === "plan") {
    args.push("--permission-mode", "plan");
  } else if (mode === "auto-accept") {
    args.push("--dangerously-skip-permissions");
  }

  args.push(prompt);

  process.stderr.write(
    `🚀  Spawning claude in ${session.cwd} (session: ${session.sessionId})\n` +
      `    prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}\n`,
  );

  // Ensure homebrew/nvm paths are available — the launchd plist PATH is minimal
  const extraPaths = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
  const currentPath = process.env.PATH ?? "";
  const mergedPath = [...extraPaths.filter((p) => !currentPath.includes(p)), currentPath].join(":");

  const proc = Bun.spawn(args, {
    cwd: session.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: mergedPath },
  });

  activeProcs.set(chatId, proc);

  // Typing keepalive
  const typingTimer = setInterval(() => {
    tg.sendChatAction(chatId).catch(() => undefined);
  }, TYPING_INTERVAL_MS);

  // Read stderr in background
  readStderr(proc.stderr, session.cwd);

  // Stream output to Telegram — thread under the user's message
  const renderer = new StreamingRenderer(tg, chatId);
  await renderer.start(replyToMessageId);

  try {
    const result = await processNdjsonStream(proc.stdout, renderer, chatId);

    // Update session with real ID and title
    if (result.sessionId) {
      sessions.updateSessionId(chatId, result.sessionId);
      session.lastActiveAt = Date.now();
    }
    if (result.title && !session.name) {
      session.title = result.title;
    }

    // Accumulate cost
    if (result.totalCost || result.numTurns) {
      sessions.addCost(chatId, result.totalCost ?? 0, result.numTurns ?? 0);
    }
    await sessions.save();

    // Finish rendering
    const costStr =
      result.totalCost !== undefined && result.totalCost > 0
        ? `$${result.totalCost.toFixed(4)} · ${result.numTurns ?? "?"} turns`
        : undefined;

    if (result.error) {
      await renderer.error("Session ended with an error.");
    } else {
      await renderer.finish(costStr);
    }
  } finally {
    clearInterval(typingTimer);
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
    // Clean up temp config
    await unlink(mcpConfigPath).catch(() => undefined);
  }
}

// ─── NDJSON stream processor ──────────────────────────────────────────────────

interface QueryResult {
  sessionId?: string;
  title?: string;
  totalCost?: number;
  numTurns?: number;
  error: boolean;
}

async function processNdjsonStream(
  stdout: ReadableStream<Uint8Array>,
  renderer: StreamingRenderer,
  chatId: number,
): Promise<QueryResult> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let sessionId: string | undefined;
  let title: string | undefined;
  let totalCost: number | undefined;
  let numTurns: number | undefined;
  let isError = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n")) {
      const idx = buffer.indexOf("\n");
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);

      if (!line.trim()) continue;

      let msg: ClaudeMessage;
      try {
        msg = JSON.parse(line) as ClaudeMessage;
      } catch {
        continue;
      }

      // System init — extract session ID and title
      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        const init = msg as { session_id?: string; conversation_name?: string };
        sessionId = init.session_id;
        if (init.conversation_name) title = init.conversation_name;
      }

      // Assistant message — send text as separate bubbles, show tool calls
      if (msg.type === "assistant" && "message" in msg) {
        const content = (
          msg as {
            message?: {
              content?: Array<{
                type: string;
                text?: string;
                name?: string;
                input?: unknown;
              }>;
            };
          }
        ).message?.content;

        if (content) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              // Derive title from first text response if not already set
              if (!title) {
                title = block.text.slice(0, 80).split("\n")[0];
              }
              await renderer.sendText(block.text);
            }
            if (block.type === "tool_use" && block.name) {
              if (block.name === "AskUserQuestion") {
                await sendQuestionPrompt(chatId, block.input);
              } else {
                await renderer.showToolCall(block.name, block.input);
              }
            }
          }
        }
      }

      // Tool result — extract content and show as result preview
      if (msg.type === "user" && "message" in msg) {
        const content = (
          msg as {
            message?: {
              content?: Array<{
                type: string;
                is_error?: boolean;
                content?: string | Array<{ type: string; text?: string }>;
              }>;
            };
          }
        ).message?.content;

        if (content) {
          for (const block of content) {
            if (block.type === "tool_result") {
              let resultText = "";
              if (typeof block.content === "string") {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                resultText = block.content
                  .filter((b) => b.type === "text" && b.text)
                  .map((b) => b.text!)
                  .join("\n");
              }
              if (resultText) {
                await renderer.showToolResult(resultText, block.is_error);
              }
            }
          }
        }
      }

      // API retry
      if (msg.type === "system" && "subtype" in msg && msg.subtype === "api_retry") {
        await renderer.showRetry("Retrying API call…");
      }

      // Result — final message
      if (msg.type === "result") {
        const result = msg as {
          session_id?: string;
          total_cost_usd?: number;
          num_turns?: number;
          is_error?: boolean;
          subtype?: string;
        };
        sessionId = result.session_id ?? sessionId;
        totalCost = result.total_cost_usd;
        numTurns = result.num_turns;
        isError = result.is_error ?? result.subtype !== "success";
      }
    }
  }

  return { sessionId, title, totalCost, numTurns, error: isError };
}

/** Send a question prompt to Telegram when AskUserQuestion is detected in stream. */
async function sendQuestionPrompt(chatId: number, input: unknown): Promise<void> {
  const questions = (
    input as { questions?: Array<{ question: string; options?: Array<{ label: string; description?: string }> }> }
  )?.questions;
  if (!questions?.length) return;

  const q = questions[0]!;
  let text = `❓ <b>Claude asks:</b>\n${escapeHtml(q.question)}`;

  if (q.options?.length) {
    const optionLines = q.options.map(
      (o, i) => `  ${i + 1}. <b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ""}`,
    );
    text += `\n\n${optionLines.join("\n")}`;
    text += "\n\n<i>Reply with the option name or number.</i>";
  } else {
    text += "\n\n<i>Type your answer.</i>";
  }

  await tg.sendMessage(chatId, text).catch(() => undefined);
}

/** Read stderr from claude subprocess and log it. */
async function readStderr(stderr: ReadableStream<Uint8Array>, cwd: string): Promise<void> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n").filter(Boolean)) {
        process.stderr.write(`  [claude:${cwd}] ${line}\n`);
      }
    }
  } catch {
    /* stream closed */
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const updates = await tg.getUpdates(lastUpdateId);
      for (const update of updates) {
        lastUpdateId = update.update_id + 1;

        // Handle inline keyboard callbacks (permission responses)
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query).catch((e: Error) =>
            process.stderr.write(`❌  Callback error: ${e.message}\n`),
          );
          continue;
        }

        const msg = update.message ?? update.channel_post;
        if (msg) {
          await handleMessage(msg).catch((e: Error) => process.stderr.write(`❌  ${e.message}\n`));
        }
      }
    } catch (err) {
      process.stderr.write(`⚠️   Poll error: ${err instanceof Error ? err.message : err}\n`);
    }
    await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown() {
  process.stderr.write("\n🛑  Shutting down…\n");
  relay.shutdown();
  for (const [, proc] of activeProcs) {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }
  sessions.save().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Start ────────────────────────────────────────────────────────────────────

pollLoop().catch((e: Error) => {
  process.stderr.write(`💥  ${e.message}\n`);
  process.exit(1);
});

process.stderr.write(
  `\n🚀  claude-telegram orchestrator running\n` +
    `    Bot: @${botInfo.username}  Policy: ${access.policy}\n` +
    `    Default CWD: ${DEFAULT_CWD}\n` +
    `    Relay port: ${relay.port}  Max turns: ${MAX_TURNS}\n\n`,
);
