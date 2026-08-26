// Brother PES: "#PESxxxx" magic, a little-endian pointer at offset 8 to the
// embedded PEC block, then (in full files) the CEmbOne/CSewSeg design
// section. The PEC block is what the machine sews: a 512-byte header with
// label and colour list, a 20-byte stitch-block header, then the stitch
// stream (short 7-bit deltas, long 12-bit deltas flagged 0x80 with 0x10 =
// jump / 0x20 = trim, 0xFE 0xB0 nn = colour change, 0xFF = end) followed by
// one 6×38 thumbnail per colour plus one for the whole design.
// PEC's y axis points down; it is flipped to the shared y-up convention.

import { PEC_THREADS, paletteIndex, paletteName } from "./palettes";
import {
  buildProgram,
  colorCount,
  createByteWriter,
  createStitchCollector,
  eachDelta,
  readUint32Le,
  stitchExtents,
} from "./program";
import type { StitchCommand, StitchProgram } from "./types";

const PES_MAGIC = "#PES";
const PES_VERSION_1 = "#PES0001";
const PES_PEC_POINTER_OFFSET = 8;
const PEC_LABEL_OFFSET = 3;
const PEC_LABEL_BYTES = 16;
const PEC_COLOR_COUNT_OFFSET = 48;
const PEC_HEADER_BYTES = 512;
const PEC_STITCH_DATA_OFFSET = 532;
const PEC_END = 0xff;
const PEC_COLOR_CHANGE = 0xfe;
const PEC_COLOR_CHANGE_SECOND = 0xb0;
const PEC_JUMP_FLAG = 0x10;
const PEC_TRIM_FLAG = 0x20;
const PEC_THUMBNAIL_BYTES = 6 * 38;
/** 12-bit long form carries ±2047. */
export const PEC_MAX_DELTA = 2047;
const PEC_SHORT_LIMIT = 63;

const pecComponent = (bytes: Uint8Array, offset: number) => {
  const first = bytes[offset];
  if (first === undefined) return null;
  if (first & 0x80) {
    const second = bytes[offset + 1];
    if (second === undefined) return null;
    let value = ((first & 0x0f) << 8) | second;
    if (value & 0x800) value -= 0x1000;

    return { flags: first & 0x70, next: offset + 2, value };
  }

  return {
    flags: 0,
    next: offset + 1,
    value: first >= 0x40 ? first - 0x80 : first,
  };
};

const decodeLatin1 = (bytes: Uint8Array) =>
  new TextDecoder("latin1").decode(bytes);

/** Decodes a bare PEC block (as embedded in PES, or a standalone .pec). */
export const decodePecBlock = (
  bytes: Uint8Array,
  pecOffset: number,
): StitchProgram | null => {
  if (pecOffset + PEC_STITCH_DATA_OFFSET > bytes.length) return null;
  if (decodeLatin1(bytes.subarray(pecOffset, pecOffset + 3)) !== "LA:")
    return null;
  const label = decodeLatin1(
    bytes.subarray(
      pecOffset + PEC_LABEL_OFFSET,
      pecOffset + PEC_LABEL_OFFSET + PEC_LABEL_BYTES,
    ),
  )
    .replace(/\0/g, " ")
    .trim();
  const colorByte = bytes[pecOffset + PEC_COLOR_COUNT_OFFSET] ?? 0xff;
  const threads: string[] = [];
  if (colorByte !== 0xff) {
    for (let index = 0; index <= colorByte; index += 1) {
      const paletteId = bytes[pecOffset + PEC_COLOR_COUNT_OFFSET + 1 + index];
      if (paletteId === undefined) break;
      threads.push(paletteName(PEC_THREADS, paletteId));
    }
  }
  const collector = createStitchCollector();
  let index = pecOffset + PEC_STITCH_DATA_OFFSET;
  while (index < bytes.length) {
    const first = bytes[index];
    if (first === undefined || first === PEC_END) break;
    if (
      first === PEC_COLOR_CHANGE &&
      bytes[index + 1] === PEC_COLOR_CHANGE_SECOND
    ) {
      collector.at("color");
      index += 3;
      continue;
    }
    const xPart = pecComponent(bytes, index);
    if (xPart === null) break;
    const yPart = pecComponent(bytes, xPart.next);
    if (yPart === null) break;
    index = yPart.next;
    const flags = xPart.flags | yPart.flags;
    let command: StitchCommand = "stitch";
    if (flags & PEC_TRIM_FLAG) command = "trim";
    else if (flags & PEC_JUMP_FLAG) command = "jump";
    collector.move(xPart.value, -yPart.value, command);
  }
  collector.at("end");

  return buildProgram(collector.stitches(), label, threads);
};

export const decodePes = (bytes: Uint8Array): StitchProgram | null => {
  if (bytes.length < PES_PEC_POINTER_OFFSET + 4) return null;
  if (decodeLatin1(bytes.subarray(0, PES_MAGIC.length)) !== PES_MAGIC)
    return null;
  const pecOffset = readUint32Le(bytes, PES_PEC_POINTER_OFFSET);
  if (pecOffset === null) return null;

  return decodePecBlock(bytes, pecOffset);
};

const longForm = (value: number, flags: number) =>
  0x8000 | (flags << 8) | (value & 0x0fff);

const writeComponentPair = (
  out: ReturnType<typeof createByteWriter>,
  deltaX: number,
  deltaY: number,
  flags: number,
) => {
  const short =
    flags === 0 &&
    Math.abs(deltaX) <= PEC_SHORT_LIMIT &&
    Math.abs(deltaY) <= PEC_SHORT_LIMIT;
  if (short) {
    out.bytesOf([deltaX & 0x7f, deltaY & 0x7f]);

    return;
  }
  out.uint16Be(longForm(deltaX, flags));
  out.uint16Be(longForm(deltaY, flags));
};

const pecThreadIndices = (program: StitchProgram) => {
  const count = colorCount(program);
  const indices: number[] = [];
  for (let index = 0; index < count; index += 1) {
    indices.push(paletteIndex(PEC_THREADS, program.threads?.[index], index));
  }

  return indices;
};

/** Writes the PEC block (header + stitches + blank thumbnails). */
export const encodePecBlock = (program: StitchProgram): Uint8Array => {
  const out = createByteWriter();
  const label = program.label.replace(/[\r\n\0]/g, " ").slice(0, 16);
  const threads = pecThreadIndices(program);
  out.latin1(`LA:${label.padEnd(16, " ")}\r`);
  out.fill(0x20, 12);
  out.bytesOf([0xff, 0x00, 0x06, 0x26]);
  out.fill(0x20, 12);
  out.byte(threads.length - 1);
  out.bytesOf(threads);
  out.fill(0x20, PEC_HEADER_BYTES - out.position());
  const stitchBlockStart = out.position();
  out.bytesOf([0x00, 0x00]);
  out.uint24Le(0); // graphics offset, patched below
  out.bytesOf([0x31, 0xff, 0xf0]);
  const extents = stitchExtents(program.stitches);
  out.uint16Le(Math.max(0, extents.maxX - extents.minX));
  out.uint16Le(Math.max(0, extents.maxY - extents.minY));
  out.uint16Le(0x1e0);
  out.uint16Le(0x1b0);
  out.uint16Be((0x9000 | (-extents.minX & 0x0fff)) & 0xffff);
  out.uint16Be((0x9000 | (extents.maxY & 0x0fff)) & 0xffff);
  let colorToggle = 1;
  eachDelta(program.stitches, PEC_MAX_DELTA, (deltaX, deltaY, command) => {
    const yDown = -deltaY;
    if (command === "color" || command === "stop") {
      out.bytesOf([PEC_COLOR_CHANGE, PEC_COLOR_CHANGE_SECOND, colorToggle]);
      colorToggle = colorToggle === 1 ? 2 : 1;
      if (deltaX !== 0 || yDown !== 0) {
        writeComponentPair(out, deltaX, yDown, PEC_JUMP_FLAG);
      }

      return;
    }
    const flags =
      command === "trim"
        ? PEC_TRIM_FLAG
        : command === "jump"
          ? PEC_JUMP_FLAG
          : 0;
    writeComponentPair(out, deltaX, yDown, flags);
  });
  out.byte(PEC_END);
  out.setUint24Le(stitchBlockStart + 2, out.position() - stitchBlockStart);
  out.fill(0x00, PEC_THUMBNAIL_BYTES * (threads.length + 1));

  return out.bytes();
};

/**
 * Writes a PES version 1 file in its truncated form: the #PES0001 header
 * and hoop/scale words, then the PEC block (no CEmbOne/CSewSeg design
 * section). Machines and most software sew from the PEC block.
 */
export const encodePes = (program: StitchProgram): Uint8Array => {
  const header = createByteWriter();
  header.latin1(PES_VERSION_1);
  header.uint32Le(0); // PEC pointer, patched below
  header.uint16Le(0x01); // scale to fit
  header.uint16Le(0x01); // hoop 130×180
  header.uint16Le(0x00); // no CSewSeg blocks
  header.setUint32Le(PES_PEC_POINTER_OFFSET, header.position());
  const pec = encodePecBlock(program);
  const out = new Uint8Array(header.position() + pec.length);
  out.set(header.bytes(), 0);
  out.set(pec, header.position());

  return out;
};
