/* Bridge protocol: a cloud-hosted app queues typed jobs, a small agent on the
 * shop LAN polls for them, executes a fixed set of actions and reports back.
 * Framework-agnostic — apps mount the handlers on any two HTTP routes. */

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
};

export type MemoryBridgeStoreOptions = {
  /** A bridge is "online" when it polled within this window (default 15 s). */
  onlineWindowMs?: number;
  /** Claimed jobs the agent never reported on go back to `queued` after this (default 5 min). */
  claimTimeoutMs?: number;
  now?: () => Date;
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
  { jobs: BridgeJob[] } | { error: "unauthorized" };
export type BridgeReportRequest = {
  token: string;
  jobId: string;
  result: SendResult;
};
export type BridgeReportResponse =
  { ok: true } | { error: "unauthorized" | "invalid-result" | "unknown-job" };

export type BridgeHandlers = {
  poll: (request: BridgePollRequest) => Promise<BridgePollResponse>;
  report: (request: BridgeReportRequest) => Promise<BridgeReportResponse>;
};

/** Framework-agnostic handlers: mount `poll` on POST /bridge/poll and `report` on POST /bridge/report. */
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

      return { jobs };
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
  };
};

export const bytesToBase64 = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64");

export const base64ToBytes = (value: string) =>
  new Uint8Array(Buffer.from(value, "base64"));
