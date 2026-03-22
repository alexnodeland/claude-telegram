import { describe, expect, test } from "bun:test";
import { formatToolMessage, sendLongMessage } from "../src/streaming.js";
import type { TelegramMessage } from "../src/types.js";

/** Minimal mock of TelegramClient — only the methods used by streaming. */
function mockTg() {
  const sent: Array<{ chatId: number; text: string; replyToMessageId?: number }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const docs: Array<{ chatId: number; filename: string }> = [];
  let nextId = 1;

  return {
    client: {
      sendMessage: async (chatId: number, text: string, replyToMessageId?: number) => {
        sent.push({ chatId, text, replyToMessageId });
        return { message_id: nextId++ } as TelegramMessage;
      },
      editMessageText: async (chatId: number, messageId: number, text: string) => {
        edits.push({ chatId, messageId, text });
      },
      sendDocument: async (chatId: number, _data: Uint8Array, filename: string) => {
        docs.push({ chatId, filename });
        return { message_id: nextId++ } as TelegramMessage;
      },
      deleteMessage: async () => {},
      sendChatAction: async () => {},
    } as any,
    sent,
    edits,
    docs,
  };
}

// ─── sendLongMessage ───────────────────────────────────────────────────────

describe("sendLongMessage", () => {
  test("sends single message when text fits", async () => {
    const tg = mockTg();
    await sendLongMessage(tg.client, 123, "Hello world");
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.text).toBe("Hello world");
  });

  test("splits at newline boundary", async () => {
    const tg = mockTg();
    // Create text that's > 4096 with a good newline split point
    const line = "a".repeat(2000);
    const text = `${line}\n${line}\n${line}`; // 6002 chars
    await sendLongMessage(tg.client, 123, text);
    expect(tg.sent.length).toBeGreaterThan(1);
    // Each chunk should be <= 4096
    for (const msg of tg.sent) {
      expect(msg.text.length).toBeLessThanOrEqual(4096);
    }
  });

  test("hard splits when no good boundary", async () => {
    const tg = mockTg();
    const text = "x".repeat(5000); // no newlines or spaces
    await sendLongMessage(tg.client, 123, text);
    expect(tg.sent.length).toBe(2);
    expect(tg.sent[0]?.text.length).toBe(4096);
    expect(tg.sent[1]?.text.length).toBe(904);
  });

  test("handles exactly 4096 chars", async () => {
    const tg = mockTg();
    const text = "y".repeat(4096);
    await sendLongMessage(tg.client, 123, text);
    expect(tg.sent).toHaveLength(1);
  });

  test("handles empty text", async () => {
    const tg = mockTg();
    await sendLongMessage(tg.client, 123, "");
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.text).toBe("");
  });
});

// ─── formatToolMessage ──────────────────────────────────────────────────────

describe("formatToolMessage", () => {
  test("formats Read with HTML code and pre tags", () => {
    const msg = formatToolMessage("Read", { file_path: "/src/index.ts" });
    expect(msg).toContain("<code>Read</code>");
    expect(msg).toContain("<pre>");
    expect(msg).toContain("index.ts");
  });

  test("formats Bash with HTML pre tag", () => {
    const msg = formatToolMessage("Bash", { command: "npm test" });
    expect(msg).toContain("<code>Bash</code>");
    expect(msg).toContain("<pre>");
    expect(msg).toContain("npm test");
  });

  test("escapes HTML in tool inputs", () => {
    const msg = formatToolMessage("Bash", { command: "echo '<script>alert(1)</script>'" });
    expect(msg).toContain("&lt;script&gt;");
    expect(msg).not.toContain("<script>");
  });

  test("formats generic tool with code tag", () => {
    const msg = formatToolMessage("CustomTool", { key: "value" });
    expect(msg).toContain("<code>CustomTool</code>");
  });
});

// ─── StreamingRenderer ─────────────────────────────────────────────────────

// Note: StreamingRenderer is tested through its public API.
// These tests verify the message flow rather than internal state.

import { StreamingRenderer } from "../src/streaming.js";

describe("StreamingRenderer", () => {
  test("start sends initial status message", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.text).toContain("Working");
  });

  test("start threads reply to original message", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start(42);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.replyToMessageId).toBe(42);
  });

  test("sendText sends a new message bubble with HTML escaping", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.sendText("Hello from Claude");
    expect(tg.sent).toHaveLength(2); // status + text
    expect(tg.sent[1]?.text).toBe("Hello from Claude");
  });

  test("sendText escapes HTML entities", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.sendText("if a < b && c > d");
    expect(tg.sent[1]?.text).toBe("if a &lt; b &amp;&amp; c &gt; d");
  });

  test("sendText skips empty text", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.sendText("   ");
    expect(tg.sent).toHaveLength(1); // only status
  });

  test("showToolCall sends formatted message and updates status with step counter", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.showToolCall("Read", { file_path: "/src/index.ts" });
    expect(tg.sent).toHaveLength(2); // status + tool call
    expect(tg.sent[1]?.text).toContain("<code>Read</code>");
    expect(tg.sent[1]?.text).toContain("index.ts");
    // Status should be updated with step counter
    expect(tg.edits).toHaveLength(1);
    expect(tg.edits[0]?.text).toContain("Step 1");
    expect(tg.edits[0]?.text).toContain("Read");
  });

  test("showToolCall increments step counter", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.showToolCall("Read", { file_path: "/a.ts" });
    await renderer.showToolCall("Edit", { file_path: "/b.ts" });
    expect(tg.edits[0]?.text).toContain("Step 1");
    expect(tg.edits[1]?.text).toContain("Step 2");
  });

  test("showToolResult appends to last tool message with HTML pre tag", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.showToolCall("Bash", { command: "echo hi" });
    await renderer.showToolResult("hi\n");
    // Should have edited the tool call message
    const toolEdits = tg.edits.filter((e) => e.messageId === 2); // tool msg is id 2
    expect(toolEdits.length).toBeGreaterThan(0);
    const lastEdit = toolEdits[toolEdits.length - 1];
    expect(lastEdit?.text).toContain("<pre>");
    expect(lastEdit?.text).toContain("hi");
  });

  test("showToolResult truncates long results", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.showToolCall("Bash", { command: "cat big.txt" });
    await renderer.showToolResult("x".repeat(1000));
    const toolEdits = tg.edits.filter((e) => e.messageId === 2);
    const lastEdit = toolEdits[toolEdits.length - 1];
    expect(lastEdit?.text).toContain("…"); // truncated
  });

  test("showToolResult sends full output as document for large results", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.showToolCall("Bash", { command: "cat big.txt" });
    await renderer.showToolResult("x".repeat(1500));
    expect(tg.docs).toHaveLength(1);
    expect(tg.docs[0]?.filename).toBe("output.txt");
  });

  test("showToolResult shows error indicator", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.showToolCall("Bash", { command: "failing-cmd" });
    await renderer.showToolResult("command not found", true);
    const toolEdits = tg.edits.filter((e) => e.messageId === 2);
    const lastEdit = toolEdits[toolEdits.length - 1];
    expect(lastEdit?.text).toContain("❌");
  });

  test("finish updates status with cost in HTML italic", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.finish("$0.0042 · 3 turns");
    const lastEdit = tg.edits[tg.edits.length - 1];
    expect(lastEdit?.text).toContain("Done");
    expect(lastEdit?.text).toContain("$0.0042");
    expect(lastEdit?.text).toContain("<i>");
  });

  test("error updates status with error", async () => {
    const tg = mockTg();
    const renderer = new StreamingRenderer(tg.client, 123);
    await renderer.start();
    await renderer.error("Something went wrong");
    const lastEdit = tg.edits[tg.edits.length - 1];
    expect(lastEdit?.text).toContain("Something went wrong");
  });
});
