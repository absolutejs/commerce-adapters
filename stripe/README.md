# @absolutejs/commerce-stripe

[Stripe](https://stripe.com) payment + checkout adapter for
[`@absolutejs/commerce`](https://github.com/absolutejs/commerce). Implements the
`PaymentProvider` contract: create embedded **or** hosted checkout sessions
(with shipping, discounts, and automatic tax + graceful fallback), mint one-off
coupons, idempotent refunds, and verify webhooks into normalized checkout and
payment-dispute events. Disputes retain only provider-neutral identity, amount,
reason, status, and evidence deadline for the commerce aftercare case substrate.

```ts
import { createStripePayment } from "@absolutejs/commerce-stripe";

const payments = createStripePayment({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
});

const { clientSecret } = await payments.createCheckout({
  idempotencyKey: "checkout-attempt-123",
  uiMode: "embedded",
  returnUrl: `${origin}/return?session_id={CHECKOUT_SESSION_ID}`,
  lineItems: [{ name: "Classic Tee", amountCents: 4000, quantity: 1 }],
  shipping: { mode: "collect", countries: ["US", "CA"], flatAmountCents: 600 },
  automaticTax: true,
});

// In your webhook route (pass the raw body):
const event = await payments.verifyWebhook(rawBody, signature);
if (event.isComplete) fulfil(event.session); // normalized, gateway-agnostic
```

`submitDisputeEvidence()` uploads every clean attachment with Stripe purpose
`dispute_evidence`, maps provider-neutral text and file purposes onto the
Dispute evidence fields, and updates the exact dispute. File and dispute calls
receive stable host-owned idempotency keys. `submit: false` stages evidence for
review; `submit: true` sends it to the payment network. PAAS keeps the latter
behind a separate default-off gate.

`reconcileDisputeEvidence()` retrieves the exact Stripe Dispute and compares
the intended normalized text and file-purpose fields with Stripe's retained
evidence. It reports whether the effect applied, maps provider file IDs back to
host attachment IDs, and derives staged/submitted state from `has_evidence` and
`submission_count`. Hosts can therefore reconcile an ambiguous update before
deciding whether the stable-idempotency submission may be retried.

## License

Apache-2.0.
