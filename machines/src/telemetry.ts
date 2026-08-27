/* Machine run telemetry: measure the minutes a machine actually ran instead of
 * asking an operator to type them. Commercial embroidery and DTG machines
 * rarely expose an open API, so telemetry is pluggable per machine and every
 * path is event-driven where the hardware allows it: the machine's software
 * writes a production report and the filesystem tells us (no directory
 * polling), a Zebra pushes unsolicited alerts down a held-open socket, a
 * printer sends SNMP traps, a RIP posts to a webhook. Where the hardware can
 * only be asked, `telemetryDelivery` says so and `manual` stays the honest
 * answer.
 *
 * Pure functions: no network I/O, no node built-ins — safe to import in a
 * settings screen. The watchers themselves live in `@absolutejs/machines-bridge`. */

import type { MachineProvider } from "./types";

export type TelemetryKind =
  | "report-folder"
  | "raw-tcp-status"
  | "http-status"
  | "snmp-printer"
  | "manual";

export const TELEMETRY_KINDS: TelemetryKind[] = [
  "report-folder",
  "raw-tcp-status",
  "http-status",
  "snmp-printer",
  "manual",
];

export type ReportParser =
  "tajima-report" | "melco-report" | "generic-kv" | "json";

export const REPORT_PARSERS: ReportParser[] = [
  "tajima-report",
  "melco-report",
  "generic-kv",
  "json",
];

export type ZebraDialect = "zebra-sgd" | "zebra-hs" | "raw";

export type TelemetrySource =
  | {
      kind: "report-folder";
      path: string;
      /** Glob for the report files — `*` and `?` only (default `*`). */
      pattern?: string;
      parser?: ReportParser;
    }
  | {
      kind: "raw-tcp-status";
      host: string;
      /** Printer port for alerts and the one-shot test reading (default 9100). */
      port?: number;
      /** Test-reading command (default `~HS`). */
      query?: string;
      dialect?: ZebraDialect;
      /** Local port the agent listens on for printers that dial out with alerts. */
      alertPort?: number;
    }
  | {
      kind: "http-status";
      /** Optional: only used by the "test reading" button, never on a timer. */
      url?: string;
      username?: string;
      password?: string;
      /** Dot path into the JSON body, e.g. `printer.state` or `jobs[0].status`. */
      jsonPath?: string;
      /** Path the agent serves for this machine's webhook (default `/telemetry/<machineId>`). */
      webhookPath?: string;
      /** Shared secret the poster must send as `X-Telemetry-Secret` or `?secret=`. */
      webhookSecret?: string;
    }
  | {
      kind: "snmp-printer";
      host: string;
      community?: string;
      /** The device's SNMP port for the test reading (default 161). */
      port?: number;
      /** Local UDP port the agent listens on for traps (default 162). */
      trapPort?: number;
    }
  | { kind: "manual" };

export type MachineRunState =
  "idle" | "running" | "paused" | "error" | "offline" | "unknown";

export type MachineReading = {
  at: string;
  state: MachineRunState;
  jobName?: string;
  stitches?: number;
  pieces?: number;
  pageCount?: number;
  elapsedSeconds?: number;
  detail?: string;
  raw?: string;
};

export type MachineRunEventKind = "start" | "progress" | "finish" | "error";

export type MachineRunEvent = {
  machineId: string;
  at: string;
  kind: MachineRunEventKind;
  reading: MachineReading;
  /** Job reference parsed from the report or job name, e.g. `288C8286-L1-1`. */
  reference?: string;
};

/** What the agent should watch for one machine. */
export type TelemetryBinding = { machineId: string; source: TelemetrySource };

/**
 * How readings reach the agent:
 * - `push` — the machine or its software sends them unprompted (Zebra alerts,
 *   SNMP traps, a RIP webhook). Nothing is polled.
 * - `watch` — the OS tells the agent when something changed (filesystem
 *   events on a report folder), with a slow rescan only to heal missed events.
 * - `manual` — nothing is measured; an operator types the time.
 */
export type TelemetryDelivery = "push" | "watch" | "manual";

export const telemetryDelivery = (kind: TelemetryKind): TelemetryDelivery => {
  switch (kind) {
    case "report-folder":
      return "watch";
    case "raw-tcp-status":
    case "http-status":
    case "snmp-printer":
      return "push";
    case "manual":
      return "manual";
  }
};

export const DEFAULT_STATUS_PORT = 9100;
/** Port the agent listens on for Zebra printers configured to dial out. */
export const DEFAULT_ALERT_PORT = 9200;
export const DEFAULT_SNMP_PORT = 161;
export const DEFAULT_SNMP_TRAP_PORT = 162;
export const DEFAULT_SNMP_COMMUNITY = "public";
export const DEFAULT_ZEBRA_QUERY = "~HS";
/** Gap after which two `running` samples belong to different runs (5 min). */
export const DEFAULT_IDLE_GAP_SECONDS = 300;

// ------------------------------------------------------------ small parsing

const LINE_BREAK = /\r?\n/;

const normaliseKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const toNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : undefined;
};

/** `00:17:44` → 1064, `17:44` → 1064 (m:s), `1064` → 1064, `17 min` → 1020. */
export const parseDurationSeconds = (
  value: string | undefined,
): number | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const clock = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(trimmed);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    const first = Number(clock[1]);
    const second = Number(clock[2]);

    return clock[3] === undefined
      ? first * 60 + second
      : first * 3600 + second * 60 + Number(clock[3]);
  }
  const suffixed =
    /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)$/i.exec(
      trimmed,
    );
  if (suffixed?.[1] !== undefined && suffixed[2] !== undefined) {
    const unit = suffixed[2].toLowerCase();
    const factor = unit.startsWith("h") ? 3600 : unit.startsWith("s") ? 1 : 60;

    return Math.round(Number(suffixed[1]) * factor);
  }

  return toNumber(trimmed);
};

/** Machine reports carry shop-local wall-clock time; parse it as local time. */
export const parseReportTimestamp = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const stamp =
    /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      trimmed,
    );
  if (stamp) {
    return new Date(
      Number(stamp[1]),
      Number(stamp[2]) - 1,
      Number(stamp[3]),
      Number(stamp[4]),
      Number(stamp[5]),
      Number(stamp[6] ?? 0),
    ).toISOString();
  }
  const parsed = Date.parse(trimmed);

  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
};

const STATE_WORDS: [RegExp, MachineRunState][] = [
  [
    /\b(error|fault|failed|failure|jam|jammed|thread break|breakage|head open|cover open|paper out|media out|ribbon out|out of (paper|media|ribbon|ink)|no media|down)\b/,
    "error",
  ],
  [/\b(offline|off-line|disconnected|unreachable|not responding)\b/, "offline"],
  [/\b(pause|paused|stopped|halted|hold|suspended|waiting)\b/, "paused"],
  [
    /\b(running|run|sewing|sew|printing|print|busy|processing|active|in progress|started)\b/,
    "running",
  ],
  [
    /\b(idle|ready|standby|sleep|complete|completed|finished|finish|done|ended|end|ok|online)\b/,
    "idle",
  ],
];

/** Best-effort state from a status word or sentence; `undefined` when nothing matches. */
export const stateFromText = (
  value: string | undefined,
): MachineRunState | undefined => {
  if (value === undefined) return undefined;
  const text = value.toLowerCase();
  for (const [pattern, state] of STATE_WORDS) {
    if (pattern.test(text)) return state;
  }

  return undefined;
};

/** `\\pc\reports\288C8286-L1-1.DST` → `288C8286-L1-1`. */
export const referenceFromJobName = (
  jobName: string | undefined,
): string | undefined => {
  if (jobName === undefined) return undefined;
  const segments = jobName.split(/[\\/]/);
  const base = (segments[segments.length - 1] ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .trim();
  if (base.length === 0) return undefined;
  const dashed = /[A-Za-z0-9]{2,}(?:-[A-Za-z0-9]+)+/.exec(base);

  return dashed?.[0] ?? base;
};

// ------------------------------------------------------------ report parsing

const FIELD_KEYS = {
  elapsed: [
    "run time",
    "runtime",
    "elapsed",
    "elapsed time",
    "elapsed seconds",
    "sew time",
    "sewing time",
    "machine time",
    "total time",
    "duration",
  ],
  finished: [
    "end",
    "end time",
    "ended",
    "finish",
    "finish time",
    "finished",
    "completed at",
    "stop time",
    "date time",
    "timestamp",
    "time",
    "date",
    "at",
  ],
  jobName: [
    "design",
    "design name",
    "pattern",
    "pattern name",
    "job",
    "job name",
    "file",
    "file name",
    "filename",
    "order",
    "name",
  ],
  pageCount: ["pages", "page count", "prints", "impressions", "sheets"],
  pieces: [
    "pieces",
    "piece",
    "garments",
    "quantity",
    "qty",
    "repeats",
    "units",
    "produced",
    "output",
    "completed",
  ],
  started: ["start", "start time", "started", "begin", "began"],
  status: ["status", "state", "result", "condition", "machine status"],
  stitches: [
    "stitches",
    "stitch",
    "stitch count",
    "total stitches",
    "stitch total",
  ],
} as const;

type FieldGroup = keyof typeof FIELD_KEYS;

const pick = (
  pairs: [string, string][],
  group: FieldGroup,
): string | undefined => {
  for (const key of FIELD_KEYS[group]) {
    const hit = pairs.find(([candidate]) => candidate === key);
    if (hit?.[1] !== undefined && hit[1].length > 0) return hit[1];
  }

  return undefined;
};

const keyValuePairs = (text: string): [string, string][] => {
  const pairs: [string, string][] = [];
  for (const line of text.split(LINE_BREAK)) {
    const match = /^\s*([A-Za-z][^:=\t]{0,40}?)\s*[:=\t]\s*(\S.*?)\s*$/.exec(
      line,
    );
    if (match?.[1] !== undefined && match[2] !== undefined) {
      pairs.push([normaliseKey(match[1]), match[2]]);
    }
  }

  return pairs;
};

const splitCsv = (line: string) =>
  line.split(",").map((cell) =>
    cell
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim(),
  );

/** Header row + data rows — Melco OS and most RIP job logs export this. */
const csvPairs = (text: string): [string, string][] | null => {
  const lines = text
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  /* Report exports often carry a title line above the real header, so try
   * every plausible header line rather than giving up on the first one. */
  for (const [index, line] of lines.entries()) {
    const header = splitCsv(line);
    if (header.length < 3) continue;
    if (header.some((cell) => cell.length === 0)) continue;
    if (header.some((cell) => /^-?\d+([.,]\d+)?$/.test(cell))) continue;
    const row = lines
      .slice(index + 1)
      .reverse()
      .find((candidate) => splitCsv(candidate).length === header.length);
    if (row === undefined) continue;
    const cells = splitCsv(row);

    return header.map((cell, position): [string, string] => [
      normaliseKey(cell),
      cells[position] ?? "",
    ]);
  }

  return null;
};

const isRunState = (value: unknown): value is MachineRunState =>
  value === "idle" ||
  value === "running" ||
  value === "paused" ||
  value === "error" ||
  value === "offline" ||
  value === "unknown";

const jsonPairs = (text: string): [string, string][] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const record = Array.isArray(parsed)
    ? (parsed[parsed.length - 1] as unknown)
    : parsed;
  if (typeof record !== "object" || record === null) return null;

  return Object.entries(record as Record<string, unknown>).flatMap(
    ([key, value]): [string, string][] =>
      value === null || typeof value === "object"
        ? []
        : [[normaliseKey(key), String(value)]],
  );
};

const readingFromPairs = (
  pairs: [string, string][],
  raw: string,
  now: Date,
): MachineReading | null => {
  const jobName = pick(pairs, "jobName");
  const stitches = toNumber(pick(pairs, "stitches"));
  const pieces = toNumber(pick(pairs, "pieces"));
  const pageCount = toNumber(pick(pairs, "pageCount"));
  const elapsedSeconds = parseDurationSeconds(pick(pairs, "elapsed"));
  if (
    jobName === undefined &&
    stitches === undefined &&
    pieces === undefined &&
    pageCount === undefined &&
    elapsedSeconds === undefined
  ) {
    return null;
  }
  const statusText = pick(pairs, "status");
  const startedAt = parseReportTimestamp(pick(pairs, "started"));
  const finishedAt = parseReportTimestamp(pick(pairs, "finished"));
  const derivedFinish =
    startedAt !== undefined && elapsedSeconds !== undefined
      ? new Date(Date.parse(startedAt) + elapsedSeconds * 1000).toISOString()
      : undefined;
  const explicit = pairs.find(([key]) => key === "state")?.[1];

  return {
    at: finishedAt ?? derivedFinish ?? startedAt ?? now.toISOString(),
    detail: statusText,
    elapsedSeconds,
    jobName,
    pageCount,
    pieces,
    raw: raw.slice(0, 1000),
    /* A report describes a run that already happened: idle unless the report
     * itself says the machine stopped on a fault or is still going. */
    state: isRunState(explicit)
      ? explicit
      : (stateFromText(statusText) ?? "idle"),
    stitches,
  };
};

/**
 * Parse one production report into a reading. `tajima-report` and
 * `melco-report` are the `Label: value` and header-row-CSV shapes those
 * packages export, read through a shared field vocabulary that covers both
 * brands' labels; every parser falls back to the generic key/value reader,
 * then CSV, then JSON, so an unexpected layout degrades instead of throwing.
 * Returns `null` when nothing job-shaped was found.
 */
export const parseMachineReport = (
  text: string,
  parser: ReportParser = "generic-kv",
  options: { now?: () => Date } = {},
): MachineReading | null => {
  const now = (options.now ?? (() => new Date()))();
  if (text.trim().length === 0) return null;
  if (parser === "json") {
    const pairs = jsonPairs(text);

    return pairs === null ? null : readingFromPairs(pairs, text, now);
  }
  const pairs = keyValuePairs(text);
  const fromPairs =
    pairs.length > 0 ? readingFromPairs(pairs, text, now) : null;
  if (fromPairs) return fromPairs;
  const csv = csvPairs(text);
  const fromCsv = csv === null ? null : readingFromPairs(csv, text, now);
  if (fromCsv) return fromCsv;
  const json = jsonPairs(text);

  return json === null ? null : readingFromPairs(json, text, now);
};

// ------------------------------------------------------------------- runs

export type MachineRun = {
  startedAt: string;
  finishedAt: string;
  seconds: number;
  stitches?: number;
  pieces?: number;
};

type OpenRun = {
  start: number;
  last: number;
  pieces?: number;
  stitches?: number;
};

const higher = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

const closeRun = (open: OpenRun, endMs: number, gapMs: number): MachineRun => {
  const finished = Math.max(open.start, Math.min(endMs, open.last + gapMs));

  return {
    finishedAt: new Date(finished).toISOString(),
    pieces: open.pieces,
    seconds: Math.round((finished - open.start) / 1000),
    startedAt: new Date(open.start).toISOString(),
    stitches: open.stitches,
  };
};

/**
 * Collapse a stream of readings into runs. Consecutive `running` samples make
 * one run; a non-running sample or a gap longer than `idleGapSeconds` closes
 * it, and a run is never credited more than `idleGapSeconds` past its last
 * `running` sample. A non-running reading carrying `elapsedSeconds` (a
 * production report for a finished job) becomes a run of its own. Counters are
 * treated as per-run totals: the highest value seen in the run wins.
 */
export const readingsToRuns = (
  readings: MachineReading[],
  options: { idleGapSeconds?: number } = {},
): MachineRun[] => {
  const gapMs =
    Math.max(1, options.idleGapSeconds ?? DEFAULT_IDLE_GAP_SECONDS) * 1000;
  const sorted = readings
    .map((reading) => ({ ms: Date.parse(reading.at), reading }))
    .filter((entry) => Number.isFinite(entry.ms))
    .sort((a, b) => a.ms - b.ms);
  const runs: MachineRun[] = [];
  let open: OpenRun | undefined;
  for (const { ms, reading } of sorted) {
    if (reading.state === "running") {
      if (open !== undefined && ms - open.last > gapMs) {
        runs.push(closeRun(open, open.last, gapMs));
        open = undefined;
      }
      const current: OpenRun = open ?? { last: ms, start: ms };
      current.last = ms;
      current.stitches = higher(current.stitches, reading.stitches);
      current.pieces = higher(current.pieces, reading.pieces);
      open = current;
      continue;
    }
    if (open !== undefined) {
      runs.push(closeRun(open, ms, gapMs));
      open = undefined;
    }
    if (reading.elapsedSeconds !== undefined && reading.elapsedSeconds > 0) {
      runs.push({
        finishedAt: new Date(ms).toISOString(),
        pieces: reading.pieces,
        seconds: reading.elapsedSeconds,
        startedAt: new Date(ms - reading.elapsedSeconds * 1000).toISOString(),
        stitches: reading.stitches,
      });
    }
  }
  if (open !== undefined) runs.push(closeRun(open, open.last, gapMs));

  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
};

/** `readingsToRuns` over the readings carried by run events. */
export const eventsToRuns = (
  events: MachineRunEvent[],
  options: { idleGapSeconds?: number } = {},
) =>
  readingsToRuns(
    events.map((event) => event.reading),
    options,
  );

// ------------------------------------------------------------------ zebra

const flag = (fields: string[], index: number) => fields[index] === "1";

/**
 * Decode a Zebra `~HS` reply (the three comma-separated lines documented in
 * the ZPL II programming guide) or a Link-OS SGD `getvar` reply such as
 * `"idle"` / `"printing"` / `"head open"`. Used for the one-shot test reading;
 * live monitoring comes from unsolicited alerts (see `decodeZebraAlert`).
 */
export const decodeZebraStatus = (
  text: string,
  at: Date = new Date(),
): MachineReading | null => {
  const cleaned = text.replace(/[\u0000\u0002\u0003]/g, "");
  const lines = cleaned
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const first = splitCsv(lines[0] ?? "");
  if (first.length >= 12 && first.every((cell) => /^\d+$/.test(cell))) {
    const second = lines[1] ? splitCsv(lines[1]) : [];
    const buffered = Number(first[4] ?? "0");
    const remaining = Number(second[8] ?? "0");
    const labelWaiting = flag(second, 7);
    const faults = [
      flag(first, 1) ? "media out" : "",
      flag(second, 3) ? "ribbon out" : "",
      flag(second, 2) ? "printhead open" : "",
      flag(first, 9) ? "corrupt RAM" : "",
      flag(first, 10) ? "head under temperature" : "",
      flag(first, 11) ? "head over temperature" : "",
    ].filter((fault) => fault.length > 0);
    const paused = flag(first, 2);
    const busy =
      (Number.isFinite(remaining) && remaining > 0) ||
      labelWaiting ||
      (Number.isFinite(buffered) && buffered > 0);

    return {
      at: at.toISOString(),
      detail:
        faults.length > 0
          ? faults.join(", ")
          : busy
            ? `printing, ${Number.isFinite(remaining) ? remaining : 0} label(s) left in batch`
            : paused
              ? "paused"
              : "idle",
      raw: text.slice(0, 500),
      state:
        faults.length > 0
          ? "error"
          : paused
            ? "paused"
            : busy
              ? "running"
              : "idle",
    };
  }
  const word = lines
    .map((line) => line.replace(/^"|"$/g, "").trim())
    .join(" ")
    .trim();
  const state = stateFromText(word);
  if (state === undefined) return null;

  return { at: at.toISOString(), detail: word, raw: text.slice(0, 500), state };
};

const ZEBRA_ALERT_CONDITIONS: [RegExp, MachineRunState, string][] = [
  [/paper\s*out|media\s*out/i, "error", "media out"],
  [/ribbon\s*out/i, "error", "ribbon out"],
  [/head\s*open|printhead\s*open/i, "error", "printhead open"],
  [/head\s*too\s*hot|over\s*temp/i, "error", "printhead too hot"],
  [/head\s*cold|under\s*temp/i, "error", "printhead too cold"],
  [
    /ribbon\s*in|ribbon\s*low|paper\s*low|media\s*low|clean\s*printhead/i,
    "idle",
    "supplies warning",
  ],
  [/pq\s*completed|batch\s*complete/i, "idle", "batch complete"],
  [/printer\s*paused|pause/i, "paused", "paused"],
  [/cover\s*closed|head\s*closed|paper\s*in|media\s*in/i, "idle", "ready"],
  [/cold\s*start|power\s*on/i, "idle", "powered on"],
];

/**
 * Decode a Zebra **unsolicited** alert message — what the printer pushes to a
 * TCP destination configured with `~SX` / `alerts.add` (`<CONDITION> SET` and
 * `<CONDITION> CLEAR`, optionally prefixed by the printer name and serial).
 * A `CLEAR` inverts the condition to a non-error state. The condition
 * vocabulary is keyword-matched because the exact wording varies by firmware;
 * unknown messages return `null` so the agent can log them verbatim.
 */
export const decodeZebraAlert = (
  text: string,
  at: Date = new Date(),
): MachineReading | null => {
  const cleaned = text.replace(/[\u0000\u0002\u0003]/g, "").trim();
  if (cleaned.length === 0) return null;
  const cleared = /\bclear(ed)?\b/i.test(cleaned);
  for (const [pattern, state, label] of ZEBRA_ALERT_CONDITIONS) {
    if (!pattern.test(cleaned)) continue;
    const pieces = /pq\s*completed/i.test(cleaned)
      ? toNumber(/(\d+)\s*label/i.exec(cleaned)?.[1])
      : undefined;

    return {
      at: at.toISOString(),
      detail: cleared ? `${label} cleared` : label,
      pieces,
      raw: cleaned.slice(0, 500),
      state: cleared ? "idle" : state,
    };
  }

  return null;
};

// ------------------------------------------------------------------- snmp

/** Standard Host-Resources / Printer MIB OIDs, first printer instance. */
export const snmpPrinterOids = {
  description: "1.3.6.1.2.1.25.3.2.1.3.1",
  deviceStatus: "1.3.6.1.2.1.25.3.2.1.5.1",
  pageCount: "1.3.6.1.2.1.43.10.2.1.4.1.1",
  printerStatus: "1.3.6.1.2.1.25.3.5.1.1.1",
} as const;

export const SNMP_PRINTER_OID_LIST: string[] = [
  snmpPrinterOids.printerStatus,
  snmpPrinterOids.deviceStatus,
  snmpPrinterOids.pageCount,
  snmpPrinterOids.description,
];

const PRINTER_STATUS_LABELS: Record<number, string> = {
  1: "other",
  2: "unknown",
  3: "idle",
  4: "printing",
  5: "warming up",
};

const DEVICE_STATUS_LABELS: Record<number, string> = {
  1: "unknown",
  2: "running",
  3: "warning",
  4: "testing",
  5: "down",
};

/**
 * Map SNMP values (keyed by OID, from a trap's varbinds or a test GET) to a
 * reading. Page count is the lifetime marker count, so the server tracks its
 * delta; SNMP never tells you the job name or the stitch count.
 */
export const decodeSnmpPrinterStatus = (
  values: Record<string, number | string>,
  at: Date = new Date(),
): MachineReading => {
  const read = (oid: string) => values[oid] ?? values[`.${oid}`];
  const asNumber = (value: number | string | undefined) =>
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? toNumber(value)
        : undefined;
  const printerStatus = asNumber(read(snmpPrinterOids.printerStatus));
  const deviceStatus = asNumber(read(snmpPrinterOids.deviceStatus));
  const pageCount = asNumber(read(snmpPrinterOids.pageCount));
  const descriptionValue = read(snmpPrinterOids.description);
  const description =
    typeof descriptionValue === "string" ? descriptionValue : undefined;
  const parts = [
    description,
    printerStatus === undefined
      ? undefined
      : (PRINTER_STATUS_LABELS[printerStatus] ??
        `printer status ${printerStatus}`),
    deviceStatus === undefined || deviceStatus === 2
      ? undefined
      : (DEVICE_STATUS_LABELS[deviceStatus] ?? `device status ${deviceStatus}`),
    pageCount === undefined ? undefined : `${pageCount} pages`,
  ].filter((part): part is string => part !== undefined && part.length > 0);

  return {
    at: at.toISOString(),
    detail: parts.join(", "),
    pageCount,
    state:
      deviceStatus === 5
        ? "error"
        : printerStatus === 4 || printerStatus === 5
          ? "running"
          : printerStatus === 3
            ? "idle"
            : deviceStatus === 3
              ? "error"
              : deviceStatus === 2
                ? "idle"
                : "unknown",
  };
};

// -------------------------------------------------------------- type guards

export const isMachineReading = (value: unknown): value is MachineReading => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  return typeof record.at === "string" && isRunState(record.state);
};

export const isMachineRunEvent = (value: unknown): value is MachineRunEvent => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  return (
    typeof record.machineId === "string" &&
    typeof record.at === "string" &&
    (record.kind === "start" ||
      record.kind === "progress" ||
      record.kind === "finish" ||
      record.kind === "error") &&
    isMachineReading(record.reading) &&
    (record.reference === undefined || typeof record.reference === "string")
  );
};

export const isTelemetrySource = (value: unknown): value is TelemetrySource => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const optionalString = (key: string) =>
    record[key] === undefined || typeof record[key] === "string";
  const optionalNumber = (key: string) =>
    record[key] === undefined || typeof record[key] === "number";
  switch (record.kind) {
    case "report-folder":
      return (
        typeof record.path === "string" &&
        optionalString("pattern") &&
        optionalString("parser")
      );
    case "raw-tcp-status":
      return (
        typeof record.host === "string" &&
        optionalNumber("port") &&
        optionalString("query") &&
        optionalString("dialect") &&
        optionalNumber("alertPort")
      );
    case "http-status":
      return (
        optionalString("url") &&
        optionalString("username") &&
        optionalString("password") &&
        optionalString("jsonPath") &&
        optionalString("webhookPath") &&
        optionalString("webhookSecret")
      );
    case "snmp-printer":
      return (
        typeof record.host === "string" &&
        optionalString("community") &&
        optionalNumber("port") &&
        optionalNumber("trapPort")
      );
    case "manual":
      return true;
    default:
      return false;
  }
};

export const isTelemetryBinding = (
  value: unknown,
): value is TelemetryBinding => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  return (
    typeof record.machineId === "string" && isTelemetrySource(record.source)
  );
};

// ---------------------------------------------------------- settings forms

export type TelemetryField = {
  key: string;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
  required?: boolean;
  /** When present the settings form should render a select. */
  options?: string[];
};

export const TELEMETRY_LABELS: Record<TelemetryKind, string> = {
  "http-status": "Webhook from the machine's software",
  manual: "Operator types the time (nothing is measured)",
  "raw-tcp-status": "Printer alerts (Zebra, TCP 9100)",
  "report-folder": "Production report folder",
  "snmp-printer": "SNMP traps from the printer",
};

export const telemetryFieldsFor = (kind: TelemetryKind): TelemetryField[] => {
  switch (kind) {
    case "report-folder":
      return [
        {
          key: "path",
          label: "Report folder",
          placeholder: "\\\\SHOP-PC\\Reports or /mnt/machine-reports",
          required: true,
          type: "text",
        },
        {
          key: "pattern",
          label: "File pattern",
          placeholder: "*.txt",
          type: "text",
        },
        {
          key: "parser",
          label: "Report format",
          options: [...REPORT_PARSERS],
          placeholder: "generic-kv",
          type: "text",
        },
      ];
    case "raw-tcp-status":
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
          placeholder: String(DEFAULT_STATUS_PORT),
          type: "number",
        },
        {
          key: "query",
          label: "Test-reading command",
          placeholder: DEFAULT_ZEBRA_QUERY,
          type: "text",
        },
        {
          key: "dialect",
          label: "Reply format",
          options: ["zebra-hs", "zebra-sgd", "raw"],
          placeholder: "zebra-hs",
          type: "text",
        },
        {
          key: "alertPort",
          label: "Alert listen port on the bridge PC",
          placeholder: String(DEFAULT_ALERT_PORT),
          type: "number",
        },
      ];
    case "http-status":
      return [
        {
          key: "webhookPath",
          label: "Webhook path served by the bridge",
          placeholder: "/telemetry/dtg-1",
          type: "text",
        },
        {
          key: "webhookSecret",
          label: "Webhook secret",
          type: "password",
        },
        {
          key: "url",
          label: "Status URL (test reading only)",
          placeholder: "http://192.168.1.60/api/status",
          type: "text",
        },
        { key: "username", label: "Username (optional)", type: "text" },
        { key: "password", label: "Password (optional)", type: "password" },
        {
          key: "jsonPath",
          label: "JSON path (optional)",
          placeholder: "printer.state",
          type: "text",
        },
      ];
    case "snmp-printer":
      return [
        {
          key: "host",
          label: "Printer IP or hostname",
          placeholder: "192.168.1.60",
          required: true,
          type: "text",
        },
        {
          key: "community",
          label: "SNMP community",
          placeholder: DEFAULT_SNMP_COMMUNITY,
          type: "text",
        },
        {
          key: "port",
          label: "SNMP port (test reading)",
          placeholder: String(DEFAULT_SNMP_PORT),
          type: "number",
        },
        {
          key: "trapPort",
          label: "Trap listen port",
          placeholder: String(DEFAULT_SNMP_TRAP_PORT),
          type: "number",
        },
      ];
    case "manual":
      return [];
  }
};

/** Plain English: what it needs, which machines it suits, what it cannot see. */
export const telemetryHelp = (kind: TelemetryKind): string => {
  switch (kind) {
    case "report-folder":
      return "The machine's own software writes a production report per run (Tajima DG/Network Manager, Melco OS, Barudan LEM, Hirsch/Ricoma panels, and most DTG/DTF RIPs with job logging). Point the bridge at the folder those files land in: it watches the folder with the operating system's filesystem events — nothing is scanned on a timer — and reads each new report for the design name, stitches, pieces and run time. A slow rescan runs only as a safety net for events the OS drops on network shares. This is the only path that gives real minutes for a commercial embroidery head. It is not live: a run appears when the report is written, usually at the end of the job. Ask the shop to switch report writing on and tell you the folder. Files are never moved or deleted.";
    case "raw-tcp-status":
      return "Zebra and Zebra-compatible label printers can PUSH alerts: configure an alert destination with `~SX` (or `alerts.add` on Link-OS) and the printer sends `PAPER OUT SET`, `HEAD OPEN SET`, `PQ COMPLETED` and their CLEARs as they happen. The bridge covers both wirings — it holds a connection to the printer's port open to read unsolicited messages, and it also listens on the alert port for printers configured to dial the bridge PC. Either way nothing is polled. The `~HS` query is used only by the Test Reading button in settings. What it cannot tell you: which order is printing, or anything at all if the shop cannot reach the printer's alert configuration. Printers that are not Zebra-compatible ignore `~SX` entirely — use SNMP traps or `manual` for those.";
    case "http-status":
      return "The machine's software posts to the bridge instead of the bridge asking it: the agent serves a small local endpoint (`http://<bridge-pc>:<port><webhookPath>`) and you paste that URL into the RIP or controller's notification/webhook settings — Kornit, Kothari, Caldera, VersaWorks and several DTG and laser controllers can call a URL on job start and finish. The body may be JSON (mapped through the same field vocabulary as production reports) or plain text. Set a secret; the agent rejects posts without it. If the machine's software can only be queried and cannot notify anything, this path is not live — say so and use `manual` instead of pretending.";
    case "snmp-printer":
      return "Printers that can send SNMP traps push their own state changes: point the printer's trap destination at the bridge PC (community `public` by default, UDP 162) and it sends alerts and status changes without being asked. The bridge decodes the trap varbinds into printer status, device status and the lifetime page count from the Host Resources and Printer MIBs. Good for networked DTG/DTF/sublimation and office-class printers whose menus have an SNMP trap destination. It measures page counts and busy/idle transitions, never stitches, pieces or job names. A one-shot SNMP GET is used only by the Test Reading button. Many shops disable SNMP or change the community string, and a printer with no trap destination setting can only be queried — that is a `manual` machine.";
    case "manual":
      return "No automatic reading: the operator enters run time on the job. Always available, and the honest choice for machines with no network at all — USB-stick embroidery heads, older DTG printers, most laser and vinyl cutters, and anything behind vendor cloud software with no local API or webhook. Use it as the fallback for every machine where none of the pushing paths has been proven against the actual hardware.";
  }
};

const NETWORKED = new Set(["lan", "wifi", "network-folder"]);

/**
 * Telemetry paths worth offering for a machine, in canonical order. This is a
 * suggestion for the settings screen derived from the provider's connections
 * and formats — never a claim that the machine has been tested. `manual` is
 * always included and is always the safe answer.
 */
export const telemetryKindsFor = (
  provider: MachineProvider,
): TelemetryKind[] => {
  const kinds = new Set<TelemetryKind>();
  const networked = provider.connections.some((connection) =>
    NETWORKED.has(connection),
  );
  const speaksZpl =
    provider.formats.includes("zpl") ||
    provider.formats.includes("epl") ||
    provider.formats.includes("tspl");
  switch (provider.kind) {
    case "embroidery":
      // The PC running the machine's software writes reports to a share.
      if (networked) kinds.add("report-folder");
      break;
    case "dtg":
    case "dtf":
    case "sublimation":
      kinds.add("report-folder"); // the RIP's job log
      if (networked) {
        kinds.add("http-status");
        kinds.add("snmp-printer");
      }
      break;
    case "label":
      if (networked && speaksZpl) kinds.add("raw-tcp-status");
      if (networked) kinds.add("snmp-printer");
      break;
    case "laser":
    case "vinyl":
      /* Only machines with a real network panel (a LAN port) have software
       * that can be told to call a webhook; Wi-Fi/cloud cutters are driven
       * from a vendor app that notifies nobody. */
      if (provider.connections.includes("lan")) kinds.add("http-status");
      break;
    case "screen":
      break;
  }
  kinds.add("manual");

  return TELEMETRY_KINDS.filter((kind) => kinds.has(kind));
};
