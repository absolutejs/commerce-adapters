# @absolutejs/commerce-square

Square Terminal as a `TerminalProvider` for
[`@absolutejs/commerce`](https://www.npmjs.com/package/@absolutejs/commerce).

Online checkout and the counter are different shapes. Online, the browser goes
to the provider and comes back. At the counter, the customer taps a card on a
piece of hardware the shop owns, and the till waits for it. This adapter is
that second shape: list the paired Terminals, send an amount to one, watch the
checkout, cancel it, and verify the webhook Square sends when it changes.

```ts
import { createSquareTerminal } from "@absolutejs/commerce-square";

const terminal = createSquareTerminal({
  accessToken: process.env.SQUARE_ACCESS_TOKEN ?? "",
  environment: "sandbox",
  webhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  webhookUrl: "https://yourshop.com/api/square/webhook",
});

const devices = await terminal.listDevices();
const checkout = await terminal.startCheckout({
  amountCents: 4500,
  deviceId: devices[0].id,
  idempotencyKey: saleId,
  reference: "walk-in-88",
});
// …the customer taps; Square posts terminal.checkout.updated
const { checkout: done } = await terminal.verifyWebhook(body, signature);
```

- **Money is integer cents**, like everywhere else in commerce.
- **No SDK.** Four REST calls and an HMAC; `fetchImpl` is injectable, so the
  whole flow is testable without a network.
- **Webhooks are refused, not trusted, without a signature key.** Square signs
  the notification URL followed by the raw body — both must match.
- **A cancel with a reason** (timed out, buyer walked away) reads as `failed`
  rather than `canceled`, because those are different things to a shop.

Pairing a Terminal happens on the device itself. The access token needs
`PAYMENTS_WRITE` and `DEVICE_CREDENTIAL_MANAGEMENT`.

## License

Apache-2.0
