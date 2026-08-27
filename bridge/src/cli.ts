#!/usr/bin/env bun
import {
  TELEMETRY_KINDS,
  telemetryHelp,
  type ReportParser,
  type TelemetryKind,
  type TelemetrySource,
  type ZebraDialect,
} from "@absolutejs/commerce-machines/telemetry";
import { BRIDGE_VERSION, probeSource, runBridge } from "./index";
import { listPrinters } from "./printers";

const USAGE = `absolutejs-machines-bridge ${BRIDGE_VERSION}

Runs on a PC or Raspberry Pi on the shop network. It holds ONE socket open to
your app: the app pushes print/embroidery jobs down it, the agent delivers them
to a folder, a printer port (TCP 9100), an IPP printer or the OS print queue,
and pushes results and machine run telemetry back up. Nothing is polled.
It only executes those four typed actions — never shell commands.

Usage:
  bunx @absolutejs/machines-bridge --server https://shop.example --token XXXX [options]

Options:
  --server <url>       App base URL (or ABS_BRIDGE_SERVER)
  --token <token>      Bridge token from the app's Machines settings (or ABS_BRIDGE_TOKEN)
  --socket-path <p>    WebSocket path of the app's sync socket (default /sync/ws)
  --http-poll          LEGACY: poll /bridge/poll over HTTP instead of the socket
  --interval <sec>     LEGACY http-poll only: seconds between polls (default 3)
  --once               Do one pass of work and exit
  --no-telemetry       Do not watch machines for run telemetry
  --webhook-port <n>   Port the telemetry webhook receiver serves (default 8787)
  --list-printers      Print the OS print queues this machine can see and exit
  --no-printers        Skip printer discovery in the heartbeat
  --help               Show this help

Test one telemetry source and print the reading (the only time a machine is
ever queried — live telemetry is pushed by the machine, never polled):
  --probe report-folder  --path <dir> [--pattern '*.txt'] [--parser tajima-report]
  --probe raw-tcp-status --host <ip> [--port 9100] [--query '~HS']
  --probe snmp-printer   --host <ip> [--port 161] [--community public]
  --probe http-status    --url <url> [--username u] [--password p] [--json-path a.b]
  --telemetry-help <kind>  Explain a telemetry path in plain English
`;

type Args = {
  community?: string;
  help: boolean;
  host?: string;
  httpPoll: boolean;
  interval?: number;
  jsonPath?: string;
  listPrinters: boolean;
  noPrinters: boolean;
  noTelemetry: boolean;
  once: boolean;
  parser?: string;
  password?: string;
  path?: string;
  pattern?: string;
  port?: number;
  probe?: string;
  query?: string;
  server?: string;
  socketPath?: string;
  telemetryHelp?: string;
  token?: string;
  url?: string;
  username?: string;
  webhookPort?: number;
};

const REPORT_PARSERS = new Set<string>([
  "tajima-report",
  "melco-report",
  "generic-kv",
  "json",
]);

export const parseArgs = (argv: string[]): Args | { error: string } => {
  const args: Args = {
    help: false,
    httpPoll: false,
    listPrinters: false,
    noPrinters: false,
    noTelemetry: false,
    once: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${arg} needs a value`);

      return value;
    };
    const positive = (label: string) => {
      const value = Number(next());
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${label} must be a positive number`);

      return value;
    };
    try {
      switch (arg) {
        case "--server":
          args.server = next();
          break;
        case "--token":
          args.token = next();
          break;
        case "--socket-path":
          args.socketPath = next();
          break;
        case "--http-poll":
          args.httpPoll = true;
          break;
        case "--interval":
          args.interval = positive("--interval");
          break;
        case "--once":
          args.once = true;
          break;
        case "--list-printers":
          args.listPrinters = true;
          break;
        case "--no-printers":
          args.noPrinters = true;
          break;
        case "--no-telemetry":
          args.noTelemetry = true;
          break;
        case "--webhook-port":
          args.webhookPort = positive("--webhook-port");
          break;
        case "--probe":
          args.probe = next();
          break;
        case "--telemetry-help":
          args.telemetryHelp = next();
          break;
        case "--path":
          args.path = next();
          break;
        case "--pattern":
          args.pattern = next();
          break;
        case "--parser":
          args.parser = next();
          break;
        case "--host":
          args.host = next();
          break;
        case "--port":
          args.port = positive("--port");
          break;
        case "--query":
          args.query = next();
          break;
        case "--community":
          args.community = next();
          break;
        case "--url":
          args.url = next();
          break;
        case "--username":
          args.username = next();
          break;
        case "--password":
          args.password = next();
          break;
        case "--json-path":
          args.jsonPath = next();
          break;
        case "--help":
        case "-h":
          args.help = true;
          break;
        default:
          return { error: `unknown option ${arg}` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return args;
};

/** Build the source to test from the probe flags. */
export const sourceFromArgs = (
  args: Args,
): TelemetrySource | { error: string } => {
  switch (args.probe) {
    case "report-folder":
      if (!args.path) return { error: "--probe report-folder needs --path" };
      if (args.parser !== undefined && !REPORT_PARSERS.has(args.parser)) {
        return {
          error: `--parser must be one of ${[...REPORT_PARSERS].join(", ")}`,
        };
      }

      return {
        kind: "report-folder",
        path: args.path,
        ...(args.pattern === undefined ? {} : { pattern: args.pattern }),
        ...(args.parser === undefined
          ? {}
          : { parser: args.parser as ReportParser }),
      };
    case "raw-tcp-status":
      if (!args.host) return { error: "--probe raw-tcp-status needs --host" };

      return {
        dialect: "zebra-hs" as ZebraDialect,
        host: args.host,
        kind: "raw-tcp-status",
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.query === undefined ? {} : { query: args.query }),
      };
    case "snmp-printer":
      if (!args.host) return { error: "--probe snmp-printer needs --host" };

      return {
        host: args.host,
        kind: "snmp-printer",
        ...(args.community === undefined ? {} : { community: args.community }),
        ...(args.port === undefined ? {} : { port: args.port }),
      };
    case "http-status":
      if (!args.url) return { error: "--probe http-status needs --url" };

      return {
        kind: "http-status",
        url: args.url,
        ...(args.username === undefined ? {} : { username: args.username }),
        ...(args.password === undefined ? {} : { password: args.password }),
        ...(args.jsonPath === undefined ? {} : { jsonPath: args.jsonPath }),
      };
    case "manual":
      return { kind: "manual" };
    default:
      return { error: `--probe must be one of ${TELEMETRY_KINDS.join(", ")}` };
  }
};

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);

    return;
  }
  if (parsed.telemetryHelp) {
    const kind = parsed.telemetryHelp as TelemetryKind;
    if (!TELEMETRY_KINDS.includes(kind)) {
      console.error(`unknown telemetry kind ${parsed.telemetryHelp}`);
      process.exit(2);
    }
    console.log(telemetryHelp(kind));

    return;
  }
  if (parsed.listPrinters) {
    const printers = await listPrinters();
    console.log(
      printers.length > 0 ? printers.join("\n") : "(no printers found)",
    );

    return;
  }
  if (parsed.probe) {
    const source = sourceFromArgs(parsed);
    if ("error" in source) {
      console.error(source.error);
      process.exit(2);
    }
    const result = await probeSource(source);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(result.detail);
    console.log(JSON.stringify(result.reading, null, 2));

    return;
  }
  const server = parsed.server ?? process.env.ABS_BRIDGE_SERVER;
  const token = parsed.token ?? process.env.ABS_BRIDGE_TOKEN;
  if (!server || !token) {
    console.error(
      "--server and --token are required (or ABS_BRIDGE_SERVER / ABS_BRIDGE_TOKEN)",
    );
    console.error(USAGE);
    process.exit(2);
  }
  const controller = new AbortController();
  const stop = () => {
    console.log("[bridge] stopping…");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const summary = await runBridge({
    discoverPrinters: !parsed.noPrinters,
    once: parsed.once,
    server,
    signal: controller.signal,
    telemetry: !parsed.noTelemetry,
    token,
    transport: parsed.httpPoll ? "http-poll" : "socket",
    ...(parsed.interval === undefined
      ? {}
      : { intervalSeconds: parsed.interval }),
    ...(parsed.socketPath === undefined
      ? {}
      : { socketPath: parsed.socketPath }),
    ...(parsed.webhookPort === undefined
      ? {}
      : { telemetryOptions: { webhookPort: parsed.webhookPort } }),
  });
  if (parsed.once) {
    console.log(
      `[bridge] done: ${summary.executed} ok, ${summary.failed} failed, ${summary.events} telemetry event(s)`,
    );
    process.exit(summary.failed > 0 ? 1 : 0);
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
