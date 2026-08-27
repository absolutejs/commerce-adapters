/* Bridge protocol: a cloud-hosted app queues typed jobs and a small agent on
 * the shop LAN executes a fixed set of actions and reports back.
 *
 * The default transport is a persistent socket — see `./bridgeSync`, which is
 * re-exported here: the server pushes jobs and telemetry sources down and the
 * agent pushes results and run events up, with nothing polled on either side.
 *
 * The `createBridgeHandlers` poll/report/telemetry routes below are the
 * LEGACY FALLBACK, kept for shops behind proxies that block WebSockets. They
 * are framework-agnostic (mount them on any three HTTP routes) and every
 * telemetry field is optional, so an older agent keeps working unchanged.
 */

import type {
  MachineRunEvent,
  TelemetryBinding,
  TelemetryKind,
} from "./telemetry";
import { isMachineRunEvent } from "./telemetry";

export type BridgeAction =
  | { kind: "folder"; path: string }
  | { kind: "raw-tcp"; host: string; port?: number }
  | { kind: "ipp"; url: string; username?: string; password?: string }
  | { kind: "os-print"; printer: string };

export type BridgeActionKind = BridgeAction["kind"];

export const BRIDGE_ACTION_KINDS: BridgeActionKind[] = [
  "folder",
  "raw-tcp",
  "ipp",
  "os-print",
];

export type SendResult =
  { ok: true; detail: string; jobId?: string } | { ok: false; error: string };

export type BridgeFile = {
  filename: string;
  mime: string;
  bytesBase64: string;
};

export type BridgeJobStatus = "queued" | "claimed" | "done" | "failed";

export type BridgeJob = {
  id: string;
  bridgeId: string;
  reference: string;
  action: BridgeAction;
  files: BridgeFile[];
  createdAt: string;
  status: BridgeJobStatus;
  result?: SendResult;
  claimedAt?: string;
  finishedAt?: string;
};

export type BridgeInfo = {
  version: string;
  platform: string;
  hostname: string;
  capabilities: BridgeActionKind[];
  printers?: string[];
  /** Telemetry paths this agent can watch (absent on pre-0.2 agents). */
  telemetry?: TelemetryKind[];
};

export type BridgeStatus = {
  online: boolean;
  lastSeen?: string;
  info?: BridgeInfo;
};

export type BridgeStore = {
  enqueue: (
    job: Omit<BridgeJob, "id" | "createdAt" | "status"> & {
      id?: string;
    },
  ) => Promise<BridgeJob>;
  claim: (bridgeId: string, max: number) => Promise<BridgeJob[]>;
  complete: (jobId: string, result: SendResult) => Promise<void>;
  heartbeat: (bridgeId: string, info: BridgeInfo) => Promise<void>;
  status: (bridgeId: string) => Promise<BridgeStatus>;
  list?: (bridgeId: string, limit: number) => Promise<BridgeJob[]>;
  /** Jobs still owed to a bridge — what a reconnecting socket hydrates with. */
  pending?: (bridgeId: string) => Promise<BridgeJob[]>;
  /** Telemetry sources this bridge should watch, per machine. */
  readings?: (bridgeId: string) => Promise<TelemetryBinding[]>;
  /** Store run events the agent reported. */
  record?: (bridgeId: string, events: MachineRunEvent[]) => Promise<void>;
  /** Most recent stored run events (newest first) — mirrors `list`. */
  records?: (bridgeId: string, limit: number) => Promise<MachineRunEvent[]>;
};

export type MemoryBridgeStoreOptions = {
  /** A bridge is "online" when it polled within this window (default 15 s). */
  onlineWindowMs?: number;
  /** Claimed jobs the agent never reported on go back to `queued` after this (default 5 min). */
  claimTimeoutMs?: number;
  now?: () => Date;
  /** Telemetry sources per bridge id, for `readings`. */
  sources?: Record<string, TelemetryBinding[]>;
  /** Run events kept per bridge (default 1000). */
  maxEvents?: number;
};

const isBridgeAction = (value: unknown): value is BridgeAction => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "folder":
      return typeof record.path === "string";
    case "raw-tcp":
      return (
        typeof record.host === "string" &&
        (record.port === undefined || typeof record.port === "number")
      );
    case "ipp":
      return typeof record.url === "string";
    case "os-print":
      return typeof record.printer === "string";
    default:
      return false;
  }
};

/** Type guard for jobs that arrive over the wire at the agent. */
export const isBridgeJob = (value: unknown): value is BridgeJob => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    typeof record.bridgeId === "string" &&
    typeof record.reference === "string" &&
    isBridgeAction(record.action) &&
    Array.isArray(record.files) &&
    record.files.every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        typeof (file as Record<string, unknown>).filename === "string" &&
        typeof (file as Record<string, unknown>).mime === "string" &&
        typeof (file as Record<string, unknown>).bytesBase64 === "string",
    )
  );
};

/** Type guard for results reported back by the agent. */
export const isSendResult = (value: unknown): value is SendResult => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return typeof record.detail === "string";
  if (record.ok === false) return typeof record.error === "string";

  return false;
};

/** In-memory store — fine for a single server process; back it with a table for anything else. */
export const createMemoryBridgeStore = (
  options: MemoryBridgeStoreOptions = {},
): BridgeStore => {
  const onlineWindowMs = options.onlineWindowMs ?? 15_000;
  const claimTimeoutMs = options.claimTimeoutMs ?? 5 * 60_000;
  const now = options.now ?? (() => new Date());
  const jobs = new Map<string, BridgeJob>();
  const seen = new Map<string, { at: Date; info: BridgeInfo }>();
  const sources = options.sources ?? {};
  const maxEvents = options.maxEvents ?? 1000;
  const events = new Map<string, MachineRunEvent[]>();

  const requeueStale = () => {
    const cutoff = now().getTime() - claimTimeoutMs;
    for (const job of jobs.values()) {
      if (
        job.status === "claimed" &&
        job.claimedAt !== undefined &&
        Date.parse(job.claimedAt) < cutoff
      ) {
        job.status = "queued";
        delete job.claimedAt;
      }
    }
  };

  return {
    claim: async (bridgeId, max) => {
      requeueStale();
      const claimed: BridgeJob[] = [];
      const queued = [...jobs.values()]
        .filter((job) => job.bridgeId === bridgeId && job.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const job of queued.slice(0, Math.max(0, max))) {
        job.status = "claimed";
        job.claimedAt = now().toISOString();
        claimed.push(structuredClone(job));
      }

      return claimed;
    },
    complete: async (jobId, result) => {
      const job = jobs.get(jobId);
      if (!job) return;
      job.status = result.ok ? "done" : "failed";
      job.result = result;
      job.finishedAt = now().toISOString();
    },
    enqueue: async (input) => {
      const job: BridgeJob = {
        action: input.action,
        bridgeId: input.bridgeId,
        createdAt: now().toISOString(),
        files: input.files,
        id: input.id ?? crypto.randomUUID(),
        reference: input.reference,
        status: "queued",
      };
      jobs.set(job.id, job);

      return structuredClone(job);
    },
    heartbeat: async (bridgeId, info) => {
      seen.set(bridgeId, { at: now(), info });
    },
    pending: async (bridgeId) =>
      [...jobs.values()]
        .filter(
          (job) =>
            job.bridgeId === bridgeId &&
            (job.status === "queued" || job.status === "claimed"),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((job) => structuredClone(job)),
    readings: async (bridgeId) => [...(sources[bridgeId] ?? [])],
    record: async (bridgeId, incoming) => {
      const kept = [...(events.get(bridgeId) ?? []), ...incoming];
      events.set(bridgeId, kept.slice(-maxEvents));
    },
    records: async (bridgeId, limit) =>
      [...(events.get(bridgeId) ?? [])].reverse().slice(0, Math.max(0, limit)),
    list: async (bridgeId, limit) =>
      [...jobs.values()]
        .filter((job) => job.bridgeId === bridgeId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, Math.max(0, limit))
        .map((job) => structuredClone(job)),
    status: async (bridgeId) => {
      const entry = seen.get(bridgeId);
      if (!entry) return { online: false };

      return {
        info: entry.info,
        lastSeen: entry.at.toISOString(),
        online: now().getTime() - entry.at.getTime() <= onlineWindowMs,
      };
    },
  };
};

export type BridgeHandlerOptions = {
  /** Map a bearer token to the bridge it belongs to, or null to reject. */
  authenticate: (token: string) => Promise<{ bridgeId: string } | null>;
  /** Jobs handed out per poll (default 5). */
  maxJobsPerPoll?: number;
};

export type BridgePollRequest = { token: string; info?: BridgeInfo };
export type BridgePollResponse =
  | { jobs: BridgeJob[]; sources?: TelemetryBinding[] }
  | { error: "unauthorized" };
export type BridgeReportRequest = {
  token: string;
  jobId: string;
  result: SendResult;
};
export type BridgeReportResponse =
  { ok: true } | { error: "unauthorized" | "invalid-result" | "unknown-job" };

export type BridgeTelemetryRequest = {
  token: string;
  events: MachineRunEvent[];
};
export type BridgeTelemetryResponse =
  | { ok: true; recorded: number }
  | { error: "unauthorized" | "invalid-events" | "not-supported" };

export type BridgeHandlers = {
  poll: (request: BridgePollRequest) => Promise<BridgePollResponse>;
  report: (request: BridgeReportRequest) => Promise<BridgeReportResponse>;
  telemetry: (
    request: BridgeTelemetryRequest,
  ) => Promise<BridgeTelemetryResponse>;
};

/**
 * LEGACY FALLBACK transport. Mount `poll` on POST /bridge/poll, `report` on
 * POST /bridge/report and `telemetry` on POST /bridge/telemetry for shops
 * whose network blocks WebSockets. The default path is the socket
 * (`createBridgeSync`); these handlers stay supported and unchanged in
 * behaviour, with the telemetry source list added to the poll response so a
 * fallback agent needs no extra round-trip.
 */
export const createBridgeHandlers = (
  store: BridgeStore,
  options: BridgeHandlerOptions,
): BridgeHandlers => {
  const maxJobs = options.maxJobsPerPoll ?? 5;

  return {
    poll: async ({ token, info }) => {
      const auth = await options.authenticate(token);
      if (!auth) return { error: "unauthorized" };
      if (info) await store.heartbeat(auth.bridgeId, info);
      const jobs = await store.claim(auth.bridgeId, maxJobs);
      const sources = store.readings
        ? await store.readings(auth.bridgeId)
        : undefined;

      return sources === undefined ? { jobs } : { jobs, sources };
    },
    report: async ({ token, jobId, result }) => {
      const auth = await options.authenticate(token);
      if (!auth) return { error: "unauthorized" };
      if (!isSendResult(result)) return { error: "invalid-result" };
      if (store.list) {
        const known = (
          await store.list(auth.bridgeId, Number.MAX_SAFE_INTEGER)
        ).some((job) => job.id === jobId);
        if (!known) return { error: "unknown-job" };
      }
      await store.complete(jobId, result);

      return { ok: true };
    },
    telemetry: async ({ token, events }) => {
      const auth = await options.authenticate(token);
      if (!auth) return { error: "unauthorized" };
      if (!Array.isArray(events)) return { error: "invalid-events" };
      const valid = events.filter(isMachineRunEvent);
      if (events.length > 0 && valid.length === 0) {
        return { error: "invalid-events" };
      }
      if (!store.record) return { error: "not-supported" };
      await store.record(auth.bridgeId, valid);

      return { ok: true, recorded: valid.length };
    },
  };
};

export * from "./bridgeSync";

export const bytesToBase64 = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64");

export const base64ToBytes = (value: string) =>
  new Uint8Array(Buffer.from(value, "base64"));
