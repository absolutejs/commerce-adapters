import { describe, expect, test } from 'bun:test';
import {
	createDubowCatalog,
	createDubowClient,
	parseDubowProducts
} from './index';

describe('Dubow client', () => {
	test('creates designs with automatic customer colorway codes', async () => {
		let request: Request | undefined;
		const client = createDubowClient({
			password: 'secret',
			sandbox: true,
			userId: 42,
			fetch: async (input, init) => {
				request = new Request(input, init);

				return Response.json({ ResponseSummary: { IsSuccess: true } });
			}
		});
		await client.createDesign({
			colorways: [
				{
					customerColorwayCode: 'CBS-ACME-NAVY',
					garmentColor: 'Navy'
				}
			],
			contactId: 7,
			decorationMethod: 'Embroidery',
			fileUrl: 'https://cdn.example.com/acme.ai',
			height: 2,
			location: 'Left Chest',
			name: 'Acme logo',
			transactionId: 'design-acme-1',
			width: 3.5
		});
		const body = (await request?.json()) as Record<string, unknown>;
		expect(request?.url).toContain('test-integration.dubowtextile.com');
		expect(body.Authorization).toEqual({ Password: 'secret', UserID: 42 });
		expect(body.Designs).toEqual([
			expect.objectContaining({
				Colorways: [
					expect.objectContaining({
						CustomerColorwayCode: 'CBS-ACME-NAVY',
						GarmentColor: 'Navy'
					})
				],
				DesignTypeName: 'Embroidery',
				Location: 'Left Chest'
			})
		]);
	});

	test('surfaces Dubow response errors', async () => {
		const client = createDubowClient({
			password: 'secret',
			userId: 42,
			fetch: async () =>
				Response.json({
					ResponseSummary: {
						Errors: [{ Message: 'Colorway is invalid' }],
						IsSuccess: false
					}
				})
		});
		expect(client.listLocations()).rejects.toThrow('Colorway is invalid');
	});
});

describe('Dubow product lookup catalog', () => {
	const documentedProducts = [
		{
			Colors: ['White', 'Black'],
			Description: 'Gildan Heavy Cotton Tee',
			Id: 5001,
			IsActive: true,
			Mill: 'Gildan',
			Name: 'G500',
			ProductType: 'T-Shirt',
			RequiresMill: true,
			Sizes: ['S', 'XL']
		}
	];

	test('normalizes exact documented product, color, and size identities', async () => {
		const catalog = createDubowCatalog({
			password: 'secret',
			userId: 42,
			fetch: async () => Response.json(documentedProducts)
		});
		const page = await catalog.listProducts();
		const [item] = page.items;

		expect(item?.product).toEqual(
			expect.objectContaining({
				brand: 'Gildan',
				externalId: '5001',
				styleCode: 'G500'
			})
		);
		expect(item?.variants).toHaveLength(4);
		expect(item?.variants[0]).toEqual(
			expect.objectContaining({
				available: false,
				costCents: null,
				options: { Color: 'White', Size: 'S' },
				supplierSku: null
			})
		);
	});

	test('fails closed on malformed lookup data', () => {
		expect(() =>
			parseDubowProducts({ Products: documentedProducts })
		).toThrow('must be an array');
		expect(() =>
			parseDubowProducts([
				{ ...documentedProducts[0], Mill: '', RequiresMill: true }
			])
		).toThrow('requires its exact mill');
	});
});

test('unsuccessful provider responses reject even when error details are empty or absent', async () => {
	for (const errors of [[], undefined, [{ Message: '' }]]) {
		const client = createDubowClient({
			password: 'test-only',
			userId: 1,
			fetch: async () =>
				Response.json({
					ResponseSummary: { Errors: errors, IsSuccess: false }
				})
		});
		await expect(
			client.submitOrders([{ PoNumber: 'not-submitted-live' }])
		).rejects.toThrow('Dubow reported an unsuccessful response');
	}
});
