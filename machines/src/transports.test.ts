import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeIppRequest, IPP_TAGS } from "./ipp";
import {
  createTransports,
  probeMachine,
  safeFilename,
  sendToMachine,
  transportFieldsFor,
  transportHelp,
  MACHINE_TRANSPORT_KINDS,
} from "./transports";
import type { MachineExport } from "./types";

const file = (filename: string, text: string): MachineExport => ({
  bytes: new TextEncoder().encode(text),
  filename,
  format: "zpl",
  mime: "text/x-zpl",
});

describe("folder transport", () => {
  test("writes sanitised files, refuses traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abs-machines-"));
    try {
      const result = await sendToMachine(
        [file("../evil.zpl", "^XA^XZ"), file("ORD 1.zpl", "^XA^XZ")],
        { path: join(dir, "hot"), transport: "folder" },
        { reference: "ORD-1" },
      );
      expect(result.ok).toBe(true);
      expect(await readFile(join(dir, "hot", "evil.zpl"), "utf8")).toBe(
        "^XA^XZ",
      );
      expect(await readFile(join(dir, "hot", "ORD_1.zpl"), "utf8")).toBe(
        "^XA^XZ",
      );
      const bad = await sendToMachine(
        [],
        { path: `${dir}/../x`, transport: "folder" },
        { reference: "r" },
      );
      expect(bad.ok).toBe(false);
      expect(
        (await probeMachine({ path: join(dir, "hot"), transport: "folder" }))
          .ok,
      ).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("safeFilename", () => {
    expect(safeFilename("..\\..\\a b.dst")).toBe("a_b.dst");
    expect(safeFilename("...")).toBe("job");
  });
});

describe("raw-tcp transport", () => {
  test("streams bytes to a listening socket and probes", async () => {
    const received: Uint8Array[] = [];
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
          received.push(new Uint8Array(data));
        },
        end: () => closed(),
      },
    });
    try {
      const payload = "^XA".repeat(50_000);
      const result = await sendToMachine(
        [file("l.zpl", payload)],
        { host: "127.0.0.1", port: server.port, transport: "raw-tcp" },
        { reference: "ORD-1" },
      );
      expect(result.ok).toBe(true);
      await done;
      const total = received.reduce((sum, chunk) => sum + chunk.length, 0);
      expect(total).toBe(payload.length);
      expect(new TextDecoder().decode(Buffer.concat(received))).toBe(payload);
      const probe = await probeMachine({
        host: "127.0.0.1",
        port: server.port,
        transport: "raw-tcp",
      });
      expect(probe.ok).toBe(true);
    } finally {
      server.stop(true);
    }
    // the port we just closed refuses connections
    const dead = await sendToMachine(
      [file("l.zpl", "x")],
      { host: "127.0.0.1", port: server.port, transport: "raw-tcp" },
      { reference: "r" },
    );
    expect(dead.ok).toBe(false);
    expect(dead.ok ? "" : dead.error).toContain("unreachable");
  });
});

describe("ipp transport", () => {
  test("posts application/ipp and reads job-id + status", async () => {
    const calls: {
      url: string;
      contentType: string | null;
      auth: string | null;
      body: Uint8Array;
    }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const body = new Uint8Array(init?.body as ArrayBuffer);
      const headers = new Headers(init?.headers);
      calls.push({
        auth: headers.get("authorization"),
        body,
        contentType: headers.get("content-type"),
        url: String(input),
      });
      const operation = (body[2]! << 8) | body[3]!;
      const jobId = new Uint8Array([0, 0, 0, 9]);
      const response = new Uint8Array([
        1,
        1,
        0,
        0,
        ...body.subarray(4, 8),
        operation === 2 ? 2 : 4,
        0x21,
        0,
        6,
        ...Buffer.from("job-id"),
        0,
        4,
        ...jobId,
        0x23,
        0,
        13,
        ...Buffer.from("printer-state"),
        0,
        4,
        0,
        0,
        0,
        3,
        3,
      ]);

      return new Response(response, {
        headers: { "content-type": "application/ipp" },
      });
    };
    const transports = createTransports({ fetch: fakeFetch });
    const target = {
      password: "pw",
      transport: "ipp" as const,
      url: "ipp://printer.local:631/ipp/print",
      username: "u",
    };
    const result = await sendToMachine(
      [file("a.zpl", "^XA^XZ")],
      target,
      { reference: "ORD-9" },
      transports,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.jobId).toBe("9");
    expect(calls[0]?.url).toBe("http://printer.local:631/ipp/print");
    expect(calls[0]?.contentType).toBe("application/ipp");
    expect(calls[0]?.auth).toBe(
      `Basic ${Buffer.from("u:pw").toString("base64")}`,
    );
    expect(Buffer.from(calls[0]!.body).includes(Buffer.from("^XA^XZ"))).toBe(
      true,
    );
    const probe = await probeMachine(target, transports);
    expect(probe).toEqual({
      detail: "ipp://printer.local:631/ipp/print is idle",
      ok: true,
    });

    const failing = createTransports({
      fetch: async () =>
        new Response(new Uint8Array([1, 1, 0x04, 0x06, 0, 0, 0, 1, 3])),
    });
    const bad = await sendToMachine(
      [file("a.zpl", "x")],
      target,
      { reference: "r" },
      failing,
    );
    expect(bad).toEqual({
      error: "IPP ipp://printer.local:631/ipp/print: client-error-not-found",
      ok: false,
    });
  });
});

describe("printnode transport", () => {
  test("posts raw_base64 / pdf_base64 with basic auth", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/printers/55")) {
        return Response.json([{ name: "Zebra", state: "online" }]);
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        `Basic ${Buffer.from("key:").toString("base64")}`,
      );
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);

      return new Response("123");
    };
    const transports = createTransports({ fetch: fakeFetch });
    const target = {
      apiKey: "key",
      printerId: 55,
      transport: "printnode" as const,
    };
    const result = await sendToMachine(
      [
        file("a.zpl", "^XA"),
        {
          bytes: new Uint8Array([1]),
          filename: "b.pdf",
          format: "pdf",
          mime: "application/pdf",
        },
      ],
      target,
      { reference: "ORD-2" },
      transports,
    );
    expect(result).toEqual({
      detail: "PrintNode queued a.zpl, b.pdf on printer #55",
      jobId: "123,123",
      ok: true,
    });
    expect(bodies[0]?.contentType).toBe("raw_base64");
    expect(bodies[1]?.contentType).toBe("pdf_base64");
    expect(bodies[0]?.printerId).toBe(55);
    expect(await probeMachine(target, transports)).toEqual({
      detail: "PrintNode printer Zebra is online",
      ok: true,
    });
  });
});

describe("settings helpers", () => {
  test("every kind has a label, help and fields", () => {
    for (const kind of MACHINE_TRANSPORT_KINDS) {
      expect(transportHelp(kind).length).toBeGreaterThan(20);
      expect(Array.isArray(transportFieldsFor(kind))).toBe(true);
    }
    expect(transportFieldsFor("raw-tcp").map((f) => f.key)).toEqual([
      "host",
      "port",
    ]);
    expect(
      encodeIppRequest({
        operation: "print-job",
        operationAttributes: [],
        requestId: 1,
      })[8],
    ).toBe(IPP_TAGS.operationAttributes);
  });
});
