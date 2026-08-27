#!/usr/bin/env bun
import { BRIDGE_VERSION, runBridge } from "./index";
import { listPrinters } from "./printers";

const USAGE = `absolutejs-machines-bridge ${BRIDGE_VERSION}

Runs on a PC or Raspberry Pi on the shop network, polls your app for jobs and
sends them to a folder, a printer port (TCP 9100), an IPP printer or the OS
print queue. It only executes those four typed actions — never shell commands.

Usage:
  bunx @absolutejs/machines-bridge --server https://shop.example --token XXXX [options]

Options:
  --server <url>     App base URL (or ABS_BRIDGE_SERVER)
  --token <token>    Bridge token from the app's Machines settings (or ABS_BRIDGE_TOKEN)
  --interval <sec>   Seconds between polls (default 3)
  --once             Poll once, run what came back, exit
  --list-printers    Print the OS print queues this machine can see and exit
  --no-printers      Skip printer discovery in the heartbeat
  --help             Show this help
`;

type Args = {
  help: boolean;
  interval?: number;
  listPrinters: boolean;
  noPrinters: boolean;
  once: boolean;
  server?: string;
  token?: string;
};

export const parseArgs = (argv: string[]): Args | { error: string } => {
  const args: Args = {
    help: false,
    listPrinters: false,
    noPrinters: false,
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
    try {
      switch (arg) {
        case "--server":
          args.server = next();
          break;
        case "--token":
          args.token = next();
          break;
        case "--interval": {
          const value = Number(next());
          if (!Number.isFinite(value) || value <= 0)
            return { error: "--interval must be a positive number" };
          args.interval = value;
          break;
        }
        case "--once":
          args.once = true;
          break;
        case "--list-printers":
          args.listPrinters = true;
          break;
        case "--no-printers":
          args.noPrinters = true;
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
  if (parsed.listPrinters) {
    const printers = await listPrinters();
    console.log(
      printers.length > 0 ? printers.join("\n") : "(no printers found)",
    );

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
    intervalSeconds: parsed.interval,
    once: parsed.once,
    server,
    signal: controller.signal,
    token,
  });
  if (parsed.once) {
    console.log(
      `[bridge] done: ${summary.executed} ok, ${summary.failed} failed`,
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
