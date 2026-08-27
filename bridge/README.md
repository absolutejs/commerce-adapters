# @absolutejs/machines-bridge

The shop-side half of "send straight to the machine" for
[`@absolutejs/commerce-machines`](../machines). Your app runs in the cloud;
the embroidery heads, DTG printers and label printers sit on the shop's LAN.
The shop runs this small agent on any always-on PC or Raspberry Pi. It polls
your app for jobs (no inbound ports, no VPN) and delivers each one locally.

```sh
bunx @absolutejs/machines-bridge --server https://shop.example --token XXXX
```

Options: `--once` (poll once and exit), `--list-printers`, `--interval 3`
(seconds), `--no-printers`; env `ABS_BRIDGE_SERVER` / `ABS_BRIDGE_TOKEN`.
Needs [Bun](https://bun.sh) ≥ 1.1. See [install.md](./install.md) for running
it as a service on Linux, macOS, Windows and Raspberry Pi.

## What it will and will not do

The bridge executes exactly four typed actions and nothing else. There is no
"run this command" action, jobs are validated with a type guard before they
run, and every process it spawns is an argv array (never a shell string):

| Action     | What happens locally                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder`   | Files are written into the folder (created if missing). Filenames are reduced to a safe base name; `..` paths are refused.                                                                                                                                                                                                                     |
| `raw-tcp`  | Bytes are streamed to `host:port` (default 9100) over one TCP connection per file — Zebra, most label printers, RIP spoolers.                                                                                                                                                                                                                  |
| `ipp`      | An IPP/1.1 Print-Job is posted to the printer URL (`ipp://host:631/ipp/print`), with Basic auth when a username is set.                                                                                                                                                                                                                        |
| `os-print` | Linux/macOS: `lp -d <printer> [-o raw] <file>` (`-o raw` for ZPL/EPL/TSPL). Windows: PowerShell `Get-Content -Raw \| Out-Printer -Name` for ZPL/EPL/TSPL and `Start-Process -FilePath <file> -Verb PrintTo` for PDF and everything else. The printer name and file path are passed as environment variables, not interpolated into the script. |

Each poll carries a heartbeat (`version`, `platform`, `hostname`,
`capabilities`, discovered `printers`) so the app can show whether the bridge
is online and offer the printer list in its settings. Printers come from
`lpstat -p` (CUPS) or `Get-Printer` (Windows), rescanned every minute.

## Protocol

- `POST <server>/bridge/poll` every ~3 s with body `{ token, info }` and
  header `Authorization: Bearer <token>` → `{ jobs: BridgeJob[] }` or
  `{ error: "unauthorized" }`. Files travel inline as base64.
- `POST <server>/bridge/report` with `{ token, jobId, result }` after each job;
  `result` is `{ ok: true, detail }` or `{ ok: false, error }`.
- Network errors back off (3 s → 60 s) and are logged to stdout; a 401/403
  is reported as a bad token. Malformed jobs are ignored and logged.

The server side is `createBridgeHandlers` / `createMemoryBridgeStore` from
`@absolutejs/commerce-machines/bridge` — see that README for the store
interface and how to mount the two routes.

## Programmatic use

```ts
import {
  runBridge,
  executeJob,
  listPrinters,
} from "@absolutejs/machines-bridge";

await runBridge({
  server: "https://shop.example",
  token: process.env.ABS_BRIDGE_TOKEN!,
  intervalSeconds: 3,
  once: false, // set true to poll a single time
  signal: controller.signal, // stops the loop
  log: (line) => console.log(line),
});
// executeJob(job) runs one BridgeJob locally; listPrinters() lists OS queues.
```

## What is tested, and what is not

Bun tests cover: the folder and raw-tcp executors against a temp dir and a
local `Bun.listen`; the os-print executor with a fake spawner (asserting the
exact `lp` argv, the PowerShell script shape and that the printer name never
enters the script); `lpstat` parsing; the full poll → execute → report loop
against the reference in-memory handlers over a fake `fetch`; CLI argument
parsing.

**Not tested here:** the Windows executors against a real spooler (the
PowerShell path follows Microsoft's documented cmdlets but has not been run
against a live Windows print queue), `lp` against a real CUPS queue, and IPP
against physical printers. Raw ZPL through `Out-Printer` on Windows depends
on the driver passing text through; for Zebra printers on Windows prefer
`raw-tcp` to port 9100.

## License

Apache-2.0.
