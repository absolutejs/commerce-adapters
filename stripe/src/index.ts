import type {
  Address,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCouponInput,
  PaymentProvider,
  WebhookEvent,
} from "@absolutejs/commerce";
import Stripe from "stripe";

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
};

const LINE_ITEM_LIMIT = 100;

const isTaxError = (error: unknown) =>
  error instanceof Error && /tax/i.test(error.message);

const toAddress = (
  details: Stripe.Checkout.Session["customer_details"],
): Address | null => {
  if (!details) return null;
  const addr = details.address;

  return {
    city: addr?.city ?? "",
    country: addr?.country ?? "US",
    email: details.email ?? null,
    name: details.name ?? "",
    state: addr?.state ?? "",
    street1: addr?.line1 ?? "",
    street2: addr?.line2 ?? null,
    zip: addr?.postal_code ?? "",
  };
};

/** Build a `PaymentProvider` backed by Stripe (stripe-node, Basil API). */
export const createStripePayment = (config: StripeConfig): PaymentProvider => {
  const stripe = new Stripe(config.secretKey);

  const normalizeSession = async (
    session: Stripe.Checkout.Session,
  ): Promise<CheckoutSession> => {
    let lineItems: CheckoutSession["lineItems"] = [];
    try {
      const items = await stripe.checkout.sessions.listLineItems(session.id, {
        limit: LINE_ITEM_LIMIT,
      });
      lineItems = items.data.map((line) => ({
        amountTotalCents: line.amount_total ?? 0,
        name: line.description ?? "Item",
        quantity: line.quantity ?? 1,
      }));
    } catch (error) {
      console.error("Stripe listLineItems failed:", error);
    }

    const details = session.customer_details;

    return {
      amountTotalCents: session.amount_total,
      currency: session.currency,
      customerEmail: details?.email ?? null,
      customerName: details?.name ?? null,
      id: session.id,
      lineItems,
      metadata: (session.metadata ?? {}) as Record<string, string>,
      paymentStatus: session.payment_status ?? null,
      shippingAddress: toAddress(details),
      status: session.status ?? null,
    };
  };

  const createCheckout = async (input: CreateCheckoutInput) => {
    const currency = input.currency ?? "usd";
    const subscription = input.mode === "subscription";
    const recurring = subscription
      ? {
          recurring: {
            interval: input.recurringInterval ?? "month",
          },
        }
      : {};
    const lineItems = input.lineItems.map((line) => ({
      price_data: {
        currency,
        product_data: {
          description: line.description,
          name: line.name,
        },
        tax_behavior: line.taxBehavior,
        unit_amount: line.amountCents,
        ...recurring,
      },
      quantity: line.quantity,
    }));

    const shippingParams: Stripe.Checkout.SessionCreateParams =
      input.shipping?.mode === "collect"
        ? {
            shipping_address_collection: {
              allowed_countries: input.shipping
                .countries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection["allowed_countries"],
            },
            ...(input.shipping.flatAmountCents !== undefined
              ? {
                  shipping_options: [
                    {
                      shipping_rate_data: {
                        display_name: input.shipping.label ?? "Shipping",
                        fixed_amount: {
                          amount: input.shipping.flatAmountCents,
                          currency,
                        },
                        tax_behavior: "exclusive",
                        type: "fixed_amount",
                      },
                    },
                  ],
                }
              : {}),
          }
        : {};

    const uiParams: Stripe.Checkout.SessionCreateParams =
      input.uiMode === "embedded"
        ? { return_url: input.returnUrl, ui_mode: "embedded_page" }
        : { cancel_url: input.cancelUrl, success_url: input.successUrl };

    const params: Stripe.Checkout.SessionCreateParams = {
      line_items: lineItems,
      metadata: input.metadata,
      mode: subscription ? "subscription" : "payment",
      ...(input.couponId ? { discounts: [{ coupon: input.couponId }] } : {}),
      ...(subscription ? {} : shippingParams),
      ...uiParams,
    };

    const create = (withTax: boolean) =>
      stripe.checkout.sessions.create(
        input.automaticTax
          ? { ...params, automatic_tax: { enabled: withTax } }
          : params,
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      );

    let session: Stripe.Checkout.Session;
    try {
      session = await create(Boolean(input.automaticTax));
    } catch (error) {
      if (!input.automaticTax || !isTaxError(error)) throw error;
      session = await create(false);
    }

    return {
      clientSecret: session.client_secret,
      id: session.id,
      url: session.url,
    };
  };

  return {
    createCheckout,
    async createCoupon(input: CreateCouponInput) {
      const coupon = await stripe.coupons.create(
        input.percentOff
          ? { duration: "once", percent_off: input.percentOff }
          : {
              amount_off: input.amountOffCents ?? 0,
              currency: input.currency ?? "usd",
              duration: "once",
            },
      );

      return coupon.id;
    },
    async retrieveCheckout(sessionId: string) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      return normalizeSession(session);
    },
    async refundBySession(sessionId: string) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const intent =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null);
      if (intent) await stripe.refunds.create({ payment_intent: intent });
    },
    async verifyWebhook(
      payload: string,
      signature: string,
    ): Promise<WebhookEvent> {
      const event = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        config.webhookSecret,
      );
      const session = event.data.object as Stripe.Checkout.Session;

      return {
        id: event.id,
        isComplete:
          event.type === "checkout.session.completed" ||
          event.type === "checkout.session.async_payment_succeeded",
        isFailed:
          event.type === "checkout.session.async_payment_failed" ||
          event.type === "checkout.session.expired",
        session: await normalizeSession(session),
        type: event.type,
      };
    },
  };
};
