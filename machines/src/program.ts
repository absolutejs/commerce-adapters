import type { Stitch, StitchCommand, StitchProgram } from "./types";

/** DST, EXP, PEC and JEF coordinates are all 0.1mm units. */
export const UNITS_PER_MM = 10;

/** Signed 8-bit interpretation of a byte. */
export const signed8 = (byte: number) => (byte > 0x7f ? byte - 0x100 : byte);

export const readUint32Le = (bytes: Uint8Array, offset: number) => {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (
    b0 === undefined ||
    b1 === undefined ||
    b2 === undefined ||
    b3 === undefined
  )
    return null;

  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
};

export const readUint16Le = (bytes: Uint8Array, offset: number) => {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  if (b0 === undefined || b1 === undefined) return null;

  return b0 | (b1 << 8);
};

/** Growable byte sink shared by the encoders. */
export const createByteWriter = () => {
  let buffer = new Uint8Array(4096);
  let length = 0;
  const ensure = (extra: number) => {
    if (length + extra <= buffer.length) return;
    const next = new Uint8Array(Math.max(buffer.length * 2, length + extra));
    next.set(buffer);
    buffer = next;
  };

  return {
    bytes: () => buffer.slice(0, length),
    byte: (value: number) => {
      ensure(1);
      buffer[length] = value & 0xff;
      length += 1;
    },
    bytesOf: (values: ArrayLike<number>) => {
      ensure(values.length);
      buffer.set(values, length);
      length += values.length;
    },
    fill: (value: number, count: number) => {
      ensure(count);
      buffer.fill(value & 0xff, length, length + count);
      length += count;
    },
    latin1: (text: string) => {
      ensure(text.length);
      for (let index = 0; index < text.length; index += 1) {
        buffer[length] = text.charCodeAt(index) & 0xff;
        length += 1;
      }
    },
    position: () => length,
    setUint24Le: (offset: number, value: number) => {
      buffer[offset] = value & 0xff;
      buffer[offset + 1] = (value >> 8) & 0xff;
      buffer[offset + 2] = (value >> 16) & 0xff;
    },
    setUint32Le: (offset: number, value: number) => {
      buffer[offset] = value & 0xff;
      buffer[offset + 1] = (value >> 8) & 0xff;
      buffer[offset + 2] = (value >> 16) & 0xff;
      buffer[offset + 3] = (value >>> 24) & 0xff;
    },
    uint16Be: (value: number) => {
      ensure(2);
      buffer[length] = (value >> 8) & 0xff;
      buffer[length + 1] = value & 0xff;
      length += 2;
    },
    uint16Le: (value: number) => {
      ensure(2);
      buffer[length] = value & 0xff;
      buffer[length + 1] = (value >> 8) & 0xff;
      length += 2;
    },
    uint24Le: (value: number) => {
      ensure(3);
      buffer[length] = value & 0xff;
      buffer[length + 1] = (value >> 8) & 0xff;
      buffer[length + 2] = (value >> 16) & 0xff;
      length += 3;
    },
    uint32Le: (value: number) => {
      ensure(4);
      buffer[length] = value & 0xff;
      buffer[length + 1] = (value >> 8) & 0xff;
      buffer[length + 2] = (value >> 16) & 0xff;
      buffer[length + 3] = (value >>> 24) & 0xff;
      length += 4;
    },
  };
};

/** Collects absolute stitches from decoders that walk relative deltas. */
export const createStitchCollector = () => {
  const stitches: Stitch[] = [];
  let x = 0;
  let y = 0;

  return {
    at: (command: StitchCommand) => {
      stitches.push({ command, x, y });
    },
    move: (deltaX: number, deltaY: number, command: StitchCommand) => {
      x += deltaX;
      y += deltaY;
      stitches.push({ command, x, y });
    },
    stitches: () => stitches,
  };
};

/** Bounding box over every stitch/jump position; empty programs are 0×0. */
export const stitchExtents = (stitches: readonly Stitch[]) => {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const stitch of stitches) {
    if (stitch.command !== "stitch" && stitch.command !== "jump") continue;
    seen = true;
    if (stitch.x < minX) minX = stitch.x;
    if (stitch.x > maxX) maxX = stitch.x;
    if (stitch.y < minY) minY = stitch.y;
    if (stitch.y > maxY) maxY = stitch.y;
  }
  if (!seen) return { maxX: 0, maxY: 0, minX: 0, minY: 0 };

  return { maxX, maxY, minX, minY };
};

/** Builds the summary fields of a program from its stitch list. */
export const buildProgram = (
  stitches: Stitch[],
  label: string,
  threads?: string[],
): StitchProgram => {
  const extents = stitchExtents(stitches);
  let colorChanges = 0;
  let stitchCount = 0;
  for (const stitch of stitches) {
    if (stitch.command === "stitch") stitchCount += 1;
    else if (stitch.command === "color") colorChanges += 1;
  }

  return {
    colorChanges,
    heightMm: Math.round((extents.maxY - extents.minY) / UNITS_PER_MM),
    label,
    stitchCount,
    stitches,
    ...(threads && threads.length > 0 ? { threads } : {}),
    widthMm: Math.round((extents.maxX - extents.minX) / UNITS_PER_MM),
  };
};

/**
 * Walks a program as relative moves, splitting any move longer than
 * `maxDelta` into needle-up jumps so the final leg carries the command.
 */
export const eachDelta = (
  stitches: readonly Stitch[],
  maxDelta: number,
  emit: (deltaX: number, deltaY: number, command: StitchCommand) => void,
) => {
  let x = 0;
  let y = 0;
  for (const stitch of stitches) {
    if (stitch.command === "end") continue;
    let deltaX = Math.round(stitch.x) - x;
    let deltaY = Math.round(stitch.y) - y;
    while (Math.abs(deltaX) > maxDelta || Math.abs(deltaY) > maxDelta) {
      const stepX = Math.max(-maxDelta, Math.min(maxDelta, deltaX));
      const stepY = Math.max(-maxDelta, Math.min(maxDelta, deltaY));
      emit(stepX, stepY, "jump");
      deltaX -= stepX;
      deltaY -= stepY;
    }
    emit(deltaX, deltaY, stitch.command);
    x = Math.round(stitch.x);
    y = Math.round(stitch.y);
  }
};

/** Number of colour blocks: one more than the colour changes. */
export const colorCount = (program: StitchProgram) =>
  Math.max(1, program.colorChanges + 1);

export const fileExtension = (filename: string) => {
  const dot = filename.lastIndexOf(".");

  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
};
