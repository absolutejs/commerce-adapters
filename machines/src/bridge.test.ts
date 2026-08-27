import { describe, expect, test } from "bun:test";
import {
  base64ToBytes,
  bytesToBase64,
  createBridgeHandlers,
  createMemoryBridgeStore,
  isBridgeJob,
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
