# @absolutejs/machines-bridge

The shop-side half of "send straight to the machine" for
[`@absolutejs/commerce-machines`](../machines). Your app runs in the cloud;
the embroidery heads, DTG printers and label printers sit on the shop's LAN.
The shop runs this small agent on any always-on PC or Raspberry Pi. It holds
**one persistent socket** to your app (no inbound ports, no VPN): the app
pushes jobs down it, the agent delivers each one locally and pushes the result
— and the machines' run telemetry — back up the same connection. Nothing is
polled.

```sh
bunx @absolutejs/machines-bridge --server https://shop.example --token XXXX
```

Options: `--once` (do one pass of work and exit), `--list-printers`,
`--no-printers`, `--no-telemetry`, `--webhook-port 8787`,
`--socket-path /sync/ws`, `--probe <kind>`, `--telemetry-help <kind>`, and the
legacy `--http-poll` / `--interval 3`; env `ABS_BRIDGE_SERVER` /
`ABS_BRIDGE_TOKEN`. Needs [Bun](https://bun.sh) ≥ 1.1. See
[install.md](./install.md) for running it as a service on Linux, macOS, Windows
and Raspberry Pi, and for the per-machine telemetry setup.

## What it will and will not do

The bridge executes exactly four typed actions and nothing else. There is no
"run this command" action, jobs are validated with a type guard before they
run, and every process it spawns is an argv array (never a shell string). The
telemetry watchers only ever read: report files are parsed and never moved or
deleted, and the local webhook/trap/alert listeners accept data, never
commands:

| Action     | What happens locally                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder`   | Files are written into the folder (created if missing). Filenames are reduced to a safe base name; `..` paths are refused.                                                                                                                                                                                                                     |
| `raw-tcp`  | Bytes are streamed to `host:port` (default 9100) over one TCP connection per file — Zebra, most label printers, RIP spoolers.                                                                                                                                                                                                                  |
| `ipp`      | An IPP/1.1 Print-Job is posted to the printer URL (`ipp://host:631/ipp/print`), with Basic auth when a username is set.                                                                                                                                                                                                                        |
| `os-print` | Linux/macOS: `lp -d <printer> [-o raw] <file>` (`-o raw` for ZPL/EPL/TSPL). Windows: PowerShell `Get-Content -Raw \| Out-Printer -Name` for ZPL/EPL/TSPL and `Start-Process -FilePath <file> -Verb PrintTo` for PDF and everything else. The printer name and file path are passed as environment variables, not interpolated into the script. |

On connect it sends one heartbeat (`version`, `platform`, `hostname`,
`capabilities`, discovered `printers`, `telemetry`) so the app can show the
printer list in its settings — with a live socket, presence is the socket
itself. Printers come from `lpstat -p` (CUPS) or `Get-Printer` (Windows).

## Protocol

- One WebSocket to the app's `@absolutejs/sync` socket (`wss://<server>/sync/ws`
  by default; `--socket-path` if you mounted it elsewhere). The bridge token is
  sent as the first `authenticate` frame — never in the URL.
- The agent subscribes to `bridgeJobs` and `bridgeTelemetrySources`. A queued
  job arrives as a diff the moment the app queues it, files inline as base64;
  the agent runs it and calls the `bridge.report` mutation, which removes it
  from the collection. Telemetry events go up through `bridge.telemetry` in
  batches of at most 500, coalesced over ~1 s, retried with backoff.
- A dropped connection is reopened with backoff (500 ms → 10 s) and the
  subscriptions resume; unfinished jobs are still in the collection, so nothing
  is lost. Malformed jobs and sources are ignored and logged.
- **Legacy fallback:** `--http-poll` polls `POST <server>/bridge/poll` every
  ~3 s with `{ token, info }` and reports to `/bridge/report`, pushing
  telemetry to `/bridge/telemetry`. Use it only where WebSockets are blocked.

The server side is `createBridgeSync` (+ `createMemoryBridgeStore`,
`withBridgeSyncPublishing`) from `@absolutejs/commerce-machines/bridge` — see
that README for the store interface and the socket wiring.

## Machine run telemetry

Alongside the jobs, the agent watches whatever telemetry sources the app pushes
down for this bridge, so the shop's real machine minutes are measured instead
of typed. Every path is event-driven — the agent never asks a machine for its
status on a timer:

| Source           | How it works locally                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `report-folder`  | `fs.watch` on the folder, events coalesced over 250 ms, then each new matching file is parsed and emitted as a `finish` event with the design reference, stitches, pieces and run time. A 5-minute rescan runs **only** to heal filesystem events the OS dropped (common on network shares). Files present the first time are adopted, not replayed; nothing is ever moved or deleted, and a `.absolutejs-seen` sidecar keeps a restart from re-importing history. |
| `raw-tcp-status` | Holds a connection to the printer's port open and reads unsolicited Zebra alerts (`PAPER OUT SET`, `HEAD OPEN SET`, `PQ COMPLETED`, and their `CLEAR`s), and also listens on the alert port (default 9200) for printers configured to dial the bridge PC. A repeated condition does not emit twice. Reconnects with backoff.                                                                                                                                       |
| `snmp-printer`   | Binds UDP 162 (`trapPort`) and decodes SNMP v1/v2c traps and informs with a built-in BER codec — no dependency. Informs are acknowledged with a Response. Traps are mapped through the Host Resources / Printer MIB OIDs to state and lifetime page count.                                                                                                                                                                                                         |
| `http-status`    | Serves a small local endpoint (`http://<bridge-pc>:8787/telemetry/<machineId>` by default) for the RIP or controller to POST to, secret-checked. JSON bodies are read through the same field vocabulary as production reports; a plain status word works too.                                                                                                                                                                                                      |
| `manual`         | No watcher. The operator types the time.                                                                                                                                                                                                                                                                                                                                                                                                                           |

State transitions are collapsed into runs **on the server**
(`readingsToRuns`), not here — the agent only reports what it saw and when.
`--no-telemetry` turns the whole thing off. `--probe <kind>` runs a single
reading and prints it, for setup:

```sh
bunx @absolutejs/machines-bridge --probe report-folder --path /mnt/reports --parser tajima-report
bunx @absolutejs/machines-bridge --probe raw-tcp-status --host 192.168.1.50
bunx @absolutejs/machines-bridge --probe snmp-printer --host 192.168.1.60
bunx @absolutejs/machines-bridge --telemetry-help snmp-printer
```

A probe is the only time this agent queries a machine.

## Programmatic use

```ts
import {
  runBridge,
  connectBridge,
  executeJob,
  listPrinters,
  probeSource,
} from "@absolutejs/machines-bridge";

await runBridge({
  server: "https://shop.example",
  token: process.env.ABS_BRIDGE_TOKEN!,
  signal: controller.signal, // closes the socket
  log: (line) => console.log(line),
  // transport: "http-poll", intervalSeconds: 3 — legacy fallback only
});

// Or drive the connection yourself:
const connection = await connectBridge({ server, token });
await connection.ready; // first snapshots have landed
connection.counters(); // { executed, failed, events }
connection.close();

// executeJob(job) runs one BridgeJob locally; listPrinters() lists OS queues;
// probeSource(source) takes one reading for a settings screen.
```

## What is tested, and what is not

Bun tests cover: the folder and raw-tcp executors against a temp dir and a
local `Bun.listen`; the os-print executor with a fake spawner (asserting the
exact `lp` argv, the PowerShell script shape and that the printer name never
enters the script); `lpstat` parsing; the full socket path — a fake WebSocket
speaking the sync wire protocol against the reference bridge collections and
mutations, pushing a job down, running it, reporting it and pushing a telemetry
event back; the report-folder watcher over a temp dir with a fake clock and a
driven watcher (baseline, new file, duplicate notification, sidecar restart,
files left untouched); the Zebra alert stream over a fake connection; the SNMP
BER encode/decode round-trip and trap/inform handling against a fake UDP
socket; the webhook receiver's routing, secret check and body parsing; the
legacy HTTP-poll loop against the reference handlers over a fake `fetch`; CLI
and probe argument parsing.

**Not tested here — no real hardware was in the loop:**

- No Tajima, Melco, Barudan or Ricoma machine wrote a report into the watched
  folder. The parsers follow the layouts those packages export; confirm against
  the shop's own file before trusting a number.
- No Zebra printer pushed an alert. The `~HS` decode follows the ZPL II
  programming guide field by field; the alert decode is keyword-based because
  the message wording varies by firmware, and an unrecognised message is logged,
  not guessed. `~SX` alert configuration has not been exercised on a device.
- No printer sent an SNMP trap. The codec round-trips against itself and the
  OIDs are the standard Host Resources / Printer MIB ones.
- No RIP posted to the webhook. The endpoint is exercised with synthetic
  requests only.
- The Windows executors have not been run against a live spooler (the
  PowerShell path follows Microsoft's documented cmdlets), nor `lp` against a
  real CUPS queue, nor IPP against a physical printer. Raw ZPL through
  `Out-Printer` on Windows depends on the driver passing text through; for
  Zebra printers on Windows prefer `raw-tcp` to port 9100.

Until a path is confirmed on the shop's actual machine, leave that machine on
`manual`: it measures nothing, and it says so.

## License

Apache-2.0.
