import { describe, expect, test } from "bun:test";
import { stitchProgramSvg } from "./preview";
import type { Stitch, StitchProgram } from "./types";

const program = (stitches: Stitch[]): StitchProgram => ({
  colorChanges: stitches.filter((stitch) => stitch.command === "color").length,
  heightMm: 1,
  label: "test",
  stitchCount: stitches.filter((stitch) => stitch.command === "stitch").length,
  stitches,
  widthMm: 1,
});

describe("stitch preview", () => {
  test("one path per thread block, jumps lift the needle, y is flipped", () => {
    const svg = stitchProgramSvg(
      program([
        { command: "stitch", x: 0, y: 0 },
        { command: "stitch", x: 10, y: 10 },
        { command: "jump", x: 50, y: 10 },
        { command: "stitch", x: 60, y: 10 },
        { command: "color", x: 60, y: 10 },
        { command: "stitch", x: 60, y: 20 },
        { command: "end", x: 60, y: 20 },
      ]),
      { colors: ["#111111", "#222222"], title: "Logo <front>" },
    );
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('d="M0 0L10 -10M60 -10"');
    expect(svg).toContain('stroke="#222222"');
    expect(svg).toContain("<title>Logo &lt;front&gt;</title>");
    expect(svg).toContain('viewBox="-20 -40 100 60"');
  });

  test("an empty program still renders a valid drawing", () => {
    expect(stitchProgramSvg(program([]))).toStartWith("<svg");
  });
});
