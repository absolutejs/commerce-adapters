import { expect, test } from "bun:test";
import { createStrictResendSender } from "./strict";
import type { Resend } from "resend";
test("strict delivery surfaces provider failure and preserves idempotency", async () => {
  const seen: unknown[] = [];
  const client = {
    emails: {
      send: async (...args: unknown[]) => {
        seen.push(args);
        return { data: null, error: { message: "Unavailable" } };
      },
    },
  } as unknown as Pick<Resend, "emails">;
  const send = createStrictResendSender({
    apiKey: "test",
    from: "from@example.com",
    client,
  });
  await expect(
    send({
      to: "to@example.com",
      subject: "Test",
      html: "Test",
      idempotencyKey: "stable-1",
    }),
  ).rejects.toThrow();
  expect((seen[0] as unknown[])[1]).toEqual({ idempotencyKey: "stable-1" });
});
