# @absolutejs/commerce-stores

Provider-neutral contracts for white-label store identity, theme review and releases, membership permissions, earnings, validated commercial policies, shipping regions and surcharges, margin/extra-impression pricing, and exact supplier-media artwork previews.

All monetary values are integer cents. `defaultStoreOperatingPolicy()` creates isolated defaults; commercial enforcement is opt-in through `commercialConfigured`. `parseStoreOperatingPolicy` and `parseStoreProductPolicy` validate untrusted input. `storeMockups` emits overlays only when the matching supplier color/view photo and a bounded placement calibration exist.

Applications own persistence, authorization, payment settlement and approval of business terms. No database or provider credentials are included.
