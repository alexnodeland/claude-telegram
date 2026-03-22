#!/usr/bin/env bun

/**
 * claude-telegram
 *
 * A Claude Code Channel plugin that bridges Telegram ↔ a running Claude Code
 * session. Declares the "claude/channel" (experimental) capability so Claude
 * Code treats this MCP server as a live event channel.
 *
 * Runtime: Bun ≥ 1.1  |  Claude Code ≥ 2.1.80
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addToAllowlist,
  consumePairingCode,
  isAllowed,
  issuePairingCode,
  loadAccessState,
  removeFromAllowlist,
  saveAccessState,
} from "./access.js";
import { loadConfig, TYPING_INTERVAL_MS } from "./config.js";
import { fmt } from "./html.js";
import { TelegramClient } from "./telegram.js";
import type { AccessState, ActiveContext, TelegramMessage } from "./types.js";

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

process.stderr.write(
  `✅  Bot @${botInfo.username} ready — policy: ${access.policy}, ` + `allowlist: [${access.allowlist.join(", ")}]\n`,
);

// ─── Mutable session state ────────────────────────────────────────────────────

let lastUpdateId = 0;
let activeContext: ActiveContext | null = null;

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "claude-telegram", version: "1.0.0" },
  {
    capabilities: {
      experimental: {
        // This key signals to Claude Code that this is a channel server
        "claude/channel": {},
      } as Record<string, object>,
    },
    instructions: `
You are connected to Telegram via the claude-telegram plugin.

CHANNEL EVENT FORMAT
Each inbound message arrives as a <channel source="telegram"> event with attributes:
  chat_id        — Telegram chat ID (pass to reply tools)
  message_id     — User's message ID (pass to thread replies)
  user_id        — Telegram user ID
  username       — Telegram username or first name
  has_attachment — "true" if a file/photo was included

RULES
1. Read the full channel event before acting.
2. ALWAYS call telegram_reply (or telegram_send_file) when done.
3. For tasks > 5 s, call telegram_send_typing first.
4. Keep replies under 4096 chars; use telegram_send_file for larger output.
5. Use the chat_id and message_id attributes from the event when calling reply tools.

TOOLS: telegram_reply, telegram_react, telegram_edit_message, telegram_send_file, telegram_send_typing
`.trim(),
  },
);

// ─── Push channel event ───────────────────────────────────────────────────────

async function pushChannelEvent(message: TelegramMessage, attachmentNote?: string): Promise<void> {
  const from = message.from;
  const text = message.text ?? message.caption ?? attachmentNote ?? "(no text)";
  const body = attachmentNote ? `${text}\n${attachmentNote}` : text;

  await server.server.notification({
    method: "notifications/claude/channel",
    params: {
      content: body,
      meta: {
        chat_id: String(message.chat.id),
        message_id: String(message.message_id),
        user_id: String(from?.id ?? "unknown"),
        username: String(from?.username ?? from?.first_name ?? "unknown"),
        has_attachment: attachmentNote ? "true" : "false",
      },
    },
  });
}

// ─── Reply tools ──────────────────────────────────────────────────────────────

server.registerTool(
  "telegram_reply",
  {
    title: "Reply via Telegram",
    description: `Send a text message back to the Telegram user.

Primary tool for responding through the channel. Always call this after completing work.
Supports Telegram HTML: <b>bold</b>, <i>italic</i>, <code>code</code>, <pre>blocks</pre>.

Args:
  text (string)                  — Reply text, max 4096 chars.
  chat_id (number)               — From the event's chat_id attribute.
  reply_to_message_id (number?)  — Optional: thread under this message ID.

Returns: Confirmation with sent message_id.`,
    inputSchema: {
      text: z.string().min(1).max(4096).describe("Reply text (Telegram Markdown, max 4096 chars)"),
      chat_id: z.coerce.number().int().describe("Telegram chat ID from the channel event"),
      reply_to_message_id: z.coerce.number().int().optional().describe("Optional: message ID to reply under"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ text, chat_id, reply_to_message_id }) => {
    try {
      const msg = await tg.sendMessage(chat_id, text, reply_to_message_id);
      activeContext = null;
      return { content: [{ type: "text", text: `✅ Sent (message_id: ${msg.message_id})` }] };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `❌ Send failed: ${e}` }], isError: true };
    }
  },
);

server.registerTool(
  "telegram_react",
  {
    title: "React to Telegram Message",
    description: `Add an emoji reaction to a message.

Good for instant acknowledgement: react with ⚙️ when starting, then telegram_reply when done.
Common emojis: 👍 ✅ ❌ 🔥 ⚙️ 👀 🤔 💯 🎉

Args:
  chat_id (number)    — From the event's chat_id attribute.
  message_id (number) — From the event's message_id attribute.
  emoji (string)      — Single emoji character.`,
    inputSchema: {
      chat_id: z.coerce.number().int().describe("Chat ID from the event"),
      message_id: z.coerce.number().int().describe("Message ID to react to"),
      emoji: z.string().describe("Single emoji (e.g. '👍', '✅', '⚙️')"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ chat_id, message_id, emoji }) => {
    try {
      await tg.sendReaction(chat_id, message_id, emoji);
      return { content: [{ type: "text", text: `✅ Reacted with ${emoji}` }] };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `❌ React failed: ${e}` }], isError: true };
    }
  },
);

server.registerTool(
  "telegram_edit_message",
  {
    title: "Edit Telegram Message",
    description: `Edit a message the bot previously sent.

Pattern: send "⚙️ Working…" immediately, edit with final result when done.
Only works on messages sent by this bot.

Args:
  chat_id (number)    — From the event's chat_id attribute.
  message_id (number) — ID of the BOT's own prior message (from telegram_reply).
  text (string)       — New message text, max 4096 chars.`,
    inputSchema: {
      chat_id: z.coerce.number().int().describe("Chat ID from the event"),
      message_id: z.coerce.number().int().describe("ID of the bot's prior message to edit"),
      text: z.string().min(1).max(4096).describe("New message text"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ chat_id, message_id, text }) => {
    try {
      await tg.editMessageText(chat_id, message_id, text);
      return { content: [{ type: "text", text: `✅ Message ${message_id} updated` }] };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `❌ Edit failed: ${e}` }], isError: true };
    }
  },
);

server.registerTool(
  "telegram_send_file",
  {
    title: "Send File via Telegram",
    description: `Upload a local file to the Telegram chat.

Use for content too long for a text message: code, reports, images, logs.
Max 50 MB. Images (jpg/png/gif/webp) can be sent inline with as_image: true.

Args:
  chat_id (number)     — From the event's chat_id attribute.
  file_path (string)   — Absolute local path to the file.
  caption (string?)    — Optional caption, max 1024 chars.
  as_image (boolean?)  — Send image inline (vs as document). Default false.`,
    inputSchema: {
      chat_id: z.coerce.number().int().describe("Chat ID from the event"),
      file_path: z.string().describe("Absolute local path to the file to upload"),
      caption: z.string().max(1024).optional().describe("Optional caption"),
      as_image: z.boolean().optional().default(false).describe("Send as inline photo"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ chat_id, file_path, caption, as_image }) => {
    try {
      const data = await readFile(file_path).catch(() => null);
      if (!data) {
        return { content: [{ type: "text", text: `❌ File not found: ${file_path}` }], isError: true };
      }
      if (data.length > config.maxFileSizeBytes) {
        const mb = (data.length / 1024 / 1024).toFixed(1);
        return { content: [{ type: "text", text: `❌ File too large (${mb} MB). Limit: 50 MB.` }], isError: true };
      }
      const filename = file_path.split("/").pop() ?? "file";
      const bytes = new Uint8Array(data.buffer as ArrayBuffer);
      const isImg = Boolean(as_image) && /\.(jpg|jpeg|png|gif|webp)$/i.test(filename);
      const msg = isImg
        ? await tg.sendPhoto(chat_id, bytes, filename, caption)
        : await tg.sendDocument(chat_id, bytes, filename, caption);
      const kb = (data.length / 1024).toFixed(1);
      return { content: [{ type: "text", text: `✅ Sent "${filename}" (${kb} KB) — msg: ${msg.message_id}` }] };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `❌ Send file failed: ${e}` }], isError: true };
    }
  },
);

server.registerTool(
  "telegram_send_typing",
  {
    title: "Send Typing Indicator",
    description: `Show "typing…" in the chat. Call before any task taking more than ~5 s.
Auto-expires after 5 s — call again to extend it.

Args:
  chat_id (number) — From the event's chat_id attribute.`,
    inputSchema: {
      chat_id: z.coerce.number().int().describe("Chat ID from the event"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ chat_id }) => {
    try {
      await tg.sendChatAction(chat_id);
      return { content: [{ type: "text", text: "✅ Typing indicator sent" }] };
    } catch (err) {
      const e = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `❌ Failed: ${e}` }], isError: true };
    }
  },
);

// ─── Access management tools ──────────────────────────────────────────────────

server.registerTool(
  "telegram_access_pair",
  {
    title: "Pair a Telegram User",
    description: `Approve a pairing request — add the user to the allowlist.

When a new user sends /start to your bot they get a 6-char code. Enter it here.
Invoked by: /telegram:access pair <CODE>

Args:
  code (string) — 6-character code from the Telegram user.`,
    inputSchema: {
      code: z.string().min(4).max(10).describe("Pairing code from the Telegram user"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ code }) => {
    const pairing = consumePairingCode(access, code);
    if (!pairing) {
      return {
        content: [
          {
            type: "text",
            text: `❌ Code "${code.toUpperCase()}" is invalid or expired.\nAsk the user to send /start again.`,
          },
        ],
        isError: true,
      };
    }
    addToAllowlist(access, pairing.userId);
    await saveAccessState(config.allowlistPath, access);
    await tg
      .sendMessage(
        pairing.chatId,
        "✅ <b>Paired!</b> You now have access to this Claude Code session.\n\nSend any message to get started.",
      )
      .catch(() => undefined);
    process.stderr.write(`✅  Paired @${pairing.username ?? pairing.userId} (ID: ${pairing.userId})\n`);
    return {
      content: [
        {
          type: "text",
          text: `✅ Paired @${pairing.username ?? pairing.firstName} (ID: ${pairing.userId})\nAllowlist: [${access.allowlist.join(", ")}]\n\nNext: /telegram:access policy allowlist`,
        },
      ],
    };
  },
);

server.registerTool(
  "telegram_access_policy",
  {
    title: "Set Telegram Access Policy",
    description: `Change who can send messages to this session.
  "pairing"   — New users can request access via /start (default)
  "allowlist" — Only paired users, no new pairings (recommended after setup)
  "open"      — Anyone ⚠️ testing only

Invoked by: /telegram:access policy <POLICY>`,
    inputSchema: {
      policy: z.enum(["pairing", "allowlist", "open"]).describe("New access policy"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ policy }) => {
    access.policy = policy;
    await saveAccessState(config.allowlistPath, access);
    const warn = policy === "open" ? "\n⚠️  WARNING: Open — anyone can message your session!" : "";
    return {
      content: [{ type: "text", text: `✅ Policy: "${policy}"${warn}\nAllowlist: [${access.allowlist.join(", ")}]` }],
    };
  },
);

server.registerTool(
  "telegram_access_remove",
  {
    title: "Remove Telegram User from Allowlist",
    description: `Revoke a user's access. They can no longer send messages to this session.
Invoked by: /telegram:access remove <USER_ID>

Args:
  user_id (number) — Telegram user ID to revoke.`,
    inputSchema: {
      user_id: z.coerce.number().int().describe("Telegram user ID to remove"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ user_id }) => {
    removeFromAllowlist(access, user_id);
    await saveAccessState(config.allowlistPath, access);
    return { content: [{ type: "text", text: `✅ Removed ${user_id}\nAllowlist: [${access.allowlist.join(", ")}]` }] };
  },
);

server.registerTool(
  "telegram_access_status",
  {
    title: "Telegram Access Status",
    description: `Show bot info, policy, allowlist, and any pending pairing codes.
Invoked by: /telegram:access status`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const now = Date.now();
    const pending = [...access.pendingCodes.entries()]
      .filter(([, v]) => v.expiresAt > now)
      .map(([code, v]) => `  ${code} → @${v.username ?? v.userId} (${Math.round((v.expiresAt - now) / 1000)}s left)`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: [
            `📊 Telegram Channel Status`,
            `Bot:      @${botInfo.username} (ID: ${botInfo.id})`,
            `Policy:   ${access.policy}`,
            `Allowlist (${access.allowlist.length}): [${access.allowlist.join(", ")}]`,
            pending ? `\nPending codes:\n${pending}` : "No pending codes",
          ].join("\n"),
        },
      ],
    };
  },
);

// ─── Long-poll loop ───────────────────────────────────────────────────────────

async function handleMessage(message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  if (!userId) return;

  const text = (message.text ?? "").trim();

  if (text === "/start" || text === "/pair") {
    if (isAllowed(access, userId)) {
      await tg.sendMessage(message.chat.id, "✅ Already paired. Send any message to interact with Claude Code.");
      return;
    }
    if (access.policy === "allowlist") return; // silently drop

    const code = issuePairingCode(
      access,
      {
        userId,
        chatId: message.chat.id,
        username: message.from?.username,
        firstName: message.from?.first_name ?? "User",
      },
      config.pairingCodeTtlMs,
    );

    await tg.sendMessage(
      message.chat.id,
      `🔐 <b>Pairing code:</b> ${fmt.code(code)}\n\nIn Claude Code:\n${fmt.pre(`/telegram:access pair ${code}`)}\n\n<i>Expires in 10 minutes.</i>`,
    );
    process.stderr.write(`⏳  Pairing request from @${message.from?.username ?? userId} — code: ${code}\n`);
    return;
  }

  if (!isAllowed(access, userId)) {
    process.stderr.write(`🚫  Dropped msg from user ${userId} (policy=${access.policy})\n`);
    return;
  }

  activeContext = { chatId: message.chat.id, messageId: message.message_id, userId, username: message.from?.username };
  await tg.sendChatAction(message.chat.id).catch(() => undefined);

  let attachmentNote: string | undefined;
  if (message.document) {
    const d = message.document;
    const kb = d.file_size ? ` (${(d.file_size / 1024).toFixed(1)} KB)` : "";
    attachmentNote = `[File: ${d.file_name ?? "document"}${kb}, ${d.mime_type ?? "unknown"}]`;
  } else if (message.photo) {
    const p = message.photo.at(-1);
    const kb = p?.file_size ? ` (${(p.file_size / 1024).toFixed(1)} KB)` : "";
    attachmentNote = `[Photo: ${p?.width ?? "?"}×${p?.height ?? "?"}px${kb}]`;
  }

  const preview = (message.text ?? message.caption ?? "").slice(0, 60);
  process.stderr.write(
    `📨  @${message.from?.username ?? userId}: ${preview}${attachmentNote ? ` ${attachmentNote}` : ""}\n`,
  );

  await pushChannelEvent(message, attachmentNote);
}

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const updates = await tg.getUpdates(lastUpdateId);
      for (const update of updates) {
        lastUpdateId = update.update_id + 1;
        const msg = update.message ?? update.channel_post;
        if (msg) await handleMessage(msg).catch((e: Error) => process.stderr.write(`❌  ${e.message}\n`));
      }
    } catch (err) {
      process.stderr.write(`⚠️   Poll error: ${err instanceof Error ? err.message : err}\n`);
    }
    await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
  }
}

async function typingKeepalive(): Promise<void> {
  while (true) {
    if (activeContext) await tg.sendChatAction(activeContext.chatId).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, TYPING_INTERVAL_MS));
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

await mkdir(dirname(config.allowlistPath), { recursive: true }).catch(() => undefined);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("🔌  MCP stdio connected\n");

pollLoop().catch((e: Error) => {
  process.stderr.write(`💥  ${e.message}\n`);
  process.exit(1);
});
typingKeepalive().catch(() => undefined);

process.stderr.write(`\n🚀  claude-telegram running\n    Bot: @${botInfo.username}  Policy: ${access.policy}\n\n`);
