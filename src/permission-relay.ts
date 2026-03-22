#!/usr/bin/env bun
/**
 * permission-relay.ts — Sidecar MCP server for the orchestrator.
 *
 * Spawned by the Claude CLI subprocess (via --mcp-config). Exposes a single
 * tool `prompt_handler` that relays permission prompts and AskUserQuestion
 * calls to the orchestrator's HTTP relay server, which forwards them to
 * Telegram for user approval.
 *
 * Claude Code sends exactly: { tool_use_id, tool_name, input }
 * We must return: { behavior: "allow", updatedInput } or { behavior: "deny", message }
 *
 * Env vars (set by orchestrator via MCP config):
 *   RELAY_HTTP_PORT — port of the orchestrator's relay HTTP server
 *   RELAY_CHAT_ID   — Telegram chat ID to relay prompts to
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RELAY_PORT = process.env.RELAY_HTTP_PORT;
const CHAT_ID = process.env.RELAY_CHAT_ID;

if (!RELAY_PORT || !CHAT_ID) {
  process.stderr.write("❌  permission-relay: RELAY_HTTP_PORT and RELAY_CHAT_ID required\n");
  process.exit(1);
}

const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}/relay/prompt`;

const server = new McpServer({ name: "telegram_relay", version: "1.0.0" }, { capabilities: {} });

server.registerTool(
  "prompt_handler",
  {
    title: "Permission Prompt Handler",
    description: "Handles permission prompts by relaying to Telegram for user approval.",
    inputSchema: {
      tool_use_id: z.string().describe("Unique ID for this tool invocation"),
      tool_name: z.string().describe("Name of the tool requesting permission"),
      input: z.any().describe("The complete input parameters for the tool"),
    },
  },
  async (args) => {
    const toolUseId = args.tool_use_id as string;
    const toolName = args.tool_name as string;
    const input = (args.input as Record<string, unknown>) ?? {};
    const requestId = crypto.randomUUID().slice(0, 8);

    process.stderr.write(`🔐  Permission request: ${toolName} (${toolUseId.slice(0, 12)}…)\n`);

    try {
      const res = await fetch(RELAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: Number(CHAT_ID),
          requestId,
          toolName,
          toolInput: input,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        process.stderr.write(`⚠️  Relay error ${res.status}: ${text}\n`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ behavior: "deny", message: `Relay error: ${res.status}` }),
            },
          ],
        };
      }

      const response = (await res.json()) as { behavior: string; updatedInput?: unknown; message?: string };

      // Ensure updatedInput is the original input object when allowing
      // (Claude requires this to be a record, not undefined)
      if (response.behavior === "allow" && !response.updatedInput) {
        response.updatedInput = input;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`❌  Relay failed: ${msg}\n`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ behavior: "deny", message: `Relay failed: ${msg}` }),
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`🔌  permission-relay connected (port=${RELAY_PORT}, chat=${CHAT_ID})\n`);
