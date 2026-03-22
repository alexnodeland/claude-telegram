import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";

const HOME = process.env.HOME ?? "/tmp";
const DATA_DIR = join(HOME, ".claude", "channels", "telegram");

function readEnvFile(path: string): Record<string, string> {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const result: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match?.[1] && match[2]) result[match[1]] = match[2].trim();
    }
    return result;
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  const envFile = readEnvFile(join(DATA_DIR, ".env"));

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? envFile.TELEGRAM_BOT_TOKEN ?? "";

  return {
    botToken,
    dataDir: DATA_DIR,
    allowlistPath: join(DATA_DIR, "allowlist.json"),
    pollIntervalMs: 1_500,
    pairingCodeTtlMs: 10 * 60 * 1_000, // 10 minutes
    maxFileSizeBytes: 50 * 1024 * 1024, // 50 MB
  };
}

export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const PAIRING_CODE_LENGTH = 6;
export const TYPING_INTERVAL_MS = 4_500;
export const RELAY_PROMPT_TIMEOUT_MS = 120_000; // 2 minutes
