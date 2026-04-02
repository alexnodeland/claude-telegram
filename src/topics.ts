import type { TelegramClient } from "./telegram.js";
import type { SessionInfo, TelegramChatInfo } from "./types.js";

const MAX_TOPIC_NAME_LENGTH = 128;

/** Telegram Forum Topic icon colors (fixed palette). */
export const TOPIC_COLORS = {
  SESSION: 7322096, // blue
  JOB: 9367192, // green
} as const;

function truncate(name: string, maxLen: number): string {
  return name.length > maxLen ? `${name.slice(0, maxLen - 1)}…` : name;
}

export class TopicManager {
  /** Cache: chatId → chat info (includes is_forum, username, etc.) */
  private chatInfoCache = new Map<number, TelegramChatInfo>();

  /** Active mapping: "chatId:threadId" → sessionId (for routing inbound messages) */
  private threadToSession = new Map<string, string>();

  constructor(private readonly tg: TelegramClient) {}

  // ─── Forum detection ──────────────────────────────────────────────────

  async getChatInfo(chatId: number): Promise<TelegramChatInfo | null> {
    const cached = this.chatInfoCache.get(chatId);
    if (cached) return cached;
    try {
      const info = await this.tg.getChat(chatId);
      this.chatInfoCache.set(chatId, info);
      return info;
    } catch {
      return null;
    }
  }

  async isForum(chatId: number): Promise<boolean> {
    const info = await this.getChatInfo(chatId);
    return info?.is_forum === true;
  }

  invalidateCache(chatId: number): void {
    this.chatInfoCache.delete(chatId);
  }

  // ─── Topic links ─────────────────────────────────────────────────────

  getTopicLink(chatId: number, threadId: number): string | null {
    const info = this.chatInfoCache.get(chatId);
    if (!info) return null;
    if (info.username) return `https://t.me/${info.username}/${threadId}`;
    const channelId = String(chatId).replace(/^-100/, "");
    return `https://t.me/c/${channelId}/${threadId}`;
  }

  // ─── Topic lifecycle ──────────────────────────────────────────────────

  async createSessionTopic(chatId: number, sessionName: string): Promise<number> {
    const name = truncate(`Session: ${sessionName}`, MAX_TOPIC_NAME_LENGTH);
    const topic = await this.tg.createForumTopic(chatId, name, TOPIC_COLORS.SESSION);
    return topic.message_thread_id;
  }

  async createJobTopic(chatId: number, jobName: string): Promise<number> {
    const name = truncate(`Job: ${jobName}`, MAX_TOPIC_NAME_LENGTH);
    const topic = await this.tg.createForumTopic(chatId, name, TOPIC_COLORS.JOB);
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
