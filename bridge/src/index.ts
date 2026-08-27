import { hostname } from "node:os";
import {
  BRIDGE_ACTION_KINDS,
  isBridgeJob,
  type BridgeInfo,
  type BridgeJob,
  type SendResult,
} from "@absolutejs/commerce-machines/bridge";
import { executeJob, type ExecutorOptions } from "./executors";
import { listPrinters, type Spawner } from "./printers";

export {
  executeAction,
  executeJob,
  osPrint,
  toMachineExports,
} from "./executors";
export type { ExecutorOptions } from "./executors";
export { bunSpawner, listPrinters, powershell } from "./printers";
export type { Spawner, SpawnResult } from "./printers";

export const BRIDGE_VERSION = "0.1.0-beta.0";

export type BridgeLogger = (message: string) => void;

export type RunBridgeOptions = {
  /** Base URL of the app, e.g. https://shop.example — the agent posts to /bridge/poll and /bridge/report. */
  server: string;
  token: string;
  /** Seconds between polls (default 3). */
  intervalSeconds?: number;
  /** Poll once, execute what came back, and return. */
  once?: boolean;
  fetch?: typeof fetch;
  log?: BridgeLogger;
  spawn?: Spawner;
  executor?: ExecutorOptions;
  /** Resolves when the loop should stop (e.g. on SIGINT). */
  signal?: AbortSignal;
  /** Skip printer discovery in the heartbeat. */
  discoverPrinters?: boolean;
};

export type BridgeRunSummary = {
  polls: number;
  executed: number;
  failed: number;
};

const trimSlash = (url: string) => url.replace(/\/+$/, "");

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export const buildInfo = async (
  spawn?: Spawner,
  discoverPrinters = true,
): Promise<BridgeInfo> => ({
  capabilities: [...BRIDGE_ACTION_KINDS],
  hostname: hostname(),
  platform: process.platform,
  printers: discoverPrinters ? await listPrinters(spawn) : undefined,
  version: BRIDGE_VERSION,
});

/** Poll the server, execute the typed jobs it hands back, report each result. */
export const runBridge = async (
  options: RunBridgeOptions,
): Promise<BridgeRunSummary> => {
  const fetchImpl = options.fetch ?? fetch;
  const log =
    options.log ??
    ((message: string) =>
      console.log(`[bridge ${new Date().toISOString()}] ${message}`));
  const base = trimSlash(options.server);
  const baseInterval = Math.max(1, options.intervalSeconds ?? 3) * 1000;
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  };
  const summary: BridgeRunSummary = { executed: 0, failed: 0, polls: 0 };
  let backoff = baseInterval;
  let info = await buildInfo(options.spawn, options.discoverPrinters ?? true);
  let lastPrinterScan = Date.now();
  log(
    `bridge ${BRIDGE_VERSION} on ${info.hostname} (${info.platform}) → ${base}; printers: ${info.printers?.join(", ") || "none found"}`,
  );

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${base}${path}`, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403)
      throw new Error("unauthorized (check --token)");
    if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);

    return response.json();
  };

  const report = async (job: BridgeJob, result: SendResult) => {
    try {
      await post("/bridge/report", {
        jobId: job.id,
        result,
        token: options.token,
      });
    } catch (error) {
      log(
        `report for ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  while (!options.signal?.aborted) {
    if (Date.now() - lastPrinterScan > 60_000) {
      info = await buildInfo(options.spawn, options.discoverPrinters ?? true);
      lastPrinterScan = Date.now();
    }
    let jobs: BridgeJob[] = [];
    try {
      const body = await post("/bridge/poll", { info, token: options.token });
      summary.polls += 1;
      if (typeof body === "object" && body !== null && "error" in body) {
        throw new Error(String((body as { error: unknown }).error));
      }
      const raw =
        typeof body === "object" && body !== null
          ? (body as { jobs?: unknown }).jobs
          : undefined;
      jobs = Array.isArray(raw) ? raw.filter(isBridgeJob) : [];
      if (Array.isArray(raw) && raw.length !== jobs.length) {
        log(`ignored ${raw.length - jobs.length} malformed job(s)`);
      }
      backoff = baseInterval;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `poll failed: ${message}; retrying in ${Math.round(backoff / 1000)} s`,
      );
      if (options.once) return summary;
      await sleep(backoff, options.signal);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    for (const job of jobs) {
      log(
        `job ${job.id} (${job.reference}) → ${job.action.kind}: ${job.files.map((file) => file.filename).join(", ")}`,
      );
      const result = await executeJob(job, {
        spawn: options.spawn,
        ...options.executor,
      });
      if (result.ok) {
        summary.executed += 1;
        log(`job ${job.id} ok: ${result.detail}`);
      } else {
        summary.failed += 1;
        log(`job ${job.id} FAILED: ${result.error}`);
      }
      await report(job, result);
    }
    if (options.once) return summary;
    await sleep(jobs.length > 0 ? 250 : baseInterval, options.signal);
  }

  return summary;
};
