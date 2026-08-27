/* Live bridge transport: one persistent socket per shop agent.
 *
 * The app runs an `@absolutejs/sync` engine; this module is the wiring that
 * turns a `BridgeStore` into two live collections and three mutations. The
 * server PUSHES jobs and telemetry-source changes down the socket the moment
 * they change, and the agent pushes results and run events back up the same
 * connection. Nothing polls.
 *
 * The definitions are structurally typed against `@absolutejs/sync`'s
 * `defineCollection` / `defineMutation` shapes so this package keeps zero
 * dependencies — pass them straight to `engine.registerCollection` /
 * `engine.registerMutation`. */

import {
  isSendResult,
  type BridgeInfo,
  type BridgeJob,
  type BridgeStore,
  type SendResult,
} from "./bridge";
import {
  isMachineRunEvent,
  type MachineRunEvent,
  type TelemetryBinding,
} from "./telemetry";

/** Collection of jobs waiting for one bridge. Rows leave it when reported. */
export const BRIDGE_JOBS_COLLECTION = "bridgeJobs";
/** Collection of telemetry sources the bridge should watch. */
export const BRIDGE_SOURCES_COLLECTION = "bridgeTelemetrySources";
export const BRIDGE_REPORT_MUTATION = "bridge.report";
export const BRIDGE_TELEMETRY_MUTATION = "bridge.telemetry";
export const BRIDGE_HEARTBEAT_MUTATION = "bridge.heartbeat";

/** The per-bridge topic name, for logs and cluster routing. */
export const bridgeTopic = (bridgeId: string) => `bridge:${bridgeId}`;

/** Connection context resolved from the bridge token by `authenticate`. */
export type BridgeSyncContext = { bridgeId: string };

// ---- structural mirrors of the sync engine's registration shapes ----------

export type BridgeRowChange<T> = {
  op: "insert" | "update" | "delete";
  row: T;
};

/** `engine.applyChange` / `actions.change`, structurally. */
export type BridgeChangeEmitter = <T>(
  table: string,
  change: BridgeRowChange<T>,
) => void | Promise<void>;

export type BridgeCollectionDefinition<T> = {
  name: string;
  tables?: string[];
  key?: (row: T) => string;
  hydrate: (params: unknown, ctx: BridgeSyncContext) => Promise<T[]>;
  match?: (row: T, params: unknown, ctx: BridgeSyncContext) => boolean;
  authorize?: (params: unknown, ctx: BridgeSyncContext) => boolean;
};

export type BridgeMutationActions = {
  change: <T>(
    collection: string,
    change: BridgeRowChange<T>,
  ) => void | Promise<void>;
};

export type BridgeMutationDefinition<Args, Result> = {
  name: string;
  authorize?: (args: Args, ctx: BridgeSyncContext) => boolean;
  handler: (
    args: Args,
    ctx: BridgeSyncContext,
    actions: BridgeMutationActions,
  ) => Promise<Result>;
};

export type BridgeReportArgs = { jobId: string; result: SendResult };
export type BridgeTelemetryArgs = { events: MachineRunEvent[] };
export type BridgeHeartbeatArgs = { info: BridgeInfo };

export type BridgeSyncOptions = {
  /** Map a bridge token (sent as the socket's first frame) to its bridge. */
  authenticate: (token: string) => Promise<{ bridgeId: string } | null>;
  /** Events accepted per telemetry mutation (default 500). */
  maxEventsPerCall?: number;
};

export type BridgeSync = {
  /** Pass to `syncSocket({ authenticate })`; throws on an unknown token. */
  authenticate: (token: string) => Promise<BridgeSyncContext>;
  jobs: BridgeCollectionDefinition<BridgeJob>;
  sources: BridgeCollectionDefinition<TelemetryBinding>;
  report: BridgeMutationDefinition<BridgeReportArgs, SendResult | { ok: true }>;
  telemetry: BridgeMutationDefinition<
    BridgeTelemetryArgs,
    { recorded: number }
  >;
  heartbeat: BridgeMutationDefinition<BridgeHeartbeatArgs, { ok: true }>;
  collections: [
    BridgeCollectionDefinition<BridgeJob>,
    BridgeCollectionDefinition<TelemetryBinding>,
  ];
  mutations: [
    BridgeMutationDefinition<BridgeReportArgs, SendResult | { ok: true }>,
    BridgeMutationDefinition<BridgeTelemetryArgs, { recorded: number }>,
    BridgeMutationDefinition<BridgeHeartbeatArgs, { ok: true }>,
  ];
};

const isOpen = (job: BridgeJob) =>
  job.status === "queued" || job.status === "claimed";

const pendingJobs = async (
  store: BridgeStore,
  bridgeId: string,
): Promise<BridgeJob[]> => {
  if (store.pending) return store.pending(bridgeId);
  if (store.list) {
    return (await store.list(bridgeId, Number.MAX_SAFE_INTEGER)).filter(isOpen);
  }

  return store.claim(bridgeId, 50);
};

/**
 * Server half of the live bridge: two collections the agent subscribes to and
 * three mutations it calls. Register them on your sync engine and mount the
 * socket; jobs reach the agent as `insert` diffs the instant they are queued.
 */
export const createBridgeSync = (
  store: BridgeStore,
  options: BridgeSyncOptions,
): BridgeSync => {
  const maxEvents = options.maxEventsPerCall ?? 500;
  const scoped = (ctx: BridgeSyncContext) =>
    typeof ctx?.bridgeId === "string" && ctx.bridgeId.length > 0;

  const jobs: BridgeCollectionDefinition<BridgeJob> = {
    authorize: (_params, ctx) => scoped(ctx),
    hydrate: (_params, ctx) => pendingJobs(store, ctx.bridgeId),
    key: (job) => job.id,
    match: (job, _params, ctx) => job.bridgeId === ctx.bridgeId && isOpen(job),
    name: BRIDGE_JOBS_COLLECTION,
    tables: [BRIDGE_JOBS_COLLECTION],
  };

  const sources: BridgeCollectionDefinition<TelemetryBinding> = {
    authorize: (_params, ctx) => scoped(ctx),
    hydrate: async (_params, ctx) =>
      store.readings ? store.readings(ctx.bridgeId) : [],
    key: (binding) => binding.machineId,
    name: BRIDGE_SOURCES_COLLECTION,
    tables: [BRIDGE_SOURCES_COLLECTION],
  };

  const report: BridgeMutationDefinition<
    BridgeReportArgs,
    SendResult | { ok: true }
  > = {
    authorize: (_args, ctx) => scoped(ctx),
    handler: async ({ jobId, result }, ctx, actions) => {
      if (typeof jobId !== "string" || !isSendResult(result)) {
        throw new Error("invalid-result");
      }
      if (store.list) {
        const known = (
          await store.list(ctx.bridgeId, Number.MAX_SAFE_INTEGER)
        ).some((job) => job.id === jobId);
        if (!known) throw new Error("unknown-job");
      }
      await store.complete(jobId, result);
      // The job leaves every subscriber's set; the agent stops seeing it.
      await actions.change(BRIDGE_JOBS_COLLECTION, {
        op: "delete",
        row: { id: jobId },
      });

      return { ok: true };
    },
    name: BRIDGE_REPORT_MUTATION,
  };

  const telemetry: BridgeMutationDefinition<
    BridgeTelemetryArgs,
    { recorded: number }
  > = {
    authorize: (_args, ctx) => scoped(ctx),
    handler: async ({ events }, ctx) => {
      if (!Array.isArray(events)) throw new Error("invalid-events");
      const valid = events.filter(isMachineRunEvent).slice(0, maxEvents);
      if (valid.length === 0) return { recorded: 0 };
      if (!store.record) throw new Error("telemetry-not-supported");
      await store.record(ctx.bridgeId, valid);

      return { recorded: valid.length };
    },
    name: BRIDGE_TELEMETRY_MUTATION,
  };

  const heartbeat: BridgeMutationDefinition<BridgeHeartbeatArgs, { ok: true }> =
    {
      authorize: (_args, ctx) => scoped(ctx),
      handler: async ({ info }, ctx) => {
        await store.heartbeat(ctx.bridgeId, info);

        return { ok: true };
      },
      name: BRIDGE_HEARTBEAT_MUTATION,
    };

  return {
    authenticate: async (token) => {
      const auth = await options.authenticate(token);
      if (!auth) throw new Error("unknown bridge token");

      return { bridgeId: auth.bridgeId };
    },
    collections: [jobs, sources],
    heartbeat,
    jobs,
    mutations: [report, telemetry, heartbeat],
    report,
    sources,
    telemetry,
  };
};

/**
 * Wrap a store so every write also pushes down the socket: a queued job
 * reaches the agent immediately, a completed one disappears. Pass
 * `engine.applyChange`.
 */
export const withBridgeSyncPublishing = (
  store: BridgeStore,
  emit: BridgeChangeEmitter,
): BridgeStore => ({
  ...store,
  complete: async (jobId, result) => {
    await store.complete(jobId, result);
    await emit(BRIDGE_JOBS_COLLECTION, {
      op: "delete",
      row: { id: jobId },
    });
  },
  enqueue: async (input) => {
    const job = await store.enqueue(input);
    await emit(BRIDGE_JOBS_COLLECTION, { op: "insert", row: job });

    return job;
  },
});

/** Push a telemetry-source change to the bridge that owns the machine. */
export const publishTelemetrySource = (
  emit: BridgeChangeEmitter,
  binding: TelemetryBinding,
  op: BridgeRowChange<TelemetryBinding>["op"] = "update",
) => emit(BRIDGE_SOURCES_COLLECTION, { op, row: binding });
