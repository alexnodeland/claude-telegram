import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PAIRING_CODE_LENGTH } from "./config.js";
import type { AccessState, PendingPairing } from "./types.js";

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function loadAccessState(allowlistPath: string): Promise<AccessState> {
  try {
    const raw = JSON.parse(await readFile(allowlistPath, "utf8")) as {
      policy: AccessState["policy"];
      allowlist: number[];
    };
    return { policy: raw.policy ?? "pairing", allowlist: raw.allowlist ?? [], pendingCodes: new Map() };
  } catch {
    return { policy: "pairing", allowlist: [], pendingCodes: new Map() };
  }
}

export async function saveAccessState(allowlistPath: string, state: AccessState): Promise<void> {
  await mkdir(dirname(allowlistPath), { recursive: true });
  await writeFile(allowlistPath, JSON.stringify({ policy: state.policy, allowlist: state.allowlist }, null, 2));
}

// ─── Pairing Codes ────────────────────────────────────────────────────────────

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePairingCode(): string {
  const buf = new Uint8Array(PAIRING_CODE_LENGTH);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => CHARSET[b % CHARSET.length]).join("");
}

export function issuePairingCode(
  state: AccessState,
  pairing: { userId: number; chatId: number; username?: string; firstName: string },
  ttlMs: number,
): string {
  const now = Date.now();
  for (const [k, v] of state.pendingCodes) {
    if (v.expiresAt < now) state.pendingCodes.delete(k);
  }
  const code = generatePairingCode();
  state.pendingCodes.set(code, { ...pairing, expiresAt: now + ttlMs });
  return code;
}

export function consumePairingCode(state: AccessState, code: string): PendingPairing | null {
  const key = code.toUpperCase().trim();
  const entry = state.pendingCodes.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    state.pendingCodes.delete(key);
    return null;
  }
  state.pendingCodes.delete(key);
  return entry;
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

export function isAllowed(state: AccessState, userId: number): boolean {
  if (state.policy === "open") return true;
  return state.allowlist.includes(userId);
}

export function addToAllowlist(state: AccessState, userId: number): void {
  if (!state.allowlist.includes(userId)) state.allowlist.push(userId);
}

export function removeFromAllowlist(state: AccessState, userId: number): void {
  state.allowlist = state.allowlist.filter((id) => id !== userId);
}
