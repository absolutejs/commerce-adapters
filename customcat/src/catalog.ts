import type {
  CatalogPage,
  CatalogProduct,
  CatalogSourceProvider,
  FulfillmentCostQuote,
  FulfillmentCostQuoteProvider,
  FulfillmentCostQuoteRequest,
  InventoryLevel,
  ProductMedia,
  ProductVariant,
} from "@absolutejs/commerce";
import {
  createCustomCatRequest,
  record,
  stringValue,
  type CustomCatHttpConfig,
  type JsonRecord,
} from "./client";

const BACK_PRINT_CENTS = 500;
const DEFAULT_CATALOG_LIMIT = 25;
const DEFAULT_CATEGORY = "Digisoft";
const DEFAULT_SHIPPING_METHOD = "Economy";
const MAX_CATALOG_LIMIT = 250;

export type CustomCatCatalogConfig = CustomCatHttpConfig & {
  category?: string;
  subcategory?: string;
};

export type CustomCatCatalogProvider = CatalogSourceProvider &
  FulfillmentCostQuoteProvider;

const normalizedKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const field = (value: JsonRecord, ...names: string[]) => {
  const wanted = new Set(names.map(normalizedKey));
  const entry = Object.entries(value).find(([key]) =>
    wanted.has(normalizedKey(key)),
  );

  return entry?.[1];
};

const records = (value: unknown, ...containerNames: string[]): JsonRecord[] => {
  if (Array.isArray(value)) return value.filter(record);
  if (!record(value)) return [];
  for (const name of containerNames) {
    const nested = field(value, name);
    if (Array.isArray(nested)) return nested.filter(record);
  }

  return [value];
};

const booleanValue = (value: unknown, fallback = true) => {
  if (typeof value === "boolean") return value;
  const normalized = stringValue(value).trim().toLowerCase();
  if (["1", "true", "yes", "in stock", "instock"].includes(normalized))
    return true;
  if (["0", "false", "no", "out of stock", "outofstock"].includes(normalized))
    return false;

  return fallback;
};

const moneyCents = (value: unknown) => {
  const normalized = stringValue(value).replace(/[$,]/g, "").trim();
  if (!normalized) return null;
  const amount = Number(normalized);

  return Number.isFinite(amount) && amount >= 0
    ? Math.round(amount * 100)
    : null;
};

const mediaFrom = (value: JsonRecord): ProductMedia[] =>
  records(field(value, "images", "media"), "images", "media").flatMap(
    (image, index) => {
      const url = stringValue(field(image, "image_url", "url")).trim();
      if (!url) return [];

      return [
        {
          color: stringValue(field(image, "color")).trim() || undefined,
          kind: "image" as const,
          position: index,
          url,
        },
      ];
    },
  );

const variantFrom = (
  value: JsonRecord,
  productId: string,
  productMedia: ProductMedia[],
): ProductVariant => {
  const sku = stringValue(
    field(value, "catalog_sku", "catalogSku", "sku", "id"),
  ).trim();
  if (!sku) throw new Error("CustomCat catalog variant has no catalog SKU");
  const available = booleanValue(
    field(value, "instock", "in_stock", "available"),
  );
  const color = stringValue(field(value, "color", "option1")).trim();
  const size = stringValue(field(value, "size", "option2")).trim();

  return {
    available,
    costCents: moneyCents(
      field(value, "cost", "base_cost", "wholesale_price", "price"),
    ),
    currency: "USD",
    externalId: sku,
    id: `customcat:${sku}`,
    inventoryPolicy: "external",
    media: mediaFrom(value).length > 0 ? mediaFrom(value) : productMedia,
    metadata: {},
    options: {
      ...(color ? { Color: color } : {}),
      ...(size ? { Size: size } : {}),
    },
    productId,
    sku,
    supplierSku: sku,
  };
};

const productFrom = (value: JsonRecord) => {
  const nested = field(value, "product");
  const source = record(nested) ? nested : value;
  const externalId = stringValue(
    field(source, "catalog_product_id", "product_id", "id", "style_id"),
  ).trim();
  if (!externalId)
    throw new Error("CustomCat catalog product has no provider identity");
  const productId = `customcat:${externalId}`;
  const title =
    stringValue(field(source, "title", "product_name", "name")).trim() ||
    `CustomCat product ${externalId}`;
  const category = stringValue(field(source, "category")).trim();
  const productType = stringValue(
    field(source, "product_type", "subcategory", "type"),
  ).trim();
  const media = mediaFrom(source);
  const variantRecords = records(
    field(source, "variants", "skus", "items"),
    "variants",
    "skus",
    "items",
  );
  const variants = (variantRecords.length > 0 ? variantRecords : [source]).map(
    (variant) => variantFrom(variant, productId, media),
  );
  const optionNames = Array.from(
    new Set(variants.flatMap((variant) => Object.keys(variant.options))),
  );
  const product: CatalogProduct = {
    attributes: {},
    brand: stringValue(field(source, "brand", "manufacturer")).trim(),
    category,
    decorationAreas: [],
    description: stringValue(field(source, "description")).trim(),
    externalId,
    id: productId,
    media,
    metadata: {},
    optionNames,
    productType,
    slug: `${title}-${externalId}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, ""),
    sourceId: "customcat",
    status: "active",
    styleCode: externalId,
    tags: [category, productType].filter(Boolean),
    title,
  };

  return { product, variants };
};

const quoteItem = (line: FulfillmentCostQuoteRequest["lines"][number]) => ({
  catalog_sku: line.providerSku,
  quantity: line.quantity,
});

export const createCustomCatCatalog = (
  config: CustomCatCatalogConfig,
): CustomCatCatalogProvider => {
  const request = createCustomCatRequest(config);
  const getSku = async (sku: string) => {
    const payload = await request(
      `/catalog/sku/${encodeURIComponent(sku)}`,
      undefined,
      true,
    );
    const [candidate] = records(payload, "products", "catalog", "data");
    if (!candidate) throw new Error(`CustomCat catalog SKU not found: ${sku}`);
    const normalized = productFrom(candidate);
    const variant = normalized.variants.find(
      ({ supplierSku }) => supplierSku === sku,
    );
    if (!variant) throw new Error(`CustomCat catalog SKU not found: ${sku}`);

    return { ...normalized, variant };
  };

  return {
    getInventory: async (skus): Promise<InventoryLevel[]> =>
      Promise.all(
        skus.map(async (sku) => {
          const { variant } = await getSku(sku);

          return { available: variant.available, sku };
        }),
      ),
    getProduct: async (externalId) => {
      const payload = await request(
        `/catalog/${encodeURIComponent(externalId)}`,
        undefined,
        true,
      );
      const [candidate] = records(payload, "products", "catalog", "data");

      return candidate ? productFrom(candidate) : null;
    },
    id: "customcat",
    listProducts: async (
      input = {},
    ): Promise<CatalogPage<ReturnType<typeof productFrom>>> => {
      const limit = Math.min(
        Math.max(input.limit ?? DEFAULT_CATALOG_LIMIT, 1),
        MAX_CATALOG_LIMIT,
      );
      const page = Math.max(Number(input.cursor ?? "1") || 1, 1);
      const query = new URLSearchParams({
        category: config.category ?? DEFAULT_CATEGORY,
        limit: String(limit),
        page: String(page),
        ...(config.subcategory ? { subcategory: config.subcategory } : {}),
      });
      const payload = await request(`/catalog?${query}`, undefined, true);
      const items = records(payload, "products", "catalog", "data").map(
        productFrom,
      );

      return {
        items,
        ...(items.length < limit ? {} : { nextCursor: String(page + 1) }),
      };
    },
    quoteOrder: async (order): Promise<FulfillmentCostQuote> => {
      if (order.lines.length === 0)
        throw new Error("CustomCat preflight requires fulfillment lines");
      const uniqueSkus = Array.from(
        new Set(order.lines.map(({ providerSku }) => providerSku)),
      );
      const priced = new Map(
        await Promise.all(
          uniqueSkus.map(async (sku) => {
            const { variant } = await getSku(sku);
            if (!variant.available)
              throw new Error(`CustomCat catalog SKU is unavailable: ${sku}`);
            if (variant.costCents === null || variant.costCents === undefined)
              throw new Error(`CustomCat catalog SKU has no cost: ${sku}`);

            return [sku, variant.costCents] as const;
          }),
        ),
      );
      const itemsCents = order.lines.reduce(
        (total, line) =>
          total + (priced.get(line.providerSku) ?? 0) * line.quantity,
        0,
      );
      const secondSidePrintCount = order.lines.reduce(
        (total, line) =>
          total +
          (line.artwork.some(
            ({ placement }) => placement.trim().toLowerCase() === "front",
          ) &&
          line.artwork.some(
            ({ placement }) => placement.trim().toLowerCase() === "back",
          )
            ? line.quantity
            : 0),
        0,
      );
      const adjustmentsCents = secondSidePrintCount * BACK_PRINT_CENTS;
      const shippingPayload = await request("/shipping", undefined, true);
      const methods = records(
        shippingPayload,
        "shipping",
        "shipping_methods",
        "methods",
        "data",
      );
      const wantedMethod = order.shippingMethod ?? DEFAULT_SHIPPING_METHOD;
      const shipping = methods.find((method) => {
        const id = stringValue(field(method, "shipping_id", "id")).trim();
        const name = stringValue(
          field(method, "shipping_method", "method", "name", "title"),
        ).trim();

        return (
          id === wantedMethod ||
          name.toLowerCase() === wantedMethod.trim().toLowerCase()
        );
      });
      if (!shipping)
        throw new Error(
          `CustomCat shipping method is unavailable: ${wantedMethod}`,
        );
      const shippingId = stringValue(
        field(shipping, "shipping_id", "id"),
      ).trim();
      if (!shippingId)
        throw new Error("CustomCat shipping method has no provider identity");
      const shippingQuote = await request(`/shipping/${shippingId}`, {
        body: JSON.stringify({
          api_key: config.apiKey,
          country_code: order.recipient.country,
          items: order.lines.map(quoteItem),
          state: order.recipient.state ?? "",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!record(shippingQuote))
        throw new Error("CustomCat shipping quote is malformed");
      const shippingCents = moneyCents(
        field(
          shippingQuote,
          "shipping_cost",
          "shipping",
          "cost",
          "price",
          "amount",
        ),
      );
      if (shippingCents === null)
        throw new Error("CustomCat shipping quote has no cost");
      const totalCents = itemsCents + adjustmentsCents + shippingCents;

      return {
        adjustmentsCents,
        assumptions: [
          "CustomCat catalog costs and shipping are refreshed at authorization time",
          "CustomCat adds $5 per back-printed item",
          "Provider inventory and pricing are not reserved by this preview",
        ],
        currency: "USD",
        itemsCents,
        quotedAt: new Date().toISOString(),
        shippingCents,
        totalCents,
      };
    },
  };
};
