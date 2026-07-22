import {
  defineImplementation,
  defineManifest,
  toolFactory,
} from "@absolutejs/manifest";
import type { PaymentProvider } from "@absolutejs/commerce";
import { Type } from "@sinclair/typebox";
import type { StripeConfig } from "./index";

const tool = toolFactory<PaymentProvider>();

/* StripeConfig is secret material only (secretKey, webhookSecret) — both come
 * from env at wiring time, so the implementation has no settings schema. */
export const manifest = defineManifest<StripeConfig, PaymentProvider>()({
  contract: 1,
  identity: {
    accent: "#635bff",
    category: "commerce",
    description:
      "Stripe-backed `PaymentProvider` for `@absolutejs/commerce`: hosted or embedded Checkout sessions, one-time coupons, idempotent refunds, and signed checkout/dispute webhook normalization — including subscription mode.",
    docsUrl: "https://github.com/absolutejs/commerce-adapters/tree/main/stripe",
    name: "@absolutejs/commerce-stripe",
    tagline: "Take payments and host checkout with Stripe.",
  },
  implements: [
    defineImplementation<StripeConfig>()({
      contract: "commerce/payment-provider",
      factory: "createStripePayment",
      from: "@absolutejs/commerce-stripe",
      requires: {
        env: [
          {
            description: "Stripe secret API key",
            docsUrl: "https://dashboard.stripe.com/apikeys",
            example: "sk_live_xxxxxxxxx",
            key: "STRIPE_SECRET_KEY",
            secret: true,
          },
          {
            description:
              "Signing secret of the Stripe webhook endpoint that receives checkout events",
            docsUrl: "https://dashboard.stripe.com/webhooks",
            example: "whsec_xxxxxxxxx",
            key: "STRIPE_WEBHOOK_SECRET",
            secret: true,
          },
        ],
      },
      title: "Stripe",
      wiring: {
        code: 'createStripePayment({ secretKey: ${env.STRIPE_SECRET_KEY} ?? "", webhookSecret: ${env.STRIPE_WEBHOOK_SECRET} ?? "" })',
        imports: [
          {
            from: "@absolutejs/commerce-stripe",
            names: ["createStripePayment"],
          },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  tools: {
    checkout_status: tool.runtime({
      annotations: { readOnlyHint: true },
      description:
        "Fetch the current state of one Stripe Checkout session by id: status, payment status, total, customer, shipping address, and line items.",
      handler: async ({ sessionId }, payments) =>
        JSON.stringify(await payments.retrieveCheckout(sessionId)),
      input: Type.Object({
        sessionId: Type.String({ minLength: 1 }),
      }),
    }),
    create_coupon: tool.runtime({
      annotations: { openWorldHint: true },
      description:
        "Create a one-time Stripe coupon (percent off or a fixed amount off in cents) and return its id, ready to apply to a checkout.",
      handler: async ({ amountOffCents, currency, percentOff }, payments) => {
        const id = await payments.createCoupon({
          amountOffCents,
          currency,
          percentOff,
        });

        return `created coupon ${id}`;
      },
      input: Type.Object({
        amountOffCents: Type.Optional(
          Type.Integer({
            description:
              "Fixed discount in minor units (cents). Ignored when percentOff is set.",
            minimum: 1,
          }),
        ),
        currency: Type.Optional(
          Type.String({
            description: "Currency for a fixed-amount coupon (default usd).",
          }),
        ),
        percentOff: Type.Optional(Type.Number({ maximum: 100, minimum: 1 })),
      }),
    }),
    refund_order: tool.runtime({
      annotations: { destructiveHint: true, openWorldHint: true },
      description:
        "Refund the full payment behind one Stripe Checkout session id. The charge is returned to the customer — this cannot be undone.",
      handler: async ({ idempotencyKey, sessionId }, payments) => {
        const refund = await payments.refundBySession(
          sessionId,
          idempotencyKey,
        );

        return `refund ${refund.providerRefundId} is ${refund.status}`;
      },
      input: Type.Object({
        idempotencyKey: Type.String({ minLength: 1 }),
        sessionId: Type.String({ minLength: 1 }),
      }),
    }),
  },
  wiring: [],
});
