/* The agent's link to the app: ONE persistent socket, held open by
 * `@absolutejs/sync`. The server pushes jobs and telemetry sources down it;
 * the agent pushes results and run events back up the same connection. There
 * is no poll loop — a dropped connection is reopened with backoff, which is
 * the client's own reconnect, not a schedule. */

import { hostname } from "node:os";
import { createSyncClient, type SyncClient } from "@absolutejs/sync/client";
import {
  BRIDGE_HEARTBEAT_MUTATION,
  BRIDGE_JOBS_COLLECTION,
  BRIDGE_REPORT_MUTATION,
  BRIDGE_SOURCES_COLLECTION,
  BRIDGE_TELEMETRY_MUTATION,
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
  type TelemetryKind,
} from "@absolutejs/commerce-machines/telemetry";
import { executeJob, type ExecutorOptions } from "./executors";
import { listPrinters, type Spawner } from "./printers";
import {
  createTelemetryHub,
  type TelemetryHub,
  type WatcherOptions,
} from "./watchers";

export const BRIDGE_VERSION = "0.2.0-beta.0";

/** Telemetry paths this agent can actually watch (`manual` needs no agent). */
export const BRIDGE_TELEMETRY_KINDS: TelemetryKind[] = [
  "report-folder",
  "raw-tcp-status",
  "http-status",
  "snmp-printer",
];

export type BridgeLogger = (message: string) => void;

export type BridgeConnectionOptions = {
  /** App base URL, e.g. https://shop.example (http/https or ws/wss). */
  server: string;
  token: string;
  /** WebSocket path of the app's `syncSocket` (default `/sync/ws`). */
  socketPath?: string;
  log?: BridgeLogger;
  spawn?: Spawner;
  executor?: ExecutorOptions;
  /** Skip printer discovery in the connect message. */
  discoverPrinters?: boolean;
  /** Watch telemetry sources the server sends (default true). */
  telemetry?: boolean;
  telemetryOptions?: Partial<WatcherOptions>;
  /** Coalescing window before run events are pushed up (ms, default 1000). */
  telemetryBatchMs?: number;
  webSocketImpl?: typeof WebSocket;
  /** Stop the connection. */
  signal?: AbortSignal;
};

export type BridgeConnection = {
  client: SyncClient;
  hub?: TelemetryHub;
  /** Jobs executed and failed since connecting. */
  counters: () => { executed: number; failed: number; events: number };
  close: () => void;
  /** Resolves once the first snapshot of both collections has arrived. */
  ready: Promise<void>;
  /** Resolves when queued jobs have run and pending events have been pushed. */
  settled: () => Promise<void>;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const toWebSocketUrl = (server: string, path = "/sync/ws") => {
  const base = server.replace(/\/+$/, "");
  const url = /^wss?:\/\//i.test(base)
    ? base
    : base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");

  return `${url}${path.startsWith("/") ? path : `/${path}`}`;
};

export const buildInfo = async (
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
 * Open the live connection. Jobs arrive as collection diffs the moment the app
 * queues them; telemetry sources arrive the same way and re-configure the
 * watchers in place.
 */
export const connectBridge = async (
  options: BridgeConnectionOptions,
): Promise<BridgeConnection> => {
  const log =
    options.log ??
    ((message: string) =>
      console.log(`[bridge ${new Date().toISOString()}] ${message}`));
  const telemetryOn = options.telemetry ?? true;
  const batchMs = options.telemetryBatchMs ?? 1000;
  const counters = { events: 0, executed: 0, failed: 0 };
  const client = createSyncClient({
    onError: (message) => log(`sync error: ${String(message)}`),
    socketTicket: async () => options.token,
    url: toWebSocketUrl(options.server, options.socketPath),
    ...(options.webSocketImpl ? { webSocketImpl: options.webSocketImpl } : {}),
  });

  /* One handle per collection; `mutate` on either travels over the same
   * socket, so the jobs handle carries the report, telemetry and heartbeat
   * mutations too. */
  const jobs = client.collection<BridgeJob>({
    collection: BRIDGE_JOBS_COLLECTION,
  });
  const sources = client.collection<TelemetryBinding>({
    collection: BRIDGE_SOURCES_COLLECTION,
    key: (binding) => binding.machineId,
  });

  // ---- telemetry: watchers push events, we push them up in small batches ---
  const outbox: MachineRunEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let backoff = batchMs;
  const flush = async () => {
    if (flushing || outbox.length === 0) return;
    flushing = true;
    const batch = outbox.splice(0, 500);
    try {
      await jobs.mutate({
        args: { events: batch },
        name: BRIDGE_TELEMETRY_MUTATION,
      });
      counters.events += batch.length;
      backoff = batchMs;
    } catch (error) {
      // Keep the events and try again later; the socket may be reconnecting.
      outbox.unshift(...batch);
      backoff = Math.min(backoff * 2, 60_000);
      log(`telemetry push failed: ${errorMessage(error)}`);
    } finally {
      flushing = false;
      if (outbox.length > 0) schedule(backoff);
    }
  };
  const schedule = (delay: number) => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, delay);
    flushTimer.unref?.();
  };
  const hub = telemetryOn
    ? createTelemetryHub({
        log,
        ...options.telemetryOptions,
        emit: (event) => {
          if (outbox.length >= 5000) {
            outbox.shift();
            log("telemetry outbox full; dropped the oldest event");
          }
          outbox.push(event);
          schedule(batchMs);
        },
      })
    : undefined;

  // ---- jobs: execute each new one exactly once ----------------------------
  const handled = new Set<string>();
  let draining = false;
  let chain: Promise<void> = Promise.resolve();
  let hubChain: Promise<void> = Promise.resolve();
  const queue: BridgeJob[] = [];
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) break;
        log(
          `job ${job.id} (${job.reference}) → ${job.action.kind}: ${job.files
            .map((file) => file.filename)
            .join(", ")}`,
        );
        const result: SendResult = await executeJob(job, {
          spawn: options.spawn,
          ...options.executor,
        });
        if (result.ok) {
          counters.executed += 1;
          log(`job ${job.id} ok: ${result.detail}`);
        } else {
          counters.failed += 1;
          log(`job ${job.id} FAILED: ${result.error}`);
        }
        try {
          await jobs.mutate({
            args: { jobId: job.id, result },
            name: BRIDGE_REPORT_MUTATION,
          });
        } catch (error) {
          handled.delete(job.id); // let a later snapshot hand it back
          log(`report for ${job.id} failed: ${errorMessage(error)}`);
        }
      }
    } finally {
      draining = false;
    }
  };
  const kick = () => {
    chain = chain.then(drain).catch((error: unknown) => {
      log(`job run failed: ${errorMessage(error)}`);
    });
  };

  let resolveReady = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let sawJobs = false;
  let sawSources = !telemetryOn;
  const markReady = () => {
    if (sawJobs && sawSources) resolveReady();
  };

  jobs.subscribe((state) => {
    // `ready` means the server's first snapshot landed, not the empty seed.
    if (state.status === "ready") sawJobs = true;
    markReady();
    for (const row of state.data) {
      if (!isBridgeJob(row) || handled.has(row.id)) continue;
      handled.add(row.id);
      queue.push(row);
    }
    kick();
  });

  sources.subscribe((state) => {
    if (state.status === "ready") sawSources = true;
    markReady();
    if (!hub) return;
    const bindings = state.data.filter(isTelemetryBinding);
    if (bindings.length !== state.data.length) {
      log(`ignored ${state.data.length - bindings.length} malformed source(s)`);
    }
    hubChain = hubChain
      .then(() => hub.set(bindings))
      .catch((error: unknown) => {
        log(`telemetry setup failed: ${errorMessage(error)}`);
      });
  });

  // One heartbeat per connection: with a live socket, presence IS the socket.
  const info = await buildInfo(
    options.spawn,
    options.discoverPrinters ?? true,
    telemetryOn,
  );
  const sendHeartbeat = () => {
    jobs
      .mutate({ args: { info }, name: BRIDGE_HEARTBEAT_MUTATION })
      .catch((error: unknown) => log(`heartbeat: ${errorMessage(error)}`));
  };
  let connected = false;
  const unsubscribeStatus = client.subscribeStatus((status) => {
    if (status.connection === "online" && !connected) {
      connected = true;
      sendHeartbeat();
      if (outbox.length > 0) schedule(0);
    } else if (status.connection !== "online") {
      connected = false;
    }
  });
  log(
    `bridge ${BRIDGE_VERSION} on ${info.hostname} (${info.platform}) → ${toWebSocketUrl(options.server, options.socketPath)}; printers: ${info.printers?.join(", ") || "none found"}; telemetry: ${telemetryOn ? BRIDGE_TELEMETRY_KINDS.join(", ") : "off"}`,
  );

  const close = () => {
    unsubscribeStatus();
    if (flushTimer) clearTimeout(flushTimer);
    void hub?.stop();
    jobs.close();
    sources.close();
    client.close();
  };
  options.signal?.addEventListener("abort", close);

  return {
    client,
    close,
    counters: () => ({ ...counters }),
    hub,
    ready,
    settled: async () => {
      await hubChain;
      await chain;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      await flush();
    },
  };
};
