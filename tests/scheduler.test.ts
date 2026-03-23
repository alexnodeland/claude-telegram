import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ScheduleManager, computeNextRunAt, parseScheduleExpression } from "../src/scheduler.js";

describe("ScheduleManager", () => {
  // ─── In-memory operations ──────────────────────────────────────────────

  test("create returns job with correct defaults", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp/proj", "*/5 * * * *", "run tests");
    expect(job.chatId).toBe(100);
    expect(job.cwd).toBe("/tmp/proj");
    expect(job.cronExpr).toBe("*/5 * * * *");
    expect(job.prompt).toBe("run tests");
    expect(job.recurring).toBe(true);
    expect(job.enabled).toBe(true);
    expect(job.runCount).toBe(0);
    expect(job.id).toHaveLength(8);
  });

  test("create with options", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "0 9 * * *", "deploy", {
      name: "daily-deploy",
      recurring: false,
      sessionId: "sess-abc",
    });
    expect(job.name).toBe("daily-deploy");
    expect(job.recurring).toBe(false);
    expect(job.sessionId).toBe("sess-abc");
  });

  test("create generates unique IDs", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const j1 = mgr.create(100, "/tmp", "* * * * *", "a");
    const j2 = mgr.create(100, "/tmp", "* * * * *", "b");
    expect(j1.id).not.toBe(j2.id);
  });

  test("create enforces per-chat limit", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    for (let i = 0; i < 25; i++) {
      mgr.create(100, "/tmp", "* * * * *", `job-${i}`);
    }
    expect(() => mgr.create(100, "/tmp", "* * * * *", "one too many")).toThrow(/limit/i);
  });

  test("create allows jobs in different chats", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    for (let i = 0; i < 25; i++) {
      mgr.create(100, "/tmp", "* * * * *", `job-${i}`);
    }
    // Different chat should still work
    const job = mgr.create(200, "/tmp", "* * * * *", "different chat");
    expect(job.chatId).toBe(200);
  });

  // ─── Listing ───────────────────────────────────────────────────────────

  test("list filters by chatId", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    mgr.create(100, "/tmp", "*/5 * * * *", "chat-100-job");
    mgr.create(200, "/tmp", "*/10 * * * *", "chat-200-job");

    const list = mgr.list(100);
    expect(list).toHaveLength(1);
    expect(list[0]?.prompt).toBe("chat-100-job");
  });

  test("list without chatId returns all", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    mgr.create(100, "/tmp", "*/5 * * * *", "a");
    mgr.create(200, "/tmp", "*/10 * * * *", "b");
    expect(mgr.list()).toHaveLength(2);
  });

  test("list sorts by nextRunAt ascending", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const j1 = mgr.create(100, "/tmp", "0 12 * * *", "noon");
    const j2 = mgr.create(100, "/tmp", "0 6 * * *", "morning");
    // j2 (morning) should come before j1 (noon) assuming we're before both times
    const list = mgr.list(100);
    if (j2.nextRunAt! < j1.nextRunAt!) {
      expect(list[0]?.prompt).toBe("morning");
    }
  });

  // ─── Lookup ────────────────────────────────────────────────────────────

  test("findById with exact ID", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "* * * * *", "test");
    expect(mgr.findById(job.id)?.prompt).toBe("test");
  });

  test("findById with prefix", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "* * * * *", "test");
    expect(mgr.findById(job.id.slice(0, 4))?.prompt).toBe("test");
  });

  test("findById returns undefined for no match", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    expect(mgr.findById("nonexistent")).toBeUndefined();
  });

  // ─── Delete ────────────────────────────────────────────────────────────

  test("delete removes job", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "* * * * *", "test");
    expect(mgr.delete(job.id)).toBe(true);
    expect(mgr.findById(job.id)).toBeUndefined();
    expect(mgr.list()).toHaveLength(0);
  });

  test("delete returns false for nonexistent", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    expect(mgr.delete("nope")).toBe(false);
  });

  // ─── Toggle ────────────────────────────────────────────────────────────

  test("toggle flips enabled", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "* * * * *", "test");
    expect(job.enabled).toBe(true);

    mgr.toggle(job.id);
    expect(mgr.findById(job.id)?.enabled).toBe(false);

    mgr.toggle(job.id);
    expect(mgr.findById(job.id)?.enabled).toBe(true);
  });

  test("toggle returns false for nonexistent", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    expect(mgr.toggle("nope")).toBe(false);
  });

  // ─── Execution recording ──────────────────────────────────────────────

  test("recordExecution updates state", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "*/5 * * * *", "test");
    const originalNextRun = job.nextRunAt;

    mgr.recordExecution(job.id);

    const updated = mgr.findById(job.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunAt).toBeDefined();
    expect(updated.lastRunAt).toBeGreaterThan(0);
    // nextRunAt should be set (may be same or later depending on timing)
    expect(updated.nextRunAt).toBeDefined();
    if (originalNextRun != null && updated.nextRunAt != null) {
      expect(updated.nextRunAt).toBeGreaterThanOrEqual(originalNextRun);
    }
  });

  test("recordExecution increments runCount", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "*/5 * * * *", "test");
    mgr.recordExecution(job.id);
    mgr.recordExecution(job.id);
    mgr.recordExecution(job.id);
    expect(mgr.findById(job.id)?.runCount).toBe(3);
  });

  // ─── getDueJobs ───────────────────────────────────────────────────────

  test("getDueJobs returns jobs with nextRunAt <= now", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "*/5 * * * *", "test");
    // Set nextRunAt to the past
    job.nextRunAt = Date.now() - 60_000;
    const due = mgr.getDueJobs(Date.now());
    expect(due).toHaveLength(1);
    expect(due[0]?.id).toBe(job.id);
  });

  test("getDueJobs excludes disabled jobs", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "*/5 * * * *", "test");
    job.nextRunAt = Date.now() - 60_000;
    job.enabled = false;
    expect(mgr.getDueJobs(Date.now())).toHaveLength(0);
  });

  test("getDueJobs excludes future jobs", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "*/5 * * * *", "test");
    job.nextRunAt = Date.now() + 3_600_000; // 1 hour from now
    expect(mgr.getDueJobs(Date.now())).toHaveLength(0);
  });

  test("getDueJobs excludes expired jobs", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    const job = mgr.create(100, "/tmp", "*/5 * * * *", "test", { expiresAt: Date.now() - 1000 });
    job.nextRunAt = Date.now() - 60_000;
    expect(mgr.getDueJobs(Date.now())).toHaveLength(0);
  });

  // ─── countForChat ─────────────────────────────────────────────────────

  test("countForChat counts correctly", () => {
    const mgr = new ScheduleManager("/tmp/unused.json");
    mgr.create(100, "/tmp", "* * * * *", "a");
    mgr.create(100, "/tmp", "* * * * *", "b");
    mgr.create(200, "/tmp", "* * * * *", "c");
    expect(mgr.countForChat(100)).toBe(2);
    expect(mgr.countForChat(200)).toBe(1);
    expect(mgr.countForChat(999)).toBe(0);
  });

  // ─── Persistence ───────────────────────────────────────────────────────

  describe("load / save", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "tg-sched-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    test("round-trips scheduled jobs", async () => {
      const path = join(tmpDir, "schedules.json");
      const mgr1 = new ScheduleManager(path);
      mgr1.create(100, "/proj-a", "*/5 * * * *", "run tests", { name: "test-runner" });
      mgr1.create(100, "/proj-b", "0 9 * * 1-5", "deploy");
      await mgr1.save();

      const mgr2 = new ScheduleManager(path);
      await mgr2.load();
      const list = mgr2.list(100);
      expect(list).toHaveLength(2);
      expect(list.some((j) => j.name === "test-runner")).toBe(true);
    });

    test("load handles missing file", async () => {
      const mgr = new ScheduleManager(join(tmpDir, "nope.json"));
      await mgr.load();
      expect(mgr.list()).toEqual([]);
    });
  });
});

// ─── Cron helpers ────────────────────────────────────────────────────────────

describe("computeNextRunAt", () => {
  test("returns a future timestamp for valid cron", () => {
    const next = computeNextRunAt("*/5 * * * *");
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThan(Date.now() - 1000);
  });

  test("returns undefined for invalid cron", () => {
    expect(computeNextRunAt("not a cron")).toBeUndefined();
  });
});

describe("parseScheduleExpression", () => {
  test("every 30m", () => {
    const result = parseScheduleExpression("every 30m");
    expect(result).toEqual({ cronExpr: "*/30 * * * *", recurring: true });
  });

  test("every 5 minutes", () => {
    const result = parseScheduleExpression("every 5 minutes");
    expect(result).toEqual({ cronExpr: "*/5 * * * *", recurring: true });
  });

  test("every 2h", () => {
    const result = parseScheduleExpression("every 2h");
    expect(result).toEqual({ cronExpr: "0 */2 * * *", recurring: true });
  });

  test("every 1 hour", () => {
    const result = parseScheduleExpression("every 1 hour");
    expect(result).toEqual({ cronExpr: "0 */1 * * *", recurring: true });
  });

  test("every day", () => {
    const result = parseScheduleExpression("every day");
    expect(result).toEqual({ cronExpr: "0 9 * * *", recurring: true });
  });

  test("daily", () => {
    const result = parseScheduleExpression("daily");
    expect(result).toEqual({ cronExpr: "0 9 * * *", recurring: true });
  });

  test("every weekday", () => {
    const result = parseScheduleExpression("every weekday");
    expect(result).toEqual({ cronExpr: "0 9 * * 1-5", recurring: true });
  });

  test("at 9am", () => {
    const result = parseScheduleExpression("at 9am");
    expect(result).toEqual({ cronExpr: "0 9 * * *", recurring: true });
  });

  test("at 9:30am", () => {
    const result = parseScheduleExpression("at 9:30am");
    expect(result).toEqual({ cronExpr: "30 9 * * *", recurring: true });
  });

  test("at 2pm weekdays", () => {
    const result = parseScheduleExpression("at 2pm weekdays");
    expect(result).toEqual({ cronExpr: "0 14 * * 1-5", recurring: true });
  });

  test("at 9am weekends", () => {
    const result = parseScheduleExpression("at 9am weekends");
    expect(result).toEqual({ cronExpr: "0 9 * * 0,6", recurring: true });
  });

  test("at 12am (midnight)", () => {
    const result = parseScheduleExpression("at 12am");
    expect(result).toEqual({ cronExpr: "0 0 * * *", recurring: true });
  });

  test("at 12pm (noon)", () => {
    const result = parseScheduleExpression("at 12pm");
    expect(result).toEqual({ cronExpr: "0 12 * * *", recurring: true });
  });

  test("cron passthrough", () => {
    const result = parseScheduleExpression("cron */15 * * * *");
    expect(result).toEqual({ cronExpr: "*/15 * * * *", recurring: true });
  });

  test("once at time produces non-recurring", () => {
    const result = parseScheduleExpression("once at 3pm");
    expect(result).toBeDefined();
    expect(result!.recurring).toBe(false);
  });

  test("case insensitive", () => {
    expect(parseScheduleExpression("Every 5m")).toEqual({ cronExpr: "*/5 * * * *", recurring: true });
    expect(parseScheduleExpression("AT 9AM")).toEqual({ cronExpr: "0 9 * * *", recurring: true });
  });

  test("invalid expression returns undefined", () => {
    expect(parseScheduleExpression("whenever")).toBeUndefined();
    expect(parseScheduleExpression("")).toBeUndefined();
    expect(parseScheduleExpression("every 0m")).toBeUndefined();
    expect(parseScheduleExpression("every 60m")).toBeUndefined();
  });
});
