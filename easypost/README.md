# @absolutejs/commerce-easypost

[EasyPost](https://www.easypost.com) shipping adapter for
[`@absolutejs/commerce`](https://github.com/absolutejs/commerce). Implements the
`ShippingProvider` contract — rates, one-call cheapest-label purchase, and
tracking — so a shop can buy and print real carrier labels.

```ts
import { createEasyPostProvider } from '@absolutejs/commerce-easypost';

const shipping = createEasyPostProvider({ apiKey: process.env.EASYPOST_API_KEY! });

const label = await shipping.buyCheapestLabel({
	from: shopAddress,
	to: customerAddress,
	parcel: { lengthIn: 12, widthIn: 9, heightIn: 2, weightOz: 8 }
});
// label.trackingNumber, label.labelUrl (print this), label.amount, …
```

EasyPost connects your existing USPS/UPS/FedEx/etc. carrier accounts, so the
shop ships with whatever it already uses. Use a test API key for development.

## License

Apache-2.0.
