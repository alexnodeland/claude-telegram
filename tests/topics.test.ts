import { describe, expect, test } from "bun:test";
import { TopicManager } from "../src/topics.js";
import type { SessionInfo, TelegramChatInfo, TelegramForumTopic } from "../src/types.js";

/** Minimal mock TelegramClient for TopicManager tests. */
function mockTg(overrides: {
  isForum?: boolean;
  getChatThrows?: boolean;
  createThreadId?: number;
  reopenThrows?: boolean;
} = {}) {
  return {
    getChat: async (_chatId: number): Promise<TelegramChatInfo> => {
      if (overrides.getChatThrows) throw new Error("API error");
      return { id: _chatId, type: "supergroup", is_forum: overrides.isForum ?? false } as TelegramChatInfo;
    },
    createForumTopic: async (_chatId: number, name: string): Promise<TelegramForumTopic> => {
      return { message_thread_id: overrides.createThreadId ?? 100, name, icon_color: undefined };
    },
    closeForumTopic: async (): Promise<void> => {},
    reopenForumTopic: async (): Promise<void> => {
      if (overrides.reopenThrows) throw new Error("Topic not found");
    },
  } as unknown as import("../src/telegram.js").TelegramClient;
}

describe("TopicManager", () => {
  // ─── Forum detection ──────────────────────────────────────────────────

  test("isForum returns true for forum chats", async () => {
    const tm = new TopicManager(mockTg({ isForum: true }));
    expect(await tm.isForum(100)).toBe(true);
  });

  test("isForum returns false for non-forum chats", async () => {
    const tm = new TopicManager(mockTg({ isForum: false }));
    expect(await tm.isForum(100)).toBe(false);
  });

  test("isForum caches result", async () => {
    let callCount = 0;
    const tg = mockTg({ isForum: true });
    const origGetChat = tg.getChat.bind(tg);
    tg.getChat = async (chatId: number) => {
      callCount++;
      return origGetChat(chatId);
    };

    const tm = new TopicManager(tg);
    await tm.isForum(100);
    await tm.isForum(100);
    await tm.isForum(100);
    expect(callCount).toBe(1);
  });

  test("isForum returns false on API error", async () => {
    const tm = new TopicManager(mockTg({ getChatThrows: true }));
    expect(await tm.isForum(100)).toBe(false);
  });

  test("invalidateCache forces re-fetch", async () => {
    let callCount = 0;
    const tg = mockTg({ isForum: true });
    const origGetChat = tg.getChat.bind(tg);
    tg.getChat = async (chatId: number) => {
      callCount++;
      return origGetChat(chatId);
    };

    const tm = new TopicManager(tg);
    await tm.isForum(100);
    tm.invalidateCache(100);
    await tm.isForum(100);
    expect(callCount).toBe(2);
  });

  // ─── Topic lifecycle ──────────────────────────────────────────────────

  test("createSessionTopic returns threadId", async () => {
    const tm = new TopicManager(mockTg({ createThreadId: 42 }));
    const threadId = await tm.createSessionTopic(100, "frontend");
    expect(threadId).toBe(42);
  });

  test("createJobTopic returns threadId", async () => {
    const tm = new TopicManager(mockTg({ createThreadId: 99 }));
    const threadId = await tm.createJobTopic(100, "deploy-check");
    expect(threadId).toBe(99);
  });

  test("createSessionTopic truncates long names", async () => {
    let capturedName = "";
    const tg = mockTg({ createThreadId: 1 });
    tg.createForumTopic = async (_chatId: number, name: string) => {
      capturedName = name;
      return { message_thread_id: 1, name };
    };

    const tm = new TopicManager(tg);
    const longName = "A".repeat(200);
    await tm.createSessionTopic(100, longName);
    expect(capturedName.length).toBeLessThanOrEqual(128);
    expect(capturedName.startsWith("Session: ")).toBe(true);
  });

  test("closeTopic does not throw on error", async () => {
    const tg = mockTg();
    tg.closeForumTopic = async () => {
      throw new Error("Topic already closed");
    };
    const tm = new TopicManager(tg);
    // Should not throw
    await tm.closeTopic(100, 42);
  });

  test("reopenTopic propagates errors", async () => {
    const tm = new TopicManager(mockTg({ reopenThrows: true }));
    expect(tm.reopenTopic(100, 42)).rejects.toThrow("Topic not found");
  });

  // ─── Thread-to-session routing ────────────────────────────────────────

  test("registerThread and getSessionForThread", () => {
    const tm = new TopicManager(mockTg());
    tm.registerThread(100, 42, "sess-abc");
    expect(tm.getSessionForThread(100, 42)).toBe("sess-abc");
    expect(tm.getSessionForThread(100, 99)).toBeUndefined();
  });

  test("unregisterThread removes mapping", () => {
    const tm = new TopicManager(mockTg());
    tm.registerThread(100, 42, "sess-abc");
    tm.unregisterThread(100, 42);
    expect(tm.getSessionForThread(100, 42)).toBeUndefined();
  });

  test("reconcile rebuilds map from sessions", () => {
    const tm = new TopicManager(mockTg());
    // Pre-populate with stale data
    tm.registerThread(100, 1, "old-sess");

    const sessions: SessionInfo[] = [
      { sessionId: "sess-1", chatId: 100, cwd: "/a", threadId: 42, totalCost: 0, totalTurns: 0, createdAt: 0, lastActiveAt: 0 },
      { sessionId: "sess-2", chatId: 100, cwd: "/b", threadId: 99, totalCost: 0, totalTurns: 0, createdAt: 0, lastActiveAt: 0 },
      { sessionId: "sess-3", chatId: 200, cwd: "/c", totalCost: 0, totalTurns: 0, createdAt: 0, lastActiveAt: 0 }, // no threadId
    ];

    tm.reconcile(sessions);

    // Old mapping should be gone
    expect(tm.getSessionForThread(100, 1)).toBeUndefined();
    // New mappings should exist
    expect(tm.getSessionForThread(100, 42)).toBe("sess-1");
    expect(tm.getSessionForThread(100, 99)).toBe("sess-2");
    // Session without threadId should not be mapped
    expect(tm.getSessionForThread(200, 0)).toBeUndefined();
  });
});
