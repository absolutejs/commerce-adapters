// Melco EXP: headerless stream of 2-byte signed deltas (0.1mm). A 0x80
// lead byte introduces a control record: 0x80 0x00 end, 0x80 0x01 colour
// change, 0x80 0x02 stop, 0x80 0x04 jump (next delta is needle-up),
// 0x80 0x80 trim (next delta is needle-up). Control records that carry no
// delta are padded to four bytes with 0x00 0x00.

import {
  buildProgram,
  createStitchCollector,
  createByteWriter,
  eachDelta,
  signed8,
} from "./program";
import type { StitchCommand, StitchProgram } from "./types";

const EXP_CONTROL = 0x80;
const EXP_END = 0x00;
const EXP_COLOR = 0x01;
const EXP_STOP = 0x02;
const EXP_JUMP = 0x04;
const EXP_TRIM = 0x80;
/** ±127: a first byte of 0x80 would be read as a control lead. */
export const EXP_MAX_DELTA = 127;

const zeroPad = (bytes: Uint8Array, index: number) =>
  bytes[index] === 0 && bytes[index + 1] === 0 ? 2 : 0;

export const decodeExp = (bytes: Uint8Array): StitchProgram | null => {
  if (bytes.length < 2) return null;
  const collector = createStitchCollector();
  let pending: StitchCommand | null = null;
  let index = 0;
  while (index + 1 < bytes.length) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    index += 2;
    if (first !== EXP_CONTROL) {
      collector.move(signed8(first), signed8(second), pending ?? "stitch");
      pending = null;
      continue;
    }
    if (second === EXP_END) break;
    if (second === EXP_COLOR) {
      collector.at("color");
      index += zeroPad(bytes, index);
      continue;
    }
    if (second === EXP_STOP) {
      collector.at("stop");
      index += zeroPad(bytes, index);
      continue;
    }
    if (second === EXP_JUMP) {
      pending = "jump";
      continue;
    }
    if (second === EXP_TRIM) {
      pending = "trim";
      continue;
    }
    // Unknown control record: skip it.
  }
  collector.at("end");
  const program = buildProgram(collector.stitches(), "");

  return program.stitchCount > 0 || program.colorChanges > 0 ? program : null;
};

export const encodeExp = (program: StitchProgram): Uint8Array => {
  const out = createByteWriter();
  eachDelta(program.stitches, EXP_MAX_DELTA, (deltaX, deltaY, command) => {
    if (command === "color") {
      out.bytesOf([EXP_CONTROL, EXP_COLOR, 0, 0]);
      if (deltaX !== 0 || deltaY !== 0) {
        out.bytesOf([EXP_CONTROL, EXP_JUMP, deltaX, deltaY]);
      }

      return;
    }
    if (command === "stop") {
      out.bytesOf([EXP_CONTROL, EXP_STOP, 0, 0]);
      if (deltaX !== 0 || deltaY !== 0) {
        out.bytesOf([EXP_CONTROL, EXP_JUMP, deltaX, deltaY]);
      }

      return;
    }
    if (command === "jump") out.bytesOf([EXP_CONTROL, EXP_JUMP]);
    if (command === "trim") out.bytesOf([EXP_CONTROL, EXP_TRIM]);
    out.bytesOf([deltaX, deltaY]);
  });
  out.bytesOf([EXP_CONTROL, EXP_END]);

  return out.bytes();
};
