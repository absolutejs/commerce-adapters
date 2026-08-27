import { describe, expect, test } from "bun:test";
import { getMachineProvider } from "./providers";
import {
  decodeSnmpPrinterStatus,
  decodeZebraAlert,
  decodeZebraStatus,
  eventsToRuns,
  isMachineRunEvent,
  isTelemetrySource,
  parseMachineReport,
  readingsToRuns,
  referenceFromJobName,
  snmpPrinterOids,
  telemetryDelivery,
  telemetryFieldsFor,
  telemetryHelp,
  telemetryKindsFor,
  TELEMETRY_KINDS,
  TELEMETRY_LABELS,
  type MachineReading,
} from "./telemetry";

const at = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
) => new Date(year, month - 1, day, hour, minute, second).toISOString();

const now = () => new Date(Date.UTC(2026, 7, 26, 12, 0, 0));

/* Shaped like the production report a Tajima panel / DG-ML by Pulse writes
 * after a run: a header, then labelled values, numbers with thousands
 * separators and a hh:mm:ss run time. */
const TAJIMA_REPORT = `TAJIMA PRODUCTION REPORT
Machine        : TMBP-SC1501 #2
Operator       : RJ
Design         : 288C8286-L1-1.DST
Start          : 2026/08/26 09:14:03
End            : 2026/08/26 09:31:47
Run time       : 00:17:44
Stitches       : 12,480
Pieces         : 6
Stops          : 2
Thread breaks  : 1
Status         : Completed
`;

/* Melco OS exports its production log as a header row plus one row per run. */
const MELCO_REPORT = `Melco OS Production Report,,,,,,
Design,Stitches,Pieces,Start,End,Elapsed,Status
LOGO-A.OFM,4200,2,2026-08-26 08:02:00,2026-08-26 08:09:00,00:07:00,Complete
288C8286-L1-1.OFM,12480,6,2026-08-26 09:14:03,2026-08-26 09:31:47,00:17:44,Complete
`;

describe("report parsers", () => {
  test("a Tajima production report", () => {
    const reading = parseMachineReport(TAJIMA_REPORT, "tajima-report", { now });
    expect(reading).not.toBeNull();
    expect(reading?.jobName).toBe("288C8286-L1-1.DST");
    expect(reading?.stitches).toBe(12480);
    expect(reading?.pieces).toBe(6);
    expect(reading?.elapsedSeconds).toBe(1064);
    expect(reading?.state).toBe("idle");
    expect(reading?.at).toBe(at(2026, 8, 26, 9, 31, 47));
    expect(referenceFromJobName(reading?.jobName)).toBe("288C8286-L1-1");
  });

  test("a Melco CSV production report takes the newest row", () => {
    const reading = parseMachineReport(MELCO_REPORT, "melco-report", { now });
    expect(reading?.jobName).toBe("288C8286-L1-1.OFM");
    expect(reading?.stitches).toBe(12480);
    expect(reading?.pieces).toBe(6);
    expect(reading?.elapsedSeconds).toBe(1064);
    expect(reading?.at).toBe(at(2026, 8, 26, 9, 31, 47));
  });

  test("generic key/value, including = and tab separators", () => {
    const reading = parseMachineReport(
      "Job = ORD-77-L2\nStitches\t8100\nDuration = 6 min\nState = running",
      "generic-kv",
      { now },
    );
    expect(reading?.jobName).toBe("ORD-77-L2");
    expect(reading?.stitches).toBe(8100);
    expect(reading?.elapsedSeconds).toBe(360);
    expect(reading?.state).toBe("running");
    // No timestamp in the report: the injected clock is used.
    expect(reading?.at).toBe(now().toISOString());
  });

  test("JSON reports, arrays taking the last entry", () => {
    const reading = parseMachineReport(
      JSON.stringify([
        { jobName: "OLD-1", pageCount: 1 },
        {
          elapsedSeconds: 90,
          jobName: "ORD-9-L1",
          pageCount: 12,
          state: "idle",
        },
      ]),
      "json",
      { now },
    );
    expect(reading?.jobName).toBe("ORD-9-L1");
    expect(reading?.pageCount).toBe(12);
    expect(reading?.elapsedSeconds).toBe(90);
  });

  test("a report with nothing job-shaped is null, not a fake reading", () => {
    expect(
      parseMachineReport("hello\nworld", "generic-kv", { now }),
    ).toBeNull();
    expect(parseMachineReport("", "tajima-report", { now })).toBeNull();
    expect(parseMachineReport("not json", "json", { now })).toBeNull();
  });

  test("an unexpected layout degrades to the generic reader", () => {
    // A Melco-labelled parse of a Tajima file still finds the fields.
    const reading = parseMachineReport(TAJIMA_REPORT, "melco-report", { now });
    expect(reading?.stitches).toBe(12480);
  });
});

describe("readingsToRuns", () => {
  const sample = (
    minute: number,
    state: MachineReading["state"],
    stitches?: number,
  ) => ({
    at: at(2026, 8, 26, 9, minute, 0),
    state,
    stitches,
  });

  test("consecutive running samples collapse into one run", () => {
    const runs = readingsToRuns(
      [
        sample(0, "idle"),
        sample(1, "running", 100),
        sample(2, "running", 900),
        sample(3, "running", 1500),
        sample(4, "idle"),
      ],
      { idleGapSeconds: 300 },
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.startedAt).toBe(at(2026, 8, 26, 9, 1, 0));
    expect(runs[0]?.finishedAt).toBe(at(2026, 8, 26, 9, 4, 0));
    expect(runs[0]?.seconds).toBe(180);
    expect(runs[0]?.stitches).toBe(1500);
  });

  test("a gap longer than idleGapSeconds splits the run and caps the credit", () => {
    const runs = readingsToRuns(
      [
        sample(0, "running"),
        sample(1, "running"),
        sample(40, "running"),
        sample(41, "running"),
      ],
      { idleGapSeconds: 300 },
    );
    expect(runs).toHaveLength(2);
    // First run is credited to its last running sample, not into the gap.
    expect(runs[0]?.seconds).toBe(60);
    expect(runs[1]?.seconds).toBe(60);
  });

  test("a long silence then idle credits at most one gap", () => {
    const runs = readingsToRuns([sample(0, "running"), sample(120, "idle")], {
      idleGapSeconds: 300,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.seconds).toBe(300);
  });

  test("a finished report becomes its own run from elapsedSeconds", () => {
    const runs = readingsToRuns([
      {
        at: at(2026, 8, 26, 9, 31, 47),
        elapsedSeconds: 1064,
        pieces: 6,
        state: "idle",
        stitches: 12480,
      },
    ]);
    expect(runs).toEqual([
      {
        finishedAt: at(2026, 8, 26, 9, 31, 47),
        pieces: 6,
        seconds: 1064,
        startedAt: at(2026, 8, 26, 9, 14, 3),
        stitches: 12480,
      },
    ]);
  });

  test("unsorted and unparseable timestamps are handled", () => {
    const runs = readingsToRuns([
      sample(3, "running"),
      { at: "not a date", state: "running" },
      sample(1, "running"),
      sample(5, "idle"),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.startedAt).toBe(at(2026, 8, 26, 9, 1, 0));
  });

  test("eventsToRuns reads the readings out of run events", () => {
    const runs = eventsToRuns([
      {
        at: at(2026, 8, 26, 9, 1, 0),
        kind: "start",
        machineId: "m1",
        reading: sample(1, "running"),
      },
      {
        at: at(2026, 8, 26, 9, 6, 0),
        kind: "finish",
        machineId: "m1",
        reading: sample(6, "idle"),
      },
    ]);
    expect(runs[0]?.seconds).toBe(300);
  });
});

describe("zebra decoding", () => {
  const stx = String.fromCharCode(2);
  const etx = String.fromCharCode(3);
  const hs = (line1: string, line2: string) =>
    `${stx}${line1}${etx}\r\n${stx}${line2}${etx}\r\n${stx}1234,0${etx}\r\n`;

  test("~HS idle", () => {
    const reading = decodeZebraStatus(
      hs(
        "030,0,0,0888,000,0,0,0,000,0,0,0",
        "001,0,0,0,0,2,4,0,00000000,1,000",
      ),
    );
    expect(reading?.state).toBe("idle");
  });

  test("~HS printing reports the labels left in the batch", () => {
    const reading = decodeZebraStatus(
      hs(
        "030,0,0,0888,000,0,0,0,000,0,0,0",
        "001,0,0,0,0,2,4,0,00000012,1,000",
      ),
    );
    expect(reading?.state).toBe("running");
    expect(reading?.detail).toContain("12 label(s)");
  });

  test("~HS media out and head open are errors, pause is paused", () => {
    expect(
      decodeZebraStatus(
        hs(
          "030,1,0,0888,000,0,0,0,000,0,0,0",
          "001,0,0,0,0,2,4,0,00000000,1,000",
        ),
      ),
    ).toMatchObject({ detail: "media out", state: "error" });
    expect(
      decodeZebraStatus(
        hs(
          "030,0,0,0888,000,0,0,0,000,0,0,0",
          "001,0,1,0,0,2,4,0,00000000,1,000",
        ),
      )?.state,
    ).toBe("error");
    expect(
      decodeZebraStatus(
        hs(
          "030,0,1,0888,000,0,0,0,000,0,0,0",
          "001,0,0,0,0,2,4,0,00000000,1,000",
        ),
      )?.state,
    ).toBe("paused");
  });

  test("SGD getvar word replies", () => {
    expect(decodeZebraStatus('"printing"')?.state).toBe("running");
    expect(decodeZebraStatus('"head open"')?.state).toBe("error");
    expect(decodeZebraStatus("nonsense reply")).toBeNull();
  });

  test("unsolicited alerts, SET and CLEAR", () => {
    expect(decodeZebraAlert("PAPER OUT SET")).toMatchObject({
      detail: "media out",
      state: "error",
    });
    expect(decodeZebraAlert("PAPER OUT CLEAR")).toMatchObject({
      state: "idle",
    });
    expect(
      decodeZebraAlert("ZEBRA ZD421\r\nSERIAL: 12345\r\nHEAD OPEN SET")?.state,
    ).toBe("error");
    expect(decodeZebraAlert("PQ COMPLETED 12 LABELS")).toMatchObject({
      pieces: 12,
      state: "idle",
    });
    expect(decodeZebraAlert("SOMETHING UNKNOWN")).toBeNull();
  });
});

describe("snmp printer status", () => {
  test("printing with a page count", () => {
    const reading = decodeSnmpPrinterStatus({
      [snmpPrinterOids.description]: "Epson SureColor F2100",
      [snmpPrinterOids.deviceStatus]: 2,
      [snmpPrinterOids.pageCount]: 48211,
      [snmpPrinterOids.printerStatus]: 4,
    });
    expect(reading.state).toBe("running");
    expect(reading.pageCount).toBe(48211);
    expect(reading.detail).toContain("Epson SureColor F2100");
  });

  test("device down beats printer status, and leading dots are tolerated", () => {
    expect(
      decodeSnmpPrinterStatus({
        [`.${snmpPrinterOids.deviceStatus}`]: 5,
        [`.${snmpPrinterOids.printerStatus}`]: 4,
      }).state,
    ).toBe("error");
  });

  test("nothing known is unknown, never a guess", () => {
    expect(decodeSnmpPrinterStatus({}).state).toBe("unknown");
  });
});

describe("settings surface", () => {
  test("every kind has a label, help and fields", () => {
    for (const kind of TELEMETRY_KINDS) {
      expect(TELEMETRY_LABELS[kind].length).toBeGreaterThan(0);
      expect(telemetryHelp(kind).length).toBeGreaterThan(80);
      for (const field of telemetryFieldsFor(kind)) {
        expect(["text", "password", "number"]).toContain(field.type);
        expect(field.label.length).toBeGreaterThan(0);
      }
    }
    expect(telemetryFieldsFor("manual")).toEqual([]);
    expect(telemetryDelivery("report-folder")).toBe("watch");
    expect(telemetryDelivery("snmp-printer")).toBe("push");
    expect(telemetryDelivery("manual")).toBe("manual");
  });

  test("telemetryKindsFor suggests what the machine can plausibly do", () => {
    const zebra = getMachineProvider("zebra")!;
    expect(telemetryKindsFor(zebra)).toContain("raw-tcp-status");
    const dymo = getMachineProvider("dymo")!;
    expect(telemetryKindsFor(dymo)).not.toContain("raw-tcp-status");
    const tajima = getMachineProvider("tajima")!;
    expect(telemetryKindsFor(tajima)).toEqual(["report-folder", "manual"]);
    const cricut = getMachineProvider("cricut")!;
    expect(telemetryKindsFor(cricut)).toEqual(["manual"]);
    for (const provider of [zebra, dymo, tajima, cricut]) {
      expect(telemetryKindsFor(provider)).toContain("manual");
    }
  });

  test("source and event guards reject junk from the wire", () => {
    expect(isTelemetrySource({ kind: "manual" })).toBe(true);
    expect(isTelemetrySource({ kind: "report-folder", path: "/x" })).toBe(true);
    expect(isTelemetrySource({ kind: "report-folder" })).toBe(false);
    expect(isTelemetrySource({ kind: "shell", path: "/x" })).toBe(false);
    expect(
      isMachineRunEvent({
        at: "2026-08-26T09:00:00.000Z",
        kind: "finish",
        machineId: "m1",
        reading: { at: "2026-08-26T09:00:00.000Z", state: "idle" },
      }),
    ).toBe(true);
    expect(
      isMachineRunEvent({
        at: "2026-08-26T09:00:00.000Z",
        kind: "explode",
        machineId: "m1",
        reading: { at: "x", state: "idle" },
      }),
    ).toBe(false);
  });
});
