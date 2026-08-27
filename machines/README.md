# @absolutejs/commerce-machines

"Support every machine as a provider." A print / embroidery shop configures
the machines it owns; each provider knows the file formats and connection
methods that make and model accepts, and the package can export a job in
that format. The core is pure data plus file encoding — no network I/O. The optional
`./transports` and `./bridge` subpaths add "send straight to the machine"
delivery.

```ts
import {
  decodeStitchProgram,
  encodeStitchProgram,
  exportForMachine,
  getMachineProvider,
  listMachineProviders,
  machineChecklist,
} from "@absolutejs/commerce-machines";

listMachineProviders("embroidery"); // Tajima, Brother PR, Barudan, Ricoma, Melco…

const brother = getMachineProvider("brother-pr")!;
const files = exportForMachine(brother, {
  reference: "ORD-1042-L1",
  stitchFile: { bytes: dstBytes, filename: "logo.dst" },
});
// → [{ filename: "ORD-1042-L1.pes", mime: "application/x-brother-pes", bytes, format: "pes" }]

const program = decodeStitchProgram(dstBytes, "logo.dst");
// program.stitchCount, colorChanges, widthMm, heightMm, stitches[]
const jef = encodeStitchProgram(program!, "jef");

machineChecklist("dtg"); // art-ready, pretreated, printed, cured, qc
```

## What is in the box

- `MACHINE_PROVIDERS` — embroidery (Tajima, Brother PR, Barudan, Ricoma,
  Melco, SWF, Happy, ZSK, Janome MB, Bernina E16, Baby Lock), DTG (Brother
  GTX, Epson SureColor F2, Kornit, Ricoh Ri, Polyprint TexJet), DTF, sublimation
  (Epson F, Sawgrass), cutters (Cricut, Silhouette, Roland, Graphtec), screen,
  laser (Glowforge, xTool, Epilog), labels (Zebra, Rollo, Dymo, Brother QL) and
  generic fallbacks. Each carries accepted formats (preferred first),
  connections, hoops, plain-English `setup` and `developerNotes` listing what
  to ask the shop before wiring a direct integration.
- Stitch codecs: full decode and encode for Tajima **DST**, Melco **EXP**,
  Brother **PES** (v1 truncated writer; reader follows the PEC pointer of any
  PES version) and Janome **JEF**. Bare `.pec` files decode too. VP3 and XXX
  are recognised as formats but not decoded or written.
- `convertMachineFile`, `exportForMachine`, `MIME_BY_FORMAT`, `machineChecklist`
  and a `createMachineRegistry` factory for the manifest wiring.

## Notes on the codecs

- Coordinates are absolute 0.1 mm units, x right / y up (DST convention);
  PEC and JEF y-down axes are flipped on the way in and out.
- DST has no trim record; trims are written as zero-length jumps.
- The PES writer produces the truncated version-1 layout (header + PEC block,
  no CEmbOne/CSewSeg section). Machines and most software sew from the PEC
  block; a few editors that only read the design section will show it empty.
- Thread names come from the Brother PEC and Janome JEF palettes when a file
  carries indices; writers match `threads` by name and otherwise cycle.

## Send straight to the machine (`@absolutejs/commerce-machines/transports`)

```ts
import {
  createTransports,
  sendToMachine,
  probeMachine,
  transportFieldsFor,
  transportHelp,
  TRANSPORT_LABELS,
} from "@absolutejs/commerce-machines/transports";

const result = await sendToMachine(
  files, // MachineExport[] from exportForMachine
  { transport: "raw-tcp", host: "192.168.1.50" }, // port defaults to 9100
  { reference: "ORD-1042-L1" },
);
// → { ok: true, detail: "sent ORD-1042-L1.zpl (312 bytes) to 192.168.1.50:9100" }
//   | { ok: false, error: "192.168.1.50:9100 unreachable: Failed to connect" }
```

| `transport` | Target                           | Where it works                                                                  |
| ----------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `download`  | —                                | Everywhere; staff carry the file to the machine.                                |
| `folder`    | `{ path }`                       | Server can see the hot folder (local path or mounted share).                    |
| `raw-tcp`   | `{ host, port? }` (default 9100) | Server can reach the printer IP (Zebra, most label printers, RIP spoolers).     |
| `ipp`       | `{ url, username?, password? }`  | Server can reach `ipp://host:631/ipp/print` (CUPS, AirPrint, office printers).  |
| `printnode` | `{ apiKey, printerId, title? }`  | Anywhere — PrintNode's paid cloud service relays to its client on a shop PC.    |
| `bridge`    | `{ bridgeId, action }`           | Anywhere — the free bridge agent on the shop LAN executes `action` (see below). |

- `createTransports({ fetch?, bridge?, timeoutMs? })` returns one
  `MachineTransport` per kind (`kind`, `describe`, optional `probe`, `send`);
  pass a custom `fetch` in tests. `sendToMachine`, `probeMachine` and
  `describeTarget` dispatch on `target.transport`.
- `folder` sanitises filenames to their base name and refuses paths containing
  `..`. `raw-tcp` opens one connection per file, streams with back-pressure and
  closes (10 s timeout; `probe` just connects). `ipp` encodes an IPP/1.1
  Print-Job (`application/ipp`, `document-format` = the export's MIME) and
  returns the printer's `job-id`; `probe` is Get-Printer-Attributes. Basic auth
  is sent when a username is set. `printnode` posts `raw_base64` (ZPL, EPL,
  TSPL, DST, EXP, PES, JEF…) or `pdf_base64` (PDF) to
  `https://api.printnode.com/printjobs`; `probe` fetches `/printers/:id`.
- `transportFieldsFor(kind)`, `TRANSPORT_LABELS` and `transportHelp(kind)` feed
  a settings form: fields with `type: "text" | "password" | "number"`, a label,
  and plain-English help on when to use each and what to ask the shop.

Not verified against real hardware in this repo: the IPP encoder is tested
byte-for-byte and against a fake server, raw TCP against a local `Bun.listen`,
PrintNode against a fake `fetch` (the API shape follows PrintNode's public
docs).

## Bridge protocol (`@absolutejs/commerce-machines/bridge`)

Apps run in the cloud; machines sit on the shop LAN. The shop installs
[`@absolutejs/machines-bridge`](../bridge) on any PC or Raspberry Pi; it
**polls** the app (no inbound ports on the shop side) and executes a fixed set
of typed actions — never arbitrary commands:

```ts
type BridgeAction =
  | { kind: "folder"; path: string }
  | { kind: "raw-tcp"; host: string; port?: number }
  | { kind: "ipp"; url: string; username?: string; password?: string }
  | { kind: "os-print"; printer: string }; // CUPS `lp -d` / Windows spooler
```

Server side:

```ts
import {
  createBridgeHandlers,
  createMemoryBridgeStore,
} from "@absolutejs/commerce-machines/bridge";
import { createTransports } from "@absolutejs/commerce-machines/transports";

const store = createMemoryBridgeStore(); // or your own BridgeStore over a table
const handlers = createBridgeHandlers(store, {
  authenticate: async (token) => lookupBridgeByToken(token), // { bridgeId } | null
});
// mount on any framework:
//   POST /bridge/poll   → handlers.poll({ token, info })   → { jobs } | { error: "unauthorized" }
//   POST /bridge/report → handlers.report({ token, jobId, result }) → { ok: true } | { error }
const transports = createTransports({ bridge: store });
await sendToMachine(
  files,
  {
    transport: "bridge",
    bridgeId: "front-desk",
    action: { kind: "os-print", printer: "Zebra_ZD420" },
  },
  { reference },
  transports,
);
```

Protocol:

- The agent sends `POST <server>/bridge/poll` every ~3 s with
  `{ token, info }` and `Authorization: Bearer <token>`. `info` is the
  heartbeat: `{ version, platform, hostname, capabilities, printers? }` —
  `store.status(bridgeId)` reports `online` when a poll arrived within 15 s.
- The response `{ jobs: BridgeJob[] }` carries files inline
  (`{ filename, mime, bytesBase64 }`); jobs move `queued → claimed`. Claims
  that are never reported go back to `queued` after 5 min (memory store).
- After each job the agent sends `POST <server>/bridge/report` with
  `{ token, jobId, result }` where `result` is a `SendResult`; the job becomes
  `done` or `failed`.
- One bearer token per bridge; the app owns token issuing and `authenticate`.
  `BridgeStore` is the persistence seam — `enqueue`, `claim`, `complete`,
  `heartbeat`, `status`, optional `list`.

## License

Apache-2.0.
