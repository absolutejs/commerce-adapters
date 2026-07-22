# `@absolutejs/commerce-customcat`

CustomCat print-on-demand fulfillment adapter for
[`@absolutejs/commerce`](https://github.com/absolutejs/commerce).

```ts
import { createCustomCatFulfillment } from '@absolutejs/commerce-customcat';

const fulfillment = createCustomCatFulfillment({
	apiKey: process.env.CUSTOMCAT_API_KEY!,
	sandbox: true
});

await fulfillment.submitOrder({
	externalOrderId: 'ORDER-1001',
	recipient,
	lines,
	shippingMethod: 'Economy'
});
```

The adapter uses CustomCat's external-design workflow: every line supplies an
exact `catalog_sku` plus a public PNG/JPG artwork URL. Front and back artwork
are supported. Set `sandbox: true` until the account is ready to create paid
production orders.

API keys are merchant scoped. Multi-tenant platforms should resolve the key
from their secret store per fulfillment account; never persist keys in catalog
or fulfillment settings JSON.
