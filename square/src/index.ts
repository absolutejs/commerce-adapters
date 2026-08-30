// Square Terminal as a `TerminalProvider`.
//
// This is the counter, not the website: the shop rings a sale up, sends the
// amount to a Square Terminal sitting on the counter, and the customer taps
// their card on the shop's own hardware. Square drives the screen; we start
// the checkout, watch it, and can cancel it.
//
// Deliberately no SDK. Four REST calls and an HMAC is the whole surface, and
// `fetch` is injectable so the behaviour is testable without a network.

import type {
  StartTerminalCheckoutInput,
  TerminalCheckout,
  TerminalCheckoutStatus,
  TerminalDevice,
  TerminalProvider,
  TerminalWebhookEvent,
} from "@absolutejs/commerce";

export type SquareConfig = {
  accessToken: string;
  /** "production" talks to connect.squareup.com, "sandbox" to the sandbox. */
  environment?: "production" | "sandbox";
  /** Signature key from the webhook subscription; without it webhooks are
   *  refused rather than trusted. */
  webhookSignatureKey?: string;
  /** The URL Square posts to. Square signs it together with the body, so a
   *  mismatch here reads as a forged request. */
  webhookUrl?: string;
  /** Square API version to pin. Square dates its API; pinning keeps a
   *  response shape from changing under a running shop. */
  apiVersion?: string;
  /** Talk to something other than Square itself — a proxy the shop's network
   *  requires, or a stand-in while a host is being built. Overrides
   *  `environment`. */
  baseUrl?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
};

const HOSTS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
};

const DEFAULT_API_VERSION = "2025-01-23";
const DEFAULT_CURRENCY = "USD";

type SquareMoney = { amount?: number; currency?: string };
type SquareCheckout = {
  id?: string;
  amount_money?: SquareMoney;
  cancel_reason?: string;
  device_options?: { device_id?: string };
  note?: string;
  payment_ids?: string[];
  reference_id?: string;
  status?: string;
};
type SquareDevice = {
  id?: string;
  attributes?: { name?: string; model?: string; manufacturer?: string };
  status?: { category?: string };
};
type SquarePayment = {
  card_details?: { card?: { card_brand?: string; last_4?: string } };
};
type SquareError = { detail?: string; code?: string };

/** Square's own words for where a checkout is, in the contract's words.
 *  CANCEL_REQUESTED is still on the device, so it reads as in progress. */
const STATUS: Record<string, TerminalCheckoutStatus> = {
  CANCEL_REQUESTED: "in-progress",
  CANCELED: "canceled",
  COMPLETED: "completed",
  IN_PROGRESS: "in-progress",
  PENDING: "pending",
};

/** A cancel with a reason that is not "someone pressed cancel" is a failure —
 *  the customer walked away, the card was declined, the device timed out. */
const FAILURE_REASONS = new Set([
  "SELLER_CANCELED",
  "TIMED_OUT",
  "BUYER_CANCELED",
]);

const deviceStatus = (category: string | undefined) => {
  if (category === "AVAILABLE") return "online" as const;
  if (category === "UNAVAILABLE" || category === "NEEDS_ATTENTION")
    return "offline" as const;

  return "unknown" as const;
};

const toCheckout = (
  raw: SquareCheckout,
  card?: { brand: string | null; last4: string | null },
): TerminalCheckout => {
  const status = STATUS[raw.status ?? ""] ?? "pending";
  const reason = raw.cancel_reason ?? null;

  return {
    amountCents: raw.amount_money?.amount ?? 0,
    cardBrand: card?.brand ?? null,
    currency: raw.amount_money?.currency ?? DEFAULT_CURRENCY,
    deviceId: raw.device_options?.device_id ?? "",
    id: raw.id ?? "",
    last4: card?.last4 ?? null,
    paymentId: raw.payment_ids?.[0] ?? null,
    reason,
    reference: raw.reference_id ?? null,
    status:
      status === "canceled" && reason && FAILURE_REASONS.has(reason)
        ? "failed"
        : status,
  };
};

/**
 * A `TerminalProvider` backed by Square Terminal. Needs an access token with
 * the PAYMENTS_WRITE and DEVICE_CREDENTIAL_MANAGEMENT scopes, and a Terminal
 * already paired to the seller account — pairing happens on the device, not
 * here.
 */
export const createSquareTerminal = (
  config: SquareConfig,
): TerminalProvider => {
  const host = (
    config.baseUrl ?? HOSTS[config.environment ?? "production"]
  ).replace(/\/$/u, "");
  const call = config.fetchImpl ?? fetch;
  const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;

  const request = async <T>(
    path: string,
    init?: { body?: unknown; method?: string },
  ): Promise<T> => {
    const response = await call(`${host}${path}`, {
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
        "Square-Version": apiVersion,
      },
      method: init?.method ?? "GET",
    });
    const payload = (await response.json().catch(() => ({}))) as {
      errors?: SquareError[];
    } & T;
    if (!response.ok) {
      const first = payload.errors?.[0];

      throw new Error(
        first?.detail ?? `Square request failed (${response.status})`,
      );
    }

    return payload;
  };

  /** Card brand and last four for a receipt. Best effort: a completed sale is
   *  a completed sale whether or not this call answers. */
  const cardOf = async (paymentId: string | null) => {
    if (!paymentId) return undefined;
    try {
      const { payment } = await request<{ payment?: SquarePayment }>(
        `/v2/payments/${encodeURIComponent(paymentId)}`,
      );
      const card = payment?.card_details?.card;

      return {
        brand: card?.card_brand ?? null,
        last4: card?.last_4 ?? null,
      };
    } catch {
      return undefined;
    }
  };

  const readCheckout = async (raw: SquareCheckout) =>
    toCheckout(
      raw,
      raw.status === "COMPLETED"
        ? await cardOf(raw.payment_ids?.[0] ?? null)
        : undefined,
    );

  return {
    async cancelCheckout(checkoutId) {
      const { checkout } = await request<{ checkout?: SquareCheckout }>(
        `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}/cancel`,
        { method: "POST" },
      );

      return toCheckout(checkout ?? {});
    },
    async getCheckout(checkoutId) {
      const { checkout } = await request<{ checkout?: SquareCheckout }>(
        `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}`,
      );

      return readCheckout(checkout ?? {});
    },
    id: "square",
    async listDevices() {
      const { devices } = await request<{ devices?: SquareDevice[] }>(
        "/v2/devices",
      );

      return (devices ?? [])
        .filter((device) => Boolean(device.id))
        .map((device) => ({
          id: device.id ?? "",
          name:
            device.attributes?.name ??
            [device.attributes?.manufacturer, device.attributes?.model]
              .filter(Boolean)
              .join(" ") ??
            "Terminal",
          status: deviceStatus(device.status?.category),
        })) satisfies TerminalDevice[];
    },
    async startCheckout(input: StartTerminalCheckoutInput) {
      const { checkout } = await request<{ checkout?: SquareCheckout }>(
        "/v2/terminals/checkouts",
        {
          body: {
            checkout: {
              amount_money: {
                amount: Math.max(1, Math.round(input.amountCents)),
                currency: input.currency ?? DEFAULT_CURRENCY,
              },
              device_options: { device_id: input.deviceId },
              ...(input.note ? { note: input.note.slice(0, 500) } : {}),
              ...(input.reference
                ? { reference_id: input.reference.slice(0, 40) }
                : {}),
            },
            idempotency_key: input.idempotencyKey,
          },
          method: "POST",
        },
      );

      return toCheckout(checkout ?? {});
    },
    async verifyWebhook(payload, signature, url) {
      const key = config.webhookSignatureKey;
      const endpoint = url ?? config.webhookUrl;
      if (!key || !endpoint)
        throw new Error("Square webhook signature key and URL are required");
      const expected = await hmacBase64(key, `${endpoint}${payload}`);
      if (!timingSafeEqual(expected, signature))
        throw new Error("Square webhook signature did not match");
      const event = JSON.parse(payload) as {
        data?: { object?: { checkout?: SquareCheckout } };
        type?: string;
      };
      const raw = event.data?.object?.checkout;

      return {
        checkout: raw ? await readCheckout(raw) : null,
        type: event.type ?? "",
      } satisfies TerminalWebhookEvent;
    },
  };
};

/** Square signs the notification URL followed by the raw body. */
const hmacBase64 = async (secret: string, message: string) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

  return btoa(String.fromCharCode(...new Uint8Array(signed)));
};

/** Constant-time compare, so a wrong signature cannot be guessed a byte at a
 *  time by watching how long the answer takes. */
const timingSafeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let same = 0;
  for (let index = 0; index < left.length; index += 1)
    same |= left.charCodeAt(index) ^ right.charCodeAt(index);

  return same === 0;
};
