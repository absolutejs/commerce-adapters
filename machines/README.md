# @absolutejs/commerce-machines

"Support every machine as a provider." A print / embroidery shop configures
the machines it owns; each provider knows the file formats and connection
methods that make and model accepts, and the package can export a job in
that format. Pure data plus file encoding — no network I/O.

```ts
import {
  decodeStitchProgram,
  encodeStitchProgram,
  exportForMachine,
  getMachineProvider,
  listMachineProviders,
  machineChecklist,
} from "@absolutejs/commerce-machines";

listMachineProviders("embroidery"); // Tajima, Brother PR, Barudan, Ricoma, Melco…

const brother = getMachineProvider("brother-pr")!;
const files = exportForMachine(brother, {
  reference: "ORD-1042-L1",
  stitchFile: { bytes: dstBytes, filename: "logo.dst" },
});
// → [{ filename: "ORD-1042-L1.pes", mime: "application/x-brother-pes", bytes, format: "pes" }]

const program = decodeStitchProgram(dstBytes, "logo.dst");
// program.stitchCount, colorChanges, widthMm, heightMm, stitches[]
const jef = encodeStitchProgram(program!, "jef");

machineChecklist("dtg"); // art-ready, pretreated, printed, cured, qc
```

## What is in the box

- `MACHINE_PROVIDERS` — embroidery (Tajima, Brother PR, Barudan, Ricoma,
  Melco, SWF, Happy, ZSK, Janome MB, Bernina E16, Baby Lock), DTG (Brother
  GTX, Epson SureColor F2, Kornit, Ricoh Ri, Polyprint TexJet), DTF, sublimation
  (Epson F, Sawgrass), cutters (Cricut, Silhouette, Roland, Graphtec), screen,
  laser (Glowforge, xTool, Epilog), labels (Zebra, Rollo, Dymo, Brother QL) and
  generic fallbacks. Each carries accepted formats (preferred first),
  connections, hoops, plain-English `setup` and `developerNotes` listing what
  to ask the shop before wiring a direct integration.
- Stitch codecs: full decode and encode for Tajima **DST**, Melco **EXP**,
  Brother **PES** (v1 truncated writer; reader follows the PEC pointer of any
  PES version) and Janome **JEF**. Bare `.pec` files decode too. VP3 and XXX
  are recognised as formats but not decoded or written.
- `convertMachineFile`, `exportForMachine`, `MIME_BY_FORMAT`, `machineChecklist`
  and a `createMachineRegistry` factory for the manifest wiring.

## Notes on the codecs

- Coordinates are absolute 0.1 mm units, x right / y up (DST convention);
  PEC and JEF y-down axes are flipped on the way in and out.
- DST has no trim record; trims are written as zero-length jumps.
- The PES writer produces the truncated version-1 layout (header + PEC block,
  no CEmbOne/CSewSeg section). Machines and most software sew from the PEC
  block; a few editors that only read the design section will show it empty.
- Thread names come from the Brother PEC and Janome JEF palettes when a file
  carries indices; writers match `threads` by name and otherwise cycle.

## License

Apache-2.0.
