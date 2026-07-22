import { describe, expect, it } from "bun:test";
import type { FulfillmentOrderRequest } from "@absolutejs/commerce";
import {
  UnknownEffectOutcomeError,
  type EffectAdapterDriverContext,
} from "@absolutejs/execution";
import {
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
