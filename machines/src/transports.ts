/* "Send straight to the machine": server-side transports that deliver an
 * exported job to a folder, a raw TCP printer port, an IPP printer, PrintNode,
 * or a bridge agent on the shop LAN. */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  bytesToBase64,
  type BridgeAction,
  type BridgeStore,
  type SendResult,
} from "./bridge";
import {
  decodeIppResponse,
  encodeGetPrinterAttributes,
  encodePrintJob,
  ippStatusName,
  ippStatusOk,
  ippToHttpUrl,
} from "./ipp";
import type { MachineExport } from "./types";

export type { BridgeAction, SendResult } from "./bridge";

export type MachineTransportKind =
  "download" | "folder" | "raw-tcp" | "ipp" | "printnode" | "bridge";

export const MACHINE_TRANSPORT_KINDS: MachineTransportKind[] = [
  "download",
  "folder",
  "raw-tcp",
  "ipp",
  "printnode",
  "bridge",
];

export type MachineTarget =
  | { transport: "download" }
  | { transport: "folder"; path: string }
  | { transport: "raw-tcp"; host: string; port?: number }
  | { transport: "ipp"; url: string; username?: string; password?: string }
  | {
      transport: "printnode";
      apiKey: string;
      printerId: number;
      title?: string;
    }
  | { transport: "bridge"; bridgeId: string; action: BridgeAction };

export type TargetFor<K extends MachineTransportKind> = Extract<
  MachineTarget,
  { transport: K }
>;

export type SendContext = { reference: string };

export type MachineTransport<
  K extends MachineTransportKind = MachineTransportKind,
> = {
  kind: K;
  describe: (target: TargetFor<K>) => string;
  /** Cheap reachability check (connect / GET) without sending a job. */
  probe?: (target: TargetFor<K>) => Promise<SendResult>;
  send: (
    files: MachineExport[],
    target: TargetFor<K>,
    ctx: SendContext,
  ) => Promise<SendResult>;
};

export type MachineTransports = {
  [K in MachineTransportKind]: MachineTransport<K>;
};

export type TransportOptions = {
  fetch?: typeof fetch;
  bridge?: BridgeStore;
  /** Raw TCP / HTTP timeout in ms (default 10 000). */
  timeoutMs?: number;
};

export const DEFAULT_RAW_TCP_PORT = 9100;
export const PRINTNODE_API = "https://api.printnode.com";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A filename safe to drop in a folder: base name only, no traversal, no shell-hostile characters. */
export const safeFilename = (filename: string) => {
  const base = basename(filename.replace(/\\/g, "/"))
    .replace(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "");

  return base.length > 0 ? base : "job";
};

const hasTraversal = (path: string) =>
  path.split(/[\\/]/).some((segment) => segment === "..");

const listFilenames = (files: MachineExport[]) =>
  files.map((file) => file.filename).join(", ");

// ---------------------------------------------------------------- folder

export const writeToFolder = async (
  files: MachineExport[],
  path: string,
): Promise<SendResult> => {
  if (path.trim().length === 0)
    return { error: "folder path is empty", ok: false };
  if (hasTraversal(path)) {
    return { error: "folder path must not contain '..'", ok: false };
  }
  try {
    await mkdir(path, { recursive: true });
    const written: string[] = [];
    for (const file of files) {
      const target = join(path, safeFilename(file.filename));
      await Bun.write(target, file.bytes);
      written.push(target);
    }

    return { detail: `wrote ${written.join(", ")}`, ok: true };
  } catch (error) {
    return { error: `folder write failed: ${errorMessage(error)}`, ok: false };
  }
};

// --------------------------------------------------------------- raw tcp

export const sendRawTcp = (
  host: string,
  port: number,
  payload: Uint8Array,
  timeoutMs = 10_000,
) =>
  new Promise<SendResult>((resolve) => {
    let settled = false;
    let offset = 0;
    const finish = (result: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        error: `${host}:${port} timed out after ${timeoutMs} ms`,
        ok: false,
      });
    }, timeoutMs);
    const pump = (socket: {
      write: (data: Uint8Array) => number;
      end: () => void;
    }) => {
      while (offset < payload.length) {
        const wrote = socket.write(payload.subarray(offset));
        if (wrote <= 0) return;
        offset += wrote;
      }
      socket.end();
    };
    Bun.connect({
      hostname: host,
      port,
      socket: {
        close: () => {
          if (offset >= payload.length) {
            finish({
              detail: `sent ${payload.length} bytes to ${host}:${port}`,
              ok: true,
            });
          } else {
            finish({
              error: `${host}:${port} closed after ${offset}/${payload.length} bytes`,
              ok: false,
            });
          }
        },
        connectError: (_socket, error) => {
          finish({
            error: `${host}:${port} unreachable: ${errorMessage(error)}`,
            ok: false,
          });
        },
        data: () => {},
        drain: (socket) => pump(socket),
        error: (_socket, error) => {
          finish({
            error: `${host}:${port}: ${errorMessage(error)}`,
            ok: false,
          });
        },
        open: (socket) => pump(socket),
      },
    }).catch((error: unknown) => {
      finish({
        error: `${host}:${port} unreachable: ${errorMessage(error)}`,
        ok: false,
      });
    });
  });

export const probeRawTcp = (host: string, port: number, timeoutMs = 5_000) =>
  new Promise<SendResult>((resolve) => {
    let settled = false;
    const finish = (result: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        error: `${host}:${port} timed out after ${timeoutMs} ms`,
        ok: false,
      });
    }, timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        close: () =>
          finish({ detail: `${host}:${port} accepted a connection`, ok: true }),
        connectError: (_socket, error) =>
          finish({
            error: `${host}:${port} unreachable: ${errorMessage(error)}`,
            ok: false,
          }),
        data: () => {},
        error: (_socket, error) =>
          finish({
            error: `${host}:${port}: ${errorMessage(error)}`,
            ok: false,
          }),
        open: (socket) => {
          socket.end();
          finish({ detail: `${host}:${port} accepted a connection`, ok: true });
        },
      },
    }).catch((error: unknown) =>
      finish({
        error: `${host}:${port} unreachable: ${errorMessage(error)}`,
        ok: false,
      }),
    );
  });

// ------------------------------------------------------------------- ipp

const basicAuth = (
  username?: string,
  password?: string,
): Record<string, string> =>
  username
    ? {
        Authorization: `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}`,
      }
    : {};

export const ippPrint = async (
  file: MachineExport,
  target: { url: string; username?: string; password?: string },
  ctx: SendContext,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SendResult> => {
  const body = encodePrintJob({
    document: file.bytes,
    documentFormat: file.mime || "application/octet-stream",
    jobName: `${ctx.reference} ${file.filename}`,
    printerUri: target.url,
    requestId: Math.floor(Math.random() * 0x7fffffff) + 1,
    user: target.username,
  });
  try {
    const response = await fetchImpl(ippToHttpUrl(target.url), {
      body,
      headers: {
        "Content-Type": "application/ipp",
        ...basicAuth(target.username, target.password),
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { error: `IPP ${target.url}: HTTP ${response.status}`, ok: false };
    }
    const decoded = decodeIppResponse(
      new Uint8Array(await response.arrayBuffer()),
    );
    if ("error" in decoded)
      return { error: `IPP ${target.url}: ${decoded.error}`, ok: false };
    if (!ippStatusOk(decoded.statusCode)) {
      return {
        error: `IPP ${target.url}: ${ippStatusName(decoded.statusCode)}`,
        ok: false,
      };
    }
    const jobId = decoded.attributes.find(
      (attribute) => attribute.name === "job-id",
    );

    return {
      detail: `IPP ${ippStatusName(decoded.statusCode)} for ${file.filename}`,
      jobId: jobId ? String(jobId.value) : undefined,
      ok: true,
    };
  } catch (error) {
    return { error: `IPP ${target.url}: ${errorMessage(error)}`, ok: false };
  }
};

export const ippProbe = async (
  target: { url: string; username?: string; password?: string },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SendResult> => {
  try {
    const response = await fetchImpl(ippToHttpUrl(target.url), {
      body: encodeGetPrinterAttributes(target.url),
      headers: {
        "Content-Type": "application/ipp",
        ...basicAuth(target.username, target.password),
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      return { error: `IPP ${target.url}: HTTP ${response.status}`, ok: false };
    const decoded = decodeIppResponse(
      new Uint8Array(await response.arrayBuffer()),
    );
    if ("error" in decoded)
      return { error: `IPP ${target.url}: ${decoded.error}`, ok: false };
    if (!ippStatusOk(decoded.statusCode)) {
      return {
        error: `IPP ${target.url}: ${ippStatusName(decoded.statusCode)}`,
        ok: false,
      };
    }
    const name = decoded.attributes.find(
      (attribute) => attribute.name === "printer-name",
    );
    const state = decoded.attributes.find(
      (attribute) => attribute.name === "printer-state",
    );
    const stateLabel =
      state?.value === 3
        ? "idle"
        : state?.value === 4
          ? "processing"
          : state?.value === 5
            ? "stopped"
            : "unknown";

    return {
      detail: `${name ? String(name.value) : target.url} is ${stateLabel}`,
      ok: true,
    };
  } catch (error) {
    return { error: `IPP ${target.url}: ${errorMessage(error)}`, ok: false };
  }
};

// ------------------------------------------------------------- printnode

const PRINTNODE_RAW_MIMES = new Set(["pdf"]);

const printNodeContentType = (file: MachineExport) =>
  PRINTNODE_RAW_MIMES.has(file.format) || file.mime === "application/pdf"
    ? "pdf_base64"
    : "raw_base64";

const printNodeAuth = (apiKey: string) => ({
  Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
});

// --------------------------------------------------------------- factory

export const createTransports = (
  options: TransportOptions = {},
): MachineTransports => {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const download: MachineTransport<"download"> = {
    describe: () => "Download the file and load it on the machine by hand",
    kind: "download",
    send: async () => ({ detail: "download", ok: true }),
  };

  const folder: MachineTransport<"folder"> = {
    describe: (target) => `Save to folder ${target.path}`,
    kind: "folder",
    probe: async (target) => {
      if (hasTraversal(target.path))
        return { error: "folder path must not contain '..'", ok: false };
      try {
        await mkdir(target.path, { recursive: true });
        const probeFile = join(target.path, `.absolutejs-probe-${Date.now()}`);
        await Bun.write(probeFile, "ok");
        await Bun.file(probeFile).delete();

        return { detail: `${target.path} is writable`, ok: true };
      } catch (error) {
        return { error: `${target.path}: ${errorMessage(error)}`, ok: false };
      }
    },
    send: (files, target) => writeToFolder(files, target.path),
  };

  const rawTcp: MachineTransport<"raw-tcp"> = {
    describe: (target) =>
      `Raw TCP to ${target.host}:${target.port ?? DEFAULT_RAW_TCP_PORT}`,
    kind: "raw-tcp",
    probe: (target) =>
      probeRawTcp(target.host, target.port ?? DEFAULT_RAW_TCP_PORT),
    send: async (files, target) => {
      const port = target.port ?? DEFAULT_RAW_TCP_PORT;
      const details: string[] = [];
      for (const file of files) {
        const result = await sendRawTcp(
          target.host,
          port,
          file.bytes,
          timeoutMs,
        );
        if (!result.ok)
          return { error: `${file.filename}: ${result.error}`, ok: false };
        details.push(`${file.filename} (${file.bytes.length} bytes)`);
      }

      return {
        detail: `sent ${details.join(", ")} to ${target.host}:${port}`,
        ok: true,
      };
    },
  };

  const ipp: MachineTransport<"ipp"> = {
    describe: (target) => `IPP print to ${target.url}`,
    kind: "ipp",
    probe: (target) => ippProbe(target, fetchImpl, timeoutMs),
    send: async (files, target, ctx) => {
      const jobIds: string[] = [];
      for (const file of files) {
        const result = await ippPrint(file, target, ctx, fetchImpl, timeoutMs);
        if (!result.ok) return result;
        if (result.jobId) jobIds.push(result.jobId);
      }

      return {
        detail: `IPP printed ${listFilenames(files)} on ${target.url}`,
        jobId: jobIds.length > 0 ? jobIds.join(",") : undefined,
        ok: true,
      };
    },
  };

  const printnode: MachineTransport<"printnode"> = {
    describe: (target) => `PrintNode printer #${target.printerId}`,
    kind: "printnode",
    probe: async (target) => {
      try {
        const response = await fetchImpl(
          `${PRINTNODE_API}/printers/${target.printerId}`,
          {
            headers: printNodeAuth(target.apiKey),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!response.ok)
          return { error: `PrintNode: HTTP ${response.status}`, ok: false };
        const printers: unknown = await response.json();
        const first = Array.isArray(printers)
          ? (printers[0] as unknown)
          : undefined;
        if (typeof first !== "object" || first === null) {
          return {
            error: `PrintNode printer #${target.printerId} not found`,
            ok: false,
          };
        }
        const record = first as Record<string, unknown>;

        return {
          detail: `PrintNode printer ${String(record.name ?? target.printerId)} is ${String(record.state ?? "unknown")}`,
          ok: true,
        };
      } catch (error) {
        return { error: `PrintNode: ${errorMessage(error)}`, ok: false };
      }
    },
    send: async (files, target, ctx) => {
      const jobIds: string[] = [];
      for (const file of files) {
        try {
          const response = await fetchImpl(`${PRINTNODE_API}/printjobs`, {
            body: JSON.stringify({
              content: bytesToBase64(file.bytes),
              contentType: printNodeContentType(file),
              printerId: target.printerId,
              source: "absolutejs",
              title: target.title ?? `${ctx.reference} ${file.filename}`,
            }),
            headers: {
              "Content-Type": "application/json",
              ...printNodeAuth(target.apiKey),
            },
            method: "POST",
            signal: AbortSignal.timeout(timeoutMs),
          });
          const text = await response.text();
          if (!response.ok) {
            return {
              error: `PrintNode: HTTP ${response.status} ${text.slice(0, 200)}`,
              ok: false,
            };
          }
          jobIds.push(text.trim().replace(/^"|"$/g, ""));
        } catch (error) {
          return { error: `PrintNode: ${errorMessage(error)}`, ok: false };
        }
      }

      return {
        detail: `PrintNode queued ${listFilenames(files)} on printer #${target.printerId}`,
        jobId: jobIds.join(","),
        ok: true,
      };
    },
  };

  const bridge: MachineTransport<"bridge"> = {
    describe: (target) =>
      `Bridge ${target.bridgeId} → ${describeBridgeAction(target.action)}`,
    kind: "bridge",
    probe: async (target) => {
      if (!options.bridge)
        return { error: "no bridge store configured", ok: false };
      const status = await options.bridge.status(target.bridgeId);
      if (!status.online) {
        return {
          error: status.lastSeen
            ? `bridge ${target.bridgeId} last seen ${status.lastSeen}`
            : `bridge ${target.bridgeId} has never connected`,
          ok: false,
        };
      }
      if (
        status.info &&
        !status.info.capabilities.includes(target.action.kind)
      ) {
        return {
          error: `bridge ${target.bridgeId} cannot do ${target.action.kind}`,
          ok: false,
        };
      }

      return {
        detail: `bridge ${target.bridgeId} online (${status.info?.hostname ?? "unknown host"})`,
        ok: true,
      };
    },
    send: async (files, target, ctx) => {
      if (!options.bridge)
        return { error: "no bridge store configured", ok: false };
      try {
        const job = await options.bridge.enqueue({
          action: target.action,
          bridgeId: target.bridgeId,
          files: files.map((file) => ({
            bytesBase64: bytesToBase64(file.bytes),
            filename: file.filename,
            mime: file.mime,
          })),
          reference: ctx.reference,
        });

        return {
          detail: `queued for bridge ${target.bridgeId} (job ${job.id})`,
          jobId: job.id,
          ok: true,
        };
      } catch (error) {
        return {
          error: `bridge enqueue failed: ${errorMessage(error)}`,
          ok: false,
        };
      }
    },
  };

  return { bridge, download, folder, ipp, printnode, "raw-tcp": rawTcp };
};

export const describeBridgeAction = (action: BridgeAction) => {
  switch (action.kind) {
    case "folder":
      return `folder ${action.path}`;
    case "raw-tcp":
      return `raw TCP ${action.host}:${action.port ?? DEFAULT_RAW_TCP_PORT}`;
    case "ipp":
      return `IPP ${action.url}`;
    case "os-print":
      return `OS printer "${action.printer}"`;
  }
};

/** Deliver files to a target, picking the transport by `target.transport`. */
export const sendToMachine = (
  files: MachineExport[],
  target: MachineTarget,
  ctx: SendContext,
  transports: MachineTransports = createTransports(),
): Promise<SendResult> => {
  switch (target.transport) {
    case "download":
      return transports.download.send(files, target, ctx);
    case "folder":
      return transports.folder.send(files, target, ctx);
    case "raw-tcp":
      return transports["raw-tcp"].send(files, target, ctx);
    case "ipp":
      return transports.ipp.send(files, target, ctx);
    case "printnode":
      return transports.printnode.send(files, target, ctx);
    case "bridge":
      return transports.bridge.send(files, target, ctx);
  }
};

/** Reachability check for a target (download always passes). */
export const probeMachine = async (
  target: MachineTarget,
  transports: MachineTransports = createTransports(),
): Promise<SendResult> => {
  switch (target.transport) {
    case "download":
      return { detail: "download needs no connection", ok: true };
    case "folder":
      return transports.folder.probe!(target);
    case "raw-tcp":
      return transports["raw-tcp"].probe!(target);
    case "ipp":
      return transports.ipp.probe!(target);
    case "printnode":
      return transports.printnode.probe!(target);
    case "bridge":
      return transports.bridge.probe!(target);
  }
};

/** Human-readable description of a target. */
export const describeTarget = (
  target: MachineTarget,
  transports: MachineTransports = createTransports(),
): string => {
  switch (target.transport) {
    case "download":
      return transports.download.describe(target);
    case "folder":
      return transports.folder.describe(target);
    case "raw-tcp":
      return transports["raw-tcp"].describe(target);
    case "ipp":
      return transports.ipp.describe(target);
    case "printnode":
      return transports.printnode.describe(target);
    case "bridge":
      return transports.bridge.describe(target);
  }
};

// -------------------------------------------------------- settings forms

export type TransportField = {
  key: string;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
  required?: boolean;
};

export const TRANSPORT_LABELS: Record<MachineTransportKind, string> = {
  bridge: "Shop bridge (agent on the shop network)",
  download: "Download and load by hand",
  folder: "Save to a folder / network share",
  ipp: "Network printer (IPP / AirPrint / CUPS)",
  printnode: "PrintNode cloud printing",
  "raw-tcp": "Direct to printer port (TCP 9100)",
};

export const transportFieldsFor = (
  kind: MachineTransportKind,
): TransportField[] => {
  switch (kind) {
    case "download":
      return [];
    case "folder":
      return [
        {
          key: "path",
          label: "Folder path",
          placeholder: "/mnt/embroidery-hotfolder or \\\\SHOP-PC\\Designs",
          required: true,
          type: "text",
        },
      ];
    case "raw-tcp":
      return [
        {
          key: "host",
          label: "Printer IP or hostname",
          placeholder: "192.168.1.50",
          required: true,
          type: "text",
        },
        {
          key: "port",
          label: "Port",
          placeholder: String(DEFAULT_RAW_TCP_PORT),
          type: "number",
        },
      ];
    case "ipp":
      return [
        {
          key: "url",
          label: "IPP URL",
          placeholder: "ipp://192.168.1.60:631/ipp/print",
          required: true,
          type: "text",
        },
        { key: "username", label: "Username (optional)", type: "text" },
        { key: "password", label: "Password (optional)", type: "password" },
      ];
    case "printnode":
      return [
        {
          key: "apiKey",
          label: "PrintNode API key",
          required: true,
          type: "password",
        },
        {
          key: "printerId",
          label: "PrintNode printer id",
          placeholder: "123456",
          required: true,
          type: "number",
        },
        { key: "title", label: "Job title prefix (optional)", type: "text" },
      ];
    case "bridge":
      return [
        {
          key: "bridgeId",
          label: "Bridge id",
          placeholder: "front-desk-pc",
          required: true,
          type: "text",
        },
      ];
  }
};

/** Plain-English help for the settings screen: when to use it and what to ask the shop. */
export const transportHelp = (kind: MachineTransportKind): string => {
  switch (kind) {
    case "download":
      return "Staff download the file and carry it to the machine on a USB stick or open it in the machine's software. Works for every machine; nothing to configure.";
    case "folder":
      return "The server writes the file into a folder the machine (or its RIP software) watches — a hot folder. Only works when the app server can see that folder: a local path, or a network share mounted on the server. If the app runs in the cloud, use the shop bridge with a folder action instead. Ask the shop: which folder does the machine software watch?";
    case "raw-tcp":
      return "Bytes go straight to the printer's port 9100 (Zebra and most label printers, many RIP spoolers). Only works when the server can reach the printer's IP — a shop LAN, VPN, or a printer with a public address. From the cloud, use the shop bridge with a raw-tcp action. Ask the shop: the printer's IP address (on its network settings printout) and confirm port 9100 is enabled.";
    case "ipp":
      return "Standard network printing (IPP / AirPrint / CUPS) — most office printers and a CUPS server in the shop. Needs the server to reach the printer URL, typically ipp://<ip>:631/ipp/print. From the cloud, use the shop bridge with an ipp action. Ask the shop: the printer's IP and whether it needs a username/password.";
    case "printnode":
      return "PrintNode is a paid cloud printing service: the shop installs the PrintNode client on a PC with the printer, and this server sends jobs through PrintNode's API. Works from anywhere with no networking setup. Ask the shop for their PrintNode API key and the printer id from the PrintNode dashboard.";
    case "bridge":
      return "The shop runs the free @absolutejs/machines-bridge agent on any PC or Raspberry Pi on its network. It polls this server for jobs and sends them to a folder, a printer port, an IPP printer or the OS print queue. Use this whenever the app is hosted in the cloud. Ask the shop: which computer stays on during working hours to run it?";
  }
};
