/* Machine-side telemetry watchers. Every path is event-driven: the OS tells us
 * a report appeared, the printer pushes an alert or a trap, the RIP posts to a
 * webhook. Nothing here runs a query on a timer — the only repeating work is
 * the slow rescan that heals filesystem events the OS dropped (network shares
 * lose them), and reconnecting a dropped socket. */

import { watch as fsWatch } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { join } from "node:path";
import {
  DEFAULT_ALERT_PORT,
  DEFAULT_SNMP_COMMUNITY,
  DEFAULT_SNMP_PORT,
  DEFAULT_SNMP_TRAP_PORT,
  DEFAULT_STATUS_PORT,
  DEFAULT_ZEBRA_QUERY,
  decodeSnmpPrinterStatus,
  decodeZebraAlert,
  decodeZebraStatus,
  parseMachineReport,
  referenceFromJobName,
  stateFromText,
  type MachineReading,
  type MachineRunEvent,
  type MachineRunEventKind,
  type MachineRunState,
  type TelemetryBinding,
  type TelemetryKind,
  type TelemetrySource,
} from "@absolutejs/commerce-machines/telemetry";
import {
  decodeSnmpMessage,
  encodeSnmpGet,
  encodeSnmpInformResponse,
  PDU_INFORM,
  PDU_RESPONSE,
  PDU_TRAP_V1,
  PDU_TRAP_V2,
  SNMP_TRAP_OID,
  varbindRecord,
} from "./snmp";

export type TelemetryEmit = (event: MachineRunEvent) => void;

export type TelemetryLogger = (message: string) => void;

/** Sidecar remembering which report files were already read. */
export const SEEN_SIDECAR = ".absolutejs-seen";
/** Filesystem events are coalesced over this window before a directory read. */
export const DEFAULT_DEBOUNCE_MS = 250;
/** Safety net for dropped inotify events — NOT the primary path. */
export const DEFAULT_RESCAN_SECONDS = 300;
export const DEFAULT_WEBHOOK_PORT = 8787;

export type FsSeam = {
  watch?: (path: string, listener: () => void) => { close: () => void };
  readdir?: (path: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, text: string) => Promise<void>;
};

export type TcpSocketLike = {
  write: (data: Uint8Array | string) => number;
  end: () => void;
};

export type TcpConnect = (options: {
  host: string;
  port: number;
  onData: (chunk: Uint8Array) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
  onOpen: (socket: TcpSocketLike) => void;
}) => Promise<{ close: () => void }>;

export type TcpListen = (options: {
  port: number;
  onData: (remoteAddress: string, chunk: Uint8Array) => void;
}) => Promise<{ close: () => void }>;

export type UdpBind = (options: {
  port: number;
  onMessage: (
    remoteAddress: string,
    message: Uint8Array,
    reply: (payload: Uint8Array) => void,
  ) => void;
}) => Promise<{ close: () => void }>;

export type HttpServe = (options: {
  port: number;
  onRequest: (request: Request) => Promise<Response>;
}) => Promise<{ close: () => void }>;

export type WatcherOptions = {
  emit: TelemetryEmit;
  log?: TelemetryLogger;
  now?: () => Date;
  fs?: FsSeam;
  connect?: TcpConnect;
  listen?: TcpListen;
  udp?: UdpBind;
  serve?: HttpServe;
  fetch?: typeof fetch;
  /** Local port the webhook receiver listens on (default 8787). */
  webhookPort?: number;
  debounceMs?: number;
  rescanSeconds?: number;
  /** Emit for report files that already existed the first time we look. */
  emitExisting?: boolean;
  timeoutMs?: number;
};

export type Watcher = {
  machineId: string;
  kind: TelemetryKind;
  /** What the shop should be told to configure, in one line. */
  describe: string;
  stop: () => Promise<void>;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const noop = () => {};

// ---------------------------------------------------------------- emitting

type Emitter = (
  reading: MachineReading,
  options?: {
    reference?: string;
    kind?: MachineRunEventKind;
    always?: boolean;
  },
) => void;

/**
 * Turn readings into events. Pushed signals are events by definition, but a
 * printer that re-announces the same condition should not duplicate a run
 * boundary, so an unchanged state is dropped unless the caller says otherwise
 * (a finished report always carries new job data).
 */
export const createEmitter = (
  machineId: string,
  emit: TelemetryEmit,
): Emitter => {
  let last: MachineRunState | undefined;

  return (reading, options = {}) => {
    const kind =
      options.kind ??
      (reading.state === "error"
        ? "error"
        : reading.state === "running"
          ? last === "running"
            ? "progress"
            : "start"
          : last === "running"
            ? "finish"
            : "progress");
    /* A printer that re-announces the same condition should not produce a
     * second event; an explicit kind (a finished report) always goes out. */
    if (
      !options.always &&
      options.kind === undefined &&
      last === reading.state
    ) {
      return;
    }
    last = reading.state;
    emit({
      at: reading.at,
      kind,
      machineId,
      reading,
      reference: options.reference,
    });
  };
};

// ------------------------------------------------------------ report folder

/** `*` and `?` only — shops write `*.txt`, not regular expressions. */
export const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );

type FolderState = {
  seen: Set<string>;
  baselined: boolean;
};

export type FolderScanResult = { events: number; read: string[] };

const loadSeen = async (
  path: string,
  read: (path: string) => Promise<string>,
): Promise<string[] | null> => {
  try {
    const parsed: unknown = JSON.parse(await read(join(path, SEEN_SIDECAR)));

    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : null;
  } catch {
    return null;
  }
};

/**
 * Read every matching file we have not read before, emit a `finish` event per
 * parsed report, and remember it. Files are never moved or deleted — the seen
 * set lives in memory and in a `.absolutejs-seen` sidecar so a restart does not
 * re-import the shop's history.
 */
export const scanReportFolder = async (
  source: Extract<TelemetrySource, { kind: "report-folder" }>,
  state: FolderState,
  emitter: Emitter,
  options: WatcherOptions,
): Promise<FolderScanResult> => {
  const list = options.fs?.readdir ?? ((path: string) => readdir(path));
  const read =
    options.fs?.readFile ?? ((path: string) => readFile(path, "utf8"));
  const write =
    options.fs?.writeFile ??
    ((path: string, text: string) => writeFile(path, text, "utf8"));
  const now = options.now ?? (() => new Date());
  const matches = globToRegExp(source.pattern ?? "*");
  let names: string[];
  try {
    names = await list(source.path);
  } catch (error) {
    options.log?.(`report folder ${source.path}: ${errorMessage(error)}`);

    return { events: 0, read: [] };
  }
  if (!state.baselined) {
    const remembered = await loadSeen(source.path, read);
    state.baselined = true;
    if (remembered === null && !options.emitExisting) {
      // First ever run: adopt what is already there instead of replaying it.
      for (const name of names) state.seen.add(name);
      await write(
        join(source.path, SEEN_SIDECAR),
        JSON.stringify(names.slice(-2000)),
      ).catch(() => undefined);

      return { events: 0, read: [] };
    }
    for (const name of remembered ?? []) state.seen.add(name);
  }
  const fresh = names
    .filter((name) => name !== SEEN_SIDECAR && !state.seen.has(name))
    .filter((name) => matches.test(name))
    .sort();
  const readNames: string[] = [];
  let events = 0;
  for (const name of fresh) {
    state.seen.add(name);
    readNames.push(name);
    let text: string;
    try {
      text = await read(join(source.path, name));
    } catch (error) {
      options.log?.(`report ${name}: ${errorMessage(error)}`);
      continue;
    }
    const reading = parseMachineReport(text, source.parser ?? "generic-kv", {
      now,
    });
    if (!reading) {
      options.log?.(`report ${name}: nothing job-shaped in it, skipped`);
      continue;
    }
    emitter(reading, {
      always: true,
      kind: reading.state === "error" ? "error" : "finish",
      reference: referenceFromJobName(reading.jobName ?? name),
    });
    events += 1;
  }
  if (readNames.length > 0) {
    await write(
      join(source.path, SEEN_SIDECAR),
      JSON.stringify([...state.seen].slice(-2000)),
    ).catch((error: unknown) =>
      options.log?.(`could not write ${SEEN_SIDECAR}: ${errorMessage(error)}`),
    );
  }

  return { events, read: readNames };
};

const startFolderWatcher = async (
  machineId: string,
  source: Extract<TelemetrySource, { kind: "report-folder" }>,
  options: WatcherOptions,
): Promise<Watcher> => {
  const emitter = createEmitter(machineId, options.emit);
  const state: FolderState = { baselined: false, seen: new Set<string>() };
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const rescanSeconds = options.rescanSeconds ?? DEFAULT_RESCAN_SECONDS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const scan = async () => {
    if (running) {
      again = true;

      return;
    }
    running = true;
    try {
      await scanReportFolder(source, state, emitter, options);
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      await scan();
    }
  };
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void scan();
    }, debounceMs);
  };
  await scan();
  const watch =
    options.fs?.watch ??
    ((path: string, listener: () => void) => {
      const watcher = fsWatch(path, { persistent: false }, () => listener());
      watcher.on("error", (error) =>
        options.log?.(`watch ${path}: ${errorMessage(error)}`),
      );

      return { close: () => watcher.close() };
    });
  let handle: { close: () => void } | undefined;
  try {
    handle = watch(source.path, trigger);
  } catch (error) {
    options.log?.(
      `cannot watch ${source.path} (${errorMessage(error)}); the safety-net rescan is the only path`,
    );
  }
  const heal =
    rescanSeconds > 0
      ? setInterval(() => {
          void scan();
        }, rescanSeconds * 1000)
      : undefined;
  heal?.unref?.();

  return {
    describe: `watching ${source.path} for ${source.pattern ?? "*"} (${source.parser ?? "generic-kv"})`,
    kind: "report-folder",
    machineId,
    stop: async () => {
      clearTimeout(timer);
      if (heal) clearInterval(heal);
      handle?.close();
    },
  };
};

// -------------------------------------------------------------- zebra alerts

const bunConnect: TcpConnect = async ({
  host,
  onClose,
  onData,
  onError,
  onOpen,
  port,
}) => {
  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      close: () => onClose(),
      connectError: (_socket, error) => onError(error),
      data: (_socket, data) => onData(new Uint8Array(data)),
      error: (_socket, error) => onError(error),
      open: (open) => onOpen(open),
    },
  });

  return { close: () => socket.end() };
};

const bunListen: TcpListen = async ({ onData, port }) => {
  const server = Bun.listen({
    hostname: "0.0.0.0",
    port,
    socket: {
      data: (socket, data) =>
        onData(socket.remoteAddress ?? "", new Uint8Array(data)),
      open: noop,
    },
  });

  return { close: () => server.stop(true) };
};

type AlertRoute = { host: string; handle: (text: string) => void };

const alertListeners = new Map<
  number,
  { server: { close: () => void }; routes: Set<AlertRoute> }
>();

const decodeAlertText = (text: string, now: Date): MachineReading | null =>
  decodeZebraAlert(text, now) ?? decodeZebraStatus(text, now);

const startZebraWatcher = async (
  machineId: string,
  source: Extract<TelemetrySource, { kind: "raw-tcp-status" }>,
  options: WatcherOptions,
): Promise<Watcher> => {
  const emitter = createEmitter(machineId, options.emit);
  const now = options.now ?? (() => new Date());
  const connect = options.connect ?? bunConnect;
  const listen = options.listen ?? bunListen;
  const port = source.port ?? DEFAULT_STATUS_PORT;
  const alertPort = source.alertPort ?? DEFAULT_ALERT_PORT;
  let stopped = false;
  let held: { close: () => void } | undefined;
  let backoff = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let buffer = "";

  const consume = (text: string) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const reading = decodeAlertText(line, now());
      if (reading) emitter(reading);
      else options.log?.(`${machineId}: unrecognised printer message ${line}`);
    }
  };

  /* The printer pushes alerts down a connection we hold open; a dropped
   * connection is reopened with backoff. Reconnecting is not polling — we
   * never ask the printer for anything on a schedule. */
  const hold = async () => {
    if (stopped) return;
    try {
      held = await connect({
        host: source.host,
        onClose: () => {
          if (stopped) return;
          options.log?.(
            `${machineId}: alert connection to ${source.host}:${port} closed, reopening in ${Math.round(backoff / 1000)} s`,
          );
          retry = setTimeout(() => {
            void hold();
          }, backoff);
          retry.unref?.();
          backoff = Math.min(backoff * 2, 60_000);
        },
        onData: (chunk) => consume(new TextDecoder().decode(chunk)),
        onError: (error) =>
          options.log?.(
            `${machineId}: ${source.host}:${port} ${errorMessage(error)}`,
          ),
        onOpen: () => {
          backoff = 1000;
        },
        port,
      });
    } catch (error) {
      options.log?.(
        `${machineId}: cannot reach ${source.host}:${port} (${errorMessage(error)})`,
      );
      retry = setTimeout(() => {
        void hold();
      }, backoff);
      retry.unref?.();
      backoff = Math.min(backoff * 2, 60_000);
    }
  };
  await hold();

  // Printers configured to dial the bridge instead land on the alert port.
  const route: AlertRoute = { handle: consume, host: source.host };
  let listener = alertListeners.get(alertPort);
  if (!listener) {
    const routes = new Set<AlertRoute>();
    try {
      const server = await listen({
        onData: (remoteAddress, chunk) => {
          const text = new TextDecoder().decode(chunk);
          const matched = [...routes].filter(
            (candidate) => candidate.host === remoteAddress,
          );
          const targets = matched.length > 0 ? matched : [...routes];
          for (const target of targets) target.handle(text);
        },
        port: alertPort,
      });
      listener = { routes, server };
      alertListeners.set(alertPort, listener);
    } catch (error) {
      options.log?.(
        `cannot listen for printer alerts on ${alertPort}: ${errorMessage(error)}`,
      );
    }
  }
  listener?.routes.add(route);

  return {
    describe: `holding ${source.host}:${port} open for unsolicited alerts and listening on ${alertPort}; configure the printer with ~SX`,
    kind: "raw-tcp-status",
    machineId,
    stop: async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      held?.close();
      const entry = alertListeners.get(alertPort);
      if (!entry) return;
      entry.routes.delete(route);
      if (entry.routes.size === 0) {
        entry.server.close();
        alertListeners.delete(alertPort);
      }
    },
  };
};

// --------------------------------------------------------------- snmp traps

const nodeUdp: UdpBind = async ({ onMessage, port }) =>
  new Promise((resolve, reject) => {
    let socket: UdpSocket;
    try {
      socket = createSocket({ reuseAddr: true, type: "udp4" });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));

      return;
    }
    socket.on("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.on("message", (message, info) => {
      onMessage(info.address, new Uint8Array(message), (payload) => {
        socket.send(payload, info.port, info.address);
      });
    });
    socket.on("listening", () => {
      socket.unref();
      resolve({ close: () => socket.close() });
    });
    socket.bind(port);
  });

type TrapRoute = {
  host: string;
  handle: (values: Record<string, number | string>, trapOid?: string) => void;
};

const trapListeners = new Map<
  number,
  { server: { close: () => void }; routes: Set<TrapRoute> }
>();

const startSnmpWatcher = async (
  machineId: string,
  source: Extract<TelemetrySource, { kind: "snmp-printer" }>,
  options: WatcherOptions,
): Promise<Watcher> => {
  const emitter = createEmitter(machineId, options.emit);
  const now = options.now ?? (() => new Date());
  const bind = options.udp ?? nodeUdp;
  const trapPort = source.trapPort ?? DEFAULT_SNMP_TRAP_PORT;
  const route: TrapRoute = {
    handle: (values, trapOid) => {
      const reading = decodeSnmpPrinterStatus(values, now());
      const detail = [reading.detail ?? "", trapOid ? `trap ${trapOid}` : ""]
        .filter((part) => part.length > 0)
        .join(", ");
      emitter(
        { ...reading, detail, raw: JSON.stringify(values).slice(0, 500) },
        { always: reading.pageCount !== undefined },
      );
    },
    host: source.host,
  };
  let listener = trapListeners.get(trapPort);
  if (!listener) {
    const routes = new Set<TrapRoute>();
    try {
      const server = await bind({
        onMessage: (remoteAddress, message, reply) => {
          const decoded = decodeSnmpMessage(message);
          if ("error" in decoded) {
            options.log?.(`SNMP trap from ${remoteAddress}: ${decoded.error}`);

            return;
          }
          if (
            decoded.pduTag !== PDU_TRAP_V1 &&
            decoded.pduTag !== PDU_TRAP_V2 &&
            decoded.pduTag !== PDU_INFORM
          ) {
            return;
          }
          // An inform is a trap that wants an acknowledgement.
          if (decoded.pduTag === PDU_INFORM) {
            reply(encodeSnmpInformResponse(decoded));
          }
          const values = varbindRecord(decoded.varbinds);
          const trapOid = decoded.varbinds.find(
            (varbind) => varbind.oid === SNMP_TRAP_OID,
          )?.value;
          const matched = [...routes].filter(
            (candidate) => candidate.host === remoteAddress,
          );
          for (const target of matched.length > 0 ? matched : [...routes]) {
            target.handle(
              values,
              typeof trapOid === "string" ? trapOid : undefined,
            );
          }
        },
        port: trapPort,
      });
      listener = { routes, server };
      trapListeners.set(trapPort, listener);
    } catch (error) {
      options.log?.(
        `cannot listen for SNMP traps on ${trapPort}: ${errorMessage(error)}${
          trapPort < 1024 ? " (ports below 1024 need root)" : ""
        }`,
      );
    }
  }
  listener?.routes.add(route);

  return {
    describe: `listening for SNMP traps from ${source.host} on UDP ${trapPort}; point the printer's trap destination at this PC`,
    kind: "snmp-printer",
    machineId,
    stop: async () => {
      const entry = trapListeners.get(trapPort);
      if (!entry) return;
      entry.routes.delete(route);
      if (entry.routes.size === 0) {
        entry.server.close();
        trapListeners.delete(trapPort);
      }
    },
  };
};

// ----------------------------------------------------------------- webhook

const bunServe: HttpServe = async ({ onRequest, port }) => {
  const server = Bun.serve({ fetch: (request) => onRequest(request), port });

  return { close: () => void server.stop(true) };
};

type WebhookRoute = {
  path: string;
  secret?: string;
  jsonPath?: string;
  handle: (body: string, contentType: string) => void;
};

const webhookServers = new Map<
  number,
  { server: { close: () => void }; routes: Map<string, WebhookRoute> }
>();

/** `printer.state`, `jobs[0].status` — enough for a status payload. */
export const readJsonPath = (value: unknown, path: string): unknown => {
  let current = value;
  for (const segment of path.split(".")) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    if (match[1] !== undefined && match[1].length > 0) {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[match[1]];
    }
    for (const index of match[2]?.match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(index)];
    }
  }

  return current;
};

/** Turn a webhook body into a reading: JSON through the report vocabulary, or keywords. */
export const readingFromWebhook = (
  body: string,
  options: { jsonPath?: string; now: () => Date },
): MachineReading | null => {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  if (options.jsonPath !== undefined && options.jsonPath.length > 0) {
    try {
      const value = readJsonPath(JSON.parse(trimmed), options.jsonPath);
      const state = stateFromText(String(value));
      if (state !== undefined) {
        return {
          at: options.now().toISOString(),
          detail: String(value),
          raw: trimmed.slice(0, 500),
          state,
        };
      }
    } catch {
      // Fall through to the generic readers below.
    }
  }
  const parsed = parseMachineReport(
    trimmed,
    trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "generic-kv",
    { now: options.now },
  );
  if (parsed) return parsed;
  const state = stateFromText(trimmed);

  return state === undefined
    ? null
    : {
        at: options.now().toISOString(),
        detail: trimmed.slice(0, 200),
        raw: trimmed.slice(0, 500),
        state,
      };
};

const startWebhookWatcher = async (
  machineId: string,
  source: Extract<TelemetrySource, { kind: "http-status" }>,
  options: WatcherOptions,
): Promise<Watcher> => {
  const emitter = createEmitter(machineId, options.emit);
  const now = options.now ?? (() => new Date());
  const serve = options.serve ?? bunServe;
  const port = options.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const path = source.webhookPath ?? `/telemetry/${machineId}`;
  const route: WebhookRoute = {
    handle: (body) => {
      const reading = readingFromWebhook(body, {
        jsonPath: source.jsonPath,
        now,
      });
      if (!reading) {
        options.log?.(`${machineId}: webhook body not understood, ignored`);

        return;
      }
      emitter(reading, {
        always: reading.elapsedSeconds !== undefined,
        reference: referenceFromJobName(reading.jobName),
      });
    },
    jsonPath: source.jsonPath,
    path,
    secret: source.webhookSecret,
  };
  let entry = webhookServers.get(port);
  if (!entry) {
    const routes = new Map<string, WebhookRoute>();
    try {
      const server = await serve({
        onRequest: async (request) => {
          const url = new URL(request.url);
          const target = routes.get(url.pathname);
          if (!target) return new Response("no such machine", { status: 404 });
          if (
            target.secret !== undefined &&
            request.headers.get("x-telemetry-secret") !== target.secret &&
            url.searchParams.get("secret") !== target.secret
          ) {
            return new Response("bad secret", { status: 401 });
          }
          if (request.method !== "POST" && request.method !== "PUT") {
            return new Response("post here", { status: 405 });
          }
          target.handle(
            await request.text(),
            request.headers.get("content-type") ?? "",
          );

          return new Response("ok");
        },
        port,
      });
      entry = { routes, server };
      webhookServers.set(port, entry);
    } catch (error) {
      options.log?.(
        `cannot serve telemetry webhooks on ${port}: ${errorMessage(error)}`,
      );
    }
  }
  entry?.routes.set(path, route);

  return {
    describe: `serving http://<this-pc>:${port}${path} — paste that into the machine software's notification settings`,
    kind: "http-status",
    machineId,
    stop: async () => {
      const server = webhookServers.get(port);
      if (!server) return;
      server.routes.delete(path);
      if (server.routes.size === 0) {
        server.server.close();
        webhookServers.delete(port);
      }
    },
  };
};

// ------------------------------------------------------------------- hub

export const startWatcher = async (
  binding: TelemetryBinding,
  options: WatcherOptions,
): Promise<Watcher | null> => {
  switch (binding.source.kind) {
    case "report-folder":
      return startFolderWatcher(binding.machineId, binding.source, options);
    case "raw-tcp-status":
      return startZebraWatcher(binding.machineId, binding.source, options);
    case "snmp-printer":
      return startSnmpWatcher(binding.machineId, binding.source, options);
    case "http-status":
      return startWebhookWatcher(binding.machineId, binding.source, options);
    case "manual":
      return null;
  }
};

export type TelemetryHub = {
  /** Reconcile the running watchers with the sources the server pushed down. */
  set: (bindings: TelemetryBinding[]) => Promise<void>;
  running: () => Watcher[];
  stop: () => Promise<void>;
};

const bindingKey = (binding: TelemetryBinding) =>
  `${binding.machineId}|${JSON.stringify(binding.source)}`;

/** Owns one watcher per binding; adds and drops them as the server changes them. */
export const createTelemetryHub = (options: WatcherOptions): TelemetryHub => {
  const watchers = new Map<string, Watcher>();

  return {
    running: () => [...watchers.values()],
    set: async (bindings) => {
      const wanted = new Map(
        bindings.map((binding) => [bindingKey(binding), binding]),
      );
      for (const [key, watcher] of watchers) {
        if (wanted.has(key)) continue;
        await watcher.stop();
        watchers.delete(key);
        options.log?.(`stopped watching ${watcher.machineId}`);
      }
      for (const [key, binding] of wanted) {
        if (watchers.has(key)) continue;
        const watcher = await startWatcher(binding, options);
        if (!watcher) continue;
        watchers.set(key, watcher);
        options.log?.(`telemetry ${binding.machineId}: ${watcher.describe}`);
      }
    },
    stop: async () => {
      for (const watcher of watchers.values()) await watcher.stop();
      watchers.clear();
    },
  };
};

// ------------------------------------------------------------- test reading

export type ProbeResult =
  | { ok: true; reading: MachineReading; detail: string }
  | { ok: false; error: string };

/**
 * One-shot reading for the settings screen's Test Reading button. This is the
 * ONLY place a machine is queried; live telemetry never polls.
 */
export const probeSource = async (
  source: TelemetrySource,
  options: Partial<WatcherOptions> = {},
): Promise<ProbeResult> => {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 5000;
  switch (source.kind) {
    case "manual":
      return { error: "manual machines are not measured", ok: false };
    case "report-folder": {
      const list = options.fs?.readdir ?? ((path: string) => readdir(path));
      const read =
        options.fs?.readFile ?? ((path: string) => readFile(path, "utf8"));
      try {
        const matches = globToRegExp(source.pattern ?? "*");
        const names = (await list(source.path))
          .filter((name) => name !== SEEN_SIDECAR && matches.test(name))
          .sort();
        const newest = names[names.length - 1];
        if (newest === undefined) {
          return {
            error: `no files matching ${source.pattern ?? "*"} in ${source.path}`,
            ok: false,
          };
        }
        const reading = parseMachineReport(
          await read(join(source.path, newest)),
          source.parser ?? "generic-kv",
          { now },
        );

        return reading
          ? { detail: `read ${newest}`, ok: true, reading }
          : {
              error: `${newest} did not parse as a production report`,
              ok: false,
            };
      } catch (error) {
        return { error: `${source.path}: ${errorMessage(error)}`, ok: false };
      }
    }
    case "raw-tcp-status": {
      const connect = options.connect ?? bunConnect;
      const port = source.port ?? DEFAULT_STATUS_PORT;
      const query = source.query ?? DEFAULT_ZEBRA_QUERY;
      const chunks: string[] = [];

      return new Promise<ProbeResult>((resolve) => {
        let settled = false;
        const finish = (result: ProbeResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          handle?.close();
          resolve(result);
        };
        const timer = setTimeout(() => {
          const text = chunks.join("");
          const reading = text.length > 0 ? decodeAlertText(text, now()) : null;
          finish(
            reading
              ? { detail: `replied to ${query}`, ok: true, reading }
              : {
                  error: `${source.host}:${port} did not answer ${query} in ${timeoutMs} ms`,
                  ok: false,
                },
          );
        }, timeoutMs);
        let handle: { close: () => void } | undefined;
        connect({
          host: source.host,
          onClose: noop,
          onData: (chunk) => {
            chunks.push(new TextDecoder().decode(chunk));
            const reading = decodeAlertText(chunks.join(""), now());
            if (reading) {
              finish({ detail: `replied to ${query}`, ok: true, reading });
            }
          },
          onError: (error) =>
            finish({
              error: `${source.host}:${port}: ${errorMessage(error)}`,
              ok: false,
            }),
          onOpen: (socket) => {
            socket.write(new TextEncoder().encode(query));
          },
          port,
        })
          .then((opened) => {
            handle = opened;
            if (settled) opened.close();
          })
          .catch((error: unknown) =>
            finish({
              error: `${source.host}:${port}: ${errorMessage(error)}`,
              ok: false,
            }),
          );
      });
    }
    case "snmp-printer": {
      const bind = options.udp ?? nodeUdp;
      const port = source.port ?? DEFAULT_SNMP_PORT;
      const community = source.community ?? DEFAULT_SNMP_COMMUNITY;

      return new Promise<ProbeResult>((resolve) => {
        const socket = createSocket({ type: "udp4" });
        let settled = false;
        const finish = (result: ProbeResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.close();
          resolve(result);
        };
        const timer = setTimeout(
          () =>
            finish({
              error: `${source.host}:${port} did not answer SNMP in ${timeoutMs} ms`,
              ok: false,
            }),
          timeoutMs,
        );
        socket.on("error", (error) =>
          finish({ error: errorMessage(error), ok: false }),
        );
        socket.on("message", (message) => {
          const decoded = decodeSnmpMessage(new Uint8Array(message));
          if ("error" in decoded) {
            finish({ error: `SNMP: ${decoded.error}`, ok: false });

            return;
          }
          if (decoded.pduTag !== PDU_RESPONSE) return;
          finish({
            detail: `SNMP GET answered by ${source.host}`,
            ok: true,
            reading: decodeSnmpPrinterStatus(
              varbindRecord(decoded.varbinds),
              now(),
            ),
          });
        });
        const request = encodeSnmpGet({
          community,
          oids: [
            "1.3.6.1.2.1.25.3.5.1.1.1",
            "1.3.6.1.2.1.25.3.2.1.5.1",
            "1.3.6.1.2.1.43.10.2.1.4.1.1",
            "1.3.6.1.2.1.25.3.2.1.3.1",
          ],
        });
        socket.send(request, port, source.host, (error) => {
          if (error) finish({ error: errorMessage(error), ok: false });
        });
        void bind;
      });
    }
    case "http-status": {
      if (source.url === undefined || source.url.length === 0) {
        return {
          error:
            "this machine is set up to POST to the bridge; there is no URL to query. Trigger a real event from the machine software instead.",
          ok: false,
        };
      }
      const fetchImpl = options.fetch ?? fetch;
      try {
        const response = await fetchImpl(source.url, {
          headers: source.username
            ? {
                Authorization: `Basic ${Buffer.from(`${source.username}:${source.password ?? ""}`).toString("base64")}`,
              }
            : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return { error: `${source.url}: HTTP ${response.status}`, ok: false };
        }
        const reading = readingFromWebhook(await response.text(), {
          jsonPath: source.jsonPath,
          now,
        });

        return reading
          ? { detail: `read ${source.url}`, ok: true, reading }
          : { error: `${source.url}: reply not understood`, ok: false };
      } catch (error) {
        return { error: `${source.url}: ${errorMessage(error)}`, ok: false };
      }
    }
  }
};
