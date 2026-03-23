#!/usr/bin/env bun
/**
 * scheduler-relay.ts — Sidecar MCP server for the orchestrator.
 *
 * Spawned by the Claude CLI subprocess (via --mcp-config). Exposes tools
 * that let Claude schedule, list, and cancel recurring jobs by relaying
 * requests to the orchestrator's HTTP relay server.
 *
 * Env vars (set by orchestrator via MCP config):
 *   RELAY_HTTP_PORT — port of the orchestrator's relay HTTP server
 *   RELAY_CHAT_ID   — Telegram chat ID to associate jobs with
 *   SCHEDULER_CWD   — working directory for scheduled jobs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RELAY_PORT = process.env.RELAY_HTTP_PORT;
const CHAT_ID = process.env.RELAY_CHAT_ID;
const CWD = process.env.SCHEDULER_CWD;

if (!RELAY_PORT || !CHAT_ID) {
  process.stderr.write("❌  scheduler-relay: RELAY_HTTP_PORT and RELAY_CHAT_ID required\n");
  process.exit(1);
}

const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`;

const server = new McpServer({ name: "telegram_scheduler", version: "1.0.0" }, { capabilities: {} });

// ─── schedule_job ────────────────────────────────────────────────────────────

server.registerTool(
  "schedule_job",
  {
    title: "Schedule a Job",
    description:
      "Schedule a prompt to run on a recurring or one-shot schedule. " +
      "The job fires in the orchestrator even after this session ends. " +
      "Use standard 5-field cron expressions (minute hour dom month dow).",
    inputSchema: {
      prompt: z.string().describe("The prompt text to execute on each run"),
      cronExpr: z.string().describe('5-field cron expression, e.g. "*/30 * * * *" for every 30 minutes'),
      name: z.string().optional().describe("Human-readable label for the job"),
      recurring: z.boolean().default(true).describe("true = recurring, false = one-shot"),
    },
  },
  async (args) => {
    const prompt = args.prompt as string;
    const cronExpr = args.cronExpr as string;
    const name = args.name as string | undefined;
    const recurring = (args.recurring as boolean) ?? true;

    try {
      const res = await fetch(`${RELAY_BASE}/relay/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: Number(CHAT_ID),
          cwd: CWD ?? process.cwd(),
          cronExpr,
          prompt,
          name,
          recurring,
        }),
      });

      const data = (await res.json()) as { ok?: boolean; job?: unknown; error?: string };
      if (!res.ok || !data.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error ?? res.statusText}` }] };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(data.job, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to schedule: ${msg}` }] };
    }
  },
);

// ─── list_jobs ───────────────────────────────────────────────────────────────

server.registerTool(
  "list_jobs",
  {
    title: "List Scheduled Jobs",
    description: "List all scheduled jobs for this Telegram chat.",
    inputSchema: {},
  },
  async () => {
    try {
      const res = await fetch(`${RELAY_BASE}/relay/schedules?chatId=${CHAT_ID}`);
      const data = (await res.json()) as { ok?: boolean; jobs?: unknown[]; error?: string };
      if (!res.ok || !data.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error ?? res.statusText}` }] };
      }

      if (!data.jobs || data.jobs.length === 0) {
        return { content: [{ type: "text" as const, text: "No scheduled jobs." }] };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(data.jobs, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to list jobs: ${msg}` }] };
    }
  },
);

// ─── cancel_job ──────────────────────────────────────────────────────────────

server.registerTool(
  "cancel_job",
  {
    title: "Cancel a Scheduled Job",
    description: "Cancel a scheduled job by its ID.",
    inputSchema: {
      jobId: z.string().describe("The job ID to cancel"),
    },
  },
  async (args) => {
    const jobId = args.jobId as string;

    try {
      const res = await fetch(`${RELAY_BASE}/relay/schedule/${jobId}`, { method: "DELETE" });
      const data = (await res.json()) as { ok?: boolean; deleted?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${data.error ?? res.statusText}` }] };
      }

      return {
        content: [
          { type: "text" as const, text: data.deleted ? `Job ${jobId} cancelled.` : `Job ${jobId} not found.` },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Failed to cancel: ${msg}` }] };
    }
  },
);

// ─── Connect ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`📅  scheduler-relay connected (port=${RELAY_PORT}, chat=${CHAT_ID}, cwd=${CWD ?? "?"})\n`);
