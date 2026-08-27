# @absolutejs/commerce-machines

"Support every machine as a provider." A print / embroidery shop configures
the machines it owns; each provider knows the file formats and connection
methods that make and model accepts, and the package can export a job in
that format. The core is pure data plus file encoding — no network I/O. The optional
`./transports`, `./bridge` and `./telemetry` subpaths add "send straight to the
machine" delivery, the live bridge protocol, and machine run telemetry.

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

## Machine run telemetry (`@absolutejs/commerce-machines/telemetry`)

Measure the minutes a machine actually ran instead of asking an operator to
type them. Commercial embroidery and DTG machines rarely expose an open API, so
telemetry is pluggable per machine — and **every path is event-driven**. The
shop's machines push; nothing here is on a timer.

```ts
import {
  parseMachineReport,
  readingsToRuns,
  decodeZebraAlert,
  decodeSnmpPrinterStatus,
  telemetryKindsFor,
  telemetryFieldsFor,
  telemetryHelp,
  telemetryDelivery,
  TELEMETRY_LABELS,
} from "@absolutejs/commerce-machines/telemetry";

const reading = parseMachineReport(tajimaReportText, "tajima-report");
// → { at, state: "idle", jobName: "288C8286-L1-1.DST", stitches: 12480,
//     pieces: 6, elapsedSeconds: 1064, detail: "Completed", raw }

readingsToRuns(readings, { idleGapSeconds: 300 });
// → [{ startedAt, finishedAt, seconds: 1064, stitches: 12480, pieces: 6 }]
```

| `kind`           | Delivery | Where the reading comes from                                                                                                                                           | What it cannot see                                             |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `report-folder`  | `watch`  | The machine software's production report per run, caught by filesystem events (Tajima DG/Network Manager, Melco OS, Barudan LEM, Ricoma panels, DTG/DTF RIP job logs). | Anything live — the run appears when the report is written.    |
| `raw-tcp-status` | `push`   | Zebra unsolicited alerts (`~SX` / `alerts.add`) over a held-open socket.                                                                                               | Which order is printing; non-Zebra printers.                   |
| `http-status`    | `push`   | The RIP or controller POSTs to a webhook the bridge agent serves.                                                                                                      | Anything, if the software cannot notify — then it is `manual`. |
| `snmp-printer`   | `push`   | SNMP v1/v2c traps and informs (Host Resources + Printer MIB).                                                                                                          | Stitches, pieces, job names.                                   |
| `manual`         | `manual` | An operator types the time.                                                                                                                                            | Everything — and it says so.                                   |

- `telemetryKindsFor(provider)` suggests the paths worth offering for a machine
  from its connections and formats. It is a **suggestion for the settings
  screen, never a claim the machine was tested**; `manual` is always included
  and is always the safe answer. `telemetryDelivery(kind)` says whether that
  path is pushed, watched or manual, and `telemetryHelp(kind)` explains in
  plain English what it needs, which machines it suits and what it cannot see.
  `telemetryFieldsFor(kind)` + `TELEMETRY_LABELS` build the form.
- `parseMachineReport(text, parser, { now? })` reads Tajima and Melco
  production reports (`Label: value` and header-row CSV), generic key/value and
  JSON, through one field vocabulary; an unexpected layout degrades to the
  generic reader instead of throwing, and returns `null` when nothing
  job-shaped is found. `referenceFromJobName` pulls `288C8286-L1-1` out of a
  design name.
- `readingsToRuns(readings, { idleGapSeconds })` collapses a stream into runs:
  consecutive `running` samples make one run, a non-running sample or a gap
  longer than `idleGapSeconds` (default 300) closes it, a run is never credited
  more than one gap past its last `running` signal, and a non-running reading
  carrying `elapsedSeconds` (a finished production report) becomes a run of its
  own. For push-only machines that can run for hours between signals, pass a
  larger `idleGapSeconds`. `eventsToRuns` does the same over `MachineRunEvent[]`.
- `decodeZebraStatus` decodes a `~HS` three-line reply field by field per the
  ZPL II programming guide (and SGD `getvar` word replies); `decodeZebraAlert`
  decodes the pushed `<CONDITION> SET` / `CLEAR` messages by keyword, because
  the exact wording varies by firmware — an unrecognised message returns `null`
  rather than a guess.
- `snmpPrinterOids` + `decodeSnmpPrinterStatus(values, at?)` map the standard
  printer OIDs (printer status, device status, lifetime page count, device
  description) to a reading; unknown input yields `state: "unknown"`, never a
  guess.

Verified by tests here: the report parsers against real-shaped Tajima and Melco
reports, generic key/value and JSON; the run-collapsing gap logic; the Zebra
`~HS` field decode, SGD replies and alert SET/CLEAR; the SNMP status mapping;
the settings surface for every kind. **Not verified against real hardware:** no
Tajima, Melco, Zebra or SNMP printer was in the loop — the report layouts follow
what those packages export, the Zebra decoders follow Zebra's published
programming guide, and the OIDs are the standard MIB ones. Confirm against the
shop's actual machine before promising a number, and leave a machine on
`manual` until you have seen its telemetry arrive.

## Live bridge (`@absolutejs/commerce-machines/bridge`)

Apps run in the cloud; machines sit on the shop LAN. The shop installs
[`@absolutejs/machines-bridge`](../bridge) on any PC or Raspberry Pi. It holds
**one persistent socket** to the app (an `@absolutejs/sync` connection, no
inbound ports on the shop side): the server pushes jobs and telemetry sources
down, the agent pushes results and run events up. Nothing polls. The agent
executes a fixed set of typed actions — never arbitrary commands:

```ts
type BridgeAction =
  | { kind: "folder"; path: string }
  | { kind: "raw-tcp"; host: string; port?: number }
  | { kind: "ipp"; url: string; username?: string; password?: string }
  | { kind: "os-print"; printer: string }; // CUPS `lp -d` / Windows spooler
```

Server side — register the collections and mutations on your sync engine and
point `syncSocket` at the bridge tokens:

```ts
import {
  createBridgeSync,
  createMemoryBridgeStore,
  withBridgeSyncPublishing,
  publishTelemetrySource,
} from "@absolutejs/commerce-machines/bridge";
import { createSyncEngine, syncSocket } from "@absolutejs/sync";

const engine = createSyncEngine();
// Wrap the store so a queued job is pushed down the socket immediately.
const store = withBridgeSyncPublishing(
  createMemoryBridgeStore(), // or your own BridgeStore over a table
  engine.applyChange,
);
const bridge = createBridgeSync(store, {
  authenticate: async (token) => lookupBridgeByToken(token), // { bridgeId } | null
});
for (const collection of bridge.collections)
  engine.registerCollection(collection);
for (const mutation of bridge.mutations) engine.registerMutation(mutation);

app.use(syncSocket({ engine, authenticate: bridge.authenticate }));
// A telemetry source changed in your settings screen? Push it:
await publishTelemetrySource(engine.applyChange, { machineId, source });
```

Protocol:

- The agent opens the socket and sends its bridge token as the first
  `authenticate` frame, then subscribes to `bridgeJobs` and
  `bridgeTelemetrySources`. Both are scoped to its `bridgeId` by the
  collections' `authorize`/`match`.
- A queued job arrives as an `insert` diff with its files inline
  (`{ filename, mime, bytesBase64 }`). The agent runs it and calls the
  `bridge.report` mutation; the job leaves the collection.
- Run telemetry goes up in small batches through `bridge.telemetry`
  (`MachineRunEvent[]`, stored via `BridgeStore.record`). `bridge.heartbeat`
  carries `{ version, platform, hostname, capabilities, printers?, telemetry? }`
  once per connection — with a live socket, presence IS the socket.
- `BridgeStore` is the persistence seam: `enqueue`, `claim`, `complete`,
  `heartbeat`, `status`, and the optional `list`, `pending`, `readings`,
  `record`, `records`. Everything telemetry-related is optional, so an existing
  store keeps working.
- **Legacy fallback:** `createBridgeHandlers(store, { authenticate })` still
  returns `poll` / `report` / `telemetry` handlers to mount on
  `POST /bridge/poll`, `/bridge/report` and `/bridge/telemetry` for shops whose
  network blocks WebSockets. The poll response carries `sources` so a fallback
  agent needs no extra round-trip. It is supported, but it is not the default
  path and it is the only place anything is polled.

## License

Apache-2.0.
