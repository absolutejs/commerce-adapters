import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import type { TerminalProvider } from "@absolutejs/commerce";
import { Type } from "@sinclair/typebox";
import type { SquareConfig } from "./index";

/* The access token and the webhook signature key are secret material supplied
 * at wiring time; the environment and the webhook URL are the two settings a
 * host actually chooses. */
export const manifest = defineManifest<SquareConfig, TerminalProvider>()({
  contract: 2,
  identity: {
    accent: "#006aff",
    category: "commerce",
    description:
      "Square Terminal-backed `TerminalProvider` for `@absolutejs/commerce`. Rings a walk-in sale up on the shop's own card reader: send the amount to a paired Terminal, watch the customer tap, and get back the payment a refund can be issued against. Four REST calls and an HMAC — no SDK, and `fetch` is injectable so a host can test the flow without a network.",
    docsUrl: "https://github.com/absolutejs/commerce-adapters/tree/main/square",
    name: "@absolutejs/commerce-square",
    tagline: "Take a card at the counter on a Square Terminal.",
  },
  implements: [
    defineImplementation<SquareConfig>()({
      contract: "commerce/terminal-provider",
      factory: "createSquareTerminal",
      from: "@absolutejs/commerce-square",
      requires: {
        env: [
          {
            description:
              "Square access token with PAYMENTS_WRITE and DEVICE_CREDENTIAL_MANAGEMENT",
            docsUrl:
              "https://developer.squareup.com/docs/build-basics/access-tokens",
            example: "EAAAl...",
            key: "SQUARE_ACCESS_TOKEN",
            secret: true,
          },
          {
            description:
              "Signature key from the Square webhook subscription. Without it, webhooks are refused rather than trusted.",
            docsUrl:
              "https://developer.squareup.com/docs/webhooks/step3validate",
            example: "wbhk_...",
            key: "SQUARE_WEBHOOK_SIGNATURE_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        environment: Type.Optional(
          Type.Union([Type.Literal("production"), Type.Literal("sandbox")], {
            default: "production",
            description:
              "Which Square to talk to. Sandbox has its own tokens and its own paired devices.",
            title: "Environment",
          }),
        ),
        webhookUrl: Type.Optional(
          Type.String({
            description:
              "The URL Square posts terminal events to. Square signs it together with the body, so it must match exactly.",
            examples: ["https://yourshop.com/api/square/webhook"],
            title: "Webhook URL",
          }),
        ),
      }),
      title: "Square Terminal",
      wiring: {
        code: 'createSquareTerminal({ accessToken: ${env.SQUARE_ACCESS_TOKEN} ?? "", webhookSignatureKey: ${env.SQUARE_WEBHOOK_SIGNATURE_KEY}, ...${settings} })',
        imports: [
          {
            from: "@absolutejs/commerce-square",
            names: ["createSquareTerminal"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  // Starting a checkout moves money on hardware in a room we cannot see. That
  // is not something to hand a remote agent as a tool; a host drives it from
  // the till, with a person standing at the counter.
  tools: {},
  wiring: [],
});
