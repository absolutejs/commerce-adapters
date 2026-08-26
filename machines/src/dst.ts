// Tajima DST: 512-byte ASCII header followed by 3-byte stitch records.
// Each record encodes a ternary-ish delta (±1, ±3, ±9, ±27, ±81 per axis)
// with the top bits of byte 2 flagging jump (0x80) and colour change
// (0x40); 0xF3 ends the design. DST has no explicit trim — trims are
// written as zero-length jumps here and read back as jumps.

import {
  buildProgram,
  createByteWriter,
  createStitchCollector,
  eachDelta,
  stitchExtents,
} from "./program";
import type { StitchCommand, StitchProgram } from "./types";

export const DST_HEADER_BYTES = 512;
/** Largest per-axis delta a single DST record can carry. */
export const DST_MAX_DELTA = 121;
const DST_END = 0xf3;

const bit = (value: number, mask: number) => (value & mask ? 1 : 0);

const decodeDeltaX = (b0: number, b1: number, b2: number) =>
  bit(b0, 0x01) -
  bit(b0, 0x02) +
  9 * (bit(b0, 0x04) - bit(b0, 0x08)) +
  3 * (bit(b1, 0x01) - bit(b1, 0x02)) +
  27 * (bit(b1, 0x04) - bit(b1, 0x08)) +
  81 * (bit(b2, 0x04) - bit(b2, 0x08));

const decodeDeltaY = (b0: number, b1: number, b2: number) =>
  bit(b0, 0x80) -
  bit(b0, 0x40) +
  9 * (bit(b0, 0x20) - bit(b0, 0x10)) +
  3 * (bit(b1, 0x80) - bit(b1, 0x40)) +
  27 * (bit(b1, 0x20) - bit(b1, 0x10)) +
  81 * (bit(b2, 0x20) - bit(b2, 0x10));

const headerField = (header: string, key: string) => {
  const match = new RegExp(`${key}:\\s*([+-]?\\s*\\d+)`).exec(header);

  return match ? Number(match[1]?.replace(/\s+/g, "")) : null;
};

export const decodeDst = (bytes: Uint8Array): StitchProgram | null => {
  if (bytes.length < DST_HEADER_BYTES) return null;
  const header = new TextDecoder("latin1").decode(
    bytes.subarray(0, DST_HEADER_BYTES),
  );
  if (headerField(header, "ST") === null) return null;
  const label = /LA:([^\r\n]{0,16})/.exec(header)?.[1]?.trim() ?? "";
  const collector = createStitchCollector();
  let index = DST_HEADER_BYTES;
  while (index + 2 < bytes.length) {
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1] ?? 0;
    const b2 = bytes[index + 2] ?? 0;
    index += 3;
    if (b2 === DST_END) break;
    const deltaX = decodeDeltaX(b0, b1, b2);
    const deltaY = decodeDeltaY(b0, b1, b2);
    let command: StitchCommand = "stitch";
    if ((b2 & 0xc0) === 0xc0) command = "color";
    else if (b2 & 0x80) command = "jump";
    collector.move(deltaX, deltaY, command);
  }
  collector.at("end");

  return buildProgram(collector.stitches(), label);
};

const encodeRecord = (
  deltaX: number,
  deltaY: number,
  command: StitchCommand,
): [number, number, number] => {
  let x = deltaX;
  let y = deltaY;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  if (x > 40) {
    b2 |= 0x04;
    x -= 81;
  }
  if (x < -40) {
    b2 |= 0x08;
    x += 81;
  }
  if (y > 40) {
    b2 |= 0x20;
    y -= 81;
  }
  if (y < -40) {
    b2 |= 0x10;
    y += 81;
  }
  if (x > 13) {
    b1 |= 0x04;
    x -= 27;
  }
  if (x < -13) {
    b1 |= 0x08;
    x += 27;
  }
  if (y > 13) {
    b1 |= 0x20;
    y -= 27;
  }
  if (y < -13) {
    b1 |= 0x10;
    y += 27;
  }
  if (x > 4) {
    b0 |= 0x04;
    x -= 9;
  }
  if (x < -4) {
    b0 |= 0x08;
    x += 9;
  }
  if (y > 4) {
    b0 |= 0x20;
    y -= 9;
  }
  if (y < -4) {
    b0 |= 0x10;
    y += 9;
  }
  if (x > 1) {
    b1 |= 0x01;
    x -= 3;
  }
  if (x < -1) {
    b1 |= 0x02;
    x += 3;
  }
  if (y > 1) {
    b1 |= 0x80;
    y -= 3;
  }
  if (y < -1) {
    b1 |= 0x40;
    y += 3;
  }
  if (x > 0) {
    b0 |= 0x01;
    x -= 1;
  }
  if (x < 0) {
    b0 |= 0x02;
    x += 1;
  }
  if (y > 0) {
    b0 |= 0x80;
    y -= 1;
  }
  if (y < 0) {
    b0 |= 0x40;
    y += 1;
  }
  b2 |= 0x03;
  if (command === "jump" || command === "trim") b2 |= 0x80;
  if (command === "color" || command === "stop") b2 |= 0xc0;

  return [b0, b1, b2];
};

const pad = (value: number, width: number) =>
  String(Math.abs(Math.round(value))).padStart(width, " ");
const signed = (value: number, width: number) =>
  `${value < 0 ? "-" : "+"}${pad(value, width)}`;

export const encodeDst = (program: StitchProgram): Uint8Array => {
  const body = createByteWriter();
  let stitchCount = 0;
  let colorChanges = 0;
  let endX = 0;
  let endY = 0;
  eachDelta(program.stitches, DST_MAX_DELTA, (deltaX, deltaY, command) => {
    body.bytesOf(encodeRecord(deltaX, deltaY, command));
    endX += deltaX;
    endY += deltaY;
    if (command === "stitch") stitchCount += 1;
    if (command === "color") colorChanges += 1;
  });
  body.bytesOf([0, 0, DST_END]);
  const extents = stitchExtents(program.stitches);
  const label = program.label.replace(/[\r\n]/g, " ").slice(0, 16);
  const header = createByteWriter();
  header.latin1(`LA:${label.padEnd(16, " ")}\r`);
  header.latin1(`ST:${pad(stitchCount, 7)}\r`);
  header.latin1(`CO:${pad(colorChanges, 3)}\r`);
  header.latin1(`+X:${pad(Math.max(0, extents.maxX), 5)}\r`);
  header.latin1(`-X:${pad(Math.max(0, -extents.minX), 5)}\r`);
  header.latin1(`+Y:${pad(Math.max(0, extents.maxY), 5)}\r`);
  header.latin1(`-Y:${pad(Math.max(0, -extents.minY), 5)}\r`);
  header.latin1(`AX:${signed(endX, 5)}\r`);
  header.latin1(`AY:${signed(endY, 5)}\r`);
  header.latin1(`MX:${signed(0, 5)}\r`);
  header.latin1(`MY:${signed(0, 5)}\r`);
  header.latin1("PD:******\r");
  header.byte(0x1a);
  header.fill(0x20, DST_HEADER_BYTES - header.position());
  const out = new Uint8Array(DST_HEADER_BYTES + body.position());
  out.set(header.bytes(), 0);
  out.set(body.bytes(), DST_HEADER_BYTES);

  return out;
};
