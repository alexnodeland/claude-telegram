import { RELAY_PROMPT_TIMEOUT_MS } from "./config.js";
import type { ScheduleManager } from "./scheduler.js";
import type { RelayPromptRequest, RelayPromptResponse } from "./types.js";

interface PendingPrompt {
  resolve: (response: RelayPromptResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  request: RelayPromptRequest;
}

export interface RelayServer {
  port: number;
  /** Resolve a pending permission prompt (called when user responds via Telegram). */
  resolvePrompt: (chatId: number, response: RelayPromptResponse) => boolean;
  /** Check if a permission prompt is pending for a chat. */
  hasPending: (chatId: number) => boolean;
  /** Get the pending request details (for display). */
  getPending: (chatId: number) => RelayPromptRequest | undefined;
  shutdown: () => void;
}

/**
 * Start a local HTTP server that the sidecar MCP permission-relay.ts POSTs to.
 * Holds the HTTP connection open until the user responds via Telegram.
 *
 * @param onPrompt — called when a new permission prompt arrives; use this to
 *                   send the Telegram message with inline keyboard buttons.
 */
export async function startRelayServer(
  onPrompt?: (request: RelayPromptRequest) => Promise<void>,
  scheduler?: ScheduleManager,
): Promise<RelayServer> {
  const pending = new Map<number, PendingPrompt>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/relay/prompt") {
        let body: RelayPromptRequest;
        try {
          body = (await req.json()) as RelayPromptRequest;
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }

        const { chatId } = body;

        // If there's already a pending prompt for this chat, auto-deny the new one
        if (pending.has(chatId)) {
          return Response.json({
            behavior: "deny",
            message: "Another permission prompt is already pending",
          } satisfies RelayPromptResponse);
        }

        // Create a promise that will be resolved when the user responds
        const responsePromise = new Promise<RelayPromptResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(chatId);
            resolve({
              behavior: "deny",
              message: "Permission prompt timed out (2 minutes)",
            });
          }, RELAY_PROMPT_TIMEOUT_MS);

          pending.set(chatId, { resolve, reject, timer, request: body });
        });

        // Notify the orchestrator to send the Telegram message with buttons
        // (fires after pending entry is stored so hasPending() returns true)
        onPrompt?.(body).catch((e) => process.stderr.write(`⚠️  onPrompt error: ${e}\n`));

        const response = await responsePromise;
        return Response.json(response);
      }

      // ─── Schedule endpoints (for scheduler-relay sidecar) ──────────────

      if (req.method === "POST" && url.pathname === "/relay/schedule") {
        if (!scheduler) return Response.json({ error: "scheduler not configured" }, { status: 501 });
        try {
          const body = (await req.json()) as {
            chatId: number;
            cwd: string;
            cronExpr: string;
            prompt: string;
            name?: string;
            recurring?: boolean;
          };
          const job = scheduler.create(body.chatId, body.cwd, body.cronExpr, body.prompt, {
            name: body.name,
            recurring: body.recurring ?? true,
          });
          await scheduler.save();
          return Response.json({ ok: true, job });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
        }
      }

      if (req.method === "GET" && url.pathname === "/relay/schedules") {
        if (!scheduler) return Response.json({ error: "scheduler not configured" }, { status: 501 });
        const chatId = Number(url.searchParams.get("chatId"));
        const jobs = chatId ? scheduler.list(chatId) : scheduler.list();
        return Response.json({ ok: true, jobs });
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/relay/schedule/")) {
        if (!scheduler) return Response.json({ error: "scheduler not configured" }, { status: 501 });
        const id = url.pathname.split("/").pop() ?? "";
        const deleted = scheduler.delete(id);
        if (deleted) await scheduler.save();
        return Response.json({ ok: true, deleted });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const port = server.port ?? 0;
  process.stderr.write(`🔌  Relay server on 127.0.0.1:${port}\n`);

  return {
    port,

    resolvePrompt(chatId: number, response: RelayPromptResponse): boolean {
      const entry = pending.get(chatId);
      if (!entry) return false;
      clearTimeout(entry.timer);
      pending.delete(chatId);
      entry.resolve(response);
      return true;
    },

    hasPending(chatId: number): boolean {
      return pending.has(chatId);
    },

    getPending(chatId: number): RelayPromptRequest | undefined {
      return pending.get(chatId)?.request;
    },

    shutdown() {
      for (const [chatId, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ behavior: "deny", message: "Server shutting down" });
        pending.delete(chatId);
      }
      server.stop();
    },
  };
}
