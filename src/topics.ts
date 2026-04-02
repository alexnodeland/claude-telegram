import type { TelegramClient } from "./telegram.js";
import type { SessionInfo } from "./types.js";

const MAX_TOPIC_NAME_LENGTH = 128;

function truncate(name: string, maxLen: number): string {
  return name.length > maxLen ? `${name.slice(0, maxLen - 1)}…` : name;
}

export class TopicManager {
  /** Cache: chatId → is_forum */
  private forumCache = new Map<number, boolean>();

  /** Active mapping: "chatId:threadId" → sessionId (for routing inbound messages) */
  private threadToSession = new Map<string, string>();

  constructor(private readonly tg: TelegramClient) {}

  // ─── Forum detection ──────────────────────────────────────────────────

  async isForum(chatId: number): Promise<boolean> {
    const cached = this.forumCache.get(chatId);
    if (cached !== undefined) return cached;
    try {
      const info = await this.tg.getChat(chatId);
      const result = info.is_forum === true;
      this.forumCache.set(chatId, result);
      return result;
    } catch {
      this.forumCache.set(chatId, false);
      return false;
    }
  }

  invalidateCache(chatId: number): void {
    this.forumCache.delete(chatId);
  }

  // ─── Topic lifecycle ──────────────────────────────────────────────────

  async createSessionTopic(chatId: number, sessionName: string): Promise<number> {
    const name = truncate(`Session: ${sessionName}`, MAX_TOPIC_NAME_LENGTH);
    const topic = await this.tg.createForumTopic(chatId, name);
    return topic.message_thread_id;
  }

  async createJobTopic(chatId: number, jobName: string): Promise<number> {
    const name = truncate(`Job: ${jobName}`, MAX_TOPIC_NAME_LENGTH);
    const topic = await this.tg.createForumTopic(chatId, name);
    return topic.message_thread_id;
  }

  async closeTopic(chatId: number, threadId: number): Promise<void> {
    try {
      await this.tg.closeForumTopic(chatId, threadId);
    } catch {
      // Topic may already be closed or deleted — safe to ignore
    }
  }

  async reopenTopic(chatId: number, threadId: number): Promise<void> {
    await this.tg.reopenForumTopic(chatId, threadId);
  }

  // ─── Thread-to-session routing ────────────────────────────────────────

  registerThread(chatId: number, threadId: number, sessionId: string): void {
    this.threadToSession.set(`${chatId}:${threadId}`, sessionId);
  }

  unregisterThread(chatId: number, threadId: number): void {
    this.threadToSession.delete(`${chatId}:${threadId}`);
  }

  getSessionForThread(chatId: number, threadId: number): string | undefined {
    return this.threadToSession.get(`${chatId}:${threadId}`);
  }

  /** Rebuild thread-to-session map from active sessions (call on startup). */
  reconcile(activeSessions: SessionInfo[]): void {
    this.threadToSession.clear();
    for (const s of activeSessions) {
      if (s.threadId != null) {
        this.registerThread(s.chatId, s.threadId, s.sessionId);
      }
    }
  }
}
