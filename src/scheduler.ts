import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Cron } from "croner";
import { MAX_JOBS_PER_CHAT } from "./config.js";
import type { ScheduledJob } from "./types.js";

/**
 * Manages scheduled jobs per Telegram chat.
 * Persists to disk so jobs survive orchestrator restarts.
 */
export class ScheduleManager {
  private jobs: ScheduledJob[] = [];

  constructor(private readonly storePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.storePath, "utf8")) as {
        schedules?: ScheduledJob[];
      };
      this.jobs = raw.schedules ?? [];
    } catch {
      this.jobs = [];
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify({ schedules: this.jobs }, null, 2));
  }

  create(
    chatId: number,
    cwd: string,
    cronExpr: string,
    prompt: string,
    opts?: { name?: string; recurring?: boolean; sessionId?: string; expiresAt?: number },
  ): ScheduledJob {
    if (this.countForChat(chatId) >= MAX_JOBS_PER_CHAT) {
      throw new Error(`Job limit reached (max ${MAX_JOBS_PER_CHAT} per chat)`);
    }

    const job: ScheduledJob = {
      id: crypto.randomUUID().slice(0, 8),
      chatId,
      cwd,
      cronExpr,
      prompt,
      name: opts?.name,
      recurring: opts?.recurring ?? true,
      sessionId: opts?.sessionId,
      createdAt: Date.now(),
      nextRunAt: computeNextRunAt(cronExpr),
      runCount: 0,
      expiresAt: opts?.expiresAt,
      enabled: true,
    };

    this.jobs.push(job);
    return job;
  }

  list(chatId?: number): ScheduledJob[] {
    const filtered = chatId ? this.jobs.filter((j) => j.chatId === chatId) : this.jobs;
    return filtered.sort(
      (a, b) => (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY),
    );
  }

  findById(id: string): ScheduledJob | undefined {
    return this.jobs.find((j) => j.id === id) ?? this.jobs.find((j) => j.id.startsWith(id));
  }

  delete(id: string): boolean {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    this.jobs.splice(idx, 1);
    return true;
  }

  toggle(id: string): boolean {
    const job = this.findById(id);
    if (!job) return false;
    job.enabled = !job.enabled;
    if (job.enabled) {
      job.nextRunAt = computeNextRunAt(job.cronExpr);
    }
    return true;
  }

  recordExecution(id: string): void {
    const job = this.findById(id);
    if (!job) return;
    job.lastRunAt = Date.now();
    job.runCount++;
    job.nextRunAt = computeNextRunAt(job.cronExpr);
  }

  getDueJobs(now: number): ScheduledJob[] {
    return this.jobs.filter(
      (j) => j.enabled && j.nextRunAt != null && j.nextRunAt <= now && (!j.expiresAt || j.expiresAt > now),
    );
  }

  countForChat(chatId: number): number {
    return this.jobs.filter((j) => j.chatId === chatId).length;
  }
}

// ─── Cron helpers ────────────────────────────────────────────────────────────

export function computeNextRunAt(cronExpr: string): number | undefined {
  try {
    const next = new Cron(cronExpr).nextRun();
    return next ? next.getTime() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert user-friendly schedule expressions to 5-field cron.
 *
 * Supported formats:
 *   every 30m          → *​/30 * * * *
 *   every 2h           → 0 *​/2 * * *
 *   every day / daily  → 0 9 * * *
 *   at 9am             → 0 9 * * *
 *   at 9:30am          → 30 9 * * *
 *   at 2pm weekdays    → 0 14 * * 1-5
 *   at 9am weekends    → 0 9 * * 0,6
 *   cron <raw>         → pass-through
 */
export function parseScheduleExpression(expr: string): { cronExpr: string; recurring: boolean } | undefined {
  const trimmed = expr.trim().toLowerCase();

  // Raw cron pass-through: "cron */15 * * * *"
  const cronMatch = trimmed.match(/^cron\s+(.+)$/);
  if (cronMatch?.[1]) {
    return { cronExpr: cronMatch[1].trim(), recurring: true };
  }

  // "every Nm" or "every Nh"
  const everyMatch = trimmed.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/);
  if (everyMatch?.[1] && everyMatch[2]) {
    const n = Number.parseInt(everyMatch[1], 10);
    const unit = everyMatch[2][0]; // 'm' or 'h'
    if (unit === "m") {
      if (n < 1 || n > 59) return undefined;
      return { cronExpr: `*/${n} * * * *`, recurring: true };
    }
    if (unit === "h") {
      if (n < 1 || n > 23) return undefined;
      return { cronExpr: `0 */${n} * * *`, recurring: true };
    }
  }

  // "every day" / "daily"
  if (trimmed === "every day" || trimmed === "daily") {
    return { cronExpr: "0 9 * * *", recurring: true };
  }

  // "every weekday"
  if (trimmed === "every weekday") {
    return { cronExpr: "0 9 * * 1-5", recurring: true };
  }

  // "at <time> [weekdays|weekends]" or "once at <time>"
  const once = trimmed.startsWith("once ");
  const atInput = once ? trimmed.slice(5).trim() : trimmed;

  const atMatch = atInput.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(weekdays?|weekends?)?$/);
  if (atMatch?.[1]) {
    let hour = Number.parseInt(atMatch[1], 10);
    const minute = atMatch[2] ? Number.parseInt(atMatch[2], 10) : 0;
    const ampm = atMatch[3];
    const daySpec = atMatch[4];

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;

    let dow = "*";
    if (daySpec?.startsWith("weekday")) dow = "1-5";
    else if (daySpec?.startsWith("weekend")) dow = "0,6";

    if (once) {
      const now = new Date();
      let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
      if (target.getTime() <= now.getTime()) {
        target = new Date(target.getTime() + 86_400_000); // next day
      }
      return {
        cronExpr: `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`,
        recurring: false,
      };
    }

    return { cronExpr: `${minute} ${hour} * * ${dow}`, recurring: true };
  }

  return undefined;
}
