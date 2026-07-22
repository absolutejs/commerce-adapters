# `@absolutejs/commerce-customcat`

CustomCat print-on-demand fulfillment adapter for
[`@absolutejs/commerce`](https://github.com/absolutejs/commerce).

```ts
import { createCustomCatFulfillment } from "@absolutejs/commerce-customcat";

const fulfillment = createCustomCatFulfillment({
  apiKey: process.env.CUSTOMCAT_API_KEY!,
  sandbox: true,
});

await fulfillment.submitOrder({
  externalOrderId: "ORDER-1001",
  recipient,
  lines,
  shippingMethod: "Economy",
});
```

Use `createCustomCatCatalog()` for normalized catalog browsing, live SKU
availability, and read-only fulfillment cost preflight. Preflight refreshes the
selected SKUs and shipping cost, includes CustomCat's documented back-print
adjustment, and returns item/shipping/adjustment totals. It does not reserve
inventory or price; refresh it immediately before creating spend authority.
The same provider exposes paginated free-text catalog search and destination-
aware shipping-method discovery. CustomCat does not expose server-side catalog
search, so a search walks its paginated catalog before returning normalized
matches; ordinary browsing remains a single provider page request.
Set `categories: "all"` to discover CustomCat's category/subcategory taxonomy
and traverse every returned category with opaque cursors instead of hardcoding
its current category list.

The adapter uses CustomCat's external-design workflow: every line supplies an
exact `catalog_sku` plus a public PNG/JPG artwork URL. Front and back artwork
are supported. Set `sandbox: true` until the account is ready to create paid
production orders.

API keys are merchant scoped. Multi-tenant platforms should resolve the key
from their secret store per fulfillment account; never persist keys in catalog
or fulfillment settings JSON.
