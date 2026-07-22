import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import type { FulfillmentProvider } from "@absolutejs/commerce";
import { Type } from "@sinclair/typebox";
import type { CustomCatConfig } from "./index";

export const manifest = defineManifest<CustomCatConfig, FulfillmentProvider>()({
  contract: 2,
  discovery: {
    audiences: ["agent-hosts", "commerce-platforms", "application-developers"],
    intents: [
      "submit a print-on-demand fulfillment order",
      "execute a mandate-bound CustomCat purchase",
      "reconcile or compensate a CustomCat order",
    ],
    keywords: [
      "commerce",
      "customcat",
      "fulfillment",
      "print-on-demand",
      "agent-spend",
    ],
    protocols: ["HTTPS", "CustomCat API v1"],
  },
  identity: {
    accent: "#f05a28",
    category: "commerce",
    description:
      "CustomCat print-on-demand adapter implementing `FulfillmentProvider` for `@absolutejs/commerce`: submit external-design orders, poll production status, cancel orders, and normalize shipment tracking.",
    docsUrl:
      "https://github.com/absolutejs/commerce-adapters/tree/main/customcat",
    name: "@absolutejs/commerce-customcat",
    tagline: "Print and drop-ship commerce orders with CustomCat.",
  },
  implements: [
    defineImplementation<CustomCatConfig>()({
      contract: "commerce/fulfillment-provider",
      factory: "createCustomCatFulfillment",
      from: "@absolutejs/commerce-customcat",
      requires: {
        env: [
          {
            description: "CustomCat API Store read/write key",
            docsUrl: "https://help.customcat.com/generate-an-api-key",
            key: "CUSTOMCAT_API_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        sandbox: Type.Optional(
          Type.Boolean({
            default: true,
            description:
              "Simulate submissions without creating paid production orders.",
            title: "Sandbox mode",
          }),
        ),
        shippingMethod: Type.Optional(
          Type.String({
            default: "Economy",
            description:
              "Default CustomCat shipping method when an order does not choose one.",
            title: "Default shipping method",
          }),
        ),
      }),
      title: "CustomCat fulfillment",
      wiring: {
        code: 'createCustomCatFulfillment({ apiKey: ${env.CUSTOMCAT_API_KEY} ?? "", ...${settings} })',
        imports: [
          {
            from: "@absolutejs/commerce-customcat",
            names: ["createCustomCatFulfillment"],
          },
        ],
      },
    }),
    defineImplementation<Record<string, never>>()({
      contract: "execution/effect-adapter-driver",
      factory: "createCustomCatEffectAdapterDriver",
      from: "@absolutejs/commerce-customcat",
      requires: {
        env: [
          {
            description: "CustomCat API Store read/write key",
            docsUrl: "https://help.customcat.com/generate-an-api-key",
            key: "CUSTOMCAT_API_KEY",
            secret: true,
          },
        ],
        peers: [
          {
            name: "@absolutejs/execution",
            range: ">=0.14.2 <0.15.0",
            reason: "Certified mandate-bound effect execution",
          },
        ],
      },
      settings: Type.Object({}),
      title: "CustomCat agent fulfillment effect",
      wiring: {
        code: "createCustomCatEffectAdapterDriver((apiKey) => createCustomCatFulfillment({ apiKey }))",
        imports: [
          {
            from: "@absolutejs/commerce-customcat",
            names: [
              "createCustomCatEffectAdapterDriver",
              "createCustomCatFulfillment",
            ],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
