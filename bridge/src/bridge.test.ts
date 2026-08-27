import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bytesToBase64,
  createBridgeHandlers,
  createMemoryBridgeStore,
  type BridgeJob,
} from "@absolutejs/commerce-machines/bridge";
import { parseArgs } from "./cli";
import { executeJob, osPrint } from "./executors";
import { runBridge } from "./index";
import { listPrinters, type Spawner } from "./printers";

const job = (action: BridgeJob["action"], text = "^XA^XZ"): BridgeJob => ({
  action,
  bridgeId: "b",
  createdAt: new Date().toISOString(),
  files: [
    {
      bytesBase64: bytesToBase64(new TextEncoder().encode(text)),
      filename: "ORD-1.zpl",
      mime: "text/x-zpl",
    },
  ],
  id: "job-1",
  reference: "ORD-1",
  status: "claimed",
});

describe("executors", () => {
  test("folder writes the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-bridge-test-"));
    try {
      const result = await executeJob(
        job({ kind: "folder", path: join(dir, "hot") }),
      );
      expect(result.ok).toBe(true);
      expect(await readFile(join(dir, "hot", "ORD-1.zpl"), "utf8")).toBe(
        "^XA^XZ",
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("raw-tcp streams to a local listener", async () => {
    const chunks: Uint8Array[] = [];
    let closed = () => {};
    const done = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        close: () => closed(),
        data: (_socket, data) => {
          chunks.push(new Uint8Array(data));
        },
        end: () => closed(),
      },
    });
    try {
      const result = await executeJob(
        job({ host: "127.0.0.1", kind: "raw-tcp", port: server.port }),
      );
      expect(result.ok).toBe(true);
      await done;
      expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("^XA^XZ");
    } finally {
      server.stop(true);
    }
  });

  test("os-print spawns lp / powershell with argv arrays only", async () => {
    const calls: { argv: string[]; env?: Record<string, string> }[] = [];
    const spawn: Spawner = async (argv, env) => {
      calls.push({ argv, env });

      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const files = [
      {
        bytes: new Uint8Array([1]),
        filename: "a.zpl",
        format: "zpl" as const,
        mime: "text/x-zpl",
      },
    ];
    const linux = await osPrint(files, "Zebra; rm -rf /", spawn, false);
    expect(linux.ok).toBe(true);
    expect(calls[0]?.argv.slice(0, 5)).toEqual([
      "lp",
      "-d",
      "Zebra; rm -rf /",
      "-o",
      "raw",
    ]);
    const windows = await osPrint(files, "Zebra", spawn, true);
    expect(windows.ok).toBe(true);
    expect(calls[1]?.argv[0]).toBe("powershell.exe");
    expect(calls[1]?.argv.some((part) => part.includes("Out-Printer"))).toBe(
      true,
    );
    expect(calls[1]?.env?.ABS_BRIDGE_PRINTER).toBe("Zebra");
    const pdf = await osPrint(
      [
        {
          ...files[0]!,
          filename: "a.pdf",
          format: "pdf",
          mime: "application/pdf",
        },
      ],
      "Zebra",
      spawn,
      true,
    );
    expect(pdf.ok).toBe(true);
    expect(calls[2]?.argv.some((part) => part.includes("PrintTo"))).toBe(true);
    const failing: Spawner = async () => ({
      exitCode: 1,
      stderr: "lp: The printer does not exist.",
      stdout: "",
    });
    const bad = await osPrint(files, "Nope", failing, false);
    expect(bad).toEqual({
      error:
        'print of a.zpl on "Nope" failed (exit 1): lp: The printer does not exist.',
      ok: false,
    });
  });

  test("listPrinters parses lpstat and Get-Printer output", async () => {
    const spawn: Spawner = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "printer Zebra_ZD420 is idle.\nprinter Brother_QL disabled\n",
    });
    if (process.platform !== "win32") {
      expect(await listPrinters(spawn)).toEqual(["Zebra_ZD420", "Brother_QL"]);
    }
  });
});

describe("legacy HTTP-poll fallback against the reference handlers", () => {
  test("poll → execute → report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-bridge-loop-"));
    const store = createMemoryBridgeStore();
    const handlers = createBridgeHandlers(store, {
      authenticate: async (token) =>
        token === "t" ? { bridgeId: "desk" } : null,
    });
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
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const auth = new Headers(init?.headers).get("authorization");
      expect(auth).toBe(`Bearer ${String(body.token)}`);
      if (url.pathname === "/bridge/poll") {
        return Response.json(
          await handlers.poll(body as Parameters<typeof handlers.poll>[0]),
        );
      }
      if (url.pathname === "/bridge/report") {
        return Response.json(
          await handlers.report(body as Parameters<typeof handlers.report>[0]),
        );
      }
      if (url.pathname === "/bridge/telemetry") {
        return Response.json(
          await handlers.telemetry(
            body as Parameters<typeof handlers.telemetry>[0],
          ),
        );
      }

      return new Response("nope", { status: 404 });
    };
    const logs: string[] = [];
    try {
      const summary = await runBridge({
        discoverPrinters: false,
        fetch: fakeFetch,
        log: (message) => logs.push(message),
        once: true,
        server: "https://shop.example/",
        telemetry: false,
        token: "t",
        transport: "http-poll",
      });
      expect(summary).toEqual({ events: 0, executed: 1, failed: 0, polls: 1 });
      expect(await readFile(join(dir, "hot", "a.dst"), "utf8")).toBe("x");
      const listed = await store.list!("desk", 1);
      expect(listed[0]?.status).toBe("done");
      expect((await store.status("desk")).info?.capabilities).toContain(
        "os-print",
      );
      expect(
        logs.some((line) => line.includes("job") && line.includes("ok")),
      ).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }

    const unauthorized = await runBridge({
      discoverPrinters: false,
      fetch: fakeFetch,
      log: () => {},
      once: true,
      server: "https://shop.example",
      telemetry: false,
      token: "wrong",
      transport: "http-poll",
    });
    expect(unauthorized).toEqual({
      events: 0,
      executed: 0,
      failed: 0,
      polls: 1,
    });
  });

  test("network errors do not throw in --once mode", async () => {
    const summary = await runBridge({
      discoverPrinters: false,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      log: () => {},
      once: true,
      server: "http://127.0.0.1:9",
      telemetry: false,
      token: "t",
      transport: "http-poll",
    });
    expect(summary.polls).toBe(0);
  });
});

describe("cli args", () => {
  test("parses flags", () => {
    expect(
      parseArgs([
        "--server",
        "https://x",
        "--token",
        "t",
        "--once",
        "--interval",
        "5",
      ]),
    ).toEqual({
      help: false,
      httpPoll: false,
      interval: 5,
      listPrinters: false,
      noPrinters: false,
      noTelemetry: false,
      once: true,
      server: "https://x",
      token: "t",
    });
    expect(parseArgs(["--bogus"])).toEqual({ error: "unknown option --bogus" });
    expect(parseArgs(["--server"])).toEqual({
      error: "--server needs a value",
    });
  });
});
