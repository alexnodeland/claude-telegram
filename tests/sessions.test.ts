import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/sessions.js";

describe("SessionManager", () => {
  // ─── In-memory operations ──────────────────────────────────────────────

  test("create sets session as active", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    const s = mgr.create(100, "/tmp/proj", "sess-aaa", "frontend");
    expect(mgr.getActive(100)).toBe(s);
    expect(s.sessionId).toBe("sess-aaa");
    expect(s.cwd).toBe("/tmp/proj");
    expect(s.name).toBe("frontend");
    expect(s.totalCost).toBe(0);
    expect(s.totalTurns).toBe(0);
  });

  test("getActive returns undefined for no session", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    expect(mgr.getActive(999)).toBeUndefined();
  });

  test("endActive removes and returns session", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.create(100, "/tmp", "sess-1");
    const ended = mgr.endActive(100);
    expect(ended?.sessionId).toBe("sess-1");
    expect(mgr.getActive(100)).toBeUndefined();
  });

  test("endActive returns undefined if none active", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    expect(mgr.endActive(100)).toBeUndefined();
  });

  test("setActive promotes a session", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    const s = mgr.create(100, "/tmp", "sess-1", "old");
    mgr.endActive(100);
    mgr.setActive(100, s);
    expect(mgr.getActive(100)).toBe(s);
  });

  test("updateSessionId changes the ID", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.create(100, "/tmp", "pending");
    mgr.updateSessionId(100, "real-uuid-123");
    expect(mgr.getActive(100)?.sessionId).toBe("real-uuid-123");
  });

  test("updateSessionId is no-op without active session", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.updateSessionId(100, "whatever"); // should not throw
  });

  // ─── Listing ───────────────────────────────────────────────────────────

  test("listForChat filters by chatId and excludes pending", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.create(100, "/a", "sess-1", "a");
    mgr.create(100, "/b", "pending", "b");
    mgr.create(200, "/c", "sess-2", "c");

    const list = mgr.listForChat(100);
    expect(list).toHaveLength(1);
    expect(list[0]?.sessionId).toBe("sess-1");
  });

  test("listForChat sorts by lastActiveAt descending", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    const s1 = mgr.create(100, "/a", "sess-1");
    s1.lastActiveAt = 1000;
    const s2 = mgr.create(100, "/b", "sess-2");
    s2.lastActiveAt = 3000;
    const s3 = mgr.create(100, "/c", "sess-3");
    s3.lastActiveAt = 2000;

    const list = mgr.listForChat(100);
    expect(list.map((s) => s.sessionId)).toEqual(["sess-2", "sess-3", "sess-1"]);
  });

  test("findByName scoped to chatId", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.create(100, "/a", "sess-1", "frontend");
    mgr.create(200, "/b", "sess-2", "frontend");

    const found = mgr.findByName(100, "frontend");
    expect(found?.sessionId).toBe("sess-1");
  });

  test("findByIdPrefix", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.create(100, "/a", "sess-abc-123");
    expect(mgr.findByIdPrefix(100, "sess-abc")?.sessionId).toBe("sess-abc-123");
    expect(mgr.findByIdPrefix(100, "nope")).toBeUndefined();
  });

  // ─── Cost tracking ─────────────────────────────────────────────────────

  test("addCost accumulates", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.create(100, "/tmp", "sess-1");
    mgr.addCost(100, 0.005, 3);
    mgr.addCost(100, 0.002, 2);

    const s = mgr.getActive(100);
    expect(s?.totalCost).toBeCloseTo(0.007);
    expect(s?.totalTurns).toBe(5);
  });

  test("addCost is no-op without active session", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.addCost(100, 1.0, 10); // should not throw
  });

  // ─── Processing flag ───────────────────────────────────────────────────

  test("isProcessing defaults to false", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    expect(mgr.isProcessing(100)).toBe(false);
  });

  test("setProcessing toggles the flag", () => {
    const mgr = new SessionManager("/tmp/unused.json");
    mgr.setProcessing(100, true);
    expect(mgr.isProcessing(100)).toBe(true);
    mgr.setProcessing(100, false);
    expect(mgr.isProcessing(100)).toBe(false);
  });

  // ─── Persistence ───────────────────────────────────────────────────────

  describe("load / save", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "tg-sess-test-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    test("round-trips session history", async () => {
      const path = join(tmpDir, "sessions.json");
      const mgr1 = new SessionManager(path);
      mgr1.create(100, "/proj-a", "sess-1", "frontend");
      mgr1.create(100, "/proj-b", "sess-2");
      await mgr1.save();

      const mgr2 = new SessionManager(path);
      await mgr2.load();
      const list = mgr2.listForChat(100);
      expect(list).toHaveLength(2);
    });

    test("load handles missing file", async () => {
      const mgr = new SessionManager(join(tmpDir, "nope.json"));
      await mgr.load();
      expect(mgr.listForChat(100)).toEqual([]);
    });
  });
});
