import { hostname } from "node:os";
import {
  BRIDGE_ACTION_KINDS,
  isBridgeJob,
  type BridgeInfo,
  type BridgeJob,
  type SendResult,
} from "@absolutejs/commerce-machines/bridge";
import {
  isTelemetryBinding,
  type MachineRunEvent,
  type TelemetryBinding,
} from "@absolutejs/commerce-machines/telemetry";
import {
  BRIDGE_TELEMETRY_KINDS,
  BRIDGE_VERSION,
  connectBridge,
  type BridgeConnection,
  type BridgeConnectionOptions,
  type BridgeLogger,
} from "./connection";
import { executeJob, type ExecutorOptions } from "./executors";
import { listPrinters, type Spawner } from "./printers";
import {
  createTelemetryHub,
  probeSource,
  type ProbeResult,
  type TelemetryHub,
  type WatcherOptions,
} from "./watchers";

export {
  executeAction,
  executeJob,
  osPrint,
  toMachineExports,
} from "./executors";
export type { ExecutorOptions } from "./executors";
export { bunSpawner, listPrinters, powershell } from "./printers";
export type { Spawner, SpawnResult } from "./printers";
export {
  BRIDGE_TELEMETRY_KINDS,
  BRIDGE_VERSION,
  buildInfo,
  connectBridge,
  toWebSocketUrl,
} from "./connection";
export type {
  BridgeConnection,
  BridgeConnectionOptions,
  BridgeLogger,
} from "./connection";
export {
  createEmitter,
  createTelemetryHub,
  globToRegExp,
  probeSource,
  readJsonPath,
  readingFromWebhook,
  scanReportFolder,
  startWatcher,
  SEEN_SIDECAR,
} from "./watchers";
export type {
  ProbeResult,
  TelemetryHub,
  Watcher,
  WatcherOptions,
} from "./watchers";
export {
  decodeSnmpMessage,
  encodeSnmpGet,
  encodeSnmpInformResponse,
  varbindRecord,
} from "./snmp";
export type { SnmpMessage, SnmpVarbind } from "./snmp";

/** `socket` is the default live transport; `http-poll` is the legacy fallback. */
export type BridgeTransport = "socket" | "http-poll";

export type RunBridgeOptions = {
  /** Base URL of the app, e.g. https://shop.example. */
  server: string;
  token: string;
  /** Default `socket`. Use `http-poll` only where WebSockets are blocked. */
  transport?: BridgeTransport;
  /** WebSocket path of the app's sync socket (default `/sync/ws`). */
  socketPath?: string;
  /** LEGACY http-poll only: seconds between polls (default 3). */
  intervalSeconds?: number;
  /** Run until the first work is done and return (tests, `--once`). */
  once?: boolean;
  fetch?: typeof fetch;
  log?: BridgeLogger;
  spawn?: Spawner;
  executor?: ExecutorOptions;
  /** Resolves when the run should stop (e.g. on SIGINT). */
  signal?: AbortSignal;
  /** Skip printer discovery in the heartbeat. */
  discoverPrinters?: boolean;
  /** Watch the telemetry sources the server sends (default true). */
  telemetry?: boolean;
  telemetryOptions?: Partial<WatcherOptions>;
  webSocketImpl?: typeof WebSocket;
};

export type BridgeRunSummary = {
  /** Always 0 on the socket transport — nothing is polled. */
  polls: number;
  executed: number;
  failed: number;
  events: number;
};

const trimSlash = (url: string) => url.replace(/\/+$/, "");

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export const buildLegacyInfo = async (
  spawn?: Spawner,
  discoverPrinters = true,
  telemetry = true,
): Promise<BridgeInfo> => ({
  capabilities: [...BRIDGE_ACTION_KINDS],
  hostname: hostname(),
  platform: process.platform,
  printers: discoverPrinters ? await listPrinters(spawn) : undefined,
  telemetry: telemetry ? [...BRIDGE_TELEMETRY_KINDS] : undefined,
  version: BRIDGE_VERSION,
});

/**
 * LEGACY FALLBACK: HTTP polling of `/bridge/poll`. Kept for shops whose
 * network blocks WebSockets — every other environment should use the socket
 * (`runBridge` without `transport`), where the app pushes work down and
 * nothing is polled. Telemetry still flows: the sources arrive in the poll
 * response and events are batched to `POST /bridge/telemetry`.
 */
export const runBridgeHttpPoll = async (
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
  const summary: BridgeRunSummary = {
    events: 0,
    executed: 0,
    failed: 0,
    polls: 0,
  };
  let backoff = baseInterval;
  const telemetryOn = options.telemetry ?? true;
  let info = await buildLegacyInfo(
    options.spawn,
    options.discoverPrinters ?? true,
    telemetryOn,
  );
  let lastPrinterScan = Date.now();
  log(
    `bridge ${BRIDGE_VERSION} on ${info.hostname} (${info.platform}) → ${base} (legacy HTTP polling); printers: ${info.printers?.join(", ") || "none found"}`,
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

  const outbox: MachineRunEvent[] = [];
  const hub: TelemetryHub | undefined = telemetryOn
    ? createTelemetryHub({
        log,
        ...options.telemetryOptions,
        emit: (event) => {
          if (outbox.length >= 5000) outbox.shift();
          outbox.push(event);
        },
      })
    : undefined;
  const pushTelemetry = async () => {
    if (outbox.length === 0) return;
    const batch = outbox.splice(0, 500);
    try {
      await post("/bridge/telemetry", { events: batch, token: options.token });
      summary.events += batch.length;
    } catch (error) {
      outbox.unshift(...batch);
      log(`telemetry push failed: ${errorMessage(error)}`);
    }
  };

  const report = async (job: BridgeJob, result: SendResult) => {
    try {
      await post("/bridge/report", {
        jobId: job.id,
        result,
        token: options.token,
      });
    } catch (error) {
      log(`report for ${job.id} failed: ${errorMessage(error)}`);
    }
  };

  while (!options.signal?.aborted) {
    if (Date.now() - lastPrinterScan > 60_000) {
      info = await buildLegacyInfo(
        options.spawn,
        options.discoverPrinters ?? true,
        telemetryOn,
      );
      lastPrinterScan = Date.now();
    }
    let jobs: BridgeJob[] = [];
    try {
      const body = await post("/bridge/poll", { info, token: options.token });
      summary.polls += 1;
      if (typeof body === "object" && body !== null && "error" in body) {
        throw new Error(String((body as { error: unknown }).error));
      }
      const record =
        typeof body === "object" && body !== null
          ? (body as { jobs?: unknown; sources?: unknown })
          : {};
      jobs = Array.isArray(record.jobs) ? record.jobs.filter(isBridgeJob) : [];
      if (Array.isArray(record.jobs) && record.jobs.length !== jobs.length) {
        log(`ignored ${record.jobs.length - jobs.length} malformed job(s)`);
      }
      if (hub && Array.isArray(record.sources)) {
        const bindings: TelemetryBinding[] =
          record.sources.filter(isTelemetryBinding);
        await hub.set(bindings);
      }
      backoff = baseInterval;
    } catch (error) {
      const message = errorMessage(error);
      log(
        `poll failed: ${message}; retrying in ${Math.round(backoff / 1000)} s`,
      );
      if (options.once) {
        await hub?.stop();

        return summary;
      }
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
    await pushTelemetry();
    if (options.once) {
      await hub?.stop();

      return summary;
    }
    await sleep(jobs.length > 0 ? 250 : baseInterval, options.signal);
  }
  await pushTelemetry();
  await hub?.stop();

  return summary;
};

/**
 * Run the bridge. By default it opens ONE persistent socket to the app and
 * waits: jobs are pushed down as they are queued, telemetry sources are pushed
 * down as they change, and results and run events go back up the same
 * connection. Pass `transport: "http-poll"` only for networks that block
 * WebSockets.
 */
export const runBridge = async (
  options: RunBridgeOptions,
): Promise<BridgeRunSummary> => {
  if (options.transport === "http-poll") return runBridgeHttpPoll(options);
  const connectionOptions: BridgeConnectionOptions = {
    server: options.server,
    token: options.token,
    ...(options.socketPath === undefined
      ? {}
      : { socketPath: options.socketPath }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.discoverPrinters === undefined
      ? {}
      : { discoverPrinters: options.discoverPrinters }),
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
    ...(options.telemetryOptions === undefined
      ? {}
      : { telemetryOptions: options.telemetryOptions }),
    ...(options.webSocketImpl === undefined
      ? {}
      : { webSocketImpl: options.webSocketImpl }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const connection: BridgeConnection = await connectBridge(connectionOptions);
  if (options.once) {
    await connection.ready;
    await connection.settled();
    connection.close();

    return { ...connection.counters(), polls: 0 };
  }
  await new Promise<void>((resolve) => {
    if (options.signal?.aborted) {
      resolve();

      return;
    }
    options.signal?.addEventListener("abort", () => resolve());
  });
  connection.close();

  return { ...connection.counters(), polls: 0 };
};

/** One-shot reading for setup — the only place a machine is ever queried. */
export const probeTelemetry = (
  ...args: Parameters<typeof probeSource>
): Promise<ProbeResult> => probeSource(...args);
