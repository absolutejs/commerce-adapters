// Janome JEF: 116-byte little-endian header (stitch-data offset, format
// word, 14-char timestamp, colour count, point count, hoop code, design
// extents and four hoop-clearance rectangles) followed by the thread list
// (palette index + thread type per colour) and 2-byte signed deltas. A
// 0x80 lead byte introduces a control: 0x80 0x01 colour change, 0x80 0x02
// jump/trim (with the next delta), 0x80 0x10 end. JEF's y axis points
// down; it is flipped to the shared y-up convention.

import { JEF_THREADS, paletteIndex, paletteName } from "./palettes";
import {
  buildProgram,
  colorCount,
  createByteWriter,
  createStitchCollector,
  eachDelta,
  readUint32Le,
  signed8,
  stitchExtents,
} from "./program";
import type { StitchProgram } from "./types";

const JEF_HEADER_BYTES = 0x74;
const JEF_CONTROL = 0x80;
const JEF_COLOR = 0x01;
const JEF_MOVE = 0x02;
const JEF_END = 0x10;
const JEF_THREAD_TYPE = 0x0d;
export const JEF_MAX_DELTA = 127;

type Hoop = { code: number; widthMm: number; heightMm: number };
const HOOPS: readonly Hoop[] = [
  { code: 1, heightMm: 50, widthMm: 50 },
  { code: 0, heightMm: 110, widthMm: 110 },
  { code: 3, heightMm: 110, widthMm: 126 },
  { code: 2, heightMm: 200, widthMm: 140 },
  { code: 4, heightMm: 200, widthMm: 200 },
];

export const decodeJef = (bytes: Uint8Array): StitchProgram | null => {
  if (bytes.length < JEF_HEADER_BYTES) return null;
  const stitchOffset = readUint32Le(bytes, 0);
  const colors = readUint32Le(bytes, 24);
  if (stitchOffset === null || colors === null) return null;
  if (stitchOffset < JEF_HEADER_BYTES || stitchOffset > bytes.length)
    return null;
  if (colors > 256) return null;
  const threads: string[] = [];
  for (let index = 0; index < colors; index += 1) {
    const paletteId = readUint32Le(bytes, JEF_HEADER_BYTES + index * 4);
    if (paletteId === null) break;
    threads.push(paletteName(JEF_THREADS, paletteId));
  }
  const collector = createStitchCollector();
  let index = stitchOffset;
  while (index + 1 < bytes.length) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    index += 2;
    if (first !== JEF_CONTROL) {
      collector.move(signed8(first), -signed8(second), "stitch");
      continue;
    }
    const deltaX = signed8(bytes[index] ?? 0);
    const deltaY = -signed8(bytes[index + 1] ?? 0);
    index += 2;
    if (second === JEF_END) break;
    if (second === JEF_COLOR) {
      collector.at("color");
      continue;
    }
    if (second === JEF_MOVE) {
      if (deltaX === 0 && deltaY === 0) collector.at("trim");
      else collector.move(deltaX, deltaY, "jump");
      continue;
    }
    // Unknown control (e.g. 0x80 0x00 no-op): keep walking.
  }
  collector.at("end");
  const program = buildProgram(collector.stitches(), "", threads);

  return program.stitchCount > 0 || program.colorChanges > 0 ? program : null;
};

const timestamp = () => {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");

  return (
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  );
};

const pickHoop = (widthMm: number, heightMm: number) =>
  HOOPS.find((hoop) => widthMm <= hoop.widthMm && heightMm <= hoop.heightMm) ??
  HOOPS[HOOPS.length - 1]!;

export const encodeJef = (program: StitchProgram): Uint8Array => {
  const out = createByteWriter();
  const colors = colorCount(program);
  const extents = stitchExtents(program.stitches);
  const hoop = pickHoop(
    (extents.maxX - extents.minX) / 10,
    (extents.maxY - extents.minY) / 10,
  );
  out.uint32Le(JEF_HEADER_BYTES + colors * 8);
  out.uint32Le(0x14);
  out.latin1(timestamp());
  out.bytesOf([0x00, 0x00]);
  out.uint32Le(colors);
  const pointCountOffset = out.position();
  out.uint32Le(0); // point count, patched below
  out.uint32Le(hoop.code);
  // Design extents relative to centre, then clearance to each hoop edge.
  const left = -extents.minX;
  const top = extents.maxY;
  const right = extents.maxX;
  const bottom = -extents.minY;
  out.uint32Le(left >>> 0);
  out.uint32Le(top >>> 0);
  out.uint32Le(right >>> 0);
  out.uint32Le(bottom >>> 0);
  for (const size of [110, 50, 140, 200] as const) {
    const halfX = (size === 140 ? 140 : size) * 5;
    const halfY = (size === 140 ? 200 : size) * 5;
    const fits =
      left <= halfX && right <= halfX && top <= halfY && bottom <= halfY;
    for (const clearance of [
      halfX - left,
      halfY - top,
      halfX - right,
      halfY - bottom,
    ]) {
      out.uint32Le(fits ? clearance >>> 0 : 0xffffffff);
    }
  }
  for (let index = 0; index < colors; index += 1) {
    out.uint32Le(paletteIndex(JEF_THREADS, program.threads?.[index], index));
  }
  for (let index = 0; index < colors; index += 1) out.uint32Le(JEF_THREAD_TYPE);
  let points = 0;
  eachDelta(program.stitches, JEF_MAX_DELTA, (deltaX, deltaY, command) => {
    const yDown = -deltaY;
    points += 1;
    if (command === "color" || command === "stop") {
      out.bytesOf([JEF_CONTROL, JEF_COLOR, 0x00, 0x00]);
      if (deltaX !== 0 || yDown !== 0) {
        out.bytesOf([JEF_CONTROL, JEF_MOVE, deltaX, yDown]);
        points += 1;
      }

      return;
    }
    if (command === "trim") {
      out.bytesOf([JEF_CONTROL, JEF_MOVE, 0x00, 0x00]);
      if (deltaX !== 0 || yDown !== 0) {
        out.bytesOf([JEF_CONTROL, JEF_MOVE, deltaX, yDown]);
        points += 1;
      }

      return;
    }
    if (command === "jump") {
      out.bytesOf([JEF_CONTROL, JEF_MOVE, deltaX, yDown]);

      return;
    }
    out.bytesOf([deltaX, yDown]);
  });
  out.bytesOf([JEF_CONTROL, JEF_END, 0x00, 0x00]);
  out.setUint32Le(pointCountOffset, points + 1);

  return out.bytes();
};
