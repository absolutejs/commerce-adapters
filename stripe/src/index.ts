import type {
  Address,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCouponInput,
  PaymentDispute,
  PaymentDisputeEvidenceFile,
  PaymentDisputeEvidenceReconciliation,
  PaymentProvider,
  PaymentRefund,
  PaymentWebhookEndpoint,
  PaymentWebhookEndpointManager,
  PaymentWebhookEvent,
  WebhookEvent,
} from "@absolutejs/commerce";
import Stripe from "stripe";

export type StripeConfig = {
  onWebhookSecretVerified?: (index: number) => Promise<void> | void;
  secretKey: string;
  webhookSecret?: string;
  webhookSecrets?: readonly string[];
};

const stripeWebhookSecrets = (config: StripeConfig) => {
  const secrets = [
    ...(config.webhookSecrets ?? []),
    ...(config.webhookSecret ? [config.webhookSecret] : []),
  ].filter((secret, index, all) => secret && all.indexOf(secret) === index);
  if (secrets.length === 0)
    throw new Error("Stripe requires at least one webhook signing secret");

  return secrets;
};

const constructStripeWebhookEvent = async (
  payload: string,
  signature: string,
  secrets: readonly string[],
  onVerified?: (index: number) => Promise<void> | void,
) => {
  let lastError: unknown;
  for (const [index, secret] of secrets.entries()) {
    try {
      const event = await Stripe.webhooks.constructEventAsync(
        payload,
        signature,
        secret,
      );
      await onVerified?.(index);

      return event;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Stripe webhook signature verification failed");
};

export const verifyStripeWebhookSigningSecret = async (secret: string) => {
  const payload = JSON.stringify({
    data: { object: {} },
    id: "evt_absolutejs_signing_secret_canary",
    object: "event",
    type: "absolutejs.signing_secret.canary",
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
  });
  await Stripe.webhooks.constructEventAsync(payload, signature, secret);

  return true;
};

const stripeWebhookEndpoint = (
  endpoint: Stripe.WebhookEndpoint,
): PaymentWebhookEndpoint => {
  if (endpoint.status !== "disabled" && endpoint.status !== "enabled")
    throw new Error(`Unsupported Stripe webhook status: ${endpoint.status}`);

  return {
    enabledEvents: [...endpoint.enabled_events],
    id: endpoint.id,
    livemode: endpoint.livemode,
    status: endpoint.status,
    url: endpoint.url,
  };
};

export const createStripeWebhookEndpointManager = (config: {
  secretKey: string;
}): PaymentWebhookEndpointManager => {
  const stripe = new Stripe(config.secretKey);

  return {
    async create(input) {
      const created = await stripe.webhookEndpoints.create({
        enabled_events:
          input.enabledEvents as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
        url: input.url,
      });
      if (!created.secret)
        throw new Error("Stripe did not return the new webhook signing secret");
      const endpoint = input.disabled
        ? await stripe.webhookEndpoints.update(created.id, { disabled: true })
        : created;

      return {
        ...stripeWebhookEndpoint(endpoint),
        signingSecret: created.secret,
      };
    },
    async delete(endpointId) {
      await stripe.webhookEndpoints.del(endpointId);
    },
    async retrieve(endpointId) {
      return stripeWebhookEndpoint(
        await stripe.webhookEndpoints.retrieve(endpointId),
      );
    },
    async update(endpointId, input) {
      return stripeWebhookEndpoint(
        await stripe.webhookEndpoints.update(endpointId, {
          disabled: input.disabled,
          enabled_events: input.enabledEvents as
            Stripe.WebhookEndpointUpdateParams.EnabledEvent[] | undefined,
          url: input.url,
        }),
      );
    },
  };
};

const LINE_ITEM_LIMIT = 100;
const STRIPE_DISPUTE_EVIDENCE_MAX_BYTES = 4_500_000;
const STRIPE_DISPUTE_EVIDENCE_MAX_TEXT_LENGTH = 150_000;
const STRIPE_DISPUTE_EVIDENCE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const validateDisputeFiles = (files: PaymentDisputeEvidenceFile[]) => {
  if (
    files.reduce((total, file) => total + file.bytes.length, 0) >
    STRIPE_DISPUTE_EVIDENCE_MAX_BYTES
  )
    throw new Error(
      "Stripe dispute evidence exceeds the 4.5 MB combined limit",
    );
  const unsupported = files.find(
    ({ contentType }) => !STRIPE_DISPUTE_EVIDENCE_TYPES.has(contentType),
  );
  if (unsupported)
    throw new Error(
      `Stripe dispute evidence does not support ${unsupported.contentType}`,
    );
};

const validateDisputeText = (
  evidence: Parameters<
    NonNullable<PaymentProvider["submitDisputeEvidence"]>
  >[0]["evidence"],
) => {
  const length = Object.values(evidence).reduce(
    (total, value) => total + (value?.length ?? 0),
    0,
  );
  if (length > STRIPE_DISPUTE_EVIDENCE_MAX_TEXT_LENGTH)
    throw new Error(
      "Stripe dispute evidence exceeds the 150,000-character combined text limit",
    );
};

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

export const stripeDisputeEvidenceReconciliation = (
  dispute: {
    evidence: object;
    evidence_details: { has_evidence: boolean; submission_count: number };
    status: string;
  },
  input: Parameters<
    NonNullable<PaymentProvider["reconcileDisputeEvidence"]>
  >[0],
) => {
  const expectedText = disputeTextEvidence(input.evidence);
  const mismatches: PaymentDisputeEvidenceReconciliation["diagnostics"]["mismatches"] =
    [];
  for (const [field, value] of Object.entries(expectedText)) {
    if (value === undefined) continue;
    const observed: unknown = Reflect.get(dispute.evidence, field);
    if (observed !== value)
      mismatches.push({
        field,
        reason:
          observed === undefined || observed === null ? "missing" : "different",
        scope: "text",
      });
  }
  const providerFileIds: Record<string, string> = {};
  const purposes = new Set<string>();
  for (const file of input.files) {
    if (purposes.has(file.purpose))
      throw new Error(
        `Stripe accepts one dispute evidence file for ${file.purpose}`,
      );
    purposes.add(file.purpose);
    const providerFile: unknown = Reflect.get(dispute.evidence, file.purpose);
    const providerFileId =
      typeof providerFile === "string"
        ? providerFile
        : providerFile &&
            typeof providerFile === "object" &&
            "id" in providerFile &&
            typeof providerFile.id === "string"
          ? providerFile.id
          : undefined;
    if (!providerFileId)
      mismatches.push({
        field: file.purpose,
        reason: "missing",
        scope: "file",
      });
    else providerFileIds[file.id] = providerFileId;
  }
  const submissionCount = dispute.evidence_details.submission_count;

  return {
    applied: dispute.evidence_details.has_evidence && mismatches.length === 0,
    diagnostics: {
      hasEvidence: dispute.evidence_details.has_evidence,
      mismatches,
    },
    providerFileIds,
    providerStatus: dispute.status,
    submissionCount,
    submitted: submissionCount > 0,
  };
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
  const webhookSecrets = stripeWebhookSecrets(config);

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
    const event = await constructStripeWebhookEvent(
      payload,
      signature,
      webhookSecrets,
      config.onWebhookSecretVerified,
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
    async reconcileDisputeEvidence(input) {
      return stripeDisputeEvidenceReconciliation(
        await stripe.disputes.retrieve(input.providerDisputeId),
        input,
      );
    },
    async submitDisputeEvidence(input) {
      validateDisputeFiles(input.files);
      validateDisputeText(input.evidence);
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
