/**
 * Parse Telegram message text into a structured command.
 */

import type { PermissionMode } from "./types.js";

/** Known bot commands — used to distinguish unknown /commands from prompts. */
const KNOWN_COMMANDS = new Set([
  "new",
  "resume",
  "sessions",
  "list",
  "stop",
  "end",
  "compact",
  "model",
  "mode",
  "cost",
  "status",
  "help",
  "approve",
  "cc",
  "start",
  "pair",
  "dirs",
  "bookmark",
  "schedule",
  "jobs",
  "cancel",
  "pause",
]);

export type Command =
  // Session management
  | { type: "new"; cwd?: string; name?: string }
  | { type: "resume"; target?: string }
  | { type: "sessions" }
  | { type: "stop" }
  // Claude control
  | { type: "compact" }
  | { type: "model"; model?: string }
  | { type: "mode"; mode?: PermissionMode }
  | { type: "cost" }
  | { type: "status" }
  // Claude Code slash command pass-through
  | { type: "cc"; slashCommand: string; args: string }
  | { type: "cc_menu" } // /cc alone — show command picker
  // Directory bookmarks
  | { type: "dirs" }
  | { type: "bookmark"; path?: string; name?: string }
  // Scheduling
  | { type: "schedule"; prompt: string; scheduleExpr: string; name?: string; cwd?: string }
  | { type: "schedule_help" }
  | { type: "jobs" }
  | { type: "cancel"; jobId: string }
  | { type: "pause"; jobId: string }
  // Admin
  | { type: "help" }
  | { type: "approve"; code: string }
  // Unknown /command (not a known bot command)
  | { type: "unknown_command"; text: string }
  // Pass-through
  | { type: "prompt"; text: string };

export function parseCommand(text: string): Command {
  const trimmed = text.trim();

  if (trimmed === "/new" || trimmed.startsWith("/new ")) {
    const args = trimmed.slice(4).trim();
    if (!args) return { type: "new" };

    const nameMatch = args.match(/--name\s+(\S+)/);
    const name = nameMatch?.[1];
    const cwd = args.replace(/--name\s+\S+/, "").trim() || undefined;
    return { type: "new", cwd, name };
  }

  if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
    const target = trimmed.slice(7).trim() || undefined;
    return { type: "resume", target };
  }

  if (trimmed === "/sessions" || trimmed === "/list") {
    return { type: "sessions" };
  }

  if (trimmed === "/stop" || trimmed === "/end") {
    return { type: "stop" };
  }

  if (trimmed === "/compact") {
    return { type: "compact" };
  }

  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    const model = trimmed.slice(6).trim() || undefined;
    return { type: "model", model };
  }

  // /mode [normal|plan|auto-accept]
  if (trimmed === "/mode" || trimmed.startsWith("/mode ")) {
    const modeArg = trimmed.slice(5).trim() || undefined;
    if (!modeArg) return { type: "mode" };
    const valid: PermissionMode[] = ["normal", "plan", "auto-accept"];
    if (valid.includes(modeArg as PermissionMode)) {
      return { type: "mode", mode: modeArg as PermissionMode };
    }
    // Shorthand aliases
    if (modeArg === "auto") return { type: "mode", mode: "auto-accept" };
    if (modeArg === "accept") return { type: "mode", mode: "auto-accept" };
    return { type: "mode" }; // invalid mode → show picker
  }

  if (trimmed === "/cost") {
    return { type: "cost" };
  }

  if (trimmed === "/status") {
    return { type: "status" };
  }

  if (trimmed === "/help") {
    return { type: "help" };
  }

  if (trimmed.startsWith("/approve ")) {
    const code = trimmed.slice(9).trim();
    if (code) return { type: "approve", code };
  }

  // /cc alone — show command picker menu
  if (trimmed === "/cc" || trimmed === "/cc ") {
    return { type: "cc_menu" };
  }

  // /cc <slashCommand> [args] — Claude Code slash command pass-through
  if (trimmed.startsWith("/cc ")) {
    const rest = trimmed.slice(4).trim();
    if (rest) {
      const spaceIdx = rest.indexOf(" ");
      const slashCommand = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
      return { type: "cc", slashCommand, args };
    }
  }

  // /dirs — list bookmarked directories
  if (trimmed === "/dirs") {
    return { type: "dirs" };
  }

  // /bookmark [path] [--name alias]
  if (trimmed === "/bookmark" || trimmed.startsWith("/bookmark ")) {
    const args = trimmed.slice(9).trim();
    if (!args) return { type: "bookmark" };
    const nameMatch = args.match(/--name\s+(\S+)/);
    const name = nameMatch?.[1];
    const path = args.replace(/--name\s+\S+/, "").trim() || undefined;
    return { type: "bookmark", path, name };
  }

  // /schedule "prompt" <schedule expression> [--name alias] [--cwd path]
  if (trimmed === "/schedule" || trimmed.startsWith("/schedule ")) {
    const args = trimmed.slice(9).trim();
    if (!args) return { type: "schedule_help" };

    // Extract quoted prompt (single or double quotes)
    const promptMatch = args.match(/^(["'])(.+?)\1\s+(.+)$/);
    if (!promptMatch?.[2] || !promptMatch[3]) return { type: "schedule_help" };

    const prompt = promptMatch[2];
    let rest = promptMatch[3];

    // Extract optional flags
    const nameMatch = rest.match(/--name\s+(\S+)/);
    const name = nameMatch?.[1];
    if (nameMatch) rest = rest.replace(/--name\s+\S+/, "").trim();

    const cwdMatch = rest.match(/--cwd\s+(\S+)/);
    const cwd = cwdMatch?.[1];
    if (cwdMatch) rest = rest.replace(/--cwd\s+\S+/, "").trim();

    const scheduleExpr = rest.trim();
    if (!scheduleExpr) return { type: "schedule_help" };

    return { type: "schedule", prompt, scheduleExpr, name, cwd };
  }

  // /jobs — list scheduled jobs
  if (trimmed === "/jobs") {
    return { type: "jobs" };
  }

  // /cancel <jobId>
  if (trimmed.startsWith("/cancel ")) {
    const jobId = trimmed.slice(8).trim();
    if (jobId) return { type: "cancel", jobId };
  }

  // /pause <jobId>
  if (trimmed.startsWith("/pause ")) {
    const jobId = trimmed.slice(7).trim();
    if (jobId) return { type: "pause", jobId };
  }

  // Detect unknown /commands (single-word slash that isn't a known command)
  if (trimmed.startsWith("/")) {
    const match = trimmed.match(/^\/(\S+)/);
    if (match?.[1] && !KNOWN_COMMANDS.has(match[1].toLowerCase())) {
      return { type: "unknown_command", text: trimmed };
    }
  }

  return { type: "prompt", text: trimmed };
}
