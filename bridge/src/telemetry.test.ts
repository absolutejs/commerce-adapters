import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bytesToBase64,
  createBridgeSync,
  createMemoryBridgeStore,
  type BridgeStore,
} from "@absolutejs/commerce-machines/bridge";
import {
  readingsToRuns,
  snmpPrinterOids,
  type MachineRunEvent,
  type TelemetryBinding,
} from "@absolutejs/commerce-machines/telemetry";
import { sourceFromArgs, parseArgs } from "./cli";
import { connectBridge, toWebSocketUrl } from "./connection";
import {
  createEmitter,
  createTelemetryHub,
  globToRegExp,
  probeSource,
  readJsonPath,
  readingFromWebhook,
  scanReportFolder,
  startWatcher,
  SEEN_SIDECAR,
  type HttpServe,
  type TcpConnect,
  type UdpBind,
  type Watcher,
} from "./watchers";
import {
  decodeOidContents,
  decodeSnmpMessage,
  encodeOidContents,
  encodeSnmpGet,
  encodeSnmpInformResponse,
  PDU_GET_REQUEST,
  PDU_INFORM,
  PDU_RESPONSE,
  PDU_TRAP_V2,
  SNMP_COUNTER32,
  SNMP_INTEGER,
  SNMP_OCTET_STRING,
  SNMP_OID,
  SNMP_SEQUENCE,
  SNMP_TRAP_OID,
  encodeInteger,
  encodeTlv,
  varbindRecord,
} from "./snmp";

const REPORT = `TAJIMA PRODUCTION REPORT
Design    : 288C8286-L1-1.DST
Start     : 2026/08/26 09:14:03
End       : 2026/08/26 09:31:47
Run time  : 00:17:44
Stitches  : 12,480
Pieces    : 6
Status    : Completed
`;

const clock = (start: number) => {
  let ms = start;

  return {
    advance: (seconds: number) => {
      ms += seconds * 1000;
    },
    now: () => new Date(ms),
  };
};

describe("report folder watcher", () => {
  test("baselines existing files, then emits only for new reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-telemetry-"));
    try {
      await writeFile(join(dir, "old.txt"), REPORT, "utf8");
      const events: MachineRunEvent[] = [];
      const fake = clock(Date.UTC(2026, 7, 26, 12, 0, 0));
      const triggers: (() => void)[] = [];
      const options = {
        emit: (event: MachineRunEvent) => events.push(event),
        fs: {
          watch: (_path: string, listener: () => void) => {
            triggers.push(listener);

            return { close: () => undefined };
          },
        },
        debounceMs: 0,
        now: fake.now,
        rescanSeconds: 0,
      };
      const watcher = await startWatcher(
        {
          machineId: "emb-1",
          source: {
            kind: "report-folder",
            parser: "tajima-report",
            path: dir,
            pattern: "*.txt",
          },
        },
        options,
      );
      expect(watcher).not.toBeNull();
      // The shop's history is adopted, never replayed.
      expect(events).toHaveLength(0);
      expect(
        JSON.parse(await readFile(join(dir, SEEN_SIDECAR), "utf8")),
      ).toEqual(["old.txt"]);

      fake.advance(60);
      await writeFile(join(dir, "run-2.txt"), REPORT, "utf8");
      await writeFile(join(dir, "ignored.csv"), REPORT, "utf8");
      expect(triggers).toHaveLength(1);
      triggers[0]?.();
      await Bun.sleep(20);

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.machineId).toBe("emb-1");
      expect(event.kind).toBe("finish");
      expect(event.reference).toBe("288C8286-L1-1");
      expect(event.reading.stitches).toBe(12480);
      expect(event.reading.elapsedSeconds).toBe(1064);

      // A second notification for the same file emits nothing.
      triggers[0]?.();
      await Bun.sleep(20);
      expect(events).toHaveLength(1);
      const remembered: string[] = JSON.parse(
        await readFile(join(dir, SEEN_SIDECAR), "utf8"),
      );
      expect(remembered).toContain("run-2.txt");
      await watcher?.stop();

      // The sidecar means a restart does not re-read the folder…
      const restarted: MachineRunEvent[] = [];
      await startWatcher(
        {
          machineId: "emb-1",
          source: {
            kind: "report-folder",
            parser: "tajima-report",
            path: dir,
            pattern: "*.txt",
          },
        },
        { ...options, emit: (event) => restarted.push(event) },
      ).then((restartedWatcher) => restartedWatcher?.stop());
      expect(restarted).toHaveLength(0);
      // …and the shop's files are still there, untouched.
      expect(await readFile(join(dir, "run-2.txt"), "utf8")).toBe(REPORT);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a file that is not a report is skipped, not reported as a run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-telemetry-"));
    try {
      const events: MachineRunEvent[] = [];
      const logs: string[] = [];
      const state = { baselined: true, seen: new Set<string>() };
      await writeFile(join(dir, "note.txt"), "just a note", "utf8");
      const result = await scanReportFolder(
        { kind: "report-folder", path: dir },
        state,
        createEmitter("m", (event) => events.push(event)),
        {
          emit: () => undefined,
          log: (message) => logs.push(message),
        },
      );
      expect(result.read).toEqual(["note.txt"]);
      expect(events).toHaveLength(0);
      expect(logs.some((line) => line.includes("nothing job-shaped"))).toBe(
        true,
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("globs are literal, not regular expressions", () => {
    expect(globToRegExp("*.txt").test("run.txt")).toBe(true);
    expect(globToRegExp("*.txt").test("run.csv")).toBe(false);
    expect(globToRegExp("run?.log").test("run1.log")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  test("probeSource reads the newest report without marking it seen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-telemetry-"));
    try {
      await writeFile(join(dir, "a-run.txt"), REPORT, "utf8");
      const probed = await probeSource({
        kind: "report-folder",
        parser: "tajima-report",
        path: dir,
      });
      expect(probed.ok).toBe(true);
      if (probed.ok) expect(probed.reading.stitches).toBe(12480);
      const missing = await probeSource({
        kind: "report-folder",
        path: dir,
        pattern: "*.none",
      });
      expect(missing.ok).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("zebra alert stream", () => {
  test("unsolicited alerts arrive on a held-open connection and become events", async () => {
    const events: MachineRunEvent[] = [];
    let push: ((chunk: Uint8Array) => void) | undefined;
    let closed = false;
    const connect: TcpConnect = async ({ onData, onOpen }) => {
      push = onData;
      onOpen({ end: () => undefined, write: () => 0 });

      return {
        close: () => {
          closed = true;
        },
      };
    };
    const watcher = await startWatcher(
      {
        machineId: "zebra-1",
        source: { host: "10.0.0.9", kind: "raw-tcp-status" },
      },
      {
        connect,
        emit: (event) => events.push(event),
        listen: async () => ({ close: () => undefined }),
      },
    );
    const send = (text: string) =>
      push?.(new TextEncoder().encode(`${text}\r\n`));
    send("PAPER OUT SET");
    send("PAPER OUT SET"); // repeated condition does not duplicate the event
    send("PAPER OUT CLEAR");
    expect(
      events.map((event) => `${event.kind}:${event.reading.state}`),
    ).toEqual(["error:error", "progress:idle"]);
    await watcher?.stop();
    expect(closed).toBe(true);
  });

  test("probing sends the ~HS query and decodes the reply", async () => {
    const stx = String.fromCharCode(2);
    const etx = String.fromCharCode(3);
    let written = "";
    const connect: TcpConnect = async ({ onData, onOpen }) => {
      onOpen({
        end: () => undefined,
        write: (data) => {
          written =
            typeof data === "string" ? data : new TextDecoder().decode(data);
          onData(
            new TextEncoder().encode(
              `${stx}030,0,0,0888,000,0,0,0,000,0,0,0${etx}\r\n${stx}001,0,0,0,0,2,4,0,00000004,1,000${etx}\r\n`,
            ),
          );

          return 0;
        },
      });

      return { close: () => undefined };
    };
    const result = await probeSource(
      { host: "10.0.0.9", kind: "raw-tcp-status" },
      { connect },
    );
    expect(written).toBe("~HS");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reading.state).toBe("running");
      expect(result.reading.detail).toContain("4 label(s)");
    }
  });
});

describe("snmp", () => {
  test("OID encoding round-trips", () => {
    for (const oid of [
      snmpPrinterOids.printerStatus,
      snmpPrinterOids.pageCount,
      SNMP_TRAP_OID,
      "1.3.6.1.4.1.683.6.3.2.1.0",
    ]) {
      expect(decodeOidContents(encodeOidContents(oid))).toBe(oid);
    }
  });

  test("a GetRequest decodes back to its OIDs", () => {
    const request = encodeSnmpGet({
      community: "public",
      oids: [snmpPrinterOids.printerStatus, snmpPrinterOids.pageCount],
      requestId: 4242,
    });
    const decoded = decodeSnmpMessage(request);
    if ("error" in decoded) throw new Error(decoded.error);
    expect(decoded.version).toBe(1);
    expect(decoded.community).toBe("public");
    expect(decoded.pduTag).toBe(PDU_GET_REQUEST);
    expect(decoded.requestId).toBe(4242);
    expect(decoded.varbinds.map((varbind) => varbind.oid)).toEqual([
      snmpPrinterOids.printerStatus,
      snmpPrinterOids.pageCount,
    ]);
    expect(decodeSnmpMessage(new Uint8Array([1, 2, 3]))).toHaveProperty(
      "error",
    );
  });

  test("traps from a fake UDP socket become readings, informs get answered", async () => {
    const events: MachineRunEvent[] = [];
    let deliver:
      | ((
          address: string,
          message: Uint8Array,
          reply: (payload: Uint8Array) => void,
        ) => void)
      | undefined;
    let boundPort = 0;
    const udp: UdpBind = async ({ onMessage, port }) => {
      deliver = onMessage;
      boundPort = port;

      return { close: () => undefined };
    };
    const watcher = await startWatcher(
      {
        machineId: "dtg-1",
        source: { host: "10.0.0.20", kind: "snmp-printer", trapPort: 1620 },
      },
      { emit: (event) => events.push(event), udp },
    );
    expect(boundPort).toBe(1620);

    const trap = (
      tag: number,
      varbinds: { oid: string; tag: number; value: Uint8Array | number }[],
    ) =>
      encodeTlv(
        SNMP_SEQUENCE,
        Buffer.concat([
          encodeInteger(1),
          encodeTlv(SNMP_OCTET_STRING, new TextEncoder().encode("public")),
          encodeTlv(
            tag,
            Buffer.concat([
              encodeInteger(7),
              encodeInteger(0),
              encodeInteger(0),
              encodeTlv(
                SNMP_SEQUENCE,
                Buffer.concat(
                  varbinds.map((varbind) =>
                    encodeTlv(
                      SNMP_SEQUENCE,
                      Buffer.concat([
                        encodeTlv(SNMP_OID, encodeOidContents(varbind.oid)),
                        typeof varbind.value === "number"
                          ? encodeInteger(varbind.value, varbind.tag)
                          : encodeTlv(varbind.tag, varbind.value),
                      ]),
                    ),
                  ),
                ),
              ),
            ]),
          ),
        ]),
      );

    const replies: Uint8Array[] = [];
    deliver?.(
      "10.0.0.20",
      new Uint8Array(
        trap(PDU_TRAP_V2, [
          {
            oid: SNMP_TRAP_OID,
            tag: SNMP_OID,
            value: encodeOidContents("1.3.6.1.6.3.1.1.5.3"),
          },
          { oid: snmpPrinterOids.printerStatus, tag: SNMP_INTEGER, value: 4 },
          { oid: snmpPrinterOids.pageCount, tag: SNMP_COUNTER32, value: 4821 },
        ]),
      ),
      (payload) => replies.push(payload),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.reading.state).toBe("running");
    expect(events[0]?.reading.pageCount).toBe(4821);
    expect(events[0]?.reading.detail).toContain("trap 1.3.6.1.6.3.1.1.5.3");
    expect(replies).toHaveLength(0); // a plain trap is not acknowledged

    deliver?.(
      "10.0.0.20",
      new Uint8Array(
        trap(PDU_INFORM, [
          { oid: snmpPrinterOids.printerStatus, tag: SNMP_INTEGER, value: 3 },
        ]),
      ),
      (payload) => replies.push(payload),
    );
    expect(replies).toHaveLength(1);
    const answer = decodeSnmpMessage(replies[0]!);
    if ("error" in answer) throw new Error(answer.error);
    expect(answer.pduTag).toBe(PDU_RESPONSE);
    expect(answer.requestId).toBe(7);
    expect(varbindRecord(answer.varbinds)).toEqual({
      [snmpPrinterOids.printerStatus]: 3,
    });
    await watcher?.stop();
  });

  test("encodeSnmpInformResponse echoes the request id", () => {
    const decoded = decodeSnmpMessage(
      encodeSnmpInformResponse({
        community: "public",
        errorIndex: 0,
        errorStatus: 0,
        pduTag: PDU_INFORM,
        requestId: 99,
        varbinds: [{ oid: snmpPrinterOids.pageCount, value: 12 }],
        version: 1,
      }),
    );
    if ("error" in decoded) throw new Error(decoded.error);
    expect(decoded.requestId).toBe(99);
    expect(decoded.varbinds[0]?.value).toBe(12);
  });
});

describe("webhook receiver", () => {
  test("serves the machine's path, checks the secret and emits", async () => {
    const events: MachineRunEvent[] = [];
    let handler: ((request: Request) => Promise<Response>) | undefined;
    const serve: HttpServe = async ({ onRequest }) => {
      handler = onRequest;

      return { close: () => undefined };
    };
    const watcher = await startWatcher(
      {
        machineId: "dtg-2",
        source: {
          kind: "http-status",
          webhookPath: "/telemetry/dtg-2",
          webhookSecret: "s3cret",
        },
      },
      { emit: (event) => events.push(event), serve, webhookPort: 8999 },
    );
    expect(watcher?.describe).toContain("8999/telemetry/dtg-2");
    const post = (body: string, secret?: string) =>
      handler!(
        new Request("http://pc:8999/telemetry/dtg-2", {
          body,
          headers: secret === undefined ? {} : { "x-telemetry-secret": secret },
          method: "POST",
        }),
      );
    expect((await post("{}", undefined)).status).toBe(401);
    expect(
      (
        await handler!(
          new Request("http://pc:8999/telemetry/nope", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
    const ok = await post(
      JSON.stringify({ jobName: "ORD-5-L1", state: "running", stitches: 10 }),
      "s3cret",
    );
    expect(ok.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("start");
    expect(events[0]?.reference).toBe("ORD-5-L1");
    await watcher?.stop();
  });

  test("bodies are read as JSON, key/value or a bare status word", () => {
    const now = () => new Date(Date.UTC(2026, 7, 26, 12, 0, 0));
    expect(
      readingFromWebhook('{"printer":{"state":"Printing"}}', {
        jsonPath: "printer.state",
        now,
      })?.state,
    ).toBe("running");
    expect(readingFromWebhook("status: paused", { now })?.state).toBe("paused");
    expect(readingFromWebhook("PRINTING", { now })?.state).toBe("running");
    expect(readingFromWebhook("   ", { now })).toBeNull();
    expect(readJsonPath({ jobs: [{ status: "idle" }] }, "jobs[0].status")).toBe(
      "idle",
    );
  });

  test("a query-only machine says so instead of pretending", async () => {
    const result = await probeSource({ kind: "http-status" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("POST to the bridge");
    expect((await probeSource({ kind: "manual" })).ok).toBe(false);
  });
});

describe("telemetry hub", () => {
  test("reconciles watchers as the server changes the sources", async () => {
    const hub = createTelemetryHub({
      emit: () => undefined,
      listen: async () => ({ close: () => undefined }),
      connect: async ({ onOpen }) => {
        onOpen({ end: () => undefined, write: () => 0 });

        return { close: () => undefined };
      },
      udp: async () => ({ close: () => undefined }),
    });
    const zebra: TelemetryBinding = {
      machineId: "z",
      source: { host: "10.0.0.9", kind: "raw-tcp-status" },
    };
    await hub.set([
      zebra,
      { machineId: "manual-1", source: { kind: "manual" } },
    ]);
    expect(hub.running().map((watcher: Watcher) => watcher.machineId)).toEqual([
      "z",
    ]);
    await hub.set([zebra]);
    expect(hub.running()).toHaveLength(1);
    await hub.set([]);
    expect(hub.running()).toHaveLength(0);
    await hub.stop();
  });
});

// --------------------------------------------------------------- socket end-to-end

/** A WebSocket that speaks the sync wire protocol against the reference
 * bridge collections/mutations — no HTTP, no polling, no Elysia. */
const fakeSyncServer = (store: BridgeStore, token: string) => {
  const sync = createBridgeSync(store, {
    authenticate: async (candidate) =>
      candidate === token ? { bridgeId: "desk" } : null,
  });
  const definitions = {
    bridgeJobs: sync.jobs,
    bridgeTelemetrySources: sync.sources,
  };
  const mutations = new Map(
    sync.mutations.map((mutation) => [mutation.name, mutation]),
  );
  const sockets = new Set<FakeSocket>();

  class FakeSocket {
    static latest: FakeSocket | undefined;
    readyState = 1;
    CLOSED = 3;
    onopen: (() => void) | undefined;
    onmessage: ((event: { data: string }) => void) | undefined;
    onclose: (() => void) | undefined;
    ctx: { bridgeId: string } | undefined;
    subscriptions = new Map<string, string>();
    chain: Promise<void> = Promise.resolve();

    constructor(_url: string) {
      FakeSocket.latest = this;
      sockets.add(this);
      queueMicrotask(() => this.onopen?.());
    }

    send(payload: string) {
      // Frames are handled in order, exactly as one connection would.
      this.chain = this.chain.then(async () => {
        try {
          await this.handle(JSON.parse(payload) as Record<string, unknown>);
        } catch {
          this.close(); // the real socket closes with 4401 on a bad ticket
        }
      });
    }

    close() {
      this.readyState = this.CLOSED;
      sockets.delete(this);
      this.onclose?.();
    }

    push(frame: unknown) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }

    async snapshot(id: string, collection: string) {
      const definition = definitions[collection as keyof typeof definitions];
      if (!definition || !this.ctx) return;
      this.push({
        id,
        rows: await definition.hydrate(undefined, this.ctx),
        type: "snapshot",
      });
    }

    async refresh() {
      for (const [id, collection] of this.subscriptions) {
        await this.snapshot(id, collection);
      }
    }

    async handle(frame: Record<string, unknown>) {
      if (frame.type === "authenticate") {
        this.ctx = await sync.authenticate(String(frame.ticket));

        return;
      }
      if (frame.type === "subscribe") {
        const id = String(frame.id);
        const collection = String(frame.collection);
        this.subscriptions.set(id, collection);
        await this.snapshot(id, collection);

        return;
      }
      if (frame.type === "mutate") {
        const mutation = mutations.get(String(frame.name));
        if (!mutation || !this.ctx) return;
        try {
          const result = await mutation.handler(frame.args as never, this.ctx, {
            change: async () => undefined,
          });
          this.push({ mutationId: frame.mutationId, result, type: "ack" });
        } catch (error) {
          this.push({
            message: error instanceof Error ? error.message : String(error),
            mutationId: frame.mutationId,
            type: "reject",
          });
        }
        for (const socket of sockets) await socket.refresh();
      }
    }
  }

  return { FakeSocket, sync };
};

describe("live socket transport", () => {
  test("the server pushes a job down, the agent runs it and pushes results and telemetry up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-bridge-socket-"));
    try {
      const reports = join(dir, "reports");
      await Bun.write(join(reports, "keep.txt"), "placeholder");
      const store = createMemoryBridgeStore({
        sources: {
          desk: [
            {
              machineId: "emb-1",
              source: {
                kind: "report-folder",
                parser: "tajima-report",
                path: reports,
              },
            },
          ],
        },
      });
      const { FakeSocket } = fakeSyncServer(store, "tok");
      await store.enqueue({
        action: { kind: "folder", path: join(dir, "hot") },
        bridgeId: "desk",
        files: [
          {
            bytesBase64: bytesToBase64(new TextEncoder().encode("x")),
            filename: "a.dst",
            mime: "application/x-tajima-dst",
          },
        ],
        reference: "ORD-7",
      });
      const logs: string[] = [];
      const connection = await connectBridge({
        discoverPrinters: false,
        log: (line) => logs.push(line),
        server: "https://shop.example",
        telemetryOptions: { debounceMs: 0, rescanSeconds: 0 },
        token: "tok",
        webSocketImpl: FakeSocket as unknown as typeof WebSocket,
      });
      await connection.ready;
      await connection.settled();

      expect(await readFile(join(dir, "hot", "a.dst"), "utf8")).toBe("x");
      expect((await store.list!("desk", 5))[0]?.status).toBe("done");
      expect((await store.status("desk")).info?.telemetry).toContain(
        "report-folder",
      );
      expect(connection.counters().executed).toBe(1);
      expect(
        connection.hub?.running().map((watcher) => watcher.machineId),
      ).toEqual(["emb-1"]);

      // A report lands in the watched folder: the event goes up the same socket.
      await Bun.write(join(reports, "run.txt"), REPORT);
      await Bun.sleep(300);
      await connection.settled();
      const recorded = await store.records!("desk", 10);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.reference).toBe("288C8286-L1-1");
      expect(readingsToRuns([recorded[0]!.reading])[0]?.seconds).toBe(1064);
      connection.close();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("an unknown token never gets a snapshot", async () => {
    const store = createMemoryBridgeStore();
    const { FakeSocket } = fakeSyncServer(store, "right");
    await store.enqueue({
      action: { kind: "folder", path: "/nope" },
      bridgeId: "desk",
      files: [],
      reference: "ORD-8",
    });
    const connection = await connectBridge({
      discoverPrinters: false,
      log: () => undefined,
      server: "https://shop.example",
      telemetry: false,
      token: "wrong",
      webSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    await Bun.sleep(50);
    expect(connection.counters().executed).toBe(0);
    expect((await store.list!("desk", 5))[0]?.status).toBe("queued");
    connection.close();
  });

  test("http(s) URLs become ws(s) socket URLs", () => {
    expect(toWebSocketUrl("https://shop.example/")).toBe(
      "wss://shop.example/sync/ws",
    );
    expect(toWebSocketUrl("http://127.0.0.1:3000", "/bridge/ws")).toBe(
      "ws://127.0.0.1:3000/bridge/ws",
    );
    expect(toWebSocketUrl("wss://shop.example")).toBe(
      "wss://shop.example/sync/ws",
    );
  });
});

describe("cli telemetry flags", () => {
  test("--probe builds a source from its flags", () => {
    const parsed = parseArgs([
      "--probe",
      "report-folder",
      "--path",
      "/reports",
      "--pattern",
      "*.txt",
      "--parser",
      "tajima-report",
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(sourceFromArgs(parsed)).toEqual({
      kind: "report-folder",
      parser: "tajima-report",
      path: "/reports",
      pattern: "*.txt",
    });
    const snmp = parseArgs(["--probe", "snmp-printer", "--host", "10.0.0.20"]);
    if ("error" in snmp) throw new Error(snmp.error);
    expect(sourceFromArgs(snmp)).toEqual({
      host: "10.0.0.20",
      kind: "snmp-printer",
    });
    const missing = parseArgs(["--probe", "raw-tcp-status"]);
    if ("error" in missing) throw new Error(missing.error);
    expect(sourceFromArgs(missing)).toEqual({
      error: "--probe raw-tcp-status needs --host",
    });
    const bogus = parseArgs(["--probe", "telepathy"]);
    if ("error" in bogus) throw new Error(bogus.error);
    expect(sourceFromArgs(bogus)).toHaveProperty("error");
  });

  test("--no-telemetry, --http-poll and --webhook-port parse", () => {
    expect(
      parseArgs([
        "--server",
        "https://x",
        "--token",
        "t",
        "--no-telemetry",
        "--http-poll",
        "--webhook-port",
        "9000",
      ]),
    ).toMatchObject({
      httpPoll: true,
      noTelemetry: true,
      webhookPort: 9000,
    });
    expect(parseArgs(["--webhook-port", "-1"])).toEqual({
      error: "--webhook-port must be a positive number",
    });
  });
});
