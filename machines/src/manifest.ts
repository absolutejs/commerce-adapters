import {
  defineImplementation,
  defineManifest,
  toolFactory,
} from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { MachineRegistry, MachineRegistryConfig } from "./index";

const tool = toolFactory<MachineRegistry>();

const kindSchema = Type.Union([
  Type.Literal("embroidery"),
  Type.Literal("dtg"),
  Type.Literal("dtf"),
  Type.Literal("screen"),
  Type.Literal("sublimation"),
  Type.Literal("vinyl"),
  Type.Literal("laser"),
  Type.Literal("label"),
]);

/* Pure data + file encoding: no network, no secrets. The registry is the
 * shop's owned-machine list; the tools read it and never leave the host. */
export const manifest = defineManifest<
  MachineRegistryConfig,
  MachineRegistry
>()({
  contract: 2,
  discovery: {
    audiences: ["commerce-platforms", "application-developers"],
    intents: [
      "list the embroidery, print, cutter, laser and label machines a shop can own",
      "convert embroidery files between DST, EXP, PES and JEF",
      "export a production job in the file format a machine accepts",
    ],
    keywords: [
      "commerce",
      "embroidery",
      "dst",
      "pes",
      "dtg",
      "dtf",
      "zpl",
      "machines",
    ],
    protocols: [
      "Tajima DST",
      "Melco EXP",
      "Brother PES/PEC",
      "Janome JEF",
      "ZPL II",
    ],
  },
  identity: {
    accent: "#0f766e",
    category: "commerce",
    description:
      "Machine registry and file encoders for `@absolutejs/commerce` production: every embroidery head, DTG/DTF/sublimation printer, vinyl cutter, laser and label printer a shop is likely to own, the formats and connections each accepts, and DST/EXP/PES/JEF stitch codecs to export a job for it. No network I/O.",
    docsUrl:
      "https://github.com/absolutejs/commerce-adapters/tree/main/machines",
    name: "@absolutejs/commerce-machines",
    tagline: "Know every machine on the floor and hand it a file it can run.",
  },
  implements: [
    defineImplementation<MachineRegistryConfig>()({
      contract: "commerce/machine-registry",
      factory: "createMachineRegistry",
      from: "@absolutejs/commerce-machines",
      settings: Type.Object({
        owned: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Ids of the machines the shop owns (see MACHINE_PROVIDERS). Omit for every provider.",
            title: "Owned machines",
          }),
        ),
      }),
      title: "Machine registry",
      wiring: {
        code: "createMachineRegistry(${settings})",
        imports: [
          {
            from: "@absolutejs/commerce-machines",
            names: ["createMachineRegistry"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({
    owned: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Ids of the machines the shop owns. Omit for every provider.",
        title: "Owned machines",
      }),
    ),
  }),
  tools: {
    list_machines: tool.runtime({
      annotations: { idempotentHint: true, readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "authenticated",
        effects: ["read"],
        requiredScopes: ["machines:read"],
        reversible: false,
      },
      description:
        "List the shop's machines (optionally by kind) with the file formats and connections each accepts, its hoops, and plain-English setup notes.",
      handler: ({ kind }, registry) =>
        JSON.stringify(
          registry.list(kind).map((provider) => ({
            brand: provider.brand,
            connections: provider.connections,
            formats: provider.formats,
            hoops: provider.hoops,
            id: provider.id,
            kind: provider.kind,
            models: provider.models,
            name: provider.name,
            setup: provider.setup,
          })),
        ),
      input: Type.Object({ kind: Type.Optional(kindSchema) }),
    }),
    machine_checklist: tool.runtime({
      annotations: { idempotentHint: true, readOnlyHint: true },
      authorization: {
        approval: "never",
        audience: "authenticated",
        effects: ["read"],
        requiredScopes: ["machines:read"],
        reversible: false,
      },
      description:
        "The operator checklist steps for a kind of machine (embroidery, dtg, dtf, screen, sublimation, vinyl, laser, label).",
      handler: ({ kind }, registry) => JSON.stringify(registry.checklist(kind)),
      input: Type.Object({ kind: kindSchema }),
    }),
  },
  wiring: [],
});
