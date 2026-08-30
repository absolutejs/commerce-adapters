import { describe, expect, test } from "bun:test";
import {
  MACHINE_PROVIDERS,
  MIME_BY_FORMAT,
  encodeStitchProgram,
  exportForMachine,
  getMachineProvider,
  listMachineProviders,
  machineChecklist,
  providersForFormat,
  machineTakesFiles,
  createMachineRegistry,
} from "./index";
import { buildProgram } from "./program";

describe("provider registry", () => {
  test("ids are unique and kebab-case", () => {
    const ids = MACHINE_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  test("every provider has formats, connections and substantial notes", () => {
    for (const provider of MACHINE_PROVIDERS) {
      // A press takes no file and plugs into nothing — it is on the list so
      // the shop can tick a job through it, not so we can send to it.
      const takesFiles = machineTakesFiles(provider);
      expect(provider.formats.length).toBeGreaterThan(takesFiles ? 0 : -1);
      expect(provider.connections.length).toBeGreaterThan(takesFiles ? 0 : -1);
      if (!takesFiles) {
        expect(provider.kind).toBe("heat-press");
        expect(provider.connections).toEqual([]);
      }
      expect(new Set(provider.formats).size).toBe(provider.formats.length);
      expect(provider.setup.length).toBeGreaterThanOrEqual(40);
      expect(provider.developerNotes.length).toBeGreaterThanOrEqual(40);
      for (const format of provider.formats)
        expect(MIME_BY_FORMAT[format]).toBeDefined();
    }
  });
  test("the required brands and generics are present", () => {
    for (const id of [
      "tajima",
      "brother-pr",
      "barudan",
      "ricoma",
      "melco",
      "swf",
      "happy",
      "zsk",
      "janome-mb",
      "bernina-e16",
      "babylock",
      "brother-gtx",
      "epson-surecolor-f2",
      "kornit",
      "ricoh-ri",
      "polyprint-texjet",
      "generic-dtf",
      "prestige-dtf",
      "epson-surecolor-f-sublimation",
      "sawgrass",
      "cricut",
      "silhouette",
      "roland-cutter",
      "graphtec",
      "generic-screen",
      "glowforge",
      "xtool",
      "epilog",
      "zebra",
      "rollo",
      "dymo",
      "brother-ql",
      "generic-embroidery",
      "generic-print",
      "generic-label",
    ]) {
      expect(getMachineProvider(id)?.id).toBe(id);
    }
  });
  test("embroidery providers prefer a format this package can write", () => {
    for (const provider of listMachineProviders("embroidery")) {
      expect(["dst", "exp", "pes", "jef"]).toContain(provider.formats[0]);
    }
  });
  test("lookups filter by kind and format", () => {
    expect(
      listMachineProviders("label").every(
        (provider) => provider.kind === "label",
      ),
    ).toBe(true);
    expect(listMachineProviders().length).toBe(MACHINE_PROVIDERS.length);
    expect(providersForFormat("zpl").map((provider) => provider.id)).toContain(
      "zebra",
    );
    expect(providersForFormat("jef").map((provider) => provider.id)).toContain(
      "janome-mb",
    );
    expect(getMachineProvider("nope")).toBeUndefined();
  });
  test("checklists have stable kebab keys for every kind", () => {
    const embroidery = machineChecklist("embroidery").map((step) => step.key);
    expect(embroidery).toEqual([
      "art-ready",
      "file-loaded",
      "hooped",
      "sewout",
      "run-complete",
      "trimmed",
      "qc",
    ]);
    expect(machineChecklist("dtg").map((step) => step.key)).toEqual([
      "art-ready",
      "pretreated",
      "printed",
      "cured",
      "qc",
    ]);
    expect(machineChecklist("label").map((step) => step.key)).toEqual([
      "printed",
    ]);
    for (const kind of [
      "dtf",
      "screen",
      "sublimation",
      "vinyl",
      "laser",
    ] as const) {
      for (const step of machineChecklist(kind))
        expect(step.key).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });
});

const program = buildProgram(
  [
    { command: "stitch", x: 0, y: 0 },
    { command: "stitch", x: 50, y: 50 },
    { command: "color", x: 50, y: 50 },
    { command: "stitch", x: 100, y: 0 },
  ],
  "TEST",
);
const dst = encodeStitchProgram(program, "dst");
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("exportForMachine", () => {
  test("embroidery converts to the preferred format with a sanitised name", () => {
    const result = exportForMachine(getMachineProvider("brother-pr")!, {
      reference: "Order #1042 / line 1",
      stitchFile: { bytes: dst, filename: "logo.dst" },
    });
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]?.format).toBe("pes");
    expect(result[0]?.filename).toBe("Order_1042_line_1.pes");
    expect(result[0]?.mime).toBe("application/x-brother-pes");
    expect(result[0]?.note).toContain("converted from DST");
  });
  test("legacy heads get 8-character uppercase DST names and pass-through bytes", () => {
    const result = exportForMachine(getMachineProvider("tajima")!, {
      reference: "order-1042-line-1",
      stitchFile: { bytes: dst, filename: "logo.dst" },
    });
    if (!Array.isArray(result)) throw new Error(result.error);
    expect(result[0]?.filename).toBe("ORDER104.dst");
    expect(result[0]?.bytes).toBe(dst);
    expect(result[0]?.note).toBeUndefined();
  });
  test("embroidery without a stitch file explains what it needs", () => {
    const result = exportForMachine(getMachineProvider("ricoma")!, {
      reference: "x",
      artwork: { bytes: png, filename: "a.png", mime: "image/png" },
    });
    expect(result).toHaveProperty("error");
    if (Array.isArray(result)) return;
    expect(result.error).toContain("dst");
  });
  test("print providers pass accepted artwork through", () => {
    const result = exportForMachine(getMachineProvider("brother-gtx")!, {
      reference: "1042",
      artwork: {
        bytes: png,
        filename: "front.png",
        heightMm: 300,
        mime: "image/png",
        widthMm: 250,
      },
    });
    if (!Array.isArray(result)) throw new Error(result.error);
    expect(result[0]).toMatchObject({
      filename: "1042.png",
      format: "png",
      mime: "image/png",
      note: "print at 250 × 300 mm",
    });
  });
  test("print providers reject artwork they cannot take and list accepted formats", () => {
    const result = exportForMachine(getMachineProvider("cricut")!, {
      reference: "1042",
      artwork: { bytes: png, filename: "front.jpg", mime: "image/jpeg" },
    });
    if (Array.isArray(result)) throw new Error("expected an error");
    expect(result.error).toContain("svg, png, dxf");
  });
  test("label providers pass ZPL through; non-ZPL label printers take a PDF", () => {
    const zebra = exportForMachine(getMachineProvider("zebra")!, {
      reference: "ship-1",
      labelZpl: "^XA^FO50,50^ADN,36,20^FDHello^FS^XZ",
    });
    if (!Array.isArray(zebra)) throw new Error(zebra.error);
    expect(zebra[0]?.format).toBe("zpl");
    expect(new TextDecoder().decode(zebra[0]!.bytes)).toContain("^XA");
    const dymo = exportForMachine(getMachineProvider("dymo")!, {
      reference: "ship-1",
      artwork: {
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        filename: "label.pdf",
        mime: "application/pdf",
      },
      labelZpl: "^XA^XZ",
    });
    if (!Array.isArray(dymo)) throw new Error(dymo.error);
    expect(dymo[0]?.format).toBe("pdf");
    const dymoZplOnly = exportForMachine(getMachineProvider("dymo")!, {
      reference: "ship-1",
      labelZpl: "^XA^XZ",
    });
    expect(dymoZplOnly).toHaveProperty("error");
  });
  test("registry filters to owned machines", () => {
    const registry = createMachineRegistry({ owned: ["zebra", "tajima"] });
    expect(registry.providers.map((provider) => provider.id)).toEqual([
      "zebra",
      "tajima",
    ]);
    expect(registry.exportJob("dymo", { reference: "x" })).toHaveProperty(
      "error",
    );
    expect(
      Array.isArray(
        registry.exportJob("zebra", { reference: "x", labelZpl: "^XA^XZ" }),
      ),
    ).toBe(true);
  });
});
