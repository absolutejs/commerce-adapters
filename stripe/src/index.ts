import type {
  Address,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCouponInput,
  PaymentDispute,
  PaymentDisputeEvidenceFile,
  PaymentProvider,
  PaymentRefund,
  PaymentWebhookEvent,
  WebhookEvent,
} from "@absolutejs/commerce";
import Stripe from "stripe";

export type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
};

const LINE_ITEM_LIMIT = 100;

const disputeTextEvidence = (
  evidence: Parameters<
    NonNullable<PaymentProvider["submitDisputeEvidence"]>
  >[0]["evidence"],
): Stripe.DisputeUpdateParams.Evidence => ({
  access_activity_log: evidence.accessActivityLog,
  billing_address: evidence.billingAddress,
  cancellation_policy_disclosure: evidence.cancellationPolicyDisclosure,
  cancellation_rebuttal: evidence.cancellationRebuttal,
  customer_email_address: evidence.customerEmailAddress,
  customer_name: evidence.customerName,
  customer_purchase_ip: evidence.customerPurchaseIp,
  duplicate_charge_explanation: evidence.duplicateChargeExplanation,
  duplicate_charge_id: evidence.duplicateChargeId,
  product_description: evidence.productDescription,
  refund_policy_disclosure: evidence.refundPolicyDisclosure,
  refund_refusal_explanation: evidence.refundRefusalExplanation,
  service_date: evidence.serviceDate,
  shipping_address: evidence.shippingAddress,
  shipping_carrier: evidence.shippingCarrier,
  shipping_date: evidence.shippingDate,
  shipping_tracking_number: evidence.shippingTrackingNumber,
  uncategorized_text: evidence.uncategorizedText,
});

const disputeFileEvidence = (
  files: PaymentDisputeEvidenceFile[],
  providerFileIds: Record<string, string>,
): Stripe.DisputeUpdateParams.Evidence => {
  const evidence: Stripe.DisputeUpdateParams.Evidence = {};
  const purposes = new Set<string>();
  for (const file of files) {
    if (purposes.has(file.purpose))
      throw new Error(
        `Stripe accepts one dispute evidence file for ${file.purpose}`,
      );
    purposes.add(file.purpose);
    evidence[file.purpose] = providerFileIds[file.id];
  }

  return evidence;
};

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
      paymentReferenceId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
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
      ...(subscription
        ? {}
        : { payment_intent_data: { metadata: input.metadata } }),
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

  const normalizeRefund = (refund: Stripe.Refund): PaymentRefund => ({
    providerRefundId: refund.id,
    status:
      refund.status === "succeeded"
        ? "succeeded"
        : refund.status === "failed" || refund.status === "canceled"
          ? "failed"
          : "pending",
  });

  const normalizeDispute = async (
    dispute: Stripe.Dispute,
  ): Promise<PaymentDispute> => {
    let paymentReferenceId =
      typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : (dispute.payment_intent?.id ?? null);
    if (!paymentReferenceId) {
      const chargeId =
        typeof dispute.charge === "string"
          ? dispute.charge
          : dispute.charge?.id;
      if (chargeId) {
        const charge = await stripe.charges.retrieve(chargeId);
        paymentReferenceId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null);
      }
    }
    if (!paymentReferenceId)
      throw new Error("Stripe dispute has no payment intent identity");

    return {
      amountCents: dispute.amount,
      currency: dispute.currency.toUpperCase(),
      evidenceDueAt: dispute.evidence_details.due_by
        ? new Date(dispute.evidence_details.due_by * 1_000)
        : null,
      providerDisputeId: dispute.id,
      providerPaymentId: paymentReferenceId,
      reason: dispute.reason,
      status: dispute.status,
    };
  };

  const verifyEvent = async (
    payload: string,
    signature: string,
  ): Promise<PaymentWebhookEvent> => {
    const event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      config.webhookSecret,
    );
    if (event.type.startsWith("charge.dispute."))
      return {
        dispute: await normalizeDispute(event.data.object as Stripe.Dispute),
        id: event.id,
        kind: "dispute",
        type: event.type,
      };
    const session = event.data.object as Stripe.Checkout.Session;

    return {
      checkout: {
        id: event.id,
        isComplete:
          event.type === "checkout.session.completed" ||
          event.type === "checkout.session.async_payment_succeeded",
        isFailed:
          event.type === "checkout.session.async_payment_failed" ||
          event.type === "checkout.session.expired",
        session: await normalizeSession(session),
        type: event.type,
      },
      kind: "checkout",
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
    async refundBySession(sessionId: string, idempotencyKey: string) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const intent =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null);
      if (!intent)
        throw new Error("Stripe Checkout session has no payment intent");
      const refund = await stripe.refunds.create(
        { payment_intent: intent },
        { idempotencyKey },
      );

      return normalizeRefund(refund);
    },
    async retrieveRefund(providerRefundId: string) {
      return normalizeRefund(await stripe.refunds.retrieve(providerRefundId));
    },
    async submitDisputeEvidence(input) {
      const providerFileIds: Record<string, string> = {};
      for (const file of input.files) {
        const uploaded = await stripe.files.create(
          {
            file: {
              data: file.bytes,
              name: file.name,
              type: file.contentType,
            },
            purpose: "dispute_evidence",
          },
          { idempotencyKey: `${input.idempotencyKey}:file:${file.id}` },
        );
        providerFileIds[file.id] = uploaded.id;
      }
      const dispute = await stripe.disputes.update(
        input.providerDisputeId,
        {
          evidence: {
            ...disputeTextEvidence(input.evidence),
            ...disputeFileEvidence(input.files, providerFileIds),
          },
          submit: input.submit,
        },
        { idempotencyKey: `${input.idempotencyKey}:dispute` },
      );

      return {
        providerFileIds,
        providerStatus: dispute.status,
        submissionCount: dispute.evidence_details.submission_count,
        submitted: input.submit,
      };
    },
    verifyEvent,
    async verifyWebhook(
      payload: string,
      signature: string,
    ): Promise<WebhookEvent> {
      const event = await verifyEvent(payload, signature);
      if (event.kind !== "checkout")
        throw new Error("Stripe event is not a Checkout lifecycle event");

      return event.checkout;
    },
  };
};
