import { describe, expect, mock, test } from "bun:test";

const calls: Array<{ input: unknown; operation: string }> = [];

mock.module("@easypost/api", () => ({
  default: class {
    readonly Shipment = {
      buy: async (shipmentId: string, rate: { id: string }) => {
        calls.push({
          input: { rateId: rate.id, shipmentId },
          operation: "buy",
        });

        return {
          id: shipmentId,
          postage_label: { label_url: "https://labels.example/label.pdf" },
          selected_rate: {
            carrier: "USPS",
            currency: "USD",
            delivery_days: 3,
            id: rate.id,
            rate: "7.25",
            service: "GroundAdvantage",
          },
          tracker: { public_url: "https://track.example/tracker" },
          tracking_code: "TRACK123",
        };
      },
      create: async (input: unknown) => {
        calls.push({ input, operation: "create" });

        return {
          id: "shipment-1",
          rates: [
            {
              carrier: "UPS",
              currency: "USD",
              delivery_days: 2,
              id: "expensive",
              rate: "12.00",
              service: "Ground",
            },
            {
              carrier: "USPS",
              currency: "USD",
              delivery_days: 3,
              id: "cheapest",
              rate: "7.25",
              service: "GroundAdvantage",
            },
          ],
        };
      },
      retrieve: async () => ({
        id: "shipment-1",
        rates: [],
      }),
    };

    readonly Tracker = {
      create: async (input: unknown) => {
        calls.push({ input, operation: "track" });

        return {
          est_delivery_date: "2026-07-30",
          public_url: "https://track.example/tracker",
          status: "in_transit",
        };
      },
    };
  },
}));

const { createEasyPostProvider } = await import("./index");

const address = {
  city: "New York",
  country: "US",
  name: "Ada Lovelace",
  state: "NY",
  street1: "1 Example Street",
  zip: "10001",
};

describe("EasyPost shipping provider", () => {
  test("maps rates and buys the actual cheapest provider rate", async () => {
    calls.length = 0;
    const provider = createEasyPostProvider({ apiKey: "test-key" });
    const input = {
      from: address,
      parcel: {
        heightIn: 2,
        lengthIn: 10,
        weightOz: 16,
        widthIn: 8,
      },
      to: address,
    };

    await expect(provider.rates(input)).resolves.toEqual([
      expect.objectContaining({ amount: 12, id: "expensive" }),
      expect.objectContaining({ amount: 7.25, id: "cheapest" }),
    ]);
    await expect(provider.buyCheapestLabel(input)).resolves.toEqual(
      expect.objectContaining({
        amount: 7.25,
        rateId: "cheapest",
        trackingNumber: "TRACK123",
      }),
    );
    expect(calls.find((call) => call.operation === "buy")?.input).toEqual({
      rateId: "cheapest",
      shipmentId: "shipment-1",
    });
  });

  test("normalizes tracker posture", async () => {
    const provider = createEasyPostProvider({ apiKey: "test-key" });

    await expect(provider.track("TRACK123", "USPS")).resolves.toEqual({
      estDelivery: "2026-07-30",
      status: "in_transit",
      trackingUrl: "https://track.example/tracker",
    });
  });
});
