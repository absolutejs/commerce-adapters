import { describe, expect, test } from "bun:test";
import { createStripePayment } from "./index";

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
});
