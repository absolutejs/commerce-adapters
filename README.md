# AbsoluteJS Commerce Adapters

Provider adapters for [`@absolutejs/commerce`](https://github.com/absolutejs/commerce).

## Packages

- `@absolutejs/commerce-stripe` — payments + checkout (Stripe)
- `@absolutejs/commerce-easypost` — shipping rates + labels (EasyPost)
- `@absolutejs/commerce-resend` — transactional email (Resend)
- `@absolutejs/commerce-customcat` — print-on-demand fulfillment (CustomCat)

Each adapter is an independently versioned npm package (Apache-2.0). This
repository is the source monorepo.

## Installation

Install the core contracts and only the provider packages your storefront needs:

```sh
bun add @absolutejs/commerce @absolutejs/commerce-stripe @absolutejs/commerce-easypost
```

Stripe handles payment and checkout evidence, EasyPost handles rates and labels, Resend handles lifecycle email, and CustomCat handles print-on-demand fulfillment. Each adapter README documents credentials, supported operations, webhook handling, idempotency, and production readiness.
