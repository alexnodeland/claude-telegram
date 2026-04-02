import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionInfo, TopicKey, TopicKeyString } from "./types.js";
import { topicKeyStr } from "./types.js";

/**
 * Manages Claude Code sessions per Telegram chat.
 * Persists session history to disk so users can resume across restarts.
 *
 * Active sessions and processing flags are keyed by TopicKeyString to support
 * concurrent sessions (Forum Topics, isolated job sessions).
 */
export class SessionManager {
  private active = new Map<TopicKeyString, SessionInfo>();
  private history: SessionInfo[] = [];
  private processing = new Set<TopicKeyString>();

  constructor(private readonly storePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.storePath, "utf8")) as {
        sessions?: SessionInfo[];
      };
      this.history = raw.sessions ?? [];
    } catch {
      this.history = [];
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify({ sessions: this.history }, null, 2));
  }

  getActive(key: TopicKey): SessionInfo | undefined {
    return this.active.get(topicKeyStr(key));
  }

  /** Return all active sessions for a chat (across all topics/jobs). */
  getActiveForChat(chatId: number): SessionInfo[] {
    const results: SessionInfo[] = [];
    for (const [_k, session] of this.active) {
      if (session.chatId === chatId) results.push(session);
    }
    return results;
  }

  /** Find active session by its Forum Topic thread ID. */
  getActiveByThread(chatId: number, threadId: number): SessionInfo | undefined {
    for (const session of this.active.values()) {
      if (session.chatId === chatId && session.threadId === threadId) return session;
    }
    return undefined;
  }

  create(key: TopicKey, cwd: string, sessionId: string, name?: string, model?: string): SessionInfo {
    const session: SessionInfo = {
      sessionId,
      chatId: key.chatId,
      cwd,
      name,
      model,
      totalCost: 0,
      totalTurns: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      threadId: key.threadId,
    };
    this.active.set(topicKeyStr(key), session);
    this.history.push(session);
    return session;
  }

  /** Promote a previous session to active (for /resume). */
  setActive(key: TopicKey, session: SessionInfo): void {
    session.lastActiveAt = Date.now();
    if (key.threadId != null) session.threadId = key.threadId;
    this.active.set(topicKeyStr(key), session);
  }

  /** Update the session ID once the real one comes back from Claude. */
  updateSessionId(key: TopicKey, sessionId: string): void {
    const session = this.active.get(topicKeyStr(key));
    if (session) {
      session.sessionId = sessionId;
      session.lastActiveAt = Date.now();
    }
  }

  endActive(key: TopicKey): SessionInfo | undefined {
    const k = topicKeyStr(key);
    const session = this.active.get(k);
    this.active.delete(k);
    return session;
  }

  listForChat(chatId: number): SessionInfo[] {
    return this.history
      .filter((s) => s.chatId === chatId && s.sessionId !== "pending")
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  findByName(chatId: number, name: string): SessionInfo | undefined {
    return this.history.find((s) => s.chatId === chatId && s.name === name);
  }

  findByTitle(chatId: number, title: string): SessionInfo | undefined {
    const lower = title.toLowerCase();
    return this.history.find((s) => s.chatId === chatId && s.title && s.title.toLowerCase().includes(lower));
  }

  findByIdPrefix(chatId: number, prefix: string): SessionInfo | undefined {
    return this.history.find((s) => s.chatId === chatId && s.sessionId.startsWith(prefix));
  }

  /** Accumulate cost and turns from a query result. */
  addCost(key: TopicKey, cost: number, turns: number): void {
    const session = this.active.get(topicKeyStr(key));
    if (session) {
      session.totalCost = (session.totalCost ?? 0) + cost;
      session.totalTurns = (session.totalTurns ?? 0) + turns;
    }
  }

  isProcessing(key: TopicKey): boolean {
    return this.processing.has(topicKeyStr(key));
  }

  /** Check if ANY session in a chat is processing (for backwards compat). */
  isAnyChatProcessing(chatId: number): boolean {
    for (const k of this.processing) {
      if (k === `${chatId}` || k.startsWith(`${chatId}:`)) return true;
    }
    return false;
  }

  setProcessing(key: TopicKey, value: boolean): void {
    const k = topicKeyStr(key);
    if (value) this.processing.add(k);
    else this.processing.delete(k);
  }
}
