import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/commands.js";

describe("parseCommand", () => {
  // ─── /new ────────────────────────────────────────────────────────────────
  test("/new with no args", () => {
    expect(parseCommand("/new")).toEqual({ type: "new" });
  });

  test("/new with path", () => {
    expect(parseCommand("/new /some/path")).toEqual({ type: "new", cwd: "/some/path" });
  });

  test("/new with path and --name", () => {
    expect(parseCommand("/new /some/path --name demo")).toEqual({
      type: "new",
      cwd: "/some/path",
      name: "demo",
    });
  });

  test("/new with --name only", () => {
    expect(parseCommand("/new --name demo")).toEqual({
      type: "new",
      cwd: undefined,
      name: "demo",
    });
  });

  // ─── /resume ─────────────────────────────────────────────────────────────
  test("/resume with no args", () => {
    expect(parseCommand("/resume")).toEqual({ type: "resume" });
  });

  test("/resume with target", () => {
    expect(parseCommand("/resume myproject")).toEqual({ type: "resume", target: "myproject" });
  });

  // ─── /sessions ───────────────────────────────────────────────────────────
  test("/sessions", () => {
    expect(parseCommand("/sessions")).toEqual({ type: "sessions" });
  });

  test("/list alias", () => {
    expect(parseCommand("/list")).toEqual({ type: "sessions" });
  });

  // ─── /stop ───────────────────────────────────────────────────────────────
  test("/stop", () => {
    expect(parseCommand("/stop")).toEqual({ type: "stop" });
  });

  test("/end alias", () => {
    expect(parseCommand("/end")).toEqual({ type: "stop" });
  });

  // ─── /compact ────────────────────────────────────────────────────────────
  test("/compact", () => {
    expect(parseCommand("/compact")).toEqual({ type: "compact" });
  });

  // ─── /model ──────────────────────────────────────────────────────────────
  test("/model with no args", () => {
    expect(parseCommand("/model")).toEqual({ type: "model" });
  });

  test("/model with model name", () => {
    expect(parseCommand("/model sonnet")).toEqual({ type: "model", model: "sonnet" });
  });

  // ─── /cost, /status ──────────────────────────────────────────────────────
  test("/cost", () => {
    expect(parseCommand("/cost")).toEqual({ type: "cost" });
  });

  test("/status", () => {
    expect(parseCommand("/status")).toEqual({ type: "status" });
  });

  // ─── /help ───────────────────────────────────────────────────────────────
  test("/help", () => {
    expect(parseCommand("/help")).toEqual({ type: "help" });
  });

  // ─── /approve ────────────────────────────────────────────────────────────
  test("/approve with code", () => {
    expect(parseCommand("/approve ABC123")).toEqual({ type: "approve", code: "ABC123" });
  });

  test("/approve with no code falls through to prompt", () => {
    // Empty code after /approve → no match → known command, treated as prompt
    expect(parseCommand("/approve ")).toEqual({ type: "prompt", text: "/approve" });
  });

  // ─── /cc — Claude Code slash command pass-through ─────────────────────────
  test("/cc commit", () => {
    expect(parseCommand("/cc commit")).toEqual({ type: "cc", slashCommand: "commit", args: "" });
  });

  test("/cc with args", () => {
    expect(parseCommand("/cc review-pr 123")).toEqual({
      type: "cc",
      slashCommand: "review-pr",
      args: "123",
    });
  });

  test("/cc with multi-word args", () => {
    expect(parseCommand('/cc commit -m "fix bug"')).toEqual({
      type: "cc",
      slashCommand: "commit",
      args: '-m "fix bug"',
    });
  });

  test("/cc alone shows command menu", () => {
    expect(parseCommand("/cc")).toEqual({ type: "cc_menu" });
  });

  test("/cc with only space shows command menu", () => {
    expect(parseCommand("/cc ")).toEqual({ type: "cc_menu" });
  });

  // ─── /mode — permission mode switching ──────────────────────────────────────
  test("/mode with no args", () => {
    expect(parseCommand("/mode")).toEqual({ type: "mode" });
  });

  test("/mode plan", () => {
    expect(parseCommand("/mode plan")).toEqual({ type: "mode", mode: "plan" });
  });

  test("/mode auto-accept", () => {
    expect(parseCommand("/mode auto-accept")).toEqual({ type: "mode", mode: "auto-accept" });
  });

  test("/mode auto shorthand", () => {
    expect(parseCommand("/mode auto")).toEqual({ type: "mode", mode: "auto-accept" });
  });

  test("/mode normal", () => {
    expect(parseCommand("/mode normal")).toEqual({ type: "mode", mode: "normal" });
  });

  test("/mode invalid → show picker", () => {
    expect(parseCommand("/mode foobar")).toEqual({ type: "mode" });
  });

  // ─── /dirs + /bookmark ─────────────────────────────────────────────────────
  test("/dirs", () => {
    expect(parseCommand("/dirs")).toEqual({ type: "dirs" });
  });

  test("/bookmark with no args", () => {
    expect(parseCommand("/bookmark")).toEqual({ type: "bookmark" });
  });

  test("/bookmark with path", () => {
    expect(parseCommand("/bookmark /home/user/project")).toEqual({
      type: "bookmark",
      path: "/home/user/project",
      name: undefined,
    });
  });

  test("/bookmark with path and --name", () => {
    expect(parseCommand("/bookmark /home/user/project --name myproj")).toEqual({
      type: "bookmark",
      path: "/home/user/project",
      name: "myproj",
    });
  });

  // ─── Unknown commands ──────────────────────────────────────────────────────
  test("unknown single-word command", () => {
    expect(parseCommand("/foo")).toEqual({ type: "unknown_command", text: "/foo" });
  });

  test("unknown command with args", () => {
    expect(parseCommand("/unknown command")).toEqual({
      type: "unknown_command",
      text: "/unknown command",
    });
  });

  // ─── Plain text / fallthrough ────────────────────────────────────────────
  test("plain text", () => {
    expect(parseCommand("fix the bug in auth.ts")).toEqual({
      type: "prompt",
      text: "fix the bug in auth.ts",
    });
  });

  test("whitespace is trimmed", () => {
    expect(parseCommand("  /help  ")).toEqual({ type: "help" });
  });

  test("whitespace-only text", () => {
    expect(parseCommand("   ")).toEqual({ type: "prompt", text: "" });
  });
});
