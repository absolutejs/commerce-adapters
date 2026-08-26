import { decodeDst, encodeDst } from "./dst";
import { decodeExp, encodeExp } from "./exp";
import { decodeJef, encodeJef } from "./jef";
import { decodePecBlock, decodePes, encodePes } from "./pes";
import { fileExtension } from "./program";
import type { StitchFormat, StitchProgram } from "./types";

export const STITCH_FORMATS: readonly StitchFormat[] = [
  "dst",
  "exp",
  "pes",
  "jef",
];

export const isStitchFormat = (value: string): value is StitchFormat =>
  (STITCH_FORMATS as readonly string[]).includes(value);

/**
 * Decodes an embroidery machine file into an absolute stitch program.
 * Recognises DST, EXP, PES (via its PEC block), bare PEC and JEF by file
 * extension; returns null for anything else or for unreadable bytes.
 */
export const decodeStitchProgram = (
  bytes: Uint8Array,
  filename: string,
): StitchProgram | null => {
  const extension = fileExtension(filename);
  if (extension === "dst") return decodeDst(bytes);
  if (extension === "exp") return decodeExp(bytes);
  if (extension === "pes") return decodePes(bytes);
  if (extension === "pec") return decodePecBlock(bytes, 0);
  if (extension === "jef") return decodeJef(bytes);

  return null;
};

/** Encodes a stitch program as a machine file in the requested format. */
export const encodeStitchProgram = (
  program: StitchProgram,
  format: StitchFormat,
): Uint8Array => {
  if (format === "dst") return encodeDst(program);
  if (format === "exp") return encodeExp(program);
  if (format === "pes") return encodePes(program);

  return encodeJef(program);
};
