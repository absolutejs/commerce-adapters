import { fileExtension } from "./program";
import {
  decodeStitchProgram,
  encodeStitchProgram,
  isStitchFormat,
} from "./stitch";
import type {
  MachineChecklistStep,
  MachineExport,
  MachineFormat,
  MachineJob,
  MachineKind,
  MachineProvider,
} from "./types";

export const MIME_BY_FORMAT: Record<MachineFormat, string> = {
  dst: "application/x-tajima-dst",
  dxf: "image/vnd.dxf",
  epl: "text/x-epl",
  eps: "application/postscript",
  exp: "application/x-melco-exp",
  jef: "application/x-janome-jef",
  pdf: "application/pdf",
  pes: "application/x-brother-pes",
  png: "image/png",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tspl: "text/x-tspl",
  vp3: "application/x-husqvarna-vp3",
  xxx: "application/x-singer-xxx",
  zpl: "text/x-zpl",
};

const MIME_ALIASES: Record<string, MachineFormat> = {
  "application/dxf": "dxf",
  "application/eps": "eps",
  "application/x-eps": "eps",
  "application/x-zpl": "zpl",
  "image/eps": "eps",
  "image/tif": "tiff",
  "image/x-dxf": "dxf",
  "image/x-eps": "eps",
  "image/x-tiff": "tiff",
};

const ARTWORK_FORMATS: readonly MachineFormat[] = [
  "png",
  "pdf",
  "svg",
  "tiff",
  "dxf",
  "eps",
];
const LABEL_FORMATS: readonly MachineFormat[] = ["zpl", "epl", "tspl"];

const isMachineFormat = (value: string): value is MachineFormat =>
  Object.prototype.hasOwnProperty.call(MIME_BY_FORMAT, value);

/** Resolves an artwork's format from its MIME type, falling back to the extension. */
export const formatForArtwork = (
  mime: string,
  filename: string,
): MachineFormat | null => {
  const normalised = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime = (Object.keys(MIME_BY_FORMAT) as MachineFormat[]).find(
    (format) => MIME_BY_FORMAT[format] === normalised,
  );
  if (byMime) return byMime;
  const alias = MIME_ALIASES[normalised];
  if (alias) return alias;
  const extension = fileExtension(filename);
  if (extension === "tif") return "tiff";
  if (extension === "jpg" || extension === "jpeg") return null;

  return isMachineFormat(extension) ? extension : null;
};

/** Filesystem-safe base name; 8 uppercase characters when `short` is set. */
export const sanitiseFilename = (value: string, short = false) => {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = cleaned.length > 0 ? cleaned : "job";
  if (!short) return base.slice(0, 64);

  return (
    base
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 8) || "JOB"
  );
};

/**
 * Re-encodes an embroidery file into another stitch format. Same-format
 * requests pass the original bytes through once they prove decodable.
 */
export const convertMachineFile = (
  bytes: Uint8Array,
  filename: string,
  target: MachineFormat,
):
  { filename: string; mime: string; bytes: Uint8Array } | { error: string } => {
  if (!isStitchFormat(target)) {
    const supported = ["dst", "exp", "pes", "jef"].join(", ");

    return {
      error: `cannot write ${target} — stitch conversion supports ${supported}`,
    };
  }
  const program = decodeStitchProgram(bytes, filename);
  if (program === null) {
    return { error: `could not read ${filename} as an embroidery file` };
  }
  const base = filename.replace(/\.[^.]+$/, "");
  const sameFormat = fileExtension(filename) === target;

  return {
    bytes: sameFormat ? bytes : encodeStitchProgram(program, target),
    filename: `${base}.${target}`,
    mime: MIME_BY_FORMAT[target],
  };
};

const acceptedList = (
  provider: MachineProvider,
  formats: readonly MachineFormat[],
) => provider.formats.filter((format) => formats.includes(format)).join(", ");

/**
 * Produces the file(s) the shop loads on a machine for a job, in the
 * provider's most-preferred format the job can satisfy.
 */
export const exportForMachine = (
  provider: MachineProvider,
  job: MachineJob,
): MachineExport[] | { error: string } => {
  const base = sanitiseFilename(
    job.reference,
    provider.shortFilenames === true,
  );
  for (const format of provider.formats) {
    if (isStitchFormat(format)) {
      if (!job.stitchFile) continue;
      const converted = convertMachineFile(
        job.stitchFile.bytes,
        job.stitchFile.filename,
        format,
      );
      if ("error" in converted) return converted;
      const sourceFormat = fileExtension(job.stitchFile.filename);

      return [
        {
          bytes: converted.bytes,
          filename: `${base}.${format}`,
          format,
          mime: converted.mime,
          ...(sourceFormat !== format
            ? {
                note: `converted from ${sourceFormat.toUpperCase()} — check colour order on the machine`,
              }
            : {}),
        },
      ];
    }
    if (ARTWORK_FORMATS.includes(format)) {
      if (!job.artwork) continue;
      const artworkFormat = formatForArtwork(
        job.artwork.mime,
        job.artwork.filename,
      );
      if (artworkFormat !== format) continue;

      return [
        {
          bytes: job.artwork.bytes,
          filename: `${base}.${format}`,
          format,
          mime: MIME_BY_FORMAT[format],
          ...(job.artwork.widthMm && job.artwork.heightMm
            ? {
                note: `print at ${job.artwork.widthMm} × ${job.artwork.heightMm} mm`,
              }
            : {}),
        },
      ];
    }
    if (format === "zpl" && job.labelZpl) {
      return [
        {
          bytes: new TextEncoder().encode(job.labelZpl),
          filename: `${base}.zpl`,
          format,
          mime: MIME_BY_FORMAT.zpl,
        },
      ];
    }
  }
  // Nothing matched: explain what this machine needs.
  const stitchAccepted = acceptedList(provider, [
    "dst",
    "exp",
    "pes",
    "jef",
    "vp3",
    "xxx",
  ]);
  const artworkAccepted = acceptedList(provider, ARTWORK_FORMATS);
  const labelAccepted = acceptedList(provider, LABEL_FORMATS);
  if (job.artwork && artworkAccepted) {
    const got =
      formatForArtwork(job.artwork.mime, job.artwork.filename) ??
      job.artwork.mime;

    return {
      error: `${provider.name} does not accept ${got} artwork — accepted formats: ${artworkAccepted}`,
    };
  }
  if (job.stitchFile && stitchAccepted) {
    return {
      error: `${provider.name} needs a stitch file in ${stitchAccepted}; ${job.stitchFile.filename} could not be converted`,
    };
  }
  const needs: string[] = [];
  if (stitchAccepted) needs.push(`an embroidery file (${stitchAccepted})`);
  if (artworkAccepted) needs.push(`artwork (${artworkAccepted})`);
  if (labelAccepted) needs.push(`label text (${labelAccepted})`);

  return {
    error: `${provider.name} needs ${needs.join(" or ")} — the job has none`,
  };
};

const CHECKLISTS: Record<MachineKind, MachineChecklistStep[]> = {
  dtf: [
    { key: "art-ready", label: "Artwork approved and sized" },
    { key: "printed", label: "Printed to film" },
    { key: "powdered", label: "Powdered and cured" },
    { key: "pressed", label: "Heat pressed onto garment" },
    { key: "qc", label: "Quality checked" },
  ],
  dtg: [
    { key: "art-ready", label: "Artwork approved and sized" },
    { key: "pretreated", label: "Garment pretreated" },
    { key: "printed", label: "Printed" },
    { key: "cured", label: "Cured" },
    { key: "qc", label: "Quality checked" },
  ],
  "heat-press": [
    { key: "transfer-ready", label: "Transfer printed / cut and ready" },
    { key: "garment-placed", label: "Garment laid out and pressed flat" },
    { key: "pressed", label: "Pressed at the time and temperature" },
    { key: "peeled", label: "Carrier peeled" },
    { key: "qc", label: "Quality checked" },
  ],
  embroidery: [
    { key: "art-ready", label: "Digitized file approved" },
    { key: "file-loaded", label: "File loaded on the machine" },
    { key: "hooped", label: "Garment hooped with stabilizer" },
    { key: "sewout", label: "Test sew-out checked (optional)" },
    { key: "run-complete", label: "Run complete" },
    { key: "trimmed", label: "Trimmed and backing removed" },
    { key: "qc", label: "Quality checked" },
  ],
  label: [{ key: "printed", label: "Label printed" }],
  laser: [
    { key: "art-ready", label: "Artwork approved and sized" },
    { key: "material-loaded", label: "Material loaded and focused" },
    { key: "run-complete", label: "Cut / engrave complete" },
    { key: "cleaned", label: "Cleaned and masking removed" },
    { key: "qc", label: "Quality checked" },
  ],
  screen: [
    { key: "art-ready", label: "Separations approved" },
    { key: "films-printed", label: "Films printed / screens imaged" },
    { key: "screens-exposed", label: "Screens exposed and registered" },
    { key: "printed", label: "Printed" },
    { key: "cured", label: "Cured" },
    { key: "qc", label: "Quality checked" },
  ],
  sublimation: [
    { key: "art-ready", label: "Artwork approved and sized" },
    { key: "printed", label: "Printed mirrored on transfer paper" },
    { key: "pressed", label: "Pressed onto blank" },
    { key: "qc", label: "Quality checked" },
  ],
  vinyl: [
    { key: "art-ready", label: "Cut file approved and mirrored" },
    { key: "cut", label: "Cut" },
    { key: "weeded", label: "Weeded" },
    { key: "pressed", label: "Pressed onto garment" },
    { key: "qc", label: "Quality checked" },
  ],
};

/** Operator steps for a machine kind; keys are stable kebab-case. */
export const machineChecklist = (kind: MachineKind): MachineChecklistStep[] =>
  CHECKLISTS[kind].map((step) => ({ ...step }));
