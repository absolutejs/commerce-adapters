import { describe, expect, test } from "bun:test";
import { createSquareTerminal } from "./index";

const OK = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

type Call = { body: unknown; headers: Record<string, string>; url: string };

const stub = (
  handler: (call: Call) => Response,
): { calls: Call[]; fetchImpl: typeof fetch } => {
  const calls: Call[] = [];

  return {
    calls,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
        url: String(input),
      };
      calls.push(call);

      return handler(call);
    }) as unknown as typeof fetch,
  };
};

const CHECKOUT = {
  amount_money: { amount: 4500, currency: "USD" },
  device_options: { device_id: "device-1" },
  id: "checkout-1",
  reference_id: "walk-in-88",
  status: "PENDING",
};

describe("square terminal", () => {
  test("starts a checkout on the named device, in cents", async () => {
    const { calls, fetchImpl } = stub(() => OK({ checkout: CHECKOUT }));
    const square = createSquareTerminal({
      accessToken: "token",
      environment: "sandbox",
      fetchImpl,
    });
    const checkout = await square.startCheckout({
      amountCents: 4500,
      deviceId: "device-1",
      idempotencyKey: "key-1",
      reference: "walk-in-88",
    });

    expect(calls[0]?.url).toBe(
      "https://connect.squareupsandbox.com/v2/terminals/checkouts",
    );
    const sent = calls[0]?.body as {
      checkout: { amount_money: { amount: number } };
      idempotency_key: string;
    };
    expect(sent.checkout.amount_money.amount).toBe(4500);
    expect(sent.idempotency_key).toBe("key-1");
    expect(checkout).toMatchObject({
      amountCents: 4500,
      deviceId: "device-1",
      id: "checkout-1",
      paymentId: null,
      reference: "walk-in-88",
      status: "pending",
    });
  });

  test("a completed checkout carries the payment and the card on it", async () => {
    const { fetchImpl } = stub((call) =>
      call.url.includes("/v2/payments/")
        ? OK({
            payment: {
              card_details: { card: { card_brand: "VISA", last_4: "4242" } },
            },
          })
        : OK({
            checkout: {
              ...CHECKOUT,
              payment_ids: ["payment-9"],
              status: "COMPLETED",
            },
          }),
    );
    const square = createSquareTerminal({ accessToken: "token", fetchImpl });
    const checkout = await square.getCheckout("checkout-1");

    expect(checkout.status).toBe("completed");
    expect(checkout.paymentId).toBe("payment-9");
    expect(checkout.cardBrand).toBe("VISA");
    expect(checkout.last4).toBe("4242");
  });

  test("a completed sale survives the card lookup failing", async () => {
    const { fetchImpl } = stub((call) =>
      call.url.includes("/v2/payments/")
        ? new Response("nope", { status: 500 })
        : OK({
            checkout: {
              ...CHECKOUT,
              payment_ids: ["payment-9"],
              status: "COMPLETED",
            },
          }),
    );
    const square = createSquareTerminal({ accessToken: "token", fetchImpl });
    const checkout = await square.getCheckout("checkout-1");

    expect(checkout.status).toBe("completed");
    expect(checkout.paymentId).toBe("payment-9");
    expect(checkout.cardBrand).toBeNull();
  });

  test("a timed-out cancel is a failure, a plain cancel is not", async () => {
    const timedOut = createSquareTerminal({
      accessToken: "token",
      fetchImpl: stub(() =>
        OK({
          checkout: {
            ...CHECKOUT,
            cancel_reason: "TIMED_OUT",
            status: "CANCELED",
          },
        }),
      ).fetchImpl,
    });
    expect((await timedOut.getCheckout("checkout-1")).status).toBe("failed");

    const canceled = createSquareTerminal({
      accessToken: "token",
      fetchImpl: stub(() =>
        OK({ checkout: { ...CHECKOUT, status: "CANCELED" } }),
      ).fetchImpl,
    });
    expect((await canceled.getCheckout("checkout-1")).status).toBe("canceled");
  });

  test("devices read as the shop named them, with what they are doing", async () => {
    const { fetchImpl } = stub(() =>
      OK({
        devices: [
          {
            attributes: {
              manufacturer: "Square",
              model: "Terminal",
              name: "Front counter",
            },
            id: "device-1",
            status: { category: "AVAILABLE" },
          },
          {
            attributes: { manufacturer: "Square", model: "Terminal" },
            id: "device-2",
            status: { category: "NEEDS_ATTENTION" },
          },
          { attributes: { name: "no id" }, status: { category: "AVAILABLE" } },
        ],
      }),
    );
    const square = createSquareTerminal({ accessToken: "token", fetchImpl });
    const devices = await square.listDevices();

    expect(devices).toEqual([
      { id: "device-1", name: "Front counter", status: "online" },
      { id: "device-2", name: "Square Terminal", status: "offline" },
    ]);
  });

  test("baseUrl points the same calls somewhere else", async () => {
    const { calls, fetchImpl } = stub(() => OK({ devices: [] }));
    const square = createSquareTerminal({
      accessToken: "token",
      baseUrl: "http://127.0.0.1:8787/",
      fetchImpl,
    });
    await square.listDevices();

    expect(calls[0]?.url).toBe("http://127.0.0.1:8787/v2/devices");
  });

  test("an error from Square is raised in Square's own words", async () => {
    const { fetchImpl } = stub(
      () =>
        new Response(
          JSON.stringify({ errors: [{ detail: "Device is not paired." }] }),
          { status: 400 },
        ),
    );
    const square = createSquareTerminal({ accessToken: "token", fetchImpl });

    await expect(
      square.startCheckout({
        amountCents: 100,
        deviceId: "device-1",
        idempotencyKey: "key",
      }),
    ).rejects.toThrow("Device is not paired.");
  });

  test("a webhook is only trusted when the signature covers URL and body", async () => {
    const url = "https://shop.example.com/api/square/webhook";
    const body = JSON.stringify({
      data: { object: { checkout: { ...CHECKOUT, status: "COMPLETED" } } },
      type: "terminal.checkout.updated",
    });
    const square = createSquareTerminal({
      accessToken: "token",
      fetchImpl: stub(() => OK({ payment: {} })).fetchImpl,
      webhookSignatureKey: "signature-key",
      webhookUrl: url,
    });

    // The real signature, computed the way Square computes it.
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode("signature-key"),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${url}${body}`),
    );
    const signature = btoa(String.fromCharCode(...new Uint8Array(signed)));

    const event = await square.verifyWebhook(body, signature);
    expect(event.type).toBe("terminal.checkout.updated");
    expect(event.checkout?.status).toBe("completed");

    await expect(square.verifyWebhook(body, "not-it")).rejects.toThrow(
      "signature did not match",
    );
  });

  test("without a signature key a webhook is refused, not trusted", async () => {
    const square = createSquareTerminal({ accessToken: "token" });

    await expect(square.verifyWebhook("{}", "sig")).rejects.toThrow(
      "signature key and URL are required",
    );
  });
});
