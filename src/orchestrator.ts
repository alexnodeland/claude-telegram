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

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
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
import {
  loadConfig,
  MAX_CONCURRENT_JOBS_PER_CHAT,
  MAX_SESSIONS_PER_CHAT,
  SCHEDULER_CHECK_INTERVAL_MS,
  TYPING_INTERVAL_MS,
} from "./config.js";
import { escapeHtml, fmt, stripHtml } from "./html.js";
import { type RelayServer, startRelayServer } from "./relay-server.js";
import { parseScheduleExpression, ScheduleManager } from "./scheduler.js";
import { SessionManager } from "./sessions.js";
import { StreamingRenderer } from "./streaming.js";
import { TelegramClient } from "./telegram.js";
import { TopicManager } from "./topics.js";
import type {
  AccessState,
  ClaudeMessage,
  PermissionMode,
  ScheduledJob,
  SessionInfo,
  TelegramCallbackQuery,
  TelegramMessage,
  TopicKey,
  TopicKeyString,
} from "./types.js";
import { topicKeyStr } from "./types.js";

/** Extract a TopicKey from an incoming Telegram message. */
function getTopicKey(message: TelegramMessage): TopicKey {
  return { chatId: message.chat.id, threadId: message.message_thread_id };
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();

if (!config.botToken) {
  process.stderr.write(
    "❌  TELEGRAM_BOT_TOKEN not set.\n\n" + "Set it with:\n  export TELEGRAM_BOT_TOKEN=123456789:AAH...\n\n",
  );
  process.exit(1);
}

const tg = new TelegramClient(config.botToken);
const topics = new TopicManager(tg);

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
topics.reconcile(sessions.getAllActive());

// ─── Activity topic persistence ──────────────────────────────────────────────

const activityTopicPath = join(config.dataDir, "activity-topics.json");

async function loadActivityTopics(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(activityTopicPath, "utf8")) as Record<string, number>;
    for (const [chatId, threadId] of Object.entries(data)) {
      topics.setActivityTopic(Number(chatId), threadId);
    }
  } catch {
    /* no file yet */
  }
}

async function saveActivityTopic(chatId: number, threadId: number): Promise<void> {
  let data: Record<string, number> = {};
  try {
    data = JSON.parse(await readFile(activityTopicPath, "utf8")) as Record<string, number>;
  } catch {
    /* fresh */
  }
  data[String(chatId)] = threadId;
  await writeFile(activityTopicPath, JSON.stringify(data, null, 2));
}

await loadActivityTopics();

// ─── General topic pinned control panel ──────────────────────────────────────

const generalPinPath = join(config.dataDir, "general-pins.json");
const generalPinIds = new Map<number, number>(); // chatId → messageId

async function loadGeneralPins(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(generalPinPath, "utf8")) as Record<string, number>;
    for (const [chatId, msgId] of Object.entries(data)) {
      generalPinIds.set(Number(chatId), msgId);
    }
  } catch {
    /* no file yet */
  }
}

async function saveGeneralPin(chatId: number, messageId: number): Promise<void> {
  generalPinIds.set(chatId, messageId);
  const data = Object.fromEntries(generalPinIds);
  await writeFile(generalPinPath, JSON.stringify(data, null, 2));
}

/** Build the live cockpit text from current state. */
function buildCockpitText(chatId: number): string {
  // Filter to interactive sessions only (exclude job-isolated sessions)
  const activeSessions = sessions.getActiveForChat(chatId).filter((s) => {
    // Check if this session is keyed with a jobId by looking for ":job:" in any active key
    // Interactive sessions have keys like "chatId" or "chatId:threadId"
    const key = { chatId: s.chatId, threadId: s.threadId };
    return sessions.getActive(key) === s;
  });
  const jobs = scheduler.list(chatId);
  const enabledJobs = jobs.filter((j) => j.enabled);
  const totalCost = activeSessions.reduce((sum, s) => sum + (s.totalCost ?? 0), 0);

  const lines: string[] = ["🤖 <b>Claude Control Panel</b>", ""];

  // Active sessions
  if (activeSessions.length > 0) {
    lines.push(`<b>Sessions</b> (${activeSessions.length}/${MAX_SESSIONS_PER_CHAT})`);
    for (const s of activeSessions.slice(0, 5)) {
      const label = s.name ?? s.title ?? s.sessionId.slice(0, 8);
      const isRunning = sessions.isProcessing({ chatId: s.chatId, threadId: s.threadId });
      const state = isRunning ? "🟢" : "⚪";
      const cost = (s.totalCost ?? 0) > 0 ? ` · $${(s.totalCost ?? 0).toFixed(3)}` : "";
      let line = `${state} <b>${escapeHtml(label)}</b>${cost}`;
      if (s.threadId) {
        const link = topics.getTopicLink(chatId, s.threadId);
        if (link) line += ` · <a href="${link}">open</a>`;
      }
      lines.push(line);
    }
  } else {
    lines.push("<i>No active sessions</i>");
  }

  lines.push("");

  // Scheduled jobs
  if (enabledJobs.length > 0) {
    lines.push(`<b>Jobs</b> (${enabledJobs.length} active)`);
    const next = enabledJobs.find((j) => j.nextRunAt);
    if (next) {
      const label = next.name ?? next.prompt.slice(0, 25);
      const when = next.nextRunAt ? new Date(next.nextRunAt).toLocaleTimeString() : "—";
      lines.push(`⏭ Next: <b>${escapeHtml(label)}</b> at ${when}`);
    }
  } else {
    lines.push("<i>No scheduled jobs</i>");
  }

  if (totalCost > 0) {
    lines.push("", `💰 Total: $${totalCost.toFixed(4)}`);
  }

  return lines.join("\n");
}

const COCKPIT_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🆕 New session", callback_data: "quick:new" },
      { text: "📋 Sessions", callback_data: "quick:sessions" },
    ],
    [
      { text: "⏰ Jobs", callback_data: "quick:jobs" },
      { text: "❓ Help", callback_data: "quick:help" },
    ],
  ],
};

/** Track whether we've already closed General for a chat this runtime. */
const generalClosed = new Set<number>();

/** Ensure the General topic has a pinned cockpit. Creates or updates. */
async function ensureGeneralPin(chatId: number): Promise<void> {
  const isForum = await topics.isForum(chatId);
  if (!isForum) return;

  const text = buildCockpitText(chatId);
  const existing = generalPinIds.get(chatId);
  if (existing) {
    // Edit existing — ignore "message not modified" errors
    await tg.editMessageText(chatId, existing, text, COCKPIT_KEYBOARD).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not modified")) return; // text unchanged, fine
      // Message was actually deleted — recreate
      generalPinIds.delete(chatId);
    });
    if (generalPinIds.has(chatId)) {
      // Ensure General is closed (once per runtime)
      if (!generalClosed.has(chatId)) {
        await tg.closeGeneralForumTopic(chatId).catch(() => undefined);
        generalClosed.add(chatId);
      }
      return;
    }
  }

  // Delete old pin if it exists (force fresh keyboard)
  if (existing) {
    await tg.deleteMessage(chatId, existing);
  }

  try {
    const msg = await tg.sendMessageWithKeyboard(chatId, text, COCKPIT_KEYBOARD);
    await tg.pinChatMessage(chatId, msg.message_id).catch(() => undefined);
    await saveGeneralPin(chatId, msg.message_id);
    await tg.closeGeneralForumTopic(chatId).catch(() => undefined);
    generalClosed.add(chatId);
  } catch (err) {
    process.stderr.write(`⚠️  Failed to pin cockpit: ${err}\n`);
  }
}

/** Refresh the cockpit after state changes (best-effort, fire-and-forget). */
function refreshCockpit(chatId: number): void {
  ensureGeneralPin(chatId).catch(() => undefined);
}

await loadGeneralPins();

// ─── Scheduler ───────────────────────────────────────────────────────────────

const scheduler = new ScheduleManager(join(config.dataDir, "schedules.json"));
await scheduler.load();

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
const dirBrowserState = new Map<TopicKeyString, { currentPath: string; children: string[] }>();

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
async function showDirBrowser(key: TopicKey, dirPath: string, page = 0): Promise<void> {
  const children = await listSubdirs(dirPath);
  dirBrowserState.set(topicKeyStr(key), { currentPath: dirPath, children });

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

  await sendGeneralKeyboard(key.chatId, text, { inline_keyboard: buttons }, key.threadId);
}

/** Show the initial /new picker with bookmarks, recent dirs, and home. */
async function showNewPicker(key: TopicKey): Promise<void> {
  const recent = getRecentDirs(key.chatId);
  const shortcuts: Array<{ text: string; buttonText: string; path: string }> = [];

  // Add recent dirs (deduplicated against DEFAULT_CWD)
  for (const d of recent) {
    if (d === DEFAULT_CWD) continue;
    if (shortcuts.some((s) => s.path === d)) continue;
    const parts = d.split("/").filter(Boolean);
    const short = parts.length >= 2 ? parts.slice(-2).join("/") : (parts[parts.length - 1] ?? d);
    shortcuts.push({ text: `📂 ${short}`, buttonText: `📂 ${short}`, path: d });
  }

  // Store all paths for index-based lookup
  const allPaths = shortcuts.map((s) => s.path);
  dirBrowserState.set(topicKeyStr(key), { currentPath: DEFAULT_CWD, children: allPaths });

  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  // Browse from home
  const homeName = DEFAULT_CWD.split("/").filter(Boolean).pop() ?? "home";
  buttons.push([{ text: `🏠 Browse ~/${homeName}`, callback_data: "nav:browse_home" }]);

  // Recent dir shortcuts (1 per row)
  for (let i = 0; i < Math.min(shortcuts.length, 6); i++) {
    const s = shortcuts[i];
    if (s) buttons.push([{ text: s.buttonText, callback_data: `nav:pick_${i}` }]);
  }

  const lines =
    shortcuts.length > 0
      ? shortcuts.map((s) => `${s.text} → ${fmt.code(s.path)}`).join("\n")
      : "<i>No recent sessions</i>";

  await sendGeneralKeyboard(
    key.chatId,
    `🆕 <b>New session — choose directory:</b>\n\n${lines}\n\nTap a shortcut or browse:`,
    { inline_keyboard: buttons },
    key.threadId,
  );
}

// ─── Global session state ─────────────────────────────────────────────────────

let globalPermissionMode: PermissionMode = "normal";

// ─── Permission memory ────────────────────────────────────────────────────────
// Tracks tools the user has approved at broader scope than "once".

/** Session-scoped approvals: cleared when session ends. topicKey → Set<toolName> */
const sessionApprovedTools = new Map<TopicKeyString, Set<string>>();

/** Project-scoped approvals: persisted per cwd. cwd → Set<toolName> */
const projectApprovedTools = new Map<string, Set<string>>();

function isToolAutoApproved(key: TopicKey, toolName: string): boolean {
  // Check session-scoped approvals
  if (sessionApprovedTools.get(topicKeyStr(key))?.has(toolName)) return true;
  // Check project-scoped approvals
  const session = sessions.getActive(key);
  if (session && projectApprovedTools.get(session.cwd)?.has(toolName)) return true;
  return false;
}

function approveToolForSession(key: TopicKey, toolName: string): void {
  const k = topicKeyStr(key);
  let set = sessionApprovedTools.get(k);
  if (!set) {
    set = new Set();
    sessionApprovedTools.set(k, set);
  }
  set.add(toolName);
}

function approveToolForProject(key: TopicKey, toolName: string): void {
  const session = sessions.getActive(key);
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
  const { chatId, threadId, toolName, toolInput } = request;
  const key: TopicKey = { chatId, threadId };
  const inp = toolInput as Record<string, unknown> | undefined;

  // Auto-approve if the user previously approved this tool at session or project scope
  if (isToolAutoApproved(key, toolName)) {
    relay.resolvePrompt(key, { behavior: "allow", updatedInput: toolInput });
    return;
  }

  // Format the full tool input as a readable code block
  const toolDesc = TOOL_DESCRIPTIONS[toolName] ?? toolName;
  let detail = `Tool: ${fmt.code(toolName)} — ${escapeHtml(toolDesc)}`;
  if (inp && Object.keys(inp).length > 0) {
    const lines = Object.entries(inp).map(([k, val]) => {
      const valStr = typeof val === "string" ? val : JSON.stringify(val);
      const truncated = valStr.length > 200 ? `${valStr.slice(0, 200)}…` : valStr;
      return `${k}: ${truncated}`;
    });
    detail += `\n<pre>${escapeHtml(lines.join("\n"))}</pre>`;
  }

  // Build button rows with granular options
  const toolShort = toolName.length > 10 ? `${toolName.slice(0, 10)}…` : toolName;
  await tg.sendMessageWithKeyboard(
    chatId,
    `🔒 <b>Permission required</b>\n${detail}\n\n<i>Expires in 2 min</i>`,
    {
      inline_keyboard: [
        [
          { text: "✅ Allow once", callback_data: "permit:allow" },
          { text: "❌ Deny", callback_data: "permit:deny" },
        ],
        [{ text: `✅ Allow ${toolShort} for session`, callback_data: `permit:session:${toolName}` }],
        [{ text: `✅ Always allow ${toolShort} in project`, callback_data: `permit:project:${toolName}` }],
      ],
    },
    threadId,
  );
}, scheduler);

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
const SCHEDULER_SCRIPT = resolve(import.meta.dir, "scheduler-relay.ts");

process.stderr.write(
  `✅  Orchestrator @${botInfo.username} ready — policy: ${access.policy}, ` +
    `allowlist: [${access.allowlist.join(", ")}]\n`,
);

// Register bot commands for Telegram menu
await tg
  .setMyCommands([
    { command: "new", description: "Start a new Claude session" },
    { command: "sessions", description: "List + resume sessions" },
    { command: "stop", description: "End session" },
    { command: "compact", description: "Fresh session, same directory" },
    { command: "cc", description: "Claude Code slash command" },
    { command: "model", description: "Switch model" },
    { command: "mode", description: "Permission mode" },
    { command: "cost", description: "Session cost" },
    { command: "status", description: "Session info" },
    { command: "schedule", description: "Schedule a job" },
    { command: "jobs", description: "List scheduled jobs" },
    { command: "help", description: "Show all commands" },
  ])
  .catch((e: Error) => process.stderr.write(`⚠️  setMyCommands failed: ${e.message}\n`));

// ─── Forum helpers ───────────────────────────────────────────────────────────

/** Build compact status text for the pinned message in a session topic. */
function buildSessionStatusText(session: SessionInfo): string {
  const model = session.model ?? globalModel ?? "(default)";
  const mode = session.permissionMode ?? globalPermissionMode;
  const cost = (session.totalCost ?? 0).toFixed(4);
  const state = sessions.isProcessing({ chatId: session.chatId, threadId: session.threadId })
    ? "🟢 Running"
    : "⚪ Idle";
  return [
    `📂 ${fmt.code(session.cwd)}`,
    `🤖 ${fmt.code(model)} · ⚡ ${fmt.code(mode)} · ${state}`,
    `💰 $${cost} · ${session.totalTurns ?? 0} turns`,
  ].join("\n");
}

/** Update the pinned status message for a session (best-effort). */
async function updatePinnedStatus(session: SessionInfo): Promise<void> {
  if (session.pinnedMessageId == null || session.chatId == null) return;
  await tg
    .editMessageText(session.chatId, session.pinnedMessageId, buildSessionStatusText(session))
    .catch(() => undefined);
}

/** Send and pin a status message in a session topic. */
async function pinSessionStatus(session: SessionInfo): Promise<void> {
  if (session.threadId == null) return;
  try {
    const msg = await tg.sendMessage(session.chatId, buildSessionStatusText(session), undefined, session.threadId);
    session.pinnedMessageId = msg.message_id;
    await tg.pinChatMessage(session.chatId, msg.message_id).catch(() => undefined);
  } catch {
    // Best-effort — bot may lack can_pin_messages
  }
}

/** Send a notification to the Activity topic (no-op for non-forum chats). */
async function notifyGeneral(chatId: number, text: string): Promise<void> {
  const isForum = await topics.isForum(chatId);
  if (!isForum) return;
  const threadId = await topics.getActivityTopic(chatId);
  if (threadId != null) {
    // Ensure topic is open
    try {
      await topics.reopenTopic(chatId, threadId);
    } catch {
      /* already open */
    }
  }
  if (threadId == null) return;
  await saveActivityTopic(chatId, threadId);
  await tg.sendMessage(chatId, text, undefined, threadId).catch(() => undefined);
}

/** Last bot message in General topic per chat (for ephemeral cleanup). */
const lastGeneralMessage = new Map<number, number>();

/** Send an ephemeral message to General topic — deletes the previous one. In non-forum chats, sends normally. */
async function sendGeneralMessage(chatId: number, text: string, threadId?: number): Promise<void> {
  const isForum = await topics.isForum(chatId);
  if (isForum && threadId == null) {
    const prev = lastGeneralMessage.get(chatId);
    if (prev) tg.deleteMessage(chatId, prev);
    const msg = await tg.sendMessage(chatId, text);
    lastGeneralMessage.set(chatId, msg.message_id);
  } else {
    await tg.sendMessage(chatId, text, undefined, threadId);
  }
}

/** Send an ephemeral message with keyboard to General topic — deletes the previous one. */
async function sendGeneralKeyboard(
  chatId: number,
  text: string,
  keyboard: import("./types.js").TelegramInlineKeyboardMarkup,
  threadId?: number,
): Promise<void> {
  const isForum = await topics.isForum(chatId);
  if (isForum && threadId == null) {
    const prev = lastGeneralMessage.get(chatId);
    if (prev) tg.deleteMessage(chatId, prev);
    const msg = await tg.sendMessageWithKeyboard(chatId, text, keyboard, undefined);
    lastGeneralMessage.set(chatId, msg.message_id);
  } else {
    await tg.sendMessageWithKeyboard(chatId, text, keyboard, threadId);
  }
}

/** Quick-start inline keyboard for new/resumed sessions in forum topics. */
const SESSION_QUICK_BUTTONS = {
  inline_keyboard: [
    [
      { text: "🔄 Set model", callback_data: "quick:model" },
      { text: "⚡ Set mode", callback_data: "quick:mode" },
    ],
    [
      { text: "📋 Status", callback_data: "quick:status" },
      { text: "❓ Help", callback_data: "quick:help" },
    ],
  ],
};

/** Download a photo or document attachment, saving to the session's upload dir. */
async function downloadAttachment(
  message: TelegramMessage,
  session: SessionInfo,
): Promise<{ localPath: string; description: string } | null> {
  try {
    const uploadDir = join(session.cwd, ".claude", "telegram-uploads");

    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];
      if (!photo) return null;
      const file = await tg.getFile(photo.file_id);
      const data = await tg.downloadFile(file.file_path);
      const ext = file.file_path.split(".").pop() ?? "jpg";
      const filename = `photo-${Date.now()}.${ext}`;
      const localPath = join(uploadDir, filename);
      await mkdir(uploadDir, { recursive: true });
      await writeFile(localPath, data);
      return { localPath, description: `[User sent a photo (${photo.width}x${photo.height}), saved to ${localPath}]` };
    }

    if (message.document) {
      const doc = message.document;
      const file = await tg.getFile(doc.file_id);
      const data = await tg.downloadFile(file.file_path);
      const filename = doc.file_name ?? `file-${Date.now()}`;
      const localPath = join(uploadDir, filename);
      await mkdir(uploadDir, { recursive: true });
      await writeFile(localPath, data);
      return {
        localPath,
        description: `[User sent a file: ${doc.file_name ?? "document"} (${doc.mime_type ?? "unknown type"}), saved to ${localPath}]`,
      };
    }
  } catch (err) {
    process.stderr.write(`⚠️  Failed to download attachment: ${err}\n`);
  }
  return null;
}

// ─── Message handling ─────────────────────────────────────────────────────────

let lastUpdateId = 0;

async function handleMessage(message: TelegramMessage): Promise<void> {
  // Handle forum topic closed — auto-stop the session
  if (message.forum_topic_closed && message.message_thread_id) {
    const chatId = message.chat.id;
    const threadId = message.message_thread_id;
    const key: TopicKey = { chatId, threadId };
    const keyStr = topicKeyStr(key);
    const proc = activeProcs.get(keyStr);
    if (proc) {
      proc.kill();
      activeProcs.delete(keyStr);
    }
    sessions.setProcessing(key, false);
    const session = sessions.endActive(key);
    sessionApprovedTools.delete(keyStr);
    if (session) {
      topics.unregisterThread(chatId, threadId);
      await sessions.save();
      process.stderr.write(`🛑  Auto-stopped session in closed topic ${threadId} (chat ${chatId})\n`);
      refreshCockpit(chatId);
    }
    return;
  }

  const userId = message.from?.id;
  if (!userId) return;

  const chatId = message.chat.id;
  const key = getTopicKey(message);
  const text = (message.text ?? message.caption ?? "").trim();

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
  if (relay.hasPending(key)) {
    await handlePendingReply(key, text);
    return;
  }

  const cmd = parseCommand(text);

  // ─── Forum topic routing ─────────────────────────────────────────────
  const isForum = await topics.isForum(chatId);
  if (isForum) {
    ensureGeneralPin(chatId);
    const isGeneralTopic = !message.is_topic_message;

    const MANAGEMENT_COMMANDS: ReadonlySet<string> = new Set([
      "new",
      "sessions",
      "help",
      "approve",
      "schedule",
      "schedule_help",
      "jobs",
      "dirs",
    ]);

    const SESSION_LOCAL_COMMANDS: ReadonlySet<string> = new Set([
      "stop",
      "compact",
      "cost",
      "status",
      "cc",
      "cc_menu",
      "mode",
      "model",
      "prompt",
      "schedule",
      "schedule_help",
      "jobs",
    ]);

    if (isGeneralTopic) {
      if (cmd.type === "prompt") {
        await sendGeneralMessage(chatId, "Send prompts in a session topic.\nUse /new to create one.");
        return;
      }
      if (!MANAGEMENT_COMMANDS.has(cmd.type) && cmd.type !== "unknown_command") {
        await sendGeneralMessage(chatId, "This command works in session topics.\nUse /sessions to find yours.");
        return;
      }
    } else {
      // Session topic
      if (!SESSION_LOCAL_COMMANDS.has(cmd.type) && cmd.type !== "unknown_command") {
        await tg.sendMessage(chatId, "Use this command in the General topic.", undefined, key.threadId);
        return;
      }
    }
  }

  switch (cmd.type) {
    case "new":
      await handleNew(key, cmd.cwd, cmd.name);
      break;
    case "sessions":
      await handleListSessions(key);
      break;
    case "stop":
      await handleStop(key);
      break;
    case "compact":
      await handleCompact(key);
      break;
    case "model":
      await handleModel(key, cmd.model);
      break;
    case "cost":
      await handleCost(key);
      break;
    case "status":
      await handleStatus(key);
      break;
    case "help":
      await handleHelp(key);
      break;
    case "approve":
      await handleApprove(chatId, userId, cmd.code);
      break;
    case "cc":
      await handleClaudeCommand(key, cmd.slashCommand, cmd.args, message.message_id);
      break;
    case "cc_menu":
      await handleCcMenu(key);
      break;
    case "mode":
      await handleMode(key, cmd.mode);
      break;
    case "dirs":
      await showNewPicker(key);
      break;
    case "schedule":
      await handleSchedule(key, cmd.prompt, cmd.scheduleExpr, cmd.name, cmd.cwd);
      break;
    case "schedule_help":
      await handleScheduleHelp(chatId);
      break;
    case "jobs":
      await handleJobs(key);
      break;
    case "unknown_command":
      await sendGeneralMessage(
        chatId,
        `Unknown command: ${fmt.code(cmd.text)}\nUse /help for available commands, or send without / to chat with Claude.`,
        key.threadId,
      );
      break;
    case "prompt": {
      let promptText = cmd.text;

      // Download and include file/photo attachments
      const activeSession = sessions.getActive(key);
      if (activeSession && (message.photo || message.document)) {
        const attachment = await downloadAttachment(message, activeSession);
        if (attachment) {
          promptText = `${attachment.description}\n\n${promptText || "What is this?"}`;
        }
      }

      // Include replied-to bot message as context
      if (message.reply_to_message?.from?.id === botInfo.id) {
        const repliedText = message.reply_to_message.text ?? message.reply_to_message.caption ?? "";
        if (repliedText) {
          const plain = stripHtml(repliedText);
          const preview = plain.length > 500 ? `${plain.slice(0, 500)}…` : plain;
          promptText = `[Replying to your previous message: "${preview}"]\n\n${promptText}`;
        }
      }

      await handlePrompt(key, promptText, message.message_id);
      break;
    }
  }
}

async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data;
  if (!data) return;

  const chatId = query.message?.chat.id;
  if (!chatId) return;

  // Extract threadId from the callback's original message for correct topic routing
  const threadId = query.message?.message_thread_id;
  const key: TopicKey = { chatId, threadId };

  // Ensure cockpit exists for forum chats
  ensureGeneralPin(chatId).catch(() => undefined);

  // Permission prompt callbacks
  if (data.startsWith("permit:")) {
    const pending = relay.getPending(key);

    // "permit:allow" — allow once
    if (data === "permit:allow") {
      relay.resolvePrompt(key, {
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
      relay.resolvePrompt(key, { behavior: "deny" });
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
      approveToolForSession(key, tool);
      relay.resolvePrompt(key, {
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
      approveToolForProject(key, tool);
      approveToolForSession(key, tool); // also approve for current session
      relay.resolvePrompt(key, {
        behavior: "allow",
        ...(pending ? { updatedInput: pending.toolInput } : {}),
      });
      const session = sessions.getActive(key);
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
    const match = sessions.findByIdPrefix(key.chatId, resumeMatch[1]);
    if (match) {
      await tg.answerCallbackQuery(query.id, "🔄 Resuming…");
      await resumeSession(key, match);
    } else {
      await tg.answerCallbackQuery(query.id, "Session not found");
    }
    return;
  }

  // Model switch: "model:<name>"
  const modelMatch = data.match(/^model:(.+)$/);
  if (modelMatch?.[1]) {
    await tg.answerCallbackQuery(query.id, `✅ Switching to ${modelMatch[1]}`);
    await handleModel(key, modelMatch[1]);
    return;
  }

  // Quick-start actions: "quick:<action>"
  const quickMatch = data.match(/^quick:(.+)$/);
  if (quickMatch?.[1]) {
    await tg.answerCallbackQuery(query.id);
    switch (quickMatch[1]) {
      case "new":
        await handleNew(key);
        break;
      case "sessions":
        await handleListSessions(key);
        break;
      case "help":
        await handleHelp(key);
        break;
      case "model":
        await handleModel(key);
        break;
      case "mode":
        await handleMode(key);
        break;
      case "status":
        await handleStatus(key);
        break;
      case "jobs":
        await handleJobs(key);
        break;
      case "dirs":
        await showNewPicker(key);
        break;
    }
    return;
  }

  // /cc command picker: "cc:<command>"
  const ccMatch = data.match(/^cc:(.+)$/);
  if (ccMatch?.[1]) {
    await tg.answerCallbackQuery(query.id, `Running /${ccMatch[1]}…`);
    await handleClaudeCommand(key, ccMatch[1], "");
    return;
  }

  // Navigable directory browser: "nav:<action>"
  const navMatch = data.match(/^nav:(.+)$/);
  if (navMatch?.[1]) {
    const action = navMatch[1];
    const keyStr = topicKeyStr(key);
    const state = dirBrowserState.get(keyStr);

    if (action === "start" && state) {
      // Confirm — create session in current directory
      await tg.answerCallbackQuery(query.id, "🆕 Creating session…");
      await handleNew(key, state.currentPath);
      dirBrowserState.delete(keyStr);
      // Replace the browser message with a compact confirmation + topic link
      const session =
        sessions.getActive({ chatId: key.chatId, threadId: undefined }) === undefined
          ? sessions.getActiveForChat(key.chatId).find((s) => s.cwd === state.currentPath)
          : undefined;
      const dirName = state.currentPath.split("/").pop() ?? state.currentPath;
      let confirmText = `🆕 Session created in ${fmt.code(dirName)}`;
      if (session?.threadId) {
        const link = topics.getTopicLink(key.chatId, session.threadId);
        if (link) confirmText += ` — <a href="${link}">Open topic</a>`;
      }
      const prev = lastGeneralMessage.get(key.chatId);
      if (prev) {
        await tg.editMessageText(key.chatId, prev, confirmText).catch(() => undefined);
      }
      return;
    }

    if (action === "up" && state) {
      const parent = resolve(state.currentPath, "..");
      await tg.answerCallbackQuery(query.id, `⬆️ ${parent.split("/").pop() ?? "/"}`);
      await showDirBrowser(key, parent);
      return;
    }

    if (action === "browse_home") {
      await tg.answerCallbackQuery(query.id, "🏠 Browsing…");
      await showDirBrowser(key, DEFAULT_CWD);
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
      await showDirBrowser(key, state.currentPath, Number(pageMatch[1]));
      return;
    }

    // "pick_<index>" — shortcut from initial picker
    const pickMatch = action.match(/^pick_(\d+)$/);
    if (pickMatch?.[1] && state) {
      const idx = Number(pickMatch[1]);
      const path = state.children[idx];
      if (path) {
        await tg.answerCallbackQuery(query.id, `📂 ${path.split("/").pop()}`);
        await showDirBrowser(key, path);
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
        await showDirBrowser(key, fullPath);
        return;
      }
    }

    await tg.answerCallbackQuery(query.id);
    return;
  }

  // Scheduled job actions: "job:cancel:<id>" or "job:pause:<id>"
  const jobMatch = data.match(/^job:(cancel|pause):(.+)$/);
  if (jobMatch?.[1] && jobMatch[2]) {
    const [, action, jobId] = jobMatch;
    if (action === "cancel") {
      const deleted = scheduler.delete(jobId);
      if (deleted) {
        await scheduler.save();
        await tg.answerCallbackQuery(query.id, "🗑 Job cancelled");
        if (query.message) {
          await tg
            .editMessageText(chatId, query.message.message_id, `🗑 Job ${fmt.code(jobId)} cancelled`)
            .catch(() => undefined);
        }
      } else {
        await tg.answerCallbackQuery(query.id, "❌ Job not found");
      }
      return;
    }
    if (action === "pause") {
      const toggled = scheduler.toggle(jobId);
      if (toggled) {
        await scheduler.save();
        const job = scheduler.findById(jobId);
        const state = job?.enabled ? "▶️ Resumed" : "⏸ Paused";
        await tg.answerCallbackQuery(query.id, state);
        if (query.message) {
          await tg
            .editMessageText(chatId, query.message.message_id, `${state} job ${fmt.code(jobId)}`)
            .catch(() => undefined);
        }
      } else {
        await tg.answerCallbackQuery(query.id, "❌ Job not found");
      }
      return;
    }
  }

  // Mode switch: "mode:<mode>"
  const modeMatch = data.match(/^mode:(.+)$/);
  if (modeMatch?.[1]) {
    await tg.answerCallbackQuery(query.id, `✅ ${modeMatch[1]} mode`);
    await handleMode(key, modeMatch[1] as PermissionMode);
    return;
  }

  await tg.answerCallbackQuery(query.id);
}

/** Handle text reply to a pending AskUserQuestion prompt. */
async function handlePendingReply(key: TopicKey, text: string): Promise<void> {
  const pending = relay.getPending(key);
  if (!pending) return;

  // For AskUserQuestion, wrap the answer
  if (pending.toolName === "AskUserQuestion") {
    const questions = (pending.toolInput as { questions?: Array<{ question: string }> })?.questions;
    const firstQuestion = questions?.[0]?.question ?? "";
    relay.resolvePrompt(key, {
      behavior: "allow",
      updatedInput: {
        ...(pending.toolInput as Record<string, unknown>),
        answers: { [firstQuestion]: text },
      },
    });
  } else {
    // For other tools, treat as allow/deny
    const isAllow = /^(y|yes|allow|ok|approve)/i.test(text.trim());
    relay.resolvePrompt(key, {
      behavior: isAllow ? "allow" : "deny",
      ...(isAllow ? { updatedInput: pending.toolInput } : {}),
    });
  }

  await tg.sendMessage(key.chatId, "✅ Response recorded.", undefined, key.threadId);
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function handleNew(key: TopicKey, cwd?: string, name?: string): Promise<void> {
  if (sessions.isProcessing(key)) {
    await tg.sendMessage(
      key.chatId,
      "⏳ A task is still running. Wait for it to finish or /stop first.",
      undefined,
      key.threadId,
    );
    return;
  }

  // Forum concurrency limit
  const isForum = await topics.isForum(key.chatId);
  if (isForum) {
    const activeCount = sessions.getActiveForChat(key.chatId).length;
    if (activeCount >= MAX_SESSIONS_PER_CHAT) {
      await tg.sendMessage(
        key.chatId,
        `❌ Session limit reached (max ${MAX_SESSIONS_PER_CHAT}).\nEnd a session with /stop first.`,
        undefined,
        key.threadId,
      );
      return;
    }
  }

  // If no path specified, show navigable directory picker
  if (!cwd) {
    await showNewPicker(key);
    return;
  }

  const targetCwd = cwd ?? DEFAULT_CWD;

  try {
    const s = await stat(targetCwd);
    if (!s.isDirectory()) {
      await tg.sendMessage(key.chatId, `❌ Not a directory: ${fmt.code(targetCwd)}`, undefined, key.threadId);
      return;
    }
  } catch {
    await tg.sendMessage(key.chatId, `❌ Directory not found: ${fmt.code(targetCwd)}`, undefined, key.threadId);
    return;
  }

  sessions.endActive(key);
  const session = sessions.create(key, targetCwd, "pending", name);
  await sessions.save();

  // Create a Forum Topic for the session if in a forum chat
  if (isForum) {
    const topicName = name ?? targetCwd.split("/").pop() ?? "Claude";
    try {
      const threadId = await topics.createSessionTopic(key.chatId, topicName);
      // Rekey session to the new topic
      sessions.endActive(key);
      session.threadId = threadId;
      const newKey: TopicKey = { chatId: key.chatId, threadId };
      sessions.setActive(newKey, session);
      topics.registerThread(key.chatId, threadId, session.sessionId);
      await sessions.save();

      await tg.sendMessageWithKeyboard(
        key.chatId,
        `🆕 New session in ${fmt.code(targetCwd)}\n${name ? `Name: <b>${escapeHtml(name)}</b>\n` : ""}\nSend a message to get started, or tap a quick action:`,
        SESSION_QUICK_BUTTONS,
        threadId,
      );
      await pinSessionStatus(session);
      await sessions.save();
      refreshCockpit(key.chatId);
      return;
    } catch (err) {
      process.stderr.write(`⚠️  Failed to create forum topic: ${err}\n`);
      // Fall through to non-forum behavior
    }
  }

  await tg.sendMessage(
    key.chatId,
    `🆕 New session in ${fmt.code(targetCwd)}\n${name ? `Name: <b>${escapeHtml(name)}</b>\n` : ""}\nSend a message to get started.`,
    undefined,
    key.threadId,
  );
}

async function resumeSession(key: TopicKey, session: SessionInfo): Promise<void> {
  const label = session.name ?? session.title ?? `${session.sessionId.slice(0, 8)}…`;
  const isForum = await topics.isForum(key.chatId);

  if (isForum && session.threadId != null) {
    // Try to reopen the existing topic
    try {
      await topics.reopenTopic(key.chatId, session.threadId);
      const newKey: TopicKey = { chatId: key.chatId, threadId: session.threadId };
      sessions.setActive(newKey, session);
      topics.registerThread(key.chatId, session.threadId, session.sessionId);
      await tg.sendMessageWithKeyboard(
        key.chatId,
        `🔄 Resumed <b>${escapeHtml(label)}</b> in ${fmt.code(session.cwd)}`,
        SESSION_QUICK_BUTTONS,
        session.threadId,
      );
      await pinSessionStatus(session);
      refreshCockpit(key.chatId);
      return;
    } catch {
      // Topic was deleted — create a new one
      process.stderr.write(`⚠️  Topic ${session.threadId} gone, creating new one\n`);
    }
  }

  if (isForum) {
    // Create a new forum topic for this resumed session
    const topicName = session.name ?? session.title ?? session.sessionId.slice(0, 8);
    try {
      const threadId = await topics.createSessionTopic(key.chatId, topicName);
      session.threadId = threadId;
      const newKey: TopicKey = { chatId: key.chatId, threadId };
      sessions.setActive(newKey, session);
      topics.registerThread(key.chatId, threadId, session.sessionId);
      await sessions.save();
      await tg.sendMessageWithKeyboard(
        key.chatId,
        `🔄 Resumed <b>${escapeHtml(label)}</b> in ${fmt.code(session.cwd)}`,
        SESSION_QUICK_BUTTONS,
        threadId,
      );
      await pinSessionStatus(session);
      refreshCockpit(key.chatId);
      return;
    } catch (err) {
      process.stderr.write(`⚠️  Failed to create forum topic for resume: ${err}\n`);
      // Fall through to non-forum behavior
    }
  }

  sessions.setActive(key, session);
  await tg.sendMessage(
    key.chatId,
    `🔄 Resumed <b>${escapeHtml(label)}</b> in ${fmt.code(session.cwd)}`,
    undefined,
    key.threadId,
  );
}

async function handleListSessions(key: TopicKey): Promise<void> {
  const history = sessions.listForChat(key.chatId);
  if (history.length === 0) {
    await sendGeneralMessage(key.chatId, "No sessions yet. Use /new to start one.", key.threadId);
    return;
  }

  const active = sessions.getActive(key);
  const lines = history.slice(0, 10).map((s) => {
    const marker = active?.sessionId === s.sessionId ? " 👈" : "";
    const label = s.name ?? s.title ?? s.sessionId.slice(0, 8);
    const dir = s.cwd.split("/").pop() ?? s.cwd;
    const age = formatAge(Date.now() - s.lastActiveAt);
    const cost = (s.totalCost ?? 0) > 0 ? ` · $${(s.totalCost ?? 0).toFixed(3)}` : "";
    return `• <b>${escapeHtml(label)}</b>${marker}\n  📂 ${fmt.code(dir)} · ${age}${cost}`;
  });

  // Build inline keyboard for quick resume — show title/name instead of IDs
  // In forum chats, also include a topic link button for sessions with threadId
  const isForum = await topics.isForum(key.chatId);
  const buttonRows: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [];
  for (const s of history.slice(0, 5)) {
    const label = s.name ?? s.title ?? `${s.sessionId.slice(0, 8)}…`;
    const truncLabel = label.length > 20 ? `${label.slice(0, 20)}…` : label;
    const row: Array<{ text: string; callback_data?: string; url?: string }> = [
      { text: truncLabel, callback_data: `resume:${s.sessionId.slice(0, 8)}` },
    ];
    if (isForum && s.threadId != null) {
      const link = topics.getTopicLink(key.chatId, s.threadId);
      if (link) row.push({ text: "📍 Topic", url: link });
    }
    buttonRows.push(row);
  }

  await sendGeneralKeyboard(
    key.chatId,
    `📋 <b>Sessions:</b>\n\n${lines.join("\n")}`,
    { inline_keyboard: buttonRows },
    key.threadId,
  );
}

async function handleStop(key: TopicKey): Promise<void> {
  const keyStr = topicKeyStr(key);
  const proc = activeProcs.get(keyStr);
  if (proc) {
    proc.kill();
    activeProcs.delete(keyStr);
  }
  sessions.setProcessing(key, false);

  const session = sessions.endActive(key);
  sessionApprovedTools.delete(keyStr); // clear session-scoped permission memory
  if (session) {
    await sessions.save();

    // Close forum topic if applicable
    if (session.threadId != null) {
      topics.unregisterThread(key.chatId, session.threadId);
      await topics.closeTopic(key.chatId, session.threadId);
    }

    await tg.sendMessage(
      key.chatId,
      "🛑 Session ended.\nUse /new to start a new one or /resume to continue a previous session.",
      undefined,
      key.threadId,
    );
    refreshCockpit(key.chatId);
  } else {
    await tg.sendMessage(
      key.chatId,
      "No active session. Use /new to start one or /resume to continue.",
      undefined,
      key.threadId,
    );
  }
}

async function handleCompact(key: TopicKey): Promise<void> {
  const session = sessions.getActive(key);
  if (!session) {
    await tg.sendMessage(
      key.chatId,
      "No active session. Use /new to start one or /resume to continue.",
      undefined,
      key.threadId,
    );
    return;
  }
  if (sessions.isProcessing(key)) {
    await tg.sendMessage(key.chatId, "⏳ Wait for the current task to finish first.", undefined, key.threadId);
    return;
  }

  const cwd = session.cwd;
  const name = session.name;
  sessions.endActive(key);
  sessions.create(key, cwd, "pending", name);
  await sessions.save();

  await tg.sendMessage(
    key.chatId,
    `🔄 Fresh session in ${fmt.code(cwd)}\n` +
      `Previous session preserved — use /resume to switch back.\n\n` +
      `Send a message to get started.`,
    undefined,
    key.threadId,
  );
}

async function handleModel(key: TopicKey, model?: string): Promise<void> {
  const session = sessions.getActive(key);

  if (!model) {
    const current = session?.model ?? globalModel ?? "(default)";
    await tg.sendMessageWithKeyboard(
      key.chatId,
      `Current model: ${fmt.code(current)}\n\nTap to switch:`,
      {
        inline_keyboard: [
          [
            { text: "sonnet", callback_data: "model:sonnet" },
            { text: "opus", callback_data: "model:opus" },
            { text: "haiku", callback_data: "model:haiku" },
          ],
        ],
      },
      key.threadId,
    );
    return;
  }

  if (session) {
    session.model = model;
    await sessions.save();
    updatePinnedStatus(session);
  }
  globalModel = model;
  await tg.sendMessage(key.chatId, `✅ Model set to ${fmt.code(model)}`, undefined, key.threadId);
}

async function handleCost(key: TopicKey): Promise<void> {
  const session = sessions.getActive(key);
  if (!session) {
    await tg.sendMessage(key.chatId, "No active session. Start one with /new or /resume.", undefined, key.threadId);
    return;
  }

  const cost = (session.totalCost ?? 0).toFixed(4);
  const turns = session.totalTurns ?? 0;
  await tg.sendMessage(key.chatId, `💰 Session cost: <b>$${cost}</b>\nTotal turns: ${turns}`, undefined, key.threadId);
}

async function handleStatus(key: TopicKey): Promise<void> {
  const session = sessions.getActive(key);
  if (!session) {
    await tg.sendMessage(key.chatId, "No active session. Use /new to start one.", undefined, key.threadId);
    return;
  }

  const id =
    session.sessionId === "pending" ? "(new — not yet started)" : fmt.code(`${session.sessionId.slice(0, 12)}…`);
  const model = session.model ?? globalModel ?? "(default)";
  const cost = (session.totalCost ?? 0).toFixed(4);
  const processing = sessions.isProcessing(key) ? "🟢 Running" : "⚪ Idle";

  await tg.sendMessage(
    key.chatId,
    [
      "📊 <b>Session Status</b>",
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
    undefined,
    key.threadId,
  );
}

// ─── Scheduling handlers ──────────────────────────────────────────────────────

async function handleSchedule(
  key: TopicKey,
  prompt: string,
  scheduleExpr: string,
  name?: string,
  cwd?: string,
): Promise<void> {
  const session = sessions.getActive(key);
  const jobCwd = cwd ?? session?.cwd ?? DEFAULT_CWD;

  // Validate directory
  try {
    const s = await stat(jobCwd);
    if (!s.isDirectory()) {
      await tg.sendMessage(key.chatId, `❌ Not a directory: ${fmt.code(jobCwd)}`, undefined, key.threadId);
      return;
    }
  } catch {
    await tg.sendMessage(key.chatId, `❌ Directory not found: ${fmt.code(jobCwd)}`, undefined, key.threadId);
    return;
  }

  const parsed = parseScheduleExpression(scheduleExpr);
  if (!parsed) {
    await sendGeneralMessage(
      key.chatId,
      `❌ Invalid schedule: ${fmt.code(scheduleExpr)}\n\n` +
        "Examples: every 30m, every 2h, at 9am weekdays, cron */15 * * * *",
      key.threadId,
    );
    return;
  }

  let job: ScheduledJob;
  try {
    job = scheduler.create(key.chatId, jobCwd, parsed.cronExpr, prompt, {
      name,
      recurring: parsed.recurring,
      sessionId: session?.sessionId !== "pending" ? session?.sessionId : undefined,
      threadId: key.threadId,
    });
  } catch (err) {
    await sendGeneralMessage(key.chatId, `❌ ${err instanceof Error ? err.message : String(err)}`, key.threadId);
    return;
  }

  await scheduler.save();

  const nextRun = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "unknown";
  const label = name ? fmt.bold(escapeHtml(name)) : fmt.code(prompt.slice(0, 50));

  await sendGeneralKeyboard(
    key.chatId,
    [
      `⏰ <b>Scheduled${parsed.recurring ? "" : " (one-shot)"}</b>`,
      "",
      `📝 ${label}`,
      `🕐 ${fmt.code(parsed.cronExpr)}`,
      `📂 ${fmt.code(jobCwd)}`,
      `⏭ Next run: ${nextRun}`,
      `🆔 ${fmt.code(job.id)}`,
    ].join("\n"),
    {
      inline_keyboard: [[{ text: "🗑 Cancel", callback_data: `job:cancel:${job.id}` }]],
    },
    key.threadId,
  );
}

async function handleScheduleHelp(chatId: number): Promise<void> {
  await sendGeneralMessage(
    chatId,
    [
      `<b>Usage:</b> ${fmt.code('/schedule "prompt" <when>')}`,
      "",
      "<b>Schedule expressions:</b>",
      `${fmt.code("every 30m")} — every 30 minutes`,
      `${fmt.code("every 2h")} — every 2 hours`,
      `${fmt.code("every day")} — daily at 9am`,
      `${fmt.code("at 9am weekdays")} — weekday mornings`,
      `${fmt.code("at 2:30pm")} — daily at 2:30pm`,
      `${fmt.code("cron */15 * * * *")} — raw cron`,
      `${fmt.code("once at 3pm")} — one-shot`,
      "",
      "<b>Options:</b>",
      `${fmt.code("--name alias")} — label the job`,
      `${fmt.code("--cwd /path")} — working directory`,
      "",
      "<b>Examples:</b>",
      `${fmt.code('/schedule "run tests" every 30m')}`,
      `${fmt.code('/schedule "check deploy" at 9am weekdays --name deploy-check')}`,
      `${fmt.code('/schedule "generate report" cron 0 18 * * 1-5')}`,
    ].join("\n"),
  );
}

async function handleJobs(key: TopicKey): Promise<void> {
  const jobs = scheduler.list(key.chatId);
  if (jobs.length === 0) {
    await sendGeneralMessage(key.chatId, "No scheduled jobs. Use /schedule to create one.", key.threadId);
    return;
  }

  const lines: string[] = [`<b>Scheduled jobs</b> (${jobs.length})`, ""];
  for (const job of jobs) {
    const status = job.enabled ? "▶️" : "⏸";
    const label = job.name ? escapeHtml(job.name) : escapeHtml(job.prompt.slice(0, 40));
    const nextRun = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—";
    const runs = job.runCount > 0 ? ` (${job.runCount} runs)` : "";
    lines.push(`${status} ${fmt.code(job.id)} ${fmt.bold(label)}`);
    lines.push(`   ${fmt.code(job.cronExpr)} → ${nextRun}${runs}`);
    lines.push("");
  }

  // Build inline buttons: 2 per row (pause + cancel per job)
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const job of jobs) {
    const pauseLabel = job.enabled ? "⏸ Pause" : "▶️ Resume";
    buttons.push([
      { text: `${pauseLabel} ${job.id}`, callback_data: `job:pause:${job.id}` },
      { text: `🗑 Cancel ${job.id}`, callback_data: `job:cancel:${job.id}` },
    ]);
  }

  await sendGeneralKeyboard(key.chatId, lines.join("\n"), { inline_keyboard: buttons }, key.threadId);
}

// ─── Scheduled job execution ─────────────────────────────────────────────────

async function executeScheduledJob(job: ScheduledJob): Promise<void> {
  // Create a forum topic for the job if in a forum chat and no thread yet
  if (job.threadId == null) {
    const isForum = await topics.isForum(job.chatId);
    if (isForum) {
      try {
        const jobName = job.name ?? job.prompt.slice(0, 30);
        job.threadId = await topics.createJobTopic(job.chatId, jobName);
        await scheduler.save();
      } catch (err) {
        process.stderr.write(`⚠️  Failed to create job topic: ${err}\n`);
      }
    }
  }

  // Jobs use isolated TopicKey so they never touch interactive sessions
  const jobKey: TopicKey = { chatId: job.chatId, threadId: job.threadId, jobId: job.id };

  const label = job.name ?? job.prompt.slice(0, 50);
  await tg.sendMessage(job.chatId, `⏰ <b>Scheduled:</b> ${escapeHtml(label)}`, undefined, job.threadId);

  // Ensure an active session for this job's isolated key
  let session = sessions.getActive(jobKey);

  if (!session || session.cwd !== job.cwd) {
    if (session) sessions.endActive(jobKey);

    // Try to resume the specific session if set
    if (job.sessionId) {
      const hist = sessions.findByIdPrefix(job.chatId, job.sessionId);
      if (hist && hist.cwd === job.cwd) {
        sessions.setActive(jobKey, hist);
        session = hist;
      }
    }

    // Otherwise create a fresh session
    if (!sessions.getActive(jobKey)) {
      session = sessions.create(jobKey, job.cwd, "pending", job.name);
      await sessions.save();
    }
  }

  // Record execution BEFORE spawning (prevents crash → infinite retry)
  scheduler.recordExecution(job.id);
  if (!job.recurring) scheduler.delete(job.id);
  await scheduler.save();

  // Execute via the existing fire-and-forget pattern
  handlePrompt(jobKey, job.prompt);
}

async function handleHelp(key: TopicKey): Promise<void> {
  const session = sessions.getActive(key);
  const headerLines: string[] = [];

  if (session) {
    const id = session.sessionId === "pending" ? "(new)" : `${session.sessionId.slice(0, 8)}…`;
    headerLines.push(
      `Active: ${fmt.code(id)}${session.name ? ` <b>${escapeHtml(session.name)}</b>` : ""} in ${fmt.code(session.cwd)}`,
    );
    if (sessions.isProcessing(key)) headerLines.push("🟢 Currently running");
    headerLines.push("");
  } else {
    headerLines.push("<i>No active session — start one with /new</i>", "");
  }

  await sendGeneralMessage(
    key.chatId,
    [
      "🤖 <b>Telegram Claude Orchestrator</b>",
      "",
      ...headerLines,
      "<b>Sessions:</b>",
      `${fmt.code("/new [path] [--name n]")} — New session`,
      `${fmt.code("/sessions")} — List + resume sessions`,
      `${fmt.code("/stop")} — End session`,
      `${fmt.code("/compact")} — Fresh session, same directory`,
      "",
      "<b>Claude Code:</b>",
      `${fmt.code("/cc [command]")} — Slash command pass-through`,
      `${fmt.code("/mode [normal|plan|auto]")} — Permission mode`,
      `${fmt.code("/model [name]")} — Switch model`,
      `${fmt.code("/cost")} — Session cost`,
      `${fmt.code("/status")} — Session info`,
      "",
      "<b>Scheduling:</b>",
      `${fmt.code('/schedule "prompt" <when>')} — Schedule a job`,
      `${fmt.code("/jobs")} — List jobs (pause/cancel inline)`,
      "",
      "Send text in a session topic to chat with Claude.",
    ].join("\n"),
    key.threadId,
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

async function handleCcMenu(key: TopicKey): Promise<void> {
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
    key.chatId,
    `🔧 <b>Claude Code Commands</b>\n\n${lines.join("\n")}\n\nTap or type ${fmt.code("/cc <command>")}:`,
    {
      inline_keyboard: buttons,
    },
    key.threadId,
  );
}

// ─── /mode — permission mode switching ────────────────────────────────────────

const MODE_LABELS: Record<PermissionMode, string> = {
  normal: "🔒 Normal — asks permission for each tool",
  plan: "📋 Plan — shows plan before executing",
  "auto-accept": "⚡ Auto-accept — runs tools without prompting",
};

async function handleMode(key: TopicKey, mode?: PermissionMode): Promise<void> {
  const session = sessions.getActive(key);

  if (!mode) {
    const current = session?.permissionMode ?? globalPermissionMode;
    await tg.sendMessageWithKeyboard(
      key.chatId,
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
      key.threadId,
    );
    return;
  }

  if (session) {
    session.permissionMode = mode;
    await sessions.save();
    updatePinnedStatus(session);
  }
  globalPermissionMode = mode;
  await tg.sendMessage(
    key.chatId,
    `✅ Mode: <b>${escapeHtml(mode)}</b>\n${escapeHtml(MODE_LABELS[mode])}`,
    undefined,
    key.threadId,
  );
}

// ─── Claude subprocess management ─────────────────────────────────────────────

const activeProcs = new Map<TopicKeyString, { kill: () => void }>();

async function handleClaudeCommand(
  key: TopicKey,
  slashCommand: string,
  args: string,
  replyToMessageId?: number,
): Promise<void> {
  const prompt = args ? `/${slashCommand} ${args}` : `/${slashCommand}`;
  await handlePrompt(key, prompt, replyToMessageId);
}

async function handlePrompt(key: TopicKey, text: string, replyToMessageId?: number): Promise<void> {
  let session = sessions.getActive(key);

  // Auto-resume: if no active session but we're in a forum topic with a known session
  if (!session && key.threadId != null) {
    const isForum = await topics.isForum(key.chatId);
    if (isForum) {
      const histSession = sessions.findByThread(key.chatId, key.threadId);
      if (histSession) {
        try {
          await topics.reopenTopic(key.chatId, key.threadId);
        } catch {
          /* already open */
        }
        sessions.setActive(key, histSession);
        topics.registerThread(key.chatId, key.threadId, histSession.sessionId);
        await sessions.save();
        session = histSession;
        const label = histSession.name ?? histSession.title ?? histSession.sessionId.slice(0, 8);
        await tg.sendMessage(key.chatId, `🔄 Auto-resumed <b>${escapeHtml(label)}</b>`, undefined, key.threadId);
      }
    }
  }

  if (!session) {
    await tg.sendMessage(
      key.chatId,
      "No active session. Start one with:\n" +
        `${fmt.code("/new")} — in default directory\n` +
        `${fmt.code("/new /path/to/project")} — in a specific directory`,
      undefined,
      key.threadId,
    );
    return;
  }

  if (sessions.isProcessing(key)) {
    await tg.sendMessage(key.chatId, "⏳ Still processing. Please wait or /stop.", undefined, key.threadId);
    return;
  }

  sessions.setProcessing(key, true);

  const keyStr = topicKeyStr(key);

  // Fire and forget — don't block the poll loop
  runQuery(key, session, text, replyToMessageId)
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`❌  Query error (chat ${key.chatId}): ${msg}\n`);
      tg.sendMessage(key.chatId, `❌ Error: ${msg}`, undefined, key.threadId).catch(() => undefined);
    })
    .finally(() => {
      sessions.setProcessing(key, false);
      activeProcs.delete(keyStr);
    });
}

async function runQuery(key: TopicKey, session: SessionInfo, prompt: string, replyToMessageId?: number): Promise<void> {
  const chatId = key.chatId;
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
  const keyStr = topicKeyStr(key);
  const mcpConfigPath = `/tmp/telegram-relay-${chatId}-${process.pid}-${key.threadId ?? 0}.json`;
  const relayEnv: Record<string, string> = {
    RELAY_HTTP_PORT: String(relay.port),
    RELAY_CHAT_ID: String(chatId),
  };
  if (key.threadId != null) relayEnv.RELAY_THREAD_ID = String(key.threadId);

  const mcpConfig = {
    mcpServers: {
      ...projectMcpServers,
      telegram_relay: {
        command: "bun",
        args: ["run", RELAY_SCRIPT],
        env: relayEnv,
      },
      telegram_scheduler: {
        command: "bun",
        args: ["run", SCHEDULER_SCRIPT],
        env: {
          RELAY_HTTP_PORT: String(relay.port),
          RELAY_CHAT_ID: String(chatId),
          SCHEDULER_CWD: session.cwd,
          ...(key.threadId != null ? { RELAY_THREAD_ID: String(key.threadId) } : {}),
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

  activeProcs.set(keyStr, proc);

  // Typing keepalive
  const typingTimer = setInterval(() => {
    tg.sendChatAction(chatId, "typing", key.threadId).catch(() => undefined);
  }, TYPING_INTERVAL_MS);

  // Read stderr in background
  readStderr(proc.stderr, session.cwd);

  // Stream output to Telegram — thread under the user's message
  const renderer = new StreamingRenderer(tg, chatId, key.threadId);
  await renderer.start(replyToMessageId);

  try {
    const result = await processNdjsonStream(proc.stdout, renderer, key);

    // Update session with real ID and title
    if (result.sessionId) {
      sessions.updateSessionId(key, result.sessionId);
      session.lastActiveAt = Date.now();
    }
    if (result.title && !session.name) {
      session.title = result.title;
    }

    // Accumulate cost
    if (result.totalCost || result.numTurns) {
      sessions.addCost(key, result.totalCost ?? 0, result.numTurns ?? 0);
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

    // Update pinned status + notify General topic
    const currentSession = sessions.getActive(key);
    if (currentSession) {
      updatePinnedStatus(currentSession);
      if (key.threadId != null) {
        const label = currentSession.name ?? currentSession.title ?? currentSession.sessionId.slice(0, 8);
        const prefix = key.jobId ? "Job" : "Session";
        const costInfo = costStr ? ` · ${costStr}` : "";
        const icon = result.error ? "❌" : "✅";
        notifyGeneral(
          chatId,
          `${icon} ${prefix} <b>${escapeHtml(label)}</b>${result.error ? " error" : " completed"}${costInfo}`,
        );
        refreshCockpit(chatId);
      }
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
  key: TopicKey,
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
                await sendQuestionPrompt(key, block.input);
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
                  .filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text)
                  .map((b) => b.text)
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
async function sendQuestionPrompt(key: TopicKey, input: unknown): Promise<void> {
  const questions = (
    input as { questions?: Array<{ question: string; options?: Array<{ label: string; description?: string }> }> }
  )?.questions;
  if (!questions?.length) return;

  const q = questions[0];
  if (!q) return;
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

  await tg.sendMessage(key.chatId, text, undefined, key.threadId).catch(() => undefined);
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

// ─── Scheduler tick ──────────────────────────────────────────────────────────

const schedulerTimer = setInterval(async () => {
  try {
    const dueJobs = scheduler.getDueJobs(Date.now());
    for (const job of dueJobs) {
      // Check if THIS job's isolated session is already running
      const jobKey: TopicKey = { chatId: job.chatId, threadId: job.threadId, jobId: job.id };
      if (sessions.isProcessing(jobKey)) {
        process.stderr.write(`⏰  Skipping scheduled job ${job.id} — still running\n`);
        continue;
      }
      // Enforce per-chat concurrent job limit
      if (sessions.countProcessingJobs(job.chatId) >= MAX_CONCURRENT_JOBS_PER_CHAT) {
        process.stderr.write(`⏰  Skipping scheduled job ${job.id} — concurrent job limit reached\n`);
        continue;
      }
      await executeScheduledJob(job);
    }
  } catch (err) {
    process.stderr.write(`⚠️  Scheduler tick error: ${err instanceof Error ? err.message : err}\n`);
  }
}, SCHEDULER_CHECK_INTERVAL_MS);

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
  clearInterval(schedulerTimer);
  relay.shutdown();
  for (const [, proc] of activeProcs) {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  }
  Promise.all([sessions.save(), scheduler.save()]).finally(() => process.exit(0));
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
