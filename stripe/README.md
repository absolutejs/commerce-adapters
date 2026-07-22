# @absolutejs/commerce-stripe

[Stripe](https://stripe.com) payment + checkout adapter for
[`@absolutejs/commerce`](https://github.com/absolutejs/commerce). Implements the
`PaymentProvider` contract: create embedded **or** hosted checkout sessions
(with shipping, discounts, and automatic tax + graceful fallback), mint one-off
coupons, refund by session, and verify webhooks into a normalized event.

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

## License

Apache-2.0.
