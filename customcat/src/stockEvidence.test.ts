import { expect, it } from "bun:test";
import { createCustomCatCatalog } from "./catalog";
const catalog = (stock: unknown) =>
  createCustomCatCatalog({
    apiKey: "fixture",
    fetch: async () =>
      Response.json([
        {
          catalog_product_id: 1,
          title: "Tee",
          variants: [{ catalog_sku: "SKU", instock: stock }],
        },
      ]),
  });
it("preserves unknown stock rather than reporting a positive observation", async () => {
  const source = catalog(undefined);
  const page = await source.listProducts();
  expect(page.items[0]!.variants[0]!.metadata.supplierStock).toMatchObject({
    available: null,
    observedAt: null,
    sourceId: "customcat",
    supplierSku: "SKU",
  });
  await expect(source.getInventory!(["SKU"])).rejects.toThrow(
    "no stock observation",
  );
});
it("timestamps successful boolean stock observations", async () => {
  const source = catalog(false);
  const page = await source.listProducts();
  const stock = page.items[0]!.variants[0]!.metadata.supplierStock as {
    observedAt: string;
    available: boolean;
  };
  expect(stock.available).toBe(false);
  expect(Number.isFinite(Date.parse(stock.observedAt))).toBe(true);
  expect((await source.getInventory!(["SKU"]))[0]).toMatchObject({
    available: false,
    sku: "SKU",
  });
});
it("fetches all product variants with one request and excludes unknown observations", async () => {
  let count = 0;
  const provider = createCustomCatCatalog({
    apiKey: "fixture",
    fetch: async (input) => {
      count++;
      expect(new URL(String(input)).pathname).toEndWith("/catalog/123");
      return Response.json([
        {
          catalog_product_id: 123,
          title: "Tee",
          variants: [
            { catalog_sku: "S", instock: 1 },
            { catalog_sku: "M", instock: 0 },
            { catalog_sku: "L" },
          ],
        },
      ]);
    },
  });
  expect(await provider.getProductInventory!("123")).toEqual([
    expect.objectContaining({ sku: "S", available: true }),
    expect.objectContaining({ sku: "M", available: false }),
  ]);
  expect(count).toBe(1);
});
