import { describe, expect, test } from "bun:test";
import { parseMachineFile } from "@absolutejs/commerce";
import {
  convertMachineFile,
  decodeStitchProgram,
  encodeStitchProgram,
} from "./index";
import type { Stitch, StitchFormat, StitchProgram } from "./types";
import { buildProgram } from "./program";

const FORMATS: StitchFormat[] = ["dst", "exp", "pes", "jef"];

/** A two-colour design with a long jump, a trim and stitches beyond ±121. */
const sample = (): StitchProgram => {
  const stitches: Stitch[] = [];
  let x = 0;
  let y = 0;
  for (let index = 0; index < 40; index += 1) {
    x += 30;
    y += index % 2 === 0 ? 25 : -25;
    stitches.push({ command: "stitch", x, y });
  }
  stitches.push({ command: "trim", x, y });
  stitches.push({ command: "jump", x: 900, y: 700 });
  stitches.push({ command: "color", x: 900, y: 700 });
  for (let index = 0; index < 30; index += 1) {
    stitches.push({
      command: "stitch",
      x: 900 - index * 35,
      y: 700 - index * 20,
    });
  }
  stitches.push({ command: "stitch", x: -300, y: -450 });
  stitches.push({ command: "color", x: -300, y: -450 });
  stitches.push({ command: "stitch", x: -280, y: -440 });
  stitches.push({ command: "stitch", x: -260, y: -430 });

  return buildProgram(stitches, "ROUNDTRIP", ["Black", "Red", "White"]);
};

const finalPosition = (program: StitchProgram) => {
  const last = [...program.stitches]
    .reverse()
    .find((stitch) => stitch.command !== "end");

  return last ? { x: last.x, y: last.y } : { x: 0, y: 0 };
};

describe("stitch round-trips", () => {
  const original = sample();
  test("sample has the shape the tests rely on", () => {
    expect(original.stitchCount).toBe(73);
    expect(original.colorChanges).toBe(2);
    expect(original.widthMm).toBe(150);
    expect(original.heightMm).toBe(115);
  });
  for (const format of FORMATS) {
    test(`${format}: decode(encode(p)) keeps count, extents and colours`, () => {
      const bytes = encodeStitchProgram(original, format);
      const decoded = decodeStitchProgram(bytes, `design.${format}`);
      expect(decoded).not.toBeNull();
      expect(decoded!.stitchCount).toBe(original.stitchCount);
      expect(decoded!.colorChanges).toBe(original.colorChanges);
      expect(decoded!.widthMm).toBe(original.widthMm);
      expect(decoded!.heightMm).toBe(original.heightMm);
      expect(finalPosition(decoded!)).toEqual(finalPosition(original));
      expect(decoded!.stitches.at(-1)?.command).toBe("end");
    });
  }
  test("dst and pes keep the label; pes and jef keep thread names", () => {
    expect(
      decodeStitchProgram(encodeStitchProgram(original, "dst"), "a.dst")!.label,
    ).toBe("ROUNDTRIP");
    const pes = decodeStitchProgram(
      encodeStitchProgram(original, "pes"),
      "a.pes",
    )!;
    expect(pes.label).toBe("ROUNDTRIP");
    expect(pes.threads).toEqual(["Black", "Red", "White"]);
    const jef = decodeStitchProgram(
      encodeStitchProgram(original, "jef"),
      "a.jef",
    )!;
    expect(jef.threads).toEqual(["Black", "Red", "White"]);
  });
  test("pes stitches survive with trims and jumps intact", () => {
    const pes = decodeStitchProgram(
      encodeStitchProgram(original, "pes"),
      "a.pes",
    )!;
    expect(
      pes.stitches.filter((stitch) => stitch.command === "trim"),
    ).toHaveLength(1);
    expect(
      pes.stitches.filter((stitch) => stitch.command === "jump"),
    ).toHaveLength(1);
  });
  test("every stitch position round-trips exactly through exp and pes", () => {
    for (const format of ["exp", "pes"] as const) {
      const decoded = decodeStitchProgram(
        encodeStitchProgram(original, format),
        `a.${format}`,
      )!;
      const positions = (program: StitchProgram) =>
        program.stitches
          .filter((stitch) => stitch.command === "stitch")
          .map((stitch) => `${stitch.x},${stitch.y}`);
      expect(positions(decoded)).toEqual(positions(original));
    }
  });
});

describe("header compatibility with @absolutejs/commerce parsers", () => {
  const original = sample();
  test("dst header fields are readable by parseDstHeader", () => {
    const facts = parseMachineFile(
      encodeStitchProgram(original, "dst"),
      "a.dst",
    );
    expect(facts?.stitches).toBe(73);
    expect(facts?.colorChanges).toBe(2);
    expect(facts?.label).toBe("ROUNDTRIP");
    expect(facts?.widthMm).toBe(150);
  });
  test("pes/pec block is readable by parsePesHeader", () => {
    const facts = parseMachineFile(
      encodeStitchProgram(original, "pes"),
      "a.pes",
    );
    expect(facts?.stitches).toBe(73);
    expect(facts?.colorChanges).toBe(2);
    expect(facts?.label).toBe("ROUNDTRIP");
  });
  test("exp stream is readable by parseExpStitches", () => {
    const facts = parseMachineFile(
      encodeStitchProgram(original, "exp"),
      "a.exp",
    );
    expect(facts?.stitches).toBe(73);
    expect(facts?.colorChanges).toBe(2);
  });
});

describe("decoder edge cases", () => {
  test("dst header layout is 512 bytes with the expected fields", () => {
    const bytes = encodeStitchProgram(sample(), "dst");
    const header = new TextDecoder("latin1").decode(bytes.subarray(0, 512));
    expect(header.startsWith("LA:ROUNDTRIP       \r")).toBe(true);
    expect(header).toMatch(/ST:\s+73\r/);
    expect(header).toMatch(/CO:\s+2\r/);
    expect(header).toMatch(/\+X:\s+1200\r/);
    expect(header).toMatch(/-X:\s+300\r/);
    expect(header).toMatch(/PD:\*{6}\r/);
    expect(bytes[header.indexOf("\u001a")]).toBe(0x1a);
    expect(bytes.at(-1)).toBe(0xf3);
  });
  test("pes header points at a PEC block with the colour list", () => {
    const bytes = encodeStitchProgram(sample(), "pes");
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 8))).toBe(
      "#PES0001",
    );
    const pecOffset = bytes[8]! | (bytes[9]! << 8);
    expect(
      new TextDecoder("latin1").decode(
        bytes.subarray(pecOffset, pecOffset + 3),
      ),
    ).toBe("LA:");
    expect(bytes[pecOffset + 48]).toBe(2);
  });
  test("unknown extensions and garbage return null", () => {
    expect(decodeStitchProgram(new Uint8Array(600), "a.vp3")).toBeNull();
    expect(decodeStitchProgram(new Uint8Array(600), "a.png")).toBeNull();
    expect(decodeStitchProgram(new Uint8Array(10), "a.dst")).toBeNull();
    expect(decodeStitchProgram(new Uint8Array(10), "a.pes")).toBeNull();
    expect(decodeStitchProgram(new Uint8Array(10), "a.jef")).toBeNull();
  });
  test("dst splits moves longer than 121 units into jumps", () => {
    const program = buildProgram(
      [
        { command: "stitch", x: 0, y: 0 },
        { command: "stitch", x: 400, y: -300 },
      ],
      "",
    );
    const decoded = decodeStitchProgram(
      encodeStitchProgram(program, "dst"),
      "a.dst",
    )!;
    expect(decoded.stitchCount).toBe(2);
    expect(
      decoded.stitches.filter((stitch) => stitch.command === "jump").length,
    ).toBeGreaterThan(0);
    expect(finalPosition(decoded)).toEqual({ x: 400, y: -300 });
  });
});

describe("convertMachineFile", () => {
  test("converts between stitch formats and names the output", () => {
    const dst = encodeStitchProgram(sample(), "dst");
    const result = convertMachineFile(dst, "logo.dst", "pes");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.filename).toBe("logo.pes");
    expect(result.mime).toBe("application/x-brother-pes");
    expect(
      decodeStitchProgram(result.bytes, result.filename)?.stitchCount,
    ).toBe(73);
  });
  test("errors for non-stitch targets and unreadable input", () => {
    const dst = encodeStitchProgram(sample(), "dst");
    expect(convertMachineFile(dst, "logo.dst", "png")).toHaveProperty("error");
    expect(convertMachineFile(dst, "logo.dst", "vp3")).toHaveProperty("error");
    expect(
      convertMachineFile(new Uint8Array(3), "logo.dst", "exp"),
    ).toHaveProperty("error");
  });
});
