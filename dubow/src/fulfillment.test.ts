import type { FulfillmentOrderRequest } from '@absolutejs/commerce';
import { expect, test } from 'bun:test';
import {
	createDubowClient,
	serializeDubowOrder,
	validateDubowOrder,
	type DubowOrderConfig
} from './index';

const config: DubowOrderConfig = {
	contactId: 12,
	customerId: 34,
	procurementType: 'Contract',
	shipMethod: 'UPS-GROUND'
};
const fixture = (): FulfillmentOrderRequest => ({
	externalOrderId: 'approved-order',
	lines: ['Navy', 'White'].map((color, index) => ({
		artwork: [
			{ placement: 'left-chest', url: 'https://example.com/chest.dst' },
			{
				placement: 'full-back',
				url: `https://example.com/back-${color}.png`
			}
		],
		id: `line-${index}`,
		metadata: {
			artworkMappings: [
				{
					customerDesignCode: 'CHEST',
					placement: 'left-chest',
					providerColorwayCode: String(400 + index),
					providerDesignId: '123',
					providerLocation: 'Left Chest',
					status: 'ready'
				},
				{
					customerDesignCode: `BACK-${color}`,
					placement: 'full-back',
					providerColorwayCode: `CW-${color}`,
					providerLocation: 'Full Back',
					status: 'ready'
				}
			],
			brand: 'Gildan',
			color,
			methods: ['embroidery', 'dtf'],
			size: 'L',
			styleCode: 'G500',
			title: 'Gildan Heavy Cotton Tee'
		},
		providerId: 'dubow',
		providerSku: `G500-${color}-L`,
		quantity: 2,
		variantId: `variant-${color}`
	})),
	recipient: {
		address1: '1 Main St',
		city: 'Boston',
		country: 'US',
		firstName: 'Test',
		lastName: 'Buyer',
		postalCode: '02110',
		state: 'MA'
	}
});

test('captured orders/new body preserves garment variants, each method and approved artwork identity', async () => {
	let captured: { Orders: Array<ReturnType<typeof serializeDubowOrder>> } = {
		Orders: []
	};
	const client = createDubowClient({
		password: 'test-only',
		sandbox: true,
		userId: 1,
		fetch: async (url, init) => {
			expect(String(url)).toContain('/orders/new');
			captured = JSON.parse(String(init?.body));

			return Response.json({
				Orders: [],
				ResponseSummary: { IsSuccess: true }
			});
		}
	});
	await client.submitOrders([serializeDubowOrder(fixture(), config)]);
	const lines = captured.Orders[0]!.Manifests[0]!.LineItems;
	expect(lines.map((line) => line.Name)).toEqual([
		'G500-Navy-L',
		'G500-White-L'
	]);
	expect(lines.map((line) => line.IntegrationProduct.Color)).toEqual([
		'Navy',
		'White'
	]);
	expect(lines[0].LineItemSizes).toEqual([
		{ Quantity: 2, SizeAsString: 'L' }
	]);
	expect(lines[0].Designs[0]).toEqual({
		DesignID: 123,
		DesignTypeName: 'Embroidery',
		IntegrationColorway: {
			ColorwayID: 400,
			GarmentLocationName: 'Left Chest'
		}
	});
	expect(lines[1].Designs[0].IntegrationColorway.ColorwayID).toBe(401);
	expect(lines[0].Designs[1]).toEqual({
		CustomerDesignCode: 'BACK-Navy',
		DesignTypeName: 'Direct to Film',
		FilePath: 'https://example.com/back-Navy.png',
		IntegrationColorway: {
			CustomerColorwayCode: 'CW-Navy',
			GarmentLocationName: 'Full Back'
		}
	});
	expect(lines[1].Designs[1].CustomerDesignCode).toBe('BACK-White');
});

test('procurement is explicit, with trusted per-line override', () => {
	const order = fixture();
	expect(
		validateDubowOrder(order, { ...config, procurementType: undefined })
			.valid
	).toBe(false);
	order.lines[0]!.metadata!.procurementType = 'Custom';
	const serialized = serializeDubowOrder(order, config);
	expect(
		serialized.Manifests[0]!.LineItems.map(
			(line) => line.IntegrationProduct.ProcurementType
		)
	).toEqual(['Custom', 'Contract']);
});

test('missing color, SKU, location, method, and ambiguous existing design IDs fail before fetch', () => {
	for (const mutate of [
		(order: FulfillmentOrderRequest) => {
			order.lines[0]!.metadata!.color = '';
		},
		(order: FulfillmentOrderRequest) => {
			order.lines[0]!.providerSku = '';
		},
		(order: FulfillmentOrderRequest) => {
			(
				order.lines[0]!.metadata!.artworkMappings as Array<
					Record<string, unknown>
				>
			)[0].providerLocation = '';
		},
		(order: FulfillmentOrderRequest) => {
			order.lines[0]!.metadata!.methods = ['vinyl', 'dtf'];
		},
		(order: FulfillmentOrderRequest) => {
			(
				order.lines[0]!.metadata!.artworkMappings as Array<
					Record<string, unknown>
				>
			)[0].providerDesignId = 'local-design-id';
		},
		(order: FulfillmentOrderRequest) => {
			(
				order.lines[0]!.metadata!.artworkMappings as Array<
					Record<string, unknown>
				>
			)[0].providerColorwayCode = 'customer-code-not-numeric-id';
		},
		(order: FulfillmentOrderRequest) => {
			(
				order.lines[0]!.metadata!.artworkMappings as Array<
					Record<string, unknown>
				>
			)[0].status = 'pending';
		},
		(order: FulfillmentOrderRequest) => {
			(
				order.lines[0]!.metadata!.artworkMappings as Array<
					Record<string, unknown>
				>
			)[0].placement = 'wrong-placement';
		}
	]) {
		const order = fixture();
		mutate(order);
		expect(validateDubowOrder(order, config).valid).toBe(false);
		expect(() => serializeDubowOrder(order, config)).toThrow();
	}
});

test('screen-print minimum combines sizes in one approved colorway but never unrelated colorways', () => {
	const order = fixture();
	for (const line of order.lines) {
		line.artwork = line.artwork.slice(0, 1);
		line.metadata!.methods = ['screen-print'];
		line.metadata!.artworkMappings = (
			line.metadata!.artworkMappings as Array<Record<string, unknown>>
		).slice(0, 1);
		line.quantity = 12;
	}
	expect(validateDubowOrder(order, config).valid).toBe(false);
	(
		order.lines[1]!.metadata!.artworkMappings as Array<
			Record<string, unknown>
		>
	)[0].providerColorwayCode = '400';
	expect(validateDubowOrder(order, config).valid).toBe(true);
});
