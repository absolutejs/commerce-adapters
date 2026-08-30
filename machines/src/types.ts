export type MachineKind =
  | "embroidery"
  | "dtg"
  | "dtf"
  | "screen"
  | "sublimation"
  | "vinyl"
  | "laser"
  | "label"
  /** A press takes no file — it is here because the shop runs one, the job
   *  passes through it, and its time, temperature and pressure are what get
   *  written down. */
  | "heat-press";

export type MachineFormat =
  | "dst"
  | "exp"
  | "pes"
  | "jef"
  | "vp3"
  | "xxx"
  | "png"
  | "pdf"
  | "svg"
  | "tiff"
  | "dxf"
  | "eps"
  | "zpl"
  | "epl"
  | "tspl";

export type MachineConnection =
  | "usb-stick"
  | "usb-cable"
  | "network-folder"
  | "lan"
  | "wifi"
  | "cloud"
  | "memory-card";

export type MachineHoop = { name: string; widthMm: number; heightMm: number };

export type MachineProvider = {
  id: string;
  brand: string;
  name: string;
  kind: MachineKind;
  models: string[];
  /** Accepted file formats, preferred first. */
  formats: MachineFormat[];
  connections: MachineConnection[];
  hoops?: MachineHoop[];
  maxNeedles?: number;
  /** Digitizing / RIP software commonly paired with the machine. */
  software?: string[];
  /** Older controllers only list 8.3 filenames; exports are shortened. */
  shortFilenames?: boolean;
  /** Plain-English: how the shop gets a file onto this machine. */
  setup: string;
  /** What a developer needs to ask the shop to tailor a direct integration. */
  developerNotes: string;
};

export type StitchCommand =
  "stitch" | "jump" | "trim" | "color" | "stop" | "end";

/** Absolute needle position in 0.1mm units (x right, y up) plus the command. */
export type Stitch = { x: number; y: number; command: StitchCommand };

export type StitchProgram = {
  stitches: Stitch[];
  colorChanges: number;
  stitchCount: number;
  widthMm: number;
  heightMm: number;
  label: string;
  threads?: string[];
};

export type StitchFormat = "dst" | "exp" | "pes" | "jef";

export type MachineJob = {
  /** Order / line reference used to build export filenames. */
  reference: string;
  label?: string;
  stitchFile?: { bytes: Uint8Array; filename: string };
  artwork?: {
    bytes: Uint8Array;
    mime: string;
    filename: string;
    widthMm?: number;
    heightMm?: number;
  };
  labelZpl?: string;
};

export type MachineExport = {
  filename: string;
  mime: string;
  bytes: Uint8Array;
  format: MachineFormat;
  note?: string;
};

export type MachineChecklistStep = { key: string; label: string };
