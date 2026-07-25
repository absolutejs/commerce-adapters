import { describe, expect, mock, test } from "bun:test";

const sends: unknown[] = [];
let nextError: Error | undefined;

mock.module("resend", () => ({
  Resend: class {
    readonly emails = {
      send: async (input: unknown) => {
        sends.push(input);
        if (nextError !== undefined) {
          const error = nextError;
          nextError = undefined;
          throw error;
        }

        return { data: { id: "email-1" }, error: null };
      },
    };
  },
}));

const { createResendEmailProvider } = await import("./index");

describe("Commerce Resend email provider", () => {
  test("sends the exact composed commerce email", async () => {
    sends.length = 0;
    const provider = createResendEmailProvider({
      apiKey: "test-key",
      from: "Shop <orders@example.com>",
    });

    await provider.send({
      html: "<p>Order ready</p>",
      subject: "Order ready",
      to: "buyer@example.com",
    });

    expect(sends).toEqual([
      {
        from: "Shop <orders@example.com>",
        html: "<p>Order ready</p>",
        subject: "Order ready",
        to: "buyer@example.com",
      },
    ]);
  });

  test("keeps provider failure isolated from fulfillment", async () => {
    const reported: unknown[] = [];
    nextError = new Error("provider unavailable");
    const provider = createResendEmailProvider({
      apiKey: "test-key",
      from: "Shop <orders@example.com>",
      onError: (error) => reported.push(error),
    });

    await expect(
      provider.send({
        html: "<p>Order ready</p>",
        subject: "Order ready",
        to: "buyer@example.com",
      }),
    ).resolves.toBeUndefined();
    expect(reported).toEqual([
      expect.objectContaining({ message: "provider unavailable" }),
    ]);
  });
});
