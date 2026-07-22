import { describe, expect, it } from 'bun:test';
import type { FulfillmentOrderRequest } from '@absolutejs/commerce';
import { createCustomCatFulfillment, validateCustomCatOrder } from './index';

const order: FulfillmentOrderRequest = {
	externalOrderId: 'ORDER-1',
	lines: [
		{
			artwork: [
				{ placement: 'front', url: 'https://cdn.test/front.png' },
				{ placement: 'back', url: 'https://cdn.test/back.jpg' }
			],
			id: 'line-1',
			providerId: 'customcat',
			providerSku: '48146',
			quantity: 2,
			variantId: 'customcat:48146'
		}
	],
	recipient: {
		address1: '1300 Rosa Parks Blvd',
		city: 'Detroit',
		country: 'US',
		email: 'customer@example.com',
		firstName: 'Joe',
		lastName: 'Testing',
		postalCode: '48216',
		state: 'MI'
	}
};

describe('CustomCat fulfillment', () => {
	it('maps normalized lines to the external-design order payload', async () => {
		let requestUrl = '';
		let requestBody: Record<string, unknown> = {};
		const provider = createCustomCatFulfillment({
			apiKey: 'test-key',
			fetch: async (input, init) => {
				requestUrl = String(input);
				requestBody = JSON.parse(String(init?.body));

				return new Response(
					JSON.stringify({ ORDER_ID: 'ORDER-1', status: 'Pending' }),
					{ status: 200 }
				);
			},
			sandbox: true
		});
		const submitted = await provider.submitOrder(order);
		expect(requestUrl).toEndWith('/order/ORDER-1');
		expect(requestBody.sandbox).toBe('1');
		expect(requestBody.items).toEqual([
			{
				catalog_sku: '48146',
				design_url: 'https://cdn.test/front.png',
				design_url_back: 'https://cdn.test/back.jpg',
				quantity: 2
			}
		]);
		expect(submitted.status).toBe('accepted');
	});

	it('normalizes status shipments and cost', async () => {
		const provider = createCustomCatFulfillment({
			apiKey: 'test-key',
			fetch: async () =>
				new Response(
					JSON.stringify({
						CUSTOMCAT_ORDER_ID: 'CC-1',
						ORDER_ID: 'ORDER-1',
						ORDER_STATUS: 'Shipped',
						ORDER_TOTAL: 19.47,
						SHIPMENTS: [{ TRACKING_ID: 'TRACK-1', VENDOR: 'UPS' }]
					})
				)
		});
		const status = await provider.getOrder('ORDER-1');
		expect(status.providerOrderId).toBe('CC-1');
		expect(status.status).toBe('shipped');
		expect(status.costCents).toBe(1947);
		expect(status.tracking[0]).toEqual({
			carrier: 'UPS',
			trackingNumber: 'TRACK-1',
			trackingUrl: undefined
		});
	});

	it('rejects private or unsupported artwork before submission', () => {
		const validation = validateCustomCatOrder({
			...order,
			lines: [
				{
					...order.lines[0]!,
					artwork: [{ placement: 'sleeve', url: 'http://local/art.svg' }]
				}
			]
		});
		expect(validation.valid).toBe(false);
		expect(validation.errors).toHaveLength(2);
	});
});
