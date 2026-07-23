import {
  defineImplementation,
  defineManifest,
  toolFactory,
} from "@absolutejs/manifest";
import type { ShippingProvider } from "@absolutejs/commerce";
import { Type } from "@sinclair/typebox";
import type { EasyPostConfig } from "./index";

const tool = toolFactory<ShippingProvider>();

const addressInput = Type.Object({
  city: Type.String({ minLength: 1 }),
  country: Type.String({
    description: 'ISO-3166 alpha-2 country code, e.g. "US".',
    maxLength: 2,
    minLength: 2,
  }),
  name: Type.String({ minLength: 1 }),
  state: Type.String({ minLength: 1 }),
  street1: Type.String({ minLength: 1 }),
  street2: Type.Optional(Type.String()),
  zip: Type.String({ minLength: 1 }),
});

const parcelInput = Type.Object(
  {
    heightIn: Type.Number({ exclusiveMinimum: 0 }),
    lengthIn: Type.Number({ exclusiveMinimum: 0 }),
    weightOz: Type.Number({ exclusiveMinimum: 0 }),
    widthIn: Type.Number({ exclusiveMinimum: 0 }),
  },
  { description: "Parcel dimensions in inches, weight in ounces." },
);

/* EasyPostConfig is secret material only (apiKey) — it comes from env at
 * wiring time, so the implementation has no settings schema. */
export const manifest = defineManifest<EasyPostConfig, ShippingProvider>()({
  contract: 2,
  identity: {
    accent: "#2563eb",
    category: "commerce",
    description:
      "EasyPost-backed `ShippingProvider` for `@absolutejs/commerce`: multi-carrier rate quotes, cheapest-label or specific-rate label purchase, and shipment tracking — one API key covers USPS, UPS, FedEx, and more.",
    docsUrl:
      "https://github.com/absolutejs/commerce-adapters/tree/main/easypost",
    name: "@absolutejs/commerce-easypost",
    tagline: "Quote shipping rates and print labels with EasyPost.",
  },
  implements: [
    defineImplementation<EasyPostConfig>()({
      contract: "commerce/shipping-provider",
      factory: "createEasyPostProvider",
      from: "@absolutejs/commerce-easypost",
      requires: {
        env: [
          {
            description: "EasyPost API key",
            docsUrl: "https://app.easypost.com/account/api-keys",
            example: "EZAKxxxxxxxxx",
            key: "EASYPOST_API_KEY",
            secret: true,
          },
        ],
      },
      title: "EasyPost",
      wiring: {
        code: 'createEasyPostProvider({ apiKey: ${env.EASYPOST_API_KEY} ?? "" })',
        imports: [
          {
            from: "@absolutejs/commerce-easypost",
            names: ["createEasyPostProvider"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  tools: {
    quote_rates: tool.runtime({
      annotations: { idempotentHint: true, openWorldHint: true },
      authorization: {
        approval: "policy",
        audience: "owner",
        destinations: ["configured-easypost-account"],
        effects: ["read", "write", "external-network"],
        idempotency: { mode: "host" },
        requiredScopes: ["shipping:quote"],
        resource: { type: "shipment-quote" },
        reversible: false,
      },
      description:
        "Quote all available carrier rates for a parcel between two addresses (creates a shipment quote at EasyPost — nothing is purchased). Returns rate ids, carriers, services, prices, and delivery estimates.",
      handler: async ({ from, parcel, to }, shipping) => {
        const rates = await shipping.rates({ from, parcel, to });

        return rates.length === 0
          ? "no rates available for this shipment"
          : JSON.stringify(rates);
      },
      input: Type.Object({
        from: addressInput,
        parcel: parcelInput,
        to: addressInput,
      }),
    }),
    track_shipment: tool.runtime({
      annotations: { idempotentHint: true, openWorldHint: true },
      authorization: {
        approval: "policy",
        audience: "owner",
        destinations: ["configured-easypost-account"],
        effects: ["read", "write", "external-network"],
        idempotency: { mode: "host" },
        requiredScopes: ["shipping:track"],
        resource: {
          idField: "trackingNumber",
          type: "shipment-tracker",
        },
        reversible: false,
      },
      description:
        "Current tracking status for a shipment by tracking number: status, estimated delivery date, and a public tracking URL.",
      handler: async ({ carrier, trackingNumber }, shipping) =>
        JSON.stringify(await shipping.track(trackingNumber, carrier)),
      input: Type.Object({
        carrier: Type.Optional(
          Type.String({
            description:
              'Carrier name (e.g. "USPS"). Helps EasyPost resolve ambiguous tracking numbers.',
          }),
        ),
        trackingNumber: Type.String({ minLength: 1 }),
      }),
    }),
  },
  wiring: [],
});
