import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import type { EmailProvider } from "@absolutejs/commerce";
import { Type } from "@sinclair/typebox";
import type { ResendConfig } from "./index";

/* ResendConfig is { apiKey, from }: apiKey is secret material (env at wiring
 * time); `from` is the one serializable setting. */
export const manifest = defineManifest<ResendConfig, EmailProvider>()({
  contract: 2,
  identity: {
    accent: "#111827",
    category: "commerce",
    description:
      "Resend-backed `EmailProvider` for `@absolutejs/commerce`. Delivers the order, shipping, proof, and quote emails your shop composes with the commerce email building blocks. Sends are best-effort: failures are logged, never thrown, so a flaky mail provider can’t break fulfilment.",
    docsUrl: "https://github.com/absolutejs/commerce-adapters/tree/main/resend",
    name: "@absolutejs/commerce-resend",
    tagline: "Send your shop’s order and receipt emails with Resend.",
  },
  implements: [
    defineImplementation<ResendConfig>()({
      contract: "commerce/email-provider",
      factory: "createResendEmailProvider",
      from: "@absolutejs/commerce-resend",
      requires: {
        env: [
          {
            description: "Resend API key",
            docsUrl: "https://resend.com/api-keys",
            example: "re_xxxxxxxxx",
            key: "RESEND_API_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        from: Type.String({
          description:
            "The sender on your shop’s emails. Must use a domain you have verified with Resend.",
          examples: ["Your Shop <orders@yourshop.com>"],
          title: "Sender",
        }),
      }),
      title: "Resend",
      wiring: {
        code: 'createResendEmailProvider({ apiKey: ${env.RESEND_API_KEY} ?? "", ...${settings} })',
        imports: [
          {
            from: "@absolutejs/commerce-resend",
            names: ["createResendEmailProvider"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  // EmailProvider intentionally exposes best-effort delivery without a
  // provider receipt. Do not project that ambiguous boundary as a remote
  // agent effect; hosts should use @absolutejs/dispatch for guarded sends.
  tools: {},
  wiring: [],
});
