import type { FulfillmentOrderRequest } from '@absolutejs/commerce';

/** Wire names verified against https://integration.dubowtextile.com/ (v2.0). */
export type DubowProcurementType = 'Contract' | 'Custom';
export type DubowOrderConfig = {
	contactId: number;
	customerId: number;
	shipMethod: string;
	procurementType?: DubowProcurementType;
	/** Explicit account-approved overrides; unknown methods never become embroidery. */
	methodNames?: Record<string, string>;
};
const methodNames: Record<string, string> = {
	dtf: 'Direct to Film',
	dtg: 'Digital Print',
	embroidery: 'Embroidery',
	'screen-print': 'Screen Print',
	sublimation: 'Dye Sublimation'
};
const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown) =>
	typeof value === 'string' ? value.trim() : '';
const required = (value: unknown, label: string) => {
	const result = text(value);
	if (!result) throw new Error(`${label} is required`);

	return result;
};
const positiveId = (value: unknown, label: string) => {
	let result = typeof value === 'number' ? value : NaN;
	if (typeof value !== 'number' && /^\d+$/u.test(text(value)))
		result = Number(value);
	if (!Number.isSafeInteger(result) || result < 1)
		throw new Error(`${label} must be a positive numeric provider ID`);

	return result;
};
const httpsUrl = (value: string) => {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
};

const serializeLine = (
	line: FulfillmentOrderRequest['lines'][number],
	config: DubowOrderConfig
) => {
	if (line.providerId !== 'dubow')
		throw new Error('Line must belong to Dubow');
	const metadata = line.metadata ?? {};
	const procurement = metadata.procurementType ?? config.procurementType;
	if (procurement !== 'Contract' && procurement !== 'Custom')
		throw new Error(
			'An explicit Dubow procurement type (Contract or Custom) is required'
		);
	if (!Number.isSafeInteger(line.quantity) || line.quantity < 1)
		throw new Error('Garment quantity must be a positive integer');
	required(line.variantId, 'Exact garment variant');
	const methods = Array.isArray(metadata.methods) ? metadata.methods : [];
	const mappings = Array.isArray(metadata.artworkMappings)
		? metadata.artworkMappings
		: [];
	if (
		!line.artwork.length ||
		methods.length !== line.artwork.length ||
		mappings.length !== line.artwork.length
	)
		throw new Error(
			'Every placement needs its own approved method and artwork mapping'
		);
	const Designs = line.artwork.map((artwork, index) => {
		const mapping = record(mappings[index]);
		if (mapping.status !== 'ready')
			throw new Error(
				`Placement ${index + 1} needs a ready provider artwork mapping`
			);
		if (text(mapping.placement) !== artwork.placement)
			throw new Error(
				`Placement ${index + 1} does not match its approved mapping`
			);
		const method = required(
			methods[index],
			`Placement ${index + 1} method`
		);
		const DesignTypeName = required(
			config.methodNames?.[method] ?? methodNames[method],
			`Supported Dubow method for ${method}`
		);
		const GarmentLocationName = required(
			mapping.providerLocation,
			`Placement ${index + 1} approved Dubow location`
		);
		if (
			mapping.providerDesignId !== null &&
			mapping.providerDesignId !== undefined &&
			mapping.providerDesignId !== ''
		) {
			return {
				DesignID: positiveId(
					mapping.providerDesignId,
					`Placement ${index + 1} design`
				),
				DesignTypeName,
				IntegrationColorway: {
					ColorwayID: positiveId(
						mapping.providerColorwayCode,
						`Placement ${index + 1} colorway`
					),
					GarmentLocationName
				}
			};
		}
		if (!httpsUrl(artwork.url))
			throw new Error(
				`Placement ${index + 1} needs public HTTPS artwork`
			);

		return {
			CustomerDesignCode: required(
				mapping.customerDesignCode,
				`Placement ${index + 1} customer design code`
			),
			DesignTypeName,
			FilePath: artwork.url,
			IntegrationColorway: {
				CustomerColorwayCode: required(
					mapping.providerColorwayCode,
					`Placement ${index + 1} customer colorway code`
				),
				GarmentLocationName
			}
		};
	});

	return {
		Designs,
		IntegrationProduct: {
			Color: required(metadata.color, 'Exact garment color'),
			Description: required(metadata.title, 'Product description'),
			Mill: required(metadata.brand, 'Exact garment mill'),
			ProcurementType: procurement,
			ProductName: required(
				metadata.styleCode,
				'Exact Dubow product name'
			)
		},
		LineItemSizes: [
			{
				Quantity: line.quantity,
				SizeAsString: required(metadata.size, 'Exact garment size')
			}
		],
		Name: required(line.providerSku, 'Exact supplier SKU')
	};
};

export const serializeDubowOrder = (
	request: FulfillmentOrderRequest,
	config: DubowOrderConfig
) => {
	const validation = validateDubowOrder(request, config);
	if (!validation.valid)
		throw new Error(
			validation.errors
				.map(
					(error) =>
						`${error.lineId ? `${error.lineId}: ` : ''}${error.message}`
				)
				.join('; ')
		);

	return {
		ContactID: config.contactId,
		CustomerID: config.customerId,
		Manifests: [
			{
				LineItems: request.lines.map((line) =>
					serializeLine(line, config)
				),
				ShipMethodAbbreviation: config.shipMethod,
				ShipToAddress: {
					Address1: `${request.recipient.firstName} ${request.recipient.lastName}`,
					Address3: request.recipient.address1,
					Address4: request.recipient.address2,
					City: request.recipient.city,
					Country: request.recipient.country,
					State: request.recipient.state,
					Zip: request.recipient.postalCode
				}
			}
		],
		PoNumber: request.externalOrderId
	};
};
export const validateDubowOrder = (
	request: FulfillmentOrderRequest,
	config: DubowOrderConfig
) => {
	const errors: Array<{ lineId?: string; message: string }> = [];
	for (const [value, label] of [
		[config.contactId, 'Dubow contact'],
		[config.customerId, 'Dubow customer']
	] as const) {
		try {
			positiveId(value, label);
		} catch (error) {
			errors.push({ message: (error as Error).message });
		}
	}
	if (!text(config.shipMethod))
		errors.push({ message: 'Dubow ship method is required' });
	if (!text(request.externalOrderId))
		errors.push({ message: 'External order identity is required' });
	if (!request.lines.length)
		errors.push({ message: 'Dubow order needs at least one line' });
	const screenRuns = new Map<string, Map<string, number>>();
	for (const line of request.lines) {
		try {
			const serialized = serializeLine(line, config);
			for (const design of serialized.Designs) {
				if (
					design.DesignTypeName !== 'Screen Print' &&
					design.DesignTypeName !== 'ScreenPrint'
				)
					continue;
				const key = JSON.stringify([
					design.DesignID ?? design.CustomerDesignCode,
					design.IntegrationColorway.ColorwayID ??
						design.IntegrationColorway.CustomerColorwayCode
				]);
				const run = screenRuns.get(key) ?? new Map<string, number>();
				run.set(line.id, line.quantity);
				screenRuns.set(key, run);
			}
		} catch (error) {
			errors.push({ lineId: line.id, message: (error as Error).message });
		}
	}
	for (const run of screenRuns.values())
		if ([...run.values()].reduce((sum, quantity) => sum + quantity, 0) < 24)
			errors.push({
				message:
					'Dubow screen print requires at least 24 garments per approved design/colorway'
			});

	return { errors, valid: errors.length === 0 };
};
