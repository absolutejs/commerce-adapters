import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
	createWishesPayment,
	parseWishesTransactionResponse,
	verifyWishesWebhook
} from './index';

describe('Wishes payments', () => {
	test('submits only a single-use token and normalized amount', async () => {
		let body = '';
		const payment = createWishesPayment({
			privateKey: 'sk_test',
			publicKey: 'pk_test',
			fetch: async (_input, init) => {
				body = String(init?.body);

				return new Response(
					'response=1&responsetext=SUCCESS&transactionid=123&orderid=checkout-1'
				);
			}
		});
		const transaction = await payment.createTokenizedCheckout({
			amountCents: 1099,
			idempotencyKey: 'checkout-1',
			lineItems: [],
			paymentToken: 'single-use-token',
			totals: {
				discountCents: 0,
				shippingCents: 100,
				subtotalCents: 1099,
				taxCents: 82
			}
		});
		const sent = new URLSearchParams(body);
		expect(sent.get('amount')).toBe('10.99');
		expect(sent.get('payment_token')).toBe('single-use-token');
		expect(sent.get('shipping')).toBe('1.00');
		expect(sent.get('tax')).toBe('0.82');
		expect(sent.has('ccnumber')).toBe(false);
		expect(transaction.id).toBe('123');
	});

	test('parses declines without treating them as success', () => {
		expect(
			parseWishesTransactionResponse(
				'response=2&responsetext=DECLINED&response_code=200'
			)
		).toEqual(
			expect.objectContaining({
				responseText: 'DECLINED',
				succeeded: false
			})
		);
	});

	test('verifies signed webhook payloads', () => {
		const payload = '{"event_id":"event-1"}';
		const timestamp = '1725148800';
		const signature = createHmac('sha256', 'webhook-secret')
			.update(`${timestamp}.${payload}`)
			.digest('hex');
		expect(
			verifyWishesWebhook(
				payload,
				`t=${timestamp},s=${signature}`,
				'webhook-secret'
			)
		).toBe(true);
	});
});
