# @absolutejs/commerce-stores

Provider-neutral contracts for white-label store identity, theme review and releases, membership permissions, earnings, validated commercial policies, shipping regions and surcharges, margin/extra-impression pricing, and exact supplier-media artwork previews.

All monetary values are integer cents. `defaultStoreOperatingPolicy()` creates isolated defaults; commercial enforcement is opt-in through `commercialConfigured`. `parseStoreOperatingPolicy` and `parseStoreProductPolicy` validate untrusted input. `storeMockups` emits overlays only when the matching supplier color/view photo and a bounded placement calibration exist.

Applications own persistence, authorization, payment settlement and approval of business terms. No database or provider credentials are included.

## Homepage campaigns

`StoreTheme.hero.slides` optionally adds up to seven campaigns after the primary hero. Each slide has a unique ID, headline, optional image/accessible image description, and optional button. Theme validation bounds content and rejects unsafe destinations. Applications render manual navigation and retain their existing draft/release approval flow; this contract does not imply automatic rotation or vertical inheritance.

## Manual product mockups

`StoreProductPolicy.mockupOverrides` stores optional preview overrides by exact color and decoration placement. `parseStoreMockupOverrides` validates a maximum of 240 unique pairs, safe image URLs and normalized image bounds. A layout includes `artworkUrl`, `photoUrl` and `[x, y, width, height]`; a prepared preview instead includes `finishedImageUrl`.

Pass overrides to `storeMockups`. Layouts require the exact supplier photo/color and current artwork URL; incompatible decoration methods/placements remain excluded. Overrides from older artwork stop applying. A finished preview includes `finishedImageUrl` in the returned mockup: render that image without overlaying artwork a second time. Applications must authorize edits and validate saved overrides against the product and approved store artwork. These settings never alter production dimensions or instructions.
