import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  addToAllowlist,
  consumePairingCode,
  generatePairingCode,
  isAllowed,
  issuePairingCode,
  loadAccessState,
  removeFromAllowlist,
  saveAccessState,
} from "../src/access.js";
import type { AccessState } from "../src/types.js";

function freshState(policy: AccessState["policy"] = "pairing"): AccessState {
  return { policy, allowlist: [], pendingCodes: new Map() };
}

// ─── generatePairingCode ───────────────────────────────────────────────────

describe("generatePairingCode", () => {
  const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  test("returns a 6-character string", () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(6);
  });

  test("uses only valid charset characters", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      for (const ch of code) {
        expect(CHARSET).toContain(ch);
      }
    }
  });

  test("generates different codes", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generatePairingCode()));
    // With 30^6 possible codes, 20 samples should all be unique
    expect(codes.size).toBe(20);
  });
});

// ─── isAllowed ─────────────────────────────────────────────────────────────

describe("isAllowed", () => {
  test("returns true when policy is open", () => {
    const state = freshState("open");
    expect(isAllowed(state, 12345)).toBe(true);
  });

  test("returns true when user is in allowlist", () => {
    const state = freshState("allowlist");
    state.allowlist = [100, 200, 300];
    expect(isAllowed(state, 200)).toBe(true);
  });

  test("returns false when user is not in allowlist", () => {
    const state = freshState("allowlist");
    state.allowlist = [100, 200];
    expect(isAllowed(state, 999)).toBe(false);
  });

  test("returns false for pairing policy when not in allowlist", () => {
    const state = freshState("pairing");
    expect(isAllowed(state, 123)).toBe(false);
  });
});

// ─── addToAllowlist / removeFromAllowlist ──────────────────────────────────

describe("addToAllowlist", () => {
  test("adds user to empty allowlist", () => {
    const state = freshState();
    addToAllowlist(state, 42);
    expect(state.allowlist).toEqual([42]);
  });

  test("does not duplicate existing user", () => {
    const state = freshState();
    state.allowlist = [42];
    addToAllowlist(state, 42);
    expect(state.allowlist).toEqual([42]);
  });

  test("preserves existing entries", () => {
    const state = freshState();
    state.allowlist = [1, 2];
    addToAllowlist(state, 3);
    expect(state.allowlist).toEqual([1, 2, 3]);
  });
});

describe("removeFromAllowlist", () => {
  test("removes user", () => {
    const state = freshState();
    state.allowlist = [1, 2, 3];
    removeFromAllowlist(state, 2);
    expect(state.allowlist).toEqual([1, 3]);
  });

  test("no-op for non-existent user", () => {
    const state = freshState();
    state.allowlist = [1, 2];
    removeFromAllowlist(state, 99);
    expect(state.allowlist).toEqual([1, 2]);
  });
});

// ─── issuePairingCode / consumePairingCode ─────────────────────────────────

describe("issuePairingCode", () => {
  test("returns a code and stores it in state", () => {
    const state = freshState();
    const code = issuePairingCode(state, { userId: 1, chatId: 1, firstName: "Test" }, 60_000);
    expect(code).toHaveLength(6);
    expect(state.pendingCodes.has(code)).toBe(true);
  });

  test("cleans up expired codes on issuance", () => {
    const state = freshState();
    state.pendingCodes.set("OLDCODE", {
      userId: 1,
      chatId: 1,
      firstName: "Old",
      expiresAt: Date.now() - 1000, // already expired
    });
    issuePairingCode(state, { userId: 2, chatId: 2, firstName: "New" }, 60_000);
    expect(state.pendingCodes.has("OLDCODE")).toBe(false);
  });
});

describe("consumePairingCode", () => {
  test("returns pairing for valid code", () => {
    const state = freshState();
    const code = issuePairingCode(state, { userId: 42, chatId: 100, firstName: "Alex" }, 60_000);
    const result = consumePairingCode(state, code);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(42);
    expect(result?.chatId).toBe(100);
  });

  test("returns null for expired code", () => {
    const state = freshState();
    const code = issuePairingCode(state, { userId: 1, chatId: 1, firstName: "Test" }, 1); // 1ms TTL
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy wait 5ms
    expect(consumePairingCode(state, code)).toBeNull();
  });

  test("returns null for non-existent code", () => {
    const state = freshState();
    expect(consumePairingCode(state, "NOPE")).toBeNull();
  });

  test("is case-insensitive", () => {
    const state = freshState();
    const code = issuePairingCode(state, { userId: 1, chatId: 1, firstName: "Test" }, 60_000);
    const result = consumePairingCode(state, code.toLowerCase());
    expect(result).not.toBeNull();
  });

  test("is one-time use", () => {
    const state = freshState();
    const code = issuePairingCode(state, { userId: 1, chatId: 1, firstName: "Test" }, 60_000);
    consumePairingCode(state, code);
    expect(consumePairingCode(state, code)).toBeNull();
  });
});

// ─── Persistence ───────────────────────────────────────────────────────────

describe("loadAccessState / saveAccessState", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tg-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("round-trips policy and allowlist", async () => {
    const path = join(tmpDir, "allowlist.json");
    const state = freshState("allowlist");
    state.allowlist = [100, 200];
    await saveAccessState(path, state);

    const loaded = await loadAccessState(path);
    expect(loaded.policy).toBe("allowlist");
    expect(loaded.allowlist).toEqual([100, 200]);
    expect(loaded.pendingCodes.size).toBe(0); // runtime-only, not persisted
  });

  test("returns defaults when file does not exist", async () => {
    const loaded = await loadAccessState(join(tmpDir, "nonexistent.json"));
    expect(loaded.policy).toBe("pairing");
    expect(loaded.allowlist).toEqual([]);
  });
});
