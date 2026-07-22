import {
  validateFulfillmentOrder,
  type FulfillmentEvent,
  type FulfillmentOrder,
  type FulfillmentOrderRequest,
  type FulfillmentProvider,
  type FulfillmentStatus,
  type FulfillmentTracking,
  type FulfillmentValidation,
} from "@absolutejs/commerce";
import {
  UnknownEffectOutcomeError,
  type EffectAdapterDescriptor,
  type EffectAdapterDriver,
  type EffectAdapterDriverContext,
  type EffectAdapterQueryDriver,
} from "@absolutejs/execution";
import {
  createCustomCatRequest,
  record,
  stringValue,
  type JsonRecord,
} from "./client";
import {
  CUSTOMCAT_EFFECT_ADAPTER_ID,
  CUSTOMCAT_EFFECT_API_DESTINATION,
  CUSTOMCAT_FULFILLMENT_EFFECT,
} from "./constants";

export * from "./catalog";
export * from "./constants";

export const customCatEffectAdapterDescriptor: EffectAdapterDescriptor = {
  adapterId: CUSTOMCAT_EFFECT_ADAPTER_ID,
  compensation: { supported: true },
  credentialBindings: [
    {
      alias: "CUSTOMCAT_API_KEY",
      destination: CUSTOMCAT_EFFECT_API_DESTINATION,
      mode: "provider-sdk",
    },
  ],
  destinations: [
    { kind: "https-origin", value: CUSTOMCAT_EFFECT_API_DESTINATION },
  ],
  effects: [CUSTOMCAT_FULFILLMENT_EFFECT],
  idempotency: { scope: "tenant-effect", supported: true },
  reconciliation: {
    mode: "query",
    query: {
      credentialAlias: "CUSTOMCAT_API_KEY",
      health: {
        staleAfterMs: 900_000,
        strategy: "last-successful-query",
      },
      pollingIntervalMs: 60_000,
      provider: "customcat",
      requiresReference: true,
      rotation: { mode: "replace", verification: "successful-query" },
      supportedOutcomes: ["confirmed_succeeded"],
    },
  },
  spendAuthority: {
    canSpend: true,
    currencies: ["USD"],
    requiresMandate: true,
  },
  title: "CustomCat fulfillment order",
  version: "0.3.0",
};

export type CustomCatConfig = {
  apiKey: string;
  baseUrl?: string;
  sandbox?: boolean;
  shippingMethod?: string;
  /** Injectable for tests, proxies, and edge runtimes. */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const customCatStatus = (value: unknown): FulfillmentStatus => {
  const status = stringValue(value).trim().toLowerCase();
  if (status.includes("ship")) return "shipped";
  if (status.includes("cancel")) return "cancelled";
  if (status.includes("fail") || status.includes("error")) return "failed";
  if (
    status.includes("verified") ||
    status.includes("print") ||
    status.includes("production")
  )
    return "in_production";
  if (status.includes("pending") || status.includes("received"))
    return "accepted";

  return "pending";
};

const trackingFrom = (payload: JsonRecord): FulfillmentTracking[] => {
  const shipments = payload.SHIPMENTS ?? payload.shipments;
  if (!Array.isArray(shipments)) return [];

  return shipments.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const shipment = entry as JsonRecord;
    const trackingNumber = stringValue(
      shipment.TRACKING_ID ?? shipment.tracking_id ?? shipment.tracking_number,
    );
    if (!trackingNumber) return [];

    return [
      {
        carrier: stringValue(shipment.VENDOR ?? shipment.vendor) || undefined,
        trackingNumber,
        trackingUrl:
          stringValue(shipment.TRACKING_URL ?? shipment.tracking_url) ||
          undefined,
      },
    ];
  });
};

const artworkUrlIsSupported = (value: string) => {
  try {
    const url = new URL(value);

    return url.protocol === "https:" && /\.(png|jpe?g)$/i.test(url.pathname);
  } catch {
    return false;
  }
};

export const validateCustomCatOrder = (
  order: FulfillmentOrderRequest,
): FulfillmentValidation => {
  const base = validateFulfillmentOrder(order);
  const errors = [...base.errors];
  for (const line of order.lines) {
    const placements = new Set<string>();
    for (const artwork of line.artwork) {
      const placement = artwork.placement.trim().toLowerCase();
      if (placement !== "front" && placement !== "back")
        errors.push({
          lineId: line.id,
          message: "CustomCat artwork placement must be front or back",
        });
      if (placements.has(placement))
        errors.push({
          lineId: line.id,
          message: `CustomCat accepts one ${placement} artwork file per line`,
        });
      placements.add(placement);
      if (!artworkUrlIsSupported(artwork.url))
        errors.push({
          lineId: line.id,
          message: "CustomCat artwork must be a public HTTPS PNG or JPG URL",
        });
    }
  }

  return { errors, valid: errors.length === 0 };
};

const normalizeOrder = (
  payload: JsonRecord,
  fallbackOrderId: string,
): FulfillmentOrder => ({
  costCents: Number.isFinite(Number(payload.ORDER_TOTAL ?? payload.order_total))
    ? Math.round(Number(payload.ORDER_TOTAL ?? payload.order_total) * 100)
    : undefined,
  currency: "USD",
  externalOrderId:
    stringValue(payload.ORDER_ID ?? payload.order_id) || fallbackOrderId,
  providerOrderId:
    stringValue(
      payload.CUSTOMCAT_ORDER_ID ??
        payload.customcat_order_id ??
        payload.ORDER_ID ??
        payload.order_id,
    ) || fallbackOrderId,
  raw: payload,
  status: customCatStatus(payload.ORDER_STATUS ?? payload.status),
  tracking: trackingFrom(payload),
});

export const createCustomCatFulfillment = (
  config: CustomCatConfig,
): FulfillmentProvider => {
  const request = createCustomCatRequest(config);

  return {
    cancelOrder: async (providerOrderId) => {
      const payload = await request(
        `/order/${encodeURIComponent(providerOrderId)}`,
        { method: "DELETE" },
        true,
      );

      if (!record(payload))
        throw new Error("CustomCat order response is malformed");

      return normalizeOrder(payload, providerOrderId);
    },
    getOrder: async (providerOrderId) => {
      const payload = await request(
        `/order/status/${encodeURIComponent(providerOrderId)}`,
        undefined,
        true,
      );

      if (!record(payload))
        throw new Error("CustomCat order response is malformed");

      return normalizeOrder(payload, providerOrderId);
    },
    id: "customcat",
    parseWebhook: async (webhookRequest): Promise<FulfillmentEvent> => {
      const payload = (await webhookRequest.json()) as JsonRecord;
      const normalized = normalizeOrder(
        payload,
        stringValue(payload.ORDER_ID ?? payload.order_id),
      );
      const type =
        normalized.status === "shipped"
          ? "shipped"
          : normalized.status === "cancelled"
            ? "cancelled"
            : normalized.status === "failed"
              ? "failed"
              : normalized.status === "in_production"
                ? "production"
                : "accepted";

      return {
        externalOrderId: normalized.externalOrderId,
        id: stringValue(payload.EVENT_ID ?? payload.event_id) || undefined,
        providerOrderId: normalized.providerOrderId,
        raw: payload,
        status: normalized.status,
        tracking: normalized.tracking,
        type,
      };
    },
    submitOrder: async (order) => {
      const validation = validateCustomCatOrder(order);
      if (!validation.valid)
        throw new Error(
          validation.errors.map((error) => error.message).join("; "),
        );
      const items = order.lines.map((line) => {
        const front = line.artwork.find(
          (artwork) => artwork.placement.toLowerCase() === "front",
        );
        const back = line.artwork.find(
          (artwork) => artwork.placement.toLowerCase() === "back",
        );

        return {
          catalog_sku: line.providerSku,
          design_url: front?.url ?? back?.url,
          ...(front && back ? { design_url_back: back.url } : {}),
          ...(front?.presetId ? { preset_id: front.presetId } : {}),
          quantity: line.quantity,
        };
      });
      const body = {
        api_key: config.apiKey,
        items,
        sandbox: (order.sandbox ?? config.sandbox) ? "1" : "0",
        shipping_address1: order.recipient.address1,
        shipping_address2: order.recipient.address2 ?? "",
        shipping_city: order.recipient.city,
        shipping_country: order.recipient.country,
        shipping_email: order.recipient.email ?? "",
        shipping_first_name: order.recipient.firstName,
        shipping_last_name: order.recipient.lastName,
        shipping_method:
          order.shippingMethod ?? config.shippingMethod ?? "Economy",
        shipping_phone: order.recipient.phone ?? "",
        shipping_state: order.recipient.state ?? "",
        shipping_zip: order.recipient.postalCode,
      };
      const payload = await request(
        `/order/${encodeURIComponent(order.externalOrderId)}`,
        {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      if (!record(payload))
        throw new Error("CustomCat order response is malformed");

      return normalizeOrder(payload, order.externalOrderId);
    },
    validateOrder: validateCustomCatOrder,
  };
};

type CustomCatEffectProvider = Pick<
  FulfillmentProvider,
  "cancelOrder" | "getOrder" | "submitOrder" | "validateOrder"
>;

const normalizedEffectOrder = (order: FulfillmentOrder): FulfillmentOrder => ({
  ...(order.costCents === undefined ? {} : { costCents: order.costCents }),
  ...(order.currency === undefined ? {} : { currency: order.currency }),
  externalOrderId: order.externalOrderId,
  providerOrderId: order.providerOrderId,
  status: order.status,
  tracking: order.tracking,
});

const effectApiKey = (context: EffectAdapterDriverContext) => {
  const credential = context.credentials.find(
    (candidate) =>
      candidate.adapterAlias === "CUSTOMCAT_API_KEY" &&
      candidate.destination === CUSTOMCAT_EFFECT_API_DESTINATION &&
      candidate.mode === "provider-sdk",
  );
  if (!credential) throw new Error("CustomCat API key binding is unavailable");

  return credential.value;
};

const queryApiKey = (
  credential: Parameters<EffectAdapterQueryDriver["query"]>[1]["credential"],
) => {
  if (
    credential.adapterAlias !== "CUSTOMCAT_API_KEY" ||
    credential.destination !== CUSTOMCAT_EFFECT_API_DESTINATION ||
    credential.mode !== "provider-sdk"
  )
    throw new Error("CustomCat query API key binding is unavailable");

  return credential.value;
};

const assertEffectContext = (context: EffectAdapterDriverContext) => {
  if (
    context.effect !== CUSTOMCAT_FULFILLMENT_EFFECT ||
    context.destination !== CUSTOMCAT_EFFECT_API_DESTINATION ||
    context.currency !== "USD" ||
    !context.mandateId ||
    !context.spendMinor ||
    context.spendMinor < 1
  )
    throw new Error(
      "CustomCat execution context is outside the adapter contract",
    );
};

export const createCustomCatEffectAdapterDriver = (
  providerForKey: (apiKey: string) => CustomCatEffectProvider,
): EffectAdapterDriver<FulfillmentOrderRequest, FulfillmentOrder> => ({
  adapterId: CUSTOMCAT_EFFECT_ADAPTER_ID,
  capabilities: {
    compensation: true,
    idempotency: true,
    reconciliation: "query",
  },
  compensate: async (output, context) => {
    assertEffectContext(context);
    const provider = providerForKey(effectApiKey(context));
    if (!provider.cancelOrder)
      throw new Error("CustomCat cancellation is unavailable");
    const cancelled = await provider.cancelOrder(output.providerOrderId);
    if (cancelled.status !== "cancelled")
      throw new Error("CustomCat did not confirm order cancellation");
  },
  execute: async (order, context) => {
    assertEffectContext(context);
    if (order.externalOrderId !== context.effectId)
      throw new Error("CustomCat order identity must equal the durable effect");
    const provider = providerForKey(effectApiKey(context));
    const validation = await provider.validateOrder(order);
    if (!validation.valid)
      throw new Error(
        validation.errors.map(({ message }) => message).join("; "),
      );
    const submitted = normalizedEffectOrder(await provider.submitOrder(order));
    const reference = submitted.providerOrderId
      ? {
          adapterId: CUSTOMCAT_EFFECT_ADAPTER_ID,
          provider: "customcat",
          resourceId: submitted.providerOrderId,
        }
      : undefined;
    if (
      submitted.externalOrderId !== context.effectId ||
      submitted.costCents !== context.spendMinor ||
      submitted.currency !== context.currency
    )
      throw new UnknownEffectOutcomeError(
        "CustomCat accepted an order outside its exact spend binding",
        { ...(reference ? { reconciliationReference: reference } : {}) },
      );

    return submitted;
  },
  reconciliationReference: (output) => ({
    provider: "customcat",
    resourceId: output.providerOrderId,
  }),
  version: customCatEffectAdapterDescriptor.version,
});

export const createCustomCatEffectQueryDriver = (
  providerForKey: (apiKey: string) => CustomCatEffectProvider,
): EffectAdapterQueryDriver => ({
  adapterId: CUSTOMCAT_EFFECT_ADAPTER_ID,
  provider: "customcat",
  query: async (effect, context) => {
    const reference = effect.reconciliationReference;
    if (
      !reference ||
      reference.adapterId !== CUSTOMCAT_EFFECT_ADAPTER_ID ||
      reference.provider !== "customcat"
    )
      throw new Error(
        "CustomCat query requires its exact retained order reference",
      );
    if (context.signal.aborted) throw new Error("CustomCat query was aborted");
    const order = await providerForKey(
      queryApiKey(context.credential),
    ).getOrder(reference.resourceId);
    if (
      order.providerOrderId !== reference.resourceId ||
      order.externalOrderId !== effect.effectId
    )
      throw new Error(
        "CustomCat query response differs from the retained order",
      );

    return {
      deliveryId: `customcat:query:${reference.resourceId}:${order.status}`,
      eventType: `order.${order.status}`,
      evidenceReference: `customcat:query:${reference.resourceId}`,
      occurredAt: Date.now(),
      outcome: "confirmed_succeeded",
      providerResourceId: reference.resourceId,
      status: "resolved",
      verifier: "customcat-api-v1",
    };
  },
  version: customCatEffectAdapterDescriptor.version,
});
