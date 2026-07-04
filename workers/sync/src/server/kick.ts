/**
 * kick.ts — minimal HTTP server for the worker.
 *
 *   POST /kick   { runId }   Authorization: Bearer <SYNC_KICK_SECRET>
 *       Starts the run workflow in the background (DBOS.startWorkflow) with the
 *       runId as the workflow ID (idempotency key — a duplicate kick for the same
 *       runId is a no-op). Returns 202 immediately; the work continues durably.
 *   GET  /health              → 200 { ok: true }
 *
 * Fly.io auto-start wakes the machine on the inbound /kick request; auto-stop lets
 * it scale to zero when idle (see fly.toml). If a kick is lost (machine asleep, no
 * wake), the queued run still gets picked up by DBOS recovery on the next start.
 *
 * Uses the Node stdlib http server (no framework) — the worker's only HTTP surface.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DBOS } from "../dbos.js";
import { runSyncWorkflow } from "../workflows/runSync.js";

export interface KickServerOptions {
  port?: number;
  kickSecret?: string;
}

export function startKickServer(opts: KickServerOptions = {}): ReturnType<typeof createServer> {
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const kickSecret = opts.kickSecret ?? process.env.SYNC_KICK_SECRET;

  const server = createServer((req, res) => {
    handle(req, res, kickSecret).catch((err) => {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    });
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[kick] listening on :${port}`);
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  kickSecret: string | undefined
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && (url === "/health" || url === "/")) {
    sendJson(res, 200, { ok: true, service: "blackwood-sync", ts: new Date().toISOString() });
    return;
  }

  if (method === "POST" && url === "/kick") {
    // Auth: constant-time-ish bearer check.
    if (!kickSecret) {
      sendJson(res, 500, { ok: false, error: "SYNC_KICK_SECRET not configured" });
      return;
    }
    const auth = req.headers["authorization"] ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeEqual(token, kickSecret)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const body = await readBody(req);
    let runId: string | undefined;
    let dryRun = false;
    try {
      const parsed = JSON.parse(body || "{}");
      runId = parsed.runId;
      dryRun = parsed.dryRun === true;
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid JSON body" });
      return;
    }
    if (!runId || typeof runId !== "string") {
      sendJson(res, 400, { ok: false, error: "runId (string) required" });
      return;
    }

    // Start the run workflow in the background. The runId is the workflow ID, so a
    // duplicate kick for the same runId is idempotent (DBOS dedups on workflowID).
    // `dryRun` (classify-only) threads through to every report.
    await DBOS.startWorkflow(runSyncWorkflow, { workflowID: `run:${runId}` })({ runId, dryRun });
    sendJson(res, 202, { ok: true, runId, dryRun, status: "started" });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** Length-safe constant-time-ish string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
