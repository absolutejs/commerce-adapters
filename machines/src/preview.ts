import { stitchExtents } from "./program";
import type { StitchProgram } from "./types";

/** Distinct thread colours used when a file carries no usable thread list. */
export const PREVIEW_THREAD_COLORS: readonly string[] = [
  "#1f3a93",
  "#c0392b",
  "#27ae60",
  "#f39c12",
  "#8e44ad",
  "#16a085",
  "#2c3e50",
  "#d35400",
  "#e84393",
  "#7f8c8d",
];

export type StitchPreviewOptions = {
  /** One colour per thread block, cycled; defaults to PREVIEW_THREAD_COLORS. */
  colors?: readonly string[];
  /** Thread width in mm; embroidery thread is roughly 0.4mm. */
  threadMm?: number;
  /** Blank margin around the design, in mm. */
  paddingMm?: number;
  /** Accessible title for the drawing. */
  title?: string;
};

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Draws a decoded stitch program as an SVG: one path per thread block, jumps
 * and trims lift the needle (no line), colour changes and stops start the next
 * block in the next colour. The viewBox is in 0.1mm so the drawing keeps the
 * design's real proportions; y is flipped because machine files count up.
 */
export const stitchProgramSvg = (
  program: StitchProgram,
  options: StitchPreviewOptions = {},
) => {
  const colors = options.colors?.length
    ? options.colors
    : PREVIEW_THREAD_COLORS;
  const unitsPerMm = 10;
  const pad = (options.paddingMm ?? 2) * unitsPerMm;
  const extents = stitchExtents(program.stitches);
  const width = Math.max(extents.maxX - extents.minX, 1) + pad * 2;
  const height = Math.max(extents.maxY - extents.minY, 1) + pad * 2;
  const left = extents.minX - pad;
  const top = -extents.maxY - pad;
  const blocks: string[][] = [[]];
  let lifted = true;
  for (const stitch of program.stitches) {
    const block = blocks[blocks.length - 1]!;
    if (stitch.command === "end") break;
    if (stitch.command === "color" || stitch.command === "stop") {
      if (block.length) blocks.push([]);
      lifted = true;
      continue;
    }
    if (stitch.command === "jump" || stitch.command === "trim") {
      lifted = true;
      continue;
    }
    block.push(`${lifted ? "M" : "L"}${stitch.x} ${-stitch.y}`);
    lifted = false;
  }
  const paths = blocks
    .filter((block) => block.length)
    .map(
      (block, index) =>
        `<path d="${block.join("")}" stroke="${escapeXml(colors[index % colors.length]!)}"/>`,
    )
    .join("");
  const title = options.title
    ? `<title>${escapeXml(options.title)}</title>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="${(options.threadMm ?? 0.4) * unitsPerMm}">${title}${paths}</svg>`;
};
