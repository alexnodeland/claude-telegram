import { escapeHtml, fmt } from "./html.js";
import type { TelegramClient } from "./telegram.js";

const MAX_TG_LENGTH = 4096;
const TOOL_MESSAGE_DELAY = 100; // ms between messages to avoid rate limits
const MAX_RESULT_PREVIEW = 300; // chars of tool result to show

/**
 * Multi-bubble renderer: each assistant text block is a separate Telegram
 * message, tool calls are shown as their own code-block messages, and a
 * persistent status message tracks current activity.
 */
export class StreamingRenderer {
  private statusMessageId: number | null = null;
  private lastStatusText = "";
  private toolStepCount = 0;

  /** Track the last tool call message so we can edit it to append the result. */
  private lastToolMessageId: number | null = null;
  private lastToolText = "";

  constructor(
    private readonly tg: TelegramClient,
    private readonly chatId: number,
  ) {}

  async start(replyToMessageId?: number): Promise<void> {
    const msg = await this.tg.sendMessage(this.chatId, "⚙️ Working…", replyToMessageId);
    this.statusMessageId = msg.message_id;
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.lastToolMessageId = null; // new text block clears tool context
    await sendLongMessage(this.tg, this.chatId, escapeHtml(trimmed));
  }

  async showToolCall(toolName: string, input: unknown): Promise<void> {
    this.toolStepCount++;
    const detail = formatToolDetail(toolName, input);
    const stepLabel = `Step ${this.toolStepCount}`;
    await this.updateStatus(
      `⚙️ ${escapeHtml(stepLabel)} · <i>${escapeHtml(toolName)}</i>${detail ? ` · ${escapeHtml(detail)}` : ""}`,
    );

    const toolMsg = formatToolMessage(toolName, input);
    try {
      const sent = await this.tg.sendMessage(this.chatId, toolMsg);
      this.lastToolMessageId = sent.message_id;
      this.lastToolText = toolMsg;
    } catch {
      this.lastToolMessageId = null;
      this.lastToolText = "";
    }
    await sleep(TOOL_MESSAGE_DELAY);
  }

  /** Append a tool result preview to the last tool call message. */
  async showToolResult(resultContent: string, isError?: boolean): Promise<void> {
    if (!this.lastToolMessageId || !resultContent) return;

    const icon = isError ? "❌" : "";
    const preview =
      resultContent.length > MAX_RESULT_PREVIEW ? `${resultContent.slice(0, MAX_RESULT_PREVIEW)}…` : resultContent;

    const updated = `${this.lastToolText}\n${icon ? `${icon} ` : ""}<pre>${escapeHtml(preview)}</pre>`;

    // Only edit if it fits in a single message
    if (updated.length <= MAX_TG_LENGTH) {
      try {
        await this.tg.editMessageText(this.chatId, this.lastToolMessageId, updated);
        this.lastToolText = updated;
      } catch {
        /* ignore edit failures */
      }
    }

    // Send full output as document if result is large
    if (resultContent.length > 1000) {
      await this.sendFullOutput(resultContent);
    }

    this.lastToolMessageId = null;
  }

  async showRetry(info: string): Promise<void> {
    await this.updateStatus(`🔄 <i>${escapeHtml(info)}</i>`);
  }

  async finish(costInfo?: string): Promise<void> {
    if (costInfo) {
      await this.updateStatus(`✅ Done · <i>${escapeHtml(costInfo)}</i>`);
    } else {
      await this.updateStatus("✅ Done");
    }
  }

  async error(message: string): Promise<void> {
    await this.updateStatus(`❌ ${escapeHtml(message)}`);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async updateStatus(text: string): Promise<void> {
    if (!this.statusMessageId) return;
    if (text === this.lastStatusText) return;

    this.lastStatusText = text;
    try {
      await this.tg.editMessageText(this.chatId, this.statusMessageId, text);
    } catch {
      /* "message not modified" or other edit failures */
    }
  }

  private async sendFullOutput(content: string): Promise<void> {
    try {
      const data = new TextEncoder().encode(content);
      await this.tg.sendDocument(this.chatId, data, "output.txt", "Full tool output");
    } catch {
      /* ignore — preview is still shown inline */
    }
  }
}

// ─── Tool call formatting ─────────────────────────────────────────────────────

function formatToolDetail(toolName: string, input: unknown): string | undefined {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return undefined;

  switch (toolName) {
    case "Read":
      return shortPath(inp.file_path);
    case "Edit":
    case "Write":
      return shortPath(inp.file_path);
    case "Bash": {
      const cmd = String(inp.command ?? "");
      return cmd.length > 50 ? `${cmd.slice(0, 50)}…` : cmd || undefined;
    }
    case "Glob":
      return inp.pattern ? String(inp.pattern) : undefined;
    case "Grep":
      return inp.pattern ? `"${String(inp.pattern)}"` : undefined;
    case "Agent":
      return inp.description ? String(inp.description) : undefined;
    default:
      return undefined;
  }
}

/** Format a tool call as a Telegram message using HTML. */
export function formatToolMessage(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;

  switch (toolName) {
    case "Read": {
      const path = String(inp?.file_path ?? "");
      return `📖 ${fmt.code("Read")}\n${fmt.pre(path)}`;
    }

    case "Edit": {
      const path = String(inp?.file_path ?? "");
      return `✏️ ${fmt.code("Edit")}\n${fmt.pre(path)}`;
    }

    case "Write": {
      const path = String(inp?.file_path ?? "");
      return `📝 ${fmt.code("Write")}\n${fmt.pre(path)}`;
    }

    case "Bash": {
      const cmd = String(inp?.command ?? "").trim();
      const display = cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd;
      return `💻 ${fmt.code("Bash")}\n${fmt.pre(display)}`;
    }

    case "Glob": {
      const pattern = String(inp?.pattern ?? "");
      const path = inp?.path ? ` in ${escapeHtml(shortPath(inp.path) ?? "")}` : "";
      return `🔍 ${fmt.code("Glob")}${path}\n${fmt.pre(pattern)}`;
    }

    case "Grep": {
      const pattern = String(inp?.pattern ?? "");
      const path = inp?.path ? ` in ${escapeHtml(shortPath(inp.path) ?? "")}` : "";
      return `🔎 ${fmt.code("Grep")}${path}\n${fmt.pre(pattern)}`;
    }

    case "Agent": {
      const desc = String(inp?.description ?? "");
      return `🤖 ${fmt.code("Agent")}\n${fmt.pre(desc)}`;
    }

    case "AskUserQuestion":
      return "❓ Asking a question…";

    default: {
      const summary = inp
        ? Object.entries(inp)
            .slice(0, 3)
            .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v).slice(0, 60))}`)
            .join("\n")
        : "";
      return `🔧 ${fmt.code(toolName)}${summary ? `\n${fmt.pre(summary)}` : ""}`;
    }
  }
}

function shortPath(val: unknown): string | undefined {
  if (!val) return undefined;
  const p = String(val);
  const parts = p.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Split text into ≤4096 char chunks at line/space boundaries and send sequentially. */
export async function sendLongMessage(tg: TelegramClient, chatId: number, text: string): Promise<void> {
  if (text.length <= MAX_TG_LENGTH) {
    await tg.sendMessage(chatId, text);
    return;
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_TG_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_TG_LENGTH);
    if (splitAt < MAX_TG_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(" ", MAX_TG_LENGTH);
    }
    if (splitAt < MAX_TG_LENGTH / 2) {
      splitAt = MAX_TG_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    await tg.sendMessage(chatId, chunk);
    await sleep(200);
  }
}
