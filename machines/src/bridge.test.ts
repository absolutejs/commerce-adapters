import { describe, expect, test } from "bun:test";
import {
  base64ToBytes,
  bridgeTopic,
  bytesToBase64,
  createBridgeHandlers,
  createBridgeSync,
  createMemoryBridgeStore,
  isBridgeJob,
  publishTelemetrySource,
  withBridgeSyncPublishing,
} from "./bridge";
import { createTransports, sendToMachine } from "./transports";

describe("bridge store + handlers", () => {
  test("enqueue → poll (claim + heartbeat) → report round-trip", async () => {
    const store = createMemoryBridgeStore();
    const handlers = createBridgeHandlers(store, {
      authenticate: async (token) =>
        token === "secret" ? { bridgeId: "desk" } : null,
    });
    const transports = createTransports({ bridge: store });
    const before = await store.status("desk");
    expect(before.online).toBe(false);

    const sent = await sendToMachine(
      [
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "a.zpl",
          format: "zpl",
          mime: "text/x-zpl",
        },
      ],
      {
        action: { host: "10.0.0.5", kind: "raw-tcp" },
        bridgeId: "desk",
        transport: "bridge",
      },
      { reference: "ORD-1" },
      transports,
    );
    if (!sent.ok) throw new Error(sent.error);
    expect(sent.jobId).toBeDefined();

    expect(await handlers.poll({ token: "nope" })).toEqual({
      error: "unauthorized",
    });
    const polled = await handlers.poll({
      info: {
        capabilities: ["raw-tcp"],
        hostname: "pc",
        platform: "linux",
        version: "0.1.0",
      },
      token: "secret",
    });
    if ("error" in polled) throw new Error(polled.error);
    expect(polled.jobs).toHaveLength(1);
    const job = polled.jobs[0]!;
    expect(isBridgeJob(job)).toBe(true);
    expect(job.status).toBe("claimed");
    expect(Array.from(base64ToBytes(job.files[0]!.bytesBase64))).toEqual([
      1, 2, 3,
    ]);

    // second poll hands out nothing (already claimed)
    const again = await handlers.poll({ token: "secret" });
    if ("error" in again) throw new Error(again.error);
    expect(again.jobs).toHaveLength(0);

    const probe = await transports.bridge.probe!({
      action: { kind: "os-print", printer: "x" },
      bridgeId: "desk",
      transport: "bridge",
    });
    expect(probe.ok).toBe(false); // online but lacks os-print capability

    expect(
      await handlers.report({
        jobId: "missing",
        result: { detail: "x", ok: true },
        token: "secret",
      }),
    ).toEqual({ error: "unknown-job" });
    expect(
      await handlers.report({
        jobId: job.id,
        result: { ok: true } as never,
        token: "secret",
      }),
    ).toEqual({ error: "invalid-result" });
    expect(
      await handlers.report({
        jobId: job.id,
        result: { detail: "sent", ok: true },
        token: "secret",
      }),
    ).toEqual({ ok: true });
    const listed = await store.list!("desk", 10);
    expect(listed[0]?.status).toBe("done");
    expect(listed[0]?.result).toEqual({ detail: "sent", ok: true });
    expect((await store.status("desk")).online).toBe(true);
  });

  test("stale claims are re-queued", async () => {
    let clock = 0;
    const store = createMemoryBridgeStore({
      claimTimeoutMs: 1000,
      now: () => new Date(clock),
    });
    await store.enqueue({
      action: { kind: "folder", path: "/x" },
      bridgeId: "b",
      files: [],
      reference: "r",
    });
    expect(await store.claim("b", 5)).toHaveLength(1);
    clock = 500;
    expect(await store.claim("b", 5)).toHaveLength(0);
    clock = 2000;
    expect(await store.claim("b", 5)).toHaveLength(1);
  });

  test("base64 helpers", () => {
    expect(
      Array.from(base64ToBytes(bytesToBase64(new Uint8Array([0, 255, 7])))),
    ).toEqual([0, 255, 7]);
  });
});

describe("telemetry over the legacy HTTP fallback", () => {
  const event = (machineId: string, minute: number) => ({
    at: `2026-08-26T09:0${minute}:00.000Z`,
    kind: "progress" as const,
    machineId,
    reading: {
      at: `2026-08-26T09:0${minute}:00.000Z`,
      state: "running" as const,
    },
  });

  test("poll carries the telemetry sources; telemetry is gated by token", async () => {
    const store = createMemoryBridgeStore({
      sources: {
        desk: [
          {
            machineId: "emb-1",
            source: { kind: "report-folder", path: "/reports" },
          },
        ],
      },
    });
    const handlers = createBridgeHandlers(store, {
      authenticate: async (token) =>
        token === "secret" ? { bridgeId: "desk" } : null,
    });
    const polled = await handlers.poll({
      info: {
        capabilities: ["folder"],
        hostname: "pc",
        platform: "linux",
        telemetry: ["report-folder"],
        version: "0.2.0-beta.0",
      },
      token: "secret",
    });
    if ("error" in polled) throw new Error(polled.error);
    expect(polled.sources).toEqual([
      {
        machineId: "emb-1",
        source: { kind: "report-folder", path: "/reports" },
      },
    ]);
    expect((await store.status("desk")).info?.telemetry).toEqual([
      "report-folder",
    ]);

    expect(
      await handlers.telemetry({ events: [event("emb-1", 1)], token: "nope" }),
    ).toEqual({ error: "unauthorized" });
    expect(
      await handlers.telemetry({
        events: [{ nonsense: true }] as never,
        token: "secret",
      }),
    ).toEqual({ error: "invalid-events" });
    expect(
      await handlers.telemetry({
        events: [event("emb-1", 1), event("emb-1", 2)],
        token: "secret",
      }),
    ).toEqual({ ok: true, recorded: 2 });
    expect(await store.records!("desk", 10)).toHaveLength(2);
  });

  test("a store without record() reports not-supported", async () => {
    const base = createMemoryBridgeStore();
    const { record, records, ...withoutRecord } = base;
    const handlers = createBridgeHandlers(withoutRecord, {
      authenticate: async () => ({ bridgeId: "desk" }),
    });
    expect(
      await handlers.telemetry({ events: [event("m", 1)], token: "t" }),
    ).toEqual({ error: "not-supported" });
  });
});

describe("live bridge sync", () => {
  const authenticate = async (token: string) =>
    token === "secret" ? { bridgeId: "desk" } : null;

  test("collections hydrate per bridge and mutations push results back", async () => {
    const store = createMemoryBridgeStore({
      sources: {
        desk: [{ machineId: "zebra-1", source: { kind: "manual" } }],
        other: [],
      },
    });
    const sync = createBridgeSync(store, { authenticate });
    const ctx = await sync.authenticate("secret");
    expect(ctx).toEqual({ bridgeId: "desk" });
    await expect(sync.authenticate("nope")).rejects.toThrow();
    expect(bridgeTopic("desk")).toBe("bridge:desk");

    const job = await store.enqueue({
      action: { kind: "folder", path: "/hot" },
      bridgeId: "desk",
      files: [],
      reference: "ORD-1",
    });
    await store.enqueue({
      action: { kind: "folder", path: "/hot" },
      bridgeId: "elsewhere",
      files: [],
      reference: "ORD-2",
    });

    expect(sync.jobs.authorize!(undefined, ctx)).toBe(true);
    expect(sync.jobs.authorize!(undefined, {} as never)).toBe(false);
    const hydrated = await sync.jobs.hydrate(undefined, ctx);
    expect(hydrated.map((row) => row.reference)).toEqual(["ORD-1"]);
    expect(sync.jobs.match!(job, undefined, ctx)).toBe(true);
    expect(
      sync.jobs.match!({ ...job, bridgeId: "elsewhere" }, undefined, ctx),
    ).toBe(false);
    expect(sync.jobs.match!({ ...job, status: "done" }, undefined, ctx)).toBe(
      false,
    );
    expect(await sync.sources.hydrate(undefined, ctx)).toEqual([
      { machineId: "zebra-1", source: { kind: "manual" } },
    ]);

    const changes: { table: string; op: string }[] = [];
    const actions = {
      change: async (table: string, change: { op: string }) => {
        changes.push({ op: change.op, table });
      },
    };
    await expect(
      sync.report.handler(
        { jobId: job.id, result: { ok: true } as never },
        ctx,
        actions,
      ),
    ).rejects.toThrow("invalid-result");
    await expect(
      sync.report.handler(
        { jobId: "missing", result: { detail: "x", ok: true } },
        ctx,
        actions,
      ),
    ).rejects.toThrow("unknown-job");
    expect(
      await sync.report.handler(
        { jobId: job.id, result: { detail: "wrote", ok: true } },
        ctx,
        actions,
      ),
    ).toEqual({ ok: true });
    expect(changes).toEqual([{ op: "delete", table: "bridgeJobs" }]);
    expect((await store.list!("desk", 5))[0]?.status).toBe("done");
    expect(await sync.jobs.hydrate(undefined, ctx)).toEqual([]);

    expect(
      await sync.telemetry.handler(
        {
          events: [
            {
              at: "2026-08-26T09:00:00.000Z",
              kind: "finish",
              machineId: "zebra-1",
              reading: { at: "2026-08-26T09:00:00.000Z", state: "idle" },
            },
            { junk: true } as never,
          ],
        },
        ctx,
        actions,
      ),
    ).toEqual({ recorded: 1 });
    expect(await store.records!("desk", 10)).toHaveLength(1);

    expect(
      await sync.heartbeat.handler(
        {
          info: {
            capabilities: ["folder"],
            hostname: "pc",
            platform: "linux",
            telemetry: ["report-folder"],
            version: "0.2.0-beta.0",
          },
        },
        ctx,
        actions,
      ),
    ).toEqual({ ok: true });
    expect((await store.status("desk")).info?.hostname).toBe("pc");
  });

  test("withBridgeSyncPublishing pushes a queued job down immediately", async () => {
    const emitted: { table: string; op: string; row: unknown }[] = [];
    const store = withBridgeSyncPublishing(
      createMemoryBridgeStore(),
      (table, change) => {
        emitted.push({ op: change.op, row: change.row, table });
      },
    );
    const job = await store.enqueue({
      action: { kind: "folder", path: "/hot" },
      bridgeId: "desk",
      files: [],
      reference: "ORD-3",
    });
    await store.complete(job.id, { detail: "ok", ok: true });
    expect(emitted.map((entry) => `${entry.table}:${entry.op}`)).toEqual([
      "bridgeJobs:insert",
      "bridgeJobs:delete",
    ]);
    await publishTelemetrySource(
      (table, change) => {
        emitted.push({ op: change.op, row: change.row, table });
      },
      { machineId: "m1", source: { kind: "manual" } },
    );
    expect(emitted[2]).toEqual({
      op: "update",
      row: { machineId: "m1", source: { kind: "manual" } },
      table: "bridgeTelemetrySources",
    });
  });
});
