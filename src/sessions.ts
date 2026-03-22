import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionInfo } from "./types.js";

/**
 * Manages Claude Code sessions per Telegram chat.
 * Persists session history to disk so users can resume across restarts.
 */
export class SessionManager {
  private active = new Map<number, SessionInfo>();
  private history: SessionInfo[] = [];
  private processing = new Set<number>();

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

  getActive(chatId: number): SessionInfo | undefined {
    return this.active.get(chatId);
  }

  create(chatId: number, cwd: string, sessionId: string, name?: string, model?: string): SessionInfo {
    const session: SessionInfo = {
      sessionId,
      chatId,
      cwd,
      name,
      model,
      totalCost: 0,
      totalTurns: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.active.set(chatId, session);
    this.history.push(session);
    return session;
  }

  /** Promote a previous session to active (for /resume). */
  setActive(chatId: number, session: SessionInfo): void {
    session.lastActiveAt = Date.now();
    this.active.set(chatId, session);
  }

  /** Update the session ID once the real one comes back from Claude. */
  updateSessionId(chatId: number, sessionId: string): void {
    const session = this.active.get(chatId);
    if (session) {
      session.sessionId = sessionId;
      session.lastActiveAt = Date.now();
    }
  }

  endActive(chatId: number): SessionInfo | undefined {
    const session = this.active.get(chatId);
    this.active.delete(chatId);
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
  addCost(chatId: number, cost: number, turns: number): void {
    const session = this.active.get(chatId);
    if (session) {
      session.totalCost = (session.totalCost ?? 0) + cost;
      session.totalTurns = (session.totalTurns ?? 0) + turns;
    }
  }

  isProcessing(chatId: number): boolean {
    return this.processing.has(chatId);
  }

  setProcessing(chatId: number, value: boolean): void {
    if (value) this.processing.add(chatId);
    else this.processing.delete(chatId);
  }
}
