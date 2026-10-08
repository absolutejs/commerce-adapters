import { Resend } from "resend";

export type ResendStrictMessage = {
  to: string;
  subject: string;
  html: string;
  idempotencyKey: string;
};
/** Durable outboxes must observe failures and reuse the same key within Resend's 24-hour window. */
export const createStrictResendSender = (config: {
  apiKey: string;
  from: string;
  client?: Pick<Resend, "emails">;
}) => {
  const client = config.client ?? new Resend(config.apiKey);
  return async (message: ResendStrictMessage): Promise<{ id: string }> => {
    if (!message.to || !message.idempotencyKey)
      throw new Error("Recipient and idempotency key are required");
    const { data, error } = await client.emails.send(
      {
        from: config.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
      },
      { idempotencyKey: message.idempotencyKey },
    );
    if (error || !data?.id)
      throw new Error("Email provider did not confirm delivery acceptance");
    return { id: data.id };
  };
};
