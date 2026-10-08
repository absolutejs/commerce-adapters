# @absolutejs/commerce-dubow

Dubow catalog lookup, artwork, pricing and validated fulfillment serialization for AbsoluteJS commerce. Wire fields follow the [official Dubow v2 documentation](https://integration.dubowtextile.com/).

`createDubowClient` supports an injected fetch for isolated integration testing. `createDubowCatalog` preserves catalog identities but keeps variants unavailable until inventory, supplier SKU, price, imagery and decoration facts have been verified.

## Fulfillment

`validateDubowOrder(request, config)` returns `{ valid, errors }`. Call before collecting payment and again before release. `serializeDubowOrder(request, config)` validates and returns the single object accepted by `client.submitOrders([order])`. It performs no provider calls.

Config requires `customerId`, `contactId`, `shipMethod` and an explicit `procurementType` of `Contract` or `Custom`, unless each line supplies its trusted procurement override. Contract means customer-supplied garments; Custom means the agreed vendor sourcing arrangement. No procurement default is invented. Optional `methodNames` contains account-approved mappings for methods outside the supported defaults.

Each line retains supplier SKU in `Name`, style/mill and exact garment color in `IntegrationProduct`, and exact size/quantity in `LineItemSizes`. Its trusted metadata must include `brand`, `styleCode`, `title`, `color`, `size`, `methods[]` and `artworkMappings[]`, with one method and mapping per artwork placement. A mapping requires `status: ready`, the matching `placement`, and `providerLocation` from the approved provider setup. Existing designs require numeric `providerDesignId` and `providerColorwayCode`; URL designs require the approved `customerDesignCode`, customer `providerColorwayCode`, and an HTTPS artwork URL. Never build this metadata directly from untrusted shopper fields.

Mappings preserve embroidery, DTF, digital print, screen print and sublimation. Unknown methods, missing identities, and mismatched placements fail validation. Screen print requires 24 garments per approved design/colorway, counting combined sizes once per line. Account enablement, exact location values, source-art accessibility, and actual provider acceptance remain deployment checks.

## Validation

`bun run check:package` runs type checking, mocked outbound-request tests and build/declaration output. Tests send no real orders.
