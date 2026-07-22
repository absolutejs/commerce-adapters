import { describe, expect, it } from "bun:test";
import type { FulfillmentOrderRequest } from "@absolutejs/commerce";
import {
  UnknownEffectOutcomeError,
  type EffectAdapterDriverContext,
} from "@absolutejs/execution";
import {
  createCustomCatCatalog,
  createCustomCatEffectAdapterDriver,
  createCustomCatEffectQueryDriver,
  createCustomCatFulfillment,
  CUSTOMCAT_EFFECT_ADAPTER_ID,
  CUSTOMCAT_EFFECT_API_DESTINATION,
  CUSTOMCAT_FULFILLMENT_EFFECT,
  customCatEffectAdapterDescriptor,
  validateCustomCatOrder,
} from "./index";

const order: FulfillmentOrderRequest = {
  externalOrderId: "ORDER-1",
  lines: [
    {
      artwork: [
        { placement: "front", url: "https://cdn.test/front.png" },
        { placement: "back", url: "https://cdn.test/back.jpg" },
      ],
      id: "line-1",
      providerId: "customcat",
      providerSku: "48146",
      quantity: 2,
      variantId: "customcat:48146",
    },
  ],
  recipient: {
    address1: "1300 Rosa Parks Blvd",
    city: "Detroit",
    country: "US",
    email: "customer@example.com",
    firstName: "Joe",
    lastName: "Testing",
    postalCode: "48216",
    state: "MI",
  },
};

describe("CustomCat fulfillment", () => {
  it("normalizes catalog products and preflights exact fulfillment cost", async () => {
    const catalogProduct = {
      catalog_product_id: 101,
      category: "Digisoft",
      product_type: "T-Shirts",
      title: "Everyday Tee",
      variants: [
        {
          catalog_sku: "48146",
          color: "Black",
          cost: "6.25",
          instock: "true",
          size: "Large",
        },
      ],
    };
    const requests: string[] = [];
    const catalog = createCustomCatCatalog({
      apiKey: "test-key",
      fetch: async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/catalog/sku/")) return Response.json(catalogProduct);
        if (url.includes("/shipping/"))
          return Response.json({ shipping_cost: "4.50" });
        if (url.includes("/shipping"))
          return Response.json([{ name: "Economy", shipping_id: 1 }]);

        return Response.json([catalogProduct]);
      },
    });
    const page = await catalog.listProducts({ limit: 10 });
    expect(page.items[0]).toMatchObject({
      product: {
        externalId: "101",
        productType: "T-Shirts",
        title: "Everyday Tee",
      },
      variants: [
        {
          available: true,
          costCents: 625,
          options: { Color: "Black", Size: "Large" },
          supplierSku: "48146",
        },
      ],
    });
    const shippingMethods = await catalog.listShippingMethods({
      lines: order.lines,
      recipient: order.recipient,
    });
    expect(shippingMethods).toEqual([{ id: "Economy", name: "Economy" }]);
    const quote = await catalog.quoteOrder({
      lines: [{ ...order.lines[0]!, quantity: 2 }],
      recipient: order.recipient,
      shippingMethod: "Economy",
    });
    expect(quote).toMatchObject({
      adjustmentsCents: 1_000,
      currency: "USD",
      itemsCents: 1_250,
      shippingCents: 450,
      totalCents: 2_700,
    });
    expect(requests).toEqual([
      "GET https://customcat-beta.mylocker.net/api/v1/catalog?category=Digisoft&limit=10&page=1&api_key=test-key",
      "GET https://customcat-beta.mylocker.net/api/v1/shipping?country_code=US&api_key=test-key",
      "GET https://customcat-beta.mylocker.net/api/v1/catalog/sku/48146?api_key=test-key",
      "GET https://customcat-beta.mylocker.net/api/v1/shipping?country_code=US&api_key=test-key",
      "POST https://customcat-beta.mylocker.net/api/v1/shipping/1",
    ]);
  });

  it("searches the complete provider catalog before paginating matches", async () => {
    const products = [
      {
        catalog_product_id: 101,
        category: "Digisoft",
        product_type: "T-Shirts",
        title: "Everyday Tee",
        variants: [{ catalog_sku: "TEE-1", instock: true }],
      },
      {
        catalog_product_id: 102,
        category: "Digisoft",
        product_type: "Mugs",
        title: "Tee Camp Mug",
        variants: [{ catalog_sku: "MUG-1", instock: true }],
      },
    ];
    const catalog = createCustomCatCatalog({
      apiKey: "test-key",
      fetch: async () => Response.json(products),
    });

    const page = await catalog.listProducts({ limit: 1, search: "tee" });

    expect(page.items.map(({ product }) => product.title)).toEqual([
      "Everyday Tee",
    ]);
    expect(page.nextCursor).toBe("2");
    const nextPage = await catalog.listProducts({
      cursor: page.nextCursor ?? undefined,
      limit: 1,
      search: "tee",
    });
    expect(nextPage.items.map(({ product }) => product.title)).toEqual([
      "Tee Camp Mug",
    ]);
    expect(nextPage.nextCursor).toBeUndefined();
  });

  it("normalizes provider taxonomy and browses every configured category", async () => {
    const requests: string[] = [];
    const catalog = createCustomCatCatalog({
      apiKey: "test-key",
      categories: "all",
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/catalogcategory"))
          return Response.json([
            {
              category: "Digisoft",
              category_url_slug: "digisoft",
              subcategories: ["T-Shirts"],
            },
            {
              category: "Sublimation",
              category_url_slug: "sublimation",
              subcategories: ["Bags"],
            },
          ]);

        return Response.json([]);
      },
    });

    const taxonomy = await catalog.listTaxonomy();
    const first = await catalog.listProducts({ limit: 10 });
    const second = await catalog.listProducts({
      cursor: first.nextCursor ?? undefined,
      limit: 10,
    });

    expect(taxonomy).toContainEqual({
      externalId: "category:digisoft:subcategory:t-shirts",
      kind: "subcategory",
      metadata: { category: "Digisoft" },
      name: "T-Shirts",
      parentExternalId: "category:digisoft",
      slug: "t-shirts",
    });
    expect(second.items).toEqual([]);
    expect(
      requests.some((url) => url.includes("category=Digisoft")),
    ).toBeTrue();
    expect(
      requests.some((url) => url.includes("category=Sublimation")),
    ).toBeTrue();
  });

  it("declares an exact mandate-bound spending adapter", () => {
    expect(customCatEffectAdapterDescriptor).toMatchObject({
      adapterId: CUSTOMCAT_EFFECT_ADAPTER_ID,
      compensation: { supported: true },
      reconciliation: { mode: "query" },
      spendAuthority: {
        canSpend: true,
        currencies: ["USD"],
        requiresMandate: true,
      },
    });
  });

  it("maps normalized lines to the external-design order payload", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const provider = createCustomCatFulfillment({
      apiKey: "test-key",
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body));

        return new Response(
          JSON.stringify({ ORDER_ID: "ORDER-1", status: "Pending" }),
          { status: 200 },
        );
      },
      sandbox: true,
    });
    const submitted = await provider.submitOrder(order);
    expect(requestUrl).toEndWith("/order/ORDER-1");
    expect(requestBody.sandbox).toBe("1");
    expect(requestBody.items).toEqual([
      {
        catalog_sku: "48146",
        design_url: "https://cdn.test/front.png",
        design_url_back: "https://cdn.test/back.jpg",
        quantity: 2,
      },
    ]);
    expect(submitted.status).toBe("accepted");
  });

  it("keeps back-only artwork on the provider's back-print field", async () => {
    let requestBody: Record<string, unknown> = {};
    const provider = createCustomCatFulfillment({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));

        return Response.json({ ORDER_ID: "ORDER-1", status: "Pending" });
      },
    });
    await provider.submitOrder({
      ...order,
      lines: [
        {
          ...order.lines[0]!,
          artwork: [
            { placement: "back", url: "https://cdn.test/back-only.png" },
          ],
        },
      ],
    });

    expect(requestBody.items).toEqual([
      {
        catalog_sku: "48146",
        design_url: "",
        design_url_back: "https://cdn.test/back-only.png",
        quantity: 2,
      },
    ]);
  });

  it("normalizes status shipments and cost", async () => {
    const provider = createCustomCatFulfillment({
      apiKey: "test-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            CUSTOMCAT_ORDER_ID: "CC-1",
            ORDER_ID: "ORDER-1",
            ORDER_STATUS: "Shipped",
            ORDER_TOTAL: 19.47,
            SHIPMENTS: [{ TRACKING_ID: "TRACK-1", VENDOR: "UPS" }],
          }),
        ),
    });
    const status = await provider.getOrder("ORDER-1");
    expect(status.providerOrderId).toBe("CC-1");
    expect(status.status).toBe("shipped");
    expect(status.costCents).toBe(1947);
    expect(status.tracking[0]).toEqual({
      carrier: "UPS",
      trackingNumber: "TRACK-1",
      trackingUrl: undefined,
    });
  });

  it("rejects private or unsupported artwork before submission", () => {
    const validation = validateCustomCatOrder({
      ...order,
      lines: [
        {
          ...order.lines[0]!,
          artwork: [{ placement: "sleeve", url: "http://local/art.svg" }],
        },
      ],
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toHaveLength(2);
  });

  it("executes only an exact effect-bound order and strips raw provider data", async () => {
    const effectId = "purchase:purchase-1";
    const context: EffectAdapterDriverContext = {
      actionId: "action-1",
      credentials: [
        {
          adapterAlias: "CUSTOMCAT_API_KEY",
          destination: CUSTOMCAT_EFFECT_API_DESTINATION,
          mode: "provider-sdk",
          secretAlias: "PROJECT_CUSTOMCAT_API_KEY",
          value: "resolved-key",
        },
      ],
      currency: "USD",
      destination: CUSTOMCAT_EFFECT_API_DESTINATION,
      effect: CUSTOMCAT_FULFILLMENT_EFFECT,
      effectId,
      idempotencyKey: "purchase-1",
      inputDigest: "digest-1",
      installationId: "installation-1",
      mandateId: "mandate-1",
      signal: new AbortController().signal,
      spendMinor: 1947,
      tenantId: "tenant-1",
    };
    let resolvedKey = "";
    const driver = createCustomCatEffectAdapterDriver((apiKey) => {
      resolvedKey = apiKey;

      return {
        cancelOrder: async () => ({
          externalOrderId: effectId,
          providerOrderId: "CC-1",
          status: "cancelled",
          tracking: [],
        }),
        getOrder: async () => ({
          externalOrderId: effectId,
          providerOrderId: "CC-1",
          status: "accepted",
          tracking: [],
        }),
        submitOrder: async () => ({
          costCents: 1947,
          currency: "USD",
          externalOrderId: effectId,
          providerOrderId: "CC-1",
          raw: { api_key: "must-not-retain" },
          status: "accepted",
          tracking: [],
        }),
        validateOrder: async () => ({ errors: [], valid: true }),
      };
    });
    const submitted = await driver.execute(
      { ...order, externalOrderId: effectId },
      context,
    );
    expect(resolvedKey).toBe("resolved-key");
    expect(submitted).not.toHaveProperty("raw");
    expect(driver.reconciliationReference?.(submitted, context)).toEqual({
      provider: "customcat",
      resourceId: "CC-1",
    });
    await driver.compensate?.(submitted, context);
  });

  it("quarantines a provider order whose charged cost differs from authority", async () => {
    const effectId = "purchase:purchase-2";
    const driver = createCustomCatEffectAdapterDriver(() => ({
      getOrder: async () => {
        throw new Error("unused");
      },
      submitOrder: async () => ({
        costCents: 2000,
        currency: "USD",
        externalOrderId: effectId,
        providerOrderId: "CC-2",
        status: "accepted",
        tracking: [],
      }),
      validateOrder: async () => ({ errors: [], valid: true }),
    }));
    const execution = driver.execute(
      { ...order, externalOrderId: effectId },
      {
        actionId: "action-2",
        credentials: [
          {
            adapterAlias: "CUSTOMCAT_API_KEY",
            destination: CUSTOMCAT_EFFECT_API_DESTINATION,
            mode: "provider-sdk",
            secretAlias: "CUSTOMCAT_API_KEY",
            value: "key",
          },
        ],
        currency: "USD",
        destination: CUSTOMCAT_EFFECT_API_DESTINATION,
        effect: CUSTOMCAT_FULFILLMENT_EFFECT,
        effectId,
        idempotencyKey: "purchase-2",
        inputDigest: "digest-2",
        installationId: "installation-2",
        mandateId: "mandate-2",
        signal: new AbortController().signal,
        spendMinor: 1947,
        tenantId: "tenant-1",
      },
    );
    await expect(execution).rejects.toBeInstanceOf(UnknownEffectOutcomeError);
    await expect(execution).rejects.toMatchObject({
      reconciliationReference: {
        adapterId: CUSTOMCAT_EFFECT_ADAPTER_ID,
        provider: "customcat",
        resourceId: "CC-2",
      },
    });
  });

  it("reconciles only the exact retained provider and effect identity", async () => {
    const driver = createCustomCatEffectQueryDriver(() => ({
      getOrder: async () => ({
        externalOrderId: "purchase:purchase-3",
        providerOrderId: "CC-3",
        status: "accepted",
        tracking: [],
      }),
      submitOrder: async () => {
        throw new Error("unused");
      },
      validateOrder: async () => ({ errors: [], valid: true }),
    }));
    const result = await driver.query(
      {
        effectId: "purchase:purchase-3",
        idempotencyKey: "purchase-3",
        inputDigest: "digest-3",
        reconciliationReference: {
          adapterId: CUSTOMCAT_EFFECT_ADAPTER_ID,
          provider: "customcat",
          resourceId: "CC-3",
        },
      },
      {
        credential: {
          adapterAlias: "CUSTOMCAT_API_KEY",
          destination: CUSTOMCAT_EFFECT_API_DESTINATION,
          mode: "provider-sdk",
          secretAlias: "CUSTOMCAT_API_KEY",
          value: "key",
        },
        installationId: "installation-3",
        signal: new AbortController().signal,
        tenantId: "tenant-1",
      },
    );
    expect(result).toMatchObject({
      outcome: "confirmed_succeeded",
      providerResourceId: "CC-3",
      status: "resolved",
    });
  });
});
