import type {
	CatalogPage,
	CatalogProduct,
	CatalogSourceProvider,
	ProductVariant
} from '@absolutejs/commerce';

export const DUBOW_PRODUCTION_URL =
	'https://integration.dubowtextile.com/integration/orderintegrationservice.svc/json';
export const DUBOW_TEST_URL =
	'https://test-integration.dubowtextile.com/integration/orderintegrationservice.svc/json';

export type DubowConfig = {
	userId: number;
	password: string;
	sandbox?: boolean;
	baseUrl?: string;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export type DubowColorwayInput = {
	garmentColor: string;
	customerColorwayCode: string;
	fileUrl?: string;
	notes?: string;
};

export type DubowDesignInput = {
	additionalNotes?: string;
	contactId: number;
	decorationMethod: string;
	fileUrl: string;
	height: number;
	isHat?: boolean;
	location: string;
	name: string;
	programId?: number;
	transactionId: string;
	width: number;
	colorways: DubowColorwayInput[];
};

export type DubowProductQuery = {
	mill?: string;
	productId?: number;
	productName?: string;
};

export type DubowDecorationQuoteInput = {
	colors?: number;
	decorationMethod: string;
	height?: number;
	pricingType: 'Default' | 'Integrated' | 'Program';
	programId?: number;
	quantity: number;
	stitchCount?: number;
	width?: number;
};

export type DubowProductRecord = {
	Colors: string[];
	Description: string;
	Id: number;
	IsActive: boolean;
	Mill: string;
	Name: string;
	ProductType: string;
	RequiresMill: boolean;
	Sizes: string[];
};

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const cleanTextList = (value: unknown) =>
	Array.isArray(value)
		? value.flatMap((entry) =>
				typeof entry === 'string' && entry.trim() ? [entry.trim()] : []
			)
		: null;

export const parseDubowProducts = (payload: unknown): DubowProductRecord[] => {
	if (!Array.isArray(payload))
		throw new Error('Dubow products response must be an array');

	return payload.map((entry, index) => {
		if (!isRecord(entry))
			throw new Error(`Dubow product ${index + 1} is malformed`);
		const colors = cleanTextList(entry.Colors);
		const sizes = cleanTextList(entry.Sizes);
		const id = Number(entry.Id);
		const name = typeof entry.Name === 'string' ? entry.Name.trim() : '';
		const mill = typeof entry.Mill === 'string' ? entry.Mill.trim() : '';
		const requiresMill = entry.RequiresMill === true;
		if (!Number.isInteger(id) || id < 1 || !name || !colors || !sizes)
			throw new Error(
				`Dubow product ${index + 1} is missing required fields`
			);
		if (requiresMill && !mill)
			throw new Error(`Dubow product ${id} requires its exact mill`);

		return {
			Colors: colors,
			Description:
				typeof entry.Description === 'string'
					? entry.Description.trim()
					: '',
			Id: id,
			IsActive: entry.IsActive === true,
			Mill: mill,
			Name: name,
			ProductType:
				typeof entry.ProductType === 'string'
					? entry.ProductType.trim()
					: '',
			RequiresMill: requiresMill,
			Sizes: sizes
		};
	});
};

const slug = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/(^-|-$)/gu, '');

export const dubowCatalogItem = (record: DubowProductRecord) => {
	const productId = `dubow:${record.Id}`;
	const product: CatalogProduct = {
		attributes: {
			fulfillmentProvider: 'dubow',
			providerProductId: record.Id,
			requiresMill: record.RequiresMill
		},
		brand: record.Mill || 'Dubow',
		category: record.ProductType || 'Other',
		decorationAreas: [],
		description: record.Description,
		externalId: String(record.Id),
		id: productId,
		media: [],
		metadata: {
			catalogEvidence: 'dubow-products-v2',
			productionFactsVerified: false,
			providerProductName: record.Name
		},
		optionNames: ['Color', 'Size'],
		productType: record.ProductType || 'Other',
		slug: slug(`${record.Mill}-${record.Name}-${record.Id}`),
		sourceId: 'dubow',
		status: record.IsActive ? 'active' : 'archived',
		styleCode: record.Name,
		tags: [record.Mill, record.ProductType].filter(Boolean),
		title: record.Description || `${record.Mill} ${record.Name}`.trim()
	};
	const variants: ProductVariant[] = record.Colors.flatMap((color) =>
		record.Sizes.map((size) => ({
			available: false,
			costCents: null,
			currency: 'USD',
			externalId: `${record.Id}:${color}:${size}`,
			id: `dubow:${record.Id}:${slug(color)}:${slug(size)}`,
			inventoryPolicy: 'external',
			inventoryQuantity: null,
			media: [],
			metadata: {
				inventoryEvidence: 'not-returned-by-products-v2',
				providerColor: color,
				providerProductId: record.Id,
				providerProductName: record.Name,
				providerSize: size
			},
			options: { Color: color, Size: size },
			priceCents: null,
			productId,
			sku: `DUBOW-${record.Id}-${slug(color)}-${slug(size)}`.toUpperCase(),
			supplierSku: null
		}))
	);

	return { product, variants };
};

const errorsFrom = (payload: unknown) => {
	if (!isRecord(payload)) return [];
	const summary = payload.ResponseSummary;
	if (!isRecord(summary) || summary.IsSuccess !== false) return [];
	const errors = Array.isArray(summary.Errors) ? summary.Errors : [];

	const messages = errors.flatMap((error) =>
		isRecord(error) &&
		typeof error.Message === 'string' &&
		error.Message.trim()
			? [error.Message]
			: []
	);

	return messages.length
		? messages
		: ['Dubow reported an unsuccessful response'];
};

/**
 * Read-only normalization of Dubow's documented v2 product lookup list.
 * The endpoint does not return supplier SKU, inventory, cost, licensed media,
 * or decoration calibration. Those fields deliberately remain unavailable so
 * a lookup record can never pass the CBS merchandise launch gate by itself.
 */
export const createDubowCatalog = (
	config: DubowConfig
): CatalogSourceProvider => {
	const client = createDubowClient(config);
	let productsPromise: Promise<DubowProductRecord[]> | null = null;
	const products = () => {
		productsPromise ??= client.listProducts().then(parseDubowProducts);

		return productsPromise;
	};

	return {
		id: 'dubow',
		getProduct: async (externalId) => {
			const id = Number(externalId);
			if (!Number.isInteger(id) || id < 1) return null;
			const payload = await client.listProducts({ productId: id });
			const [record] = parseDubowProducts(payload);

			return record ? dubowCatalogItem(record) : null;
		},
		listProducts: async (
			input = {}
		): Promise<CatalogPage<ReturnType<typeof dubowCatalogItem>>> => {
			const limit = Math.min(250, Math.max(1, input.limit ?? 100));
			const offset = Math.max(0, Number(input.cursor ?? '0') || 0);
			const search = input.search?.trim().toLowerCase() ?? '';
			const records = (await products()).filter((record) =>
				search
					? [
							record.Name,
							record.Description,
							record.Mill,
							record.ProductType,
							...record.Colors,
							...record.Sizes
						].some((value) => value.toLowerCase().includes(search))
					: true
			);
			const page = records.slice(offset, offset + limit);
			const nextOffset = offset + page.length;

			return {
				items: page.map(dubowCatalogItem),
				...(nextOffset < records.length
					? { nextCursor: String(nextOffset) }
					: {})
			};
		}
	};
};

export const createDubowClient = (config: DubowConfig) => {
	if (!Number.isInteger(config.userId) || config.userId < 1)
		throw new Error('Dubow user ID is required');
	if (!config.password.trim()) throw new Error('Dubow password is required');
	const fetcher = config.fetch ?? globalThis.fetch;
	const baseUrl = (
		config.baseUrl ??
		(config.sandbox ? DUBOW_TEST_URL : DUBOW_PRODUCTION_URL)
	).replace(/\/$/u, '');
	const authorization = () => ({
		Password: config.password,
		UserID: config.userId
	});
	const request = async (
		path: string,
		options: {
			body?: JsonRecord;
			query?: Record<string, string | number>;
		} = {}
	) => {
		const url = new URL(`${baseUrl}/${path}`);
		for (const [key, value] of Object.entries(options.query ?? {}))
			url.searchParams.set(key, String(value));
		const response = await fetcher(url, {
			body: options.body
				? JSON.stringify({
						Authorization: authorization(),
						...options.body
					})
				: undefined,
			headers: options.body
				? { 'content-type': 'application/json' }
				: undefined,
			method: options.body ? 'POST' : 'GET'
		});
		const text = await response.text();
		let payload: unknown;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(
				`Dubow returned a malformed response (${response.status})`
			);
		}
		const errors = errorsFrom(payload);
		if (!response.ok || errors.length > 0)
			throw new Error(
				errors.join('; ') || `Dubow request failed (${response.status})`
			);

		return payload;
	};

	return {
		createDesign: (input: DubowDesignInput) => {
			if (input.colorways.length === 0)
				throw new Error('Dubow design requires at least one colorway');

			return request('designs/new', {
				body: {
					Designs: [
						{
							AdditionalNotes: input.additionalNotes,
							Colorways: input.colorways.map((colorway) => ({
								Breaks: [],
								ColorwayFileUrl: colorway.fileUrl,
								CustomerColorwayCode:
									colorway.customerColorwayCode,
								GarmentColor: colorway.garmentColor,
								Notes: colorway.notes
							})),
							ContactID: input.contactId,
							DesignName: input.name,
							DesignTypeName: input.decorationMethod,
							FileUrl: input.fileUrl,
							Height: input.height,
							IsHat: input.isHat ?? false,
							Location: input.location,
							ProgramID: input.programId,
							ProportionalBy: 'Width',
							Width: input.width
						}
					],
					TransactionID: input.transactionId
				}
			});
		},
		listLocations: () => request('locations'),
		listProducts: (query: DubowProductQuery = {}) =>
			request('products', {
				query: Object.fromEntries(
					Object.entries(query).filter(
						(entry): entry is [string, string | number] =>
							entry[1] !== undefined
					)
				)
			}),
		listShipMethods: () => request('shipmethods'),
		quoteDecoration: (input: DubowDecorationQuoteInput) =>
			request('pricing/decoration', {
				body: {
					PricingRequest: {
						Colors: input.colors,
						DecorationMethod: input.decorationMethod,
						Height: input.height,
						PricingType: input.pricingType,
						ProgramID: input.programId,
						Quantity: input.quantity,
						StitchCount: input.stitchCount,
						Width: input.width
					}
				}
			}),
		submitOrders: (orders: JsonRecord[]) =>
			request('orders/new', { body: { Orders: orders } })
	};
};

export {
	serializeDubowOrder,
	validateDubowOrder,
	type DubowOrderConfig,
	type DubowProcurementType
} from './fulfillment';
