import { describe, expect, test } from "bun:test";
import {
  createStripePayment,
  stripeDisputeEvidenceReconciliation,
  verifyStripeWebhookSigningSecret,
} from "./index";
import Stripe from "stripe";

describe("Stripe webhook secrets", () => {
  test("verifies a signing secret without a provider request", async () => {
    expect(await verifyStripeWebhookSigningSecret("whsec_canary")).toBe(true);
  });

  test("accepts an overlap secret and reports the matched version", async () => {
    const payload = JSON.stringify({
      data: {
        object: {
          amount: 2_500,
          currency: "usd",
          evidence_details: { due_by: null },
          id: "dp_overlap",
          payment_intent: "pi_overlap",
          reason: "fraudulent",
          status: "needs_response",
        },
      },
      id: "evt_overlap",
      object: "event",
      type: "charge.dispute.created",
    });
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: "whsec_previous",
    });
    let verifiedIndex = -1;
    const payment = createStripePayment({
      onWebhookSecretVerified: (index) => {
        verifiedIndex = index;
      },
      secretKey: "sk_test_network_free",
      webhookSecrets: ["whsec_current", "whsec_previous"],
    });

    const event = await payment.verifyEvent!(payload, signature);

    expect(event.kind).toBe("dispute");
    expect(verifiedIndex).toBe(1);
  });
});

describe("Stripe dispute evidence", () => {
  test("rejects combined text beyond Stripe's limit before a provider request", async () => {
    const payment = createStripePayment({
      secretKey: "sk_test_network_free",
      webhookSecret: "whsec_network_free",
    });

    await expect(
      payment.submitDisputeEvidence!({
        evidence: { uncategorizedText: "x".repeat(150_001) },
        files: [],
        idempotencyKey: "evidence-limit",
        providerDisputeId: "dp_network_free",
        submit: false,
      }),
    ).rejects.toThrow("150,000-character combined text limit");
  });

  test("reconciles matching staged and submitted provider evidence", () => {
    const staged = stripeDisputeEvidenceReconciliation(
      {
        evidence: {
          customer_communication: "file_customer",
          customer_name: "Ada Lovelace",
        },
        evidence_details: { has_evidence: true, submission_count: 0 },
        status: "needs_response",
      },
      {
        evidence: { customerName: "Ada Lovelace" },
        files: [
          { id: "attachment-customer", purpose: "customer_communication" },
        ],
        providerDisputeId: "dp_network_free",
        submit: false,
      },
    );
    const submitted = stripeDisputeEvidenceReconciliation(
      {
        evidence: { customer_name: "Ada Lovelace" },
        evidence_details: { has_evidence: true, submission_count: 1 },
        status: "under_review",
      },
      {
        evidence: { customerName: "Ada Lovelace" },
        files: [],
        providerDisputeId: "dp_network_free",
        submit: true,
      },
    );

    expect(staged).toEqual({
      applied: true,
      diagnostics: { hasEvidence: true, mismatches: [] },
      providerFileIds: { "attachment-customer": "file_customer" },
      providerStatus: "needs_response",
      submissionCount: 0,
      submitted: false,
    });
    expect(submitted.applied).toBe(true);
    expect(submitted.submitted).toBe(true);
  });

  test("does not reconcile mismatched text or missing files", () => {
    const result = stripeDisputeEvidenceReconciliation(
      {
        evidence: { customer_name: "Different customer" },
        evidence_details: { has_evidence: true, submission_count: 0 },
        status: "needs_response",
      },
      {
        evidence: { customerName: "Ada Lovelace" },
        files: [
          { id: "attachment-customer", purpose: "customer_communication" },
        ],
        providerDisputeId: "dp_network_free",
        submit: false,
      },
    );

    expect(result.applied).toBe(false);
    expect(result.diagnostics).toEqual({
      hasEvidence: true,
      mismatches: [
        { field: "customer_name", reason: "different", scope: "text" },
        {
          field: "customer_communication",
          reason: "missing",
          scope: "file",
        },
      ],
    });
  });
});
