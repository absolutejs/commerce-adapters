import type { EmailMessage, EmailProvider } from '@absolutejs/commerce';
import { Resend } from 'resend';

export type ResendConfig = {
	apiKey: string;
	/** Verified-domain sender, e.g. "The Embroidery Place <hi@shop.com>". */
	from: string;
};

/**
 * Build an `EmailProvider` backed by Resend. Sends are best-effort: failures are
 * logged, never thrown, so a flaky mail provider can't break fulfilment.
 */
export const createResendEmailProvider = (
	config: ResendConfig
): EmailProvider => {
	const resend = new Resend(config.apiKey);

	return {
		async send({ to, subject, html }: EmailMessage) {
			if (!to) return;
			try {
				const { error } = await resend.emails.send({
					from: config.from,
					html,
					subject,
					to
				});
				if (error) console.error('Resend send error:', error);
			} catch (error) {
				console.error('Resend threw:', error);
			}
		}
	};
};
