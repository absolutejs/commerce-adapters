import {
	validateFulfillmentOrder,
	type FulfillmentEvent,
	type FulfillmentOrder,
	type FulfillmentOrderRequest,
	type FulfillmentProvider,
	type FulfillmentStatus,
	type FulfillmentTracking,
	type FulfillmentValidation
} from '@absolutejs/commerce';

const DEFAULT_BASE_URL = 'https://customcat-beta.mylocker.net/api/v1';

export type CustomCatConfig = {
	apiKey: string;
	baseUrl?: string;
	sandbox?: boolean;
	shippingMethod?: string;
	/** Injectable for tests, proxies, and edge runtimes. */
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

type JsonRecord = Record<string, unknown>;

const stringValue = (value: unknown) =>
	typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const customCatStatus = (value: unknown): FulfillmentStatus => {
	const status = stringValue(value).trim().toLowerCase();
	if (status.includes('ship')) return 'shipped';
	if (status.includes('cancel')) return 'cancelled';
	if (status.includes('fail') || status.includes('error')) return 'failed';
	if (
		status.includes('verified') ||
		status.includes('print') ||
		status.includes('production')
	)
		return 'in_production';
	if (status.includes('pending') || status.includes('received'))
		return 'accepted';

	return 'pending';
};

const trackingFrom = (payload: JsonRecord): FulfillmentTracking[] => {
	const shipments = payload.SHIPMENTS ?? payload.shipments;
	if (!Array.isArray(shipments)) return [];

	return shipments.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return [];
		const shipment = entry as JsonRecord;
		const trackingNumber = stringValue(
			shipment.TRACKING_ID ?? shipment.tracking_id ?? shipment.tracking_number
		);
		if (!trackingNumber) return [];

		return [
			{
				carrier: stringValue(shipment.VENDOR ?? shipment.vendor) || undefined,
				trackingNumber,
				trackingUrl:
					stringValue(shipment.TRACKING_URL ?? shipment.tracking_url) ||
					undefined
			}
		];
	});
};

const artworkUrlIsSupported = (value: string) => {
	try {
		const url = new URL(value);

		return url.protocol === 'https:' && /\.(png|jpe?g)$/i.test(url.pathname);
	} catch {
		return false;
	}
};

export const validateCustomCatOrder = (
	order: FulfillmentOrderRequest
): FulfillmentValidation => {
	const base = validateFulfillmentOrder(order);
	const errors = [...base.errors];
	for (const line of order.lines) {
		const placements = new Set<string>();
		for (const artwork of line.artwork) {
			const placement = artwork.placement.trim().toLowerCase();
			if (placement !== 'front' && placement !== 'back')
				errors.push({
					lineId: line.id,
					message: 'CustomCat artwork placement must be front or back'
				});
			if (placements.has(placement))
				errors.push({
					lineId: line.id,
					message: `CustomCat accepts one ${placement} artwork file per line`
				});
			placements.add(placement);
			if (!artworkUrlIsSupported(artwork.url))
				errors.push({
					lineId: line.id,
					message: 'CustomCat artwork must be a public HTTPS PNG or JPG URL'
				});
		}
	}

	return { errors, valid: errors.length === 0 };
};

const normalizeOrder = (
	payload: JsonRecord,
	fallbackOrderId: string
): FulfillmentOrder => ({
	costCents: Number.isFinite(Number(payload.ORDER_TOTAL ?? payload.order_total))
		? Math.round(Number(payload.ORDER_TOTAL ?? payload.order_total) * 100)
		: undefined,
	currency: 'USD',
	externalOrderId:
		stringValue(payload.ORDER_ID ?? payload.order_id) || fallbackOrderId,
	providerOrderId:
		stringValue(
			payload.CUSTOMCAT_ORDER_ID ??
				payload.customcat_order_id ??
				payload.ORDER_ID ??
				payload.order_id
		) || fallbackOrderId,
	raw: payload,
	status: customCatStatus(payload.ORDER_STATUS ?? payload.status),
	tracking: trackingFrom(payload)
});

export const createCustomCatFulfillment = (
	config: CustomCatConfig
): FulfillmentProvider => {
	if (!config.apiKey.trim()) throw new Error('CustomCat API key is required');
	const fetcher = config.fetch ?? globalThis.fetch;
	const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

	const request = async (
		path: string,
		init?: RequestInit,
		includeKeyInQuery = false
	): Promise<JsonRecord> => {
		const url = new URL(`${baseUrl}${path}`);
		if (includeKeyInQuery) url.searchParams.set('api_key', config.apiKey);
		const response = await fetcher(url, init);
		const text = await response.text();
		let payload: JsonRecord = {};
		try {
			const parsed = text ? JSON.parse(text) : {};
			payload =
				parsed && typeof parsed === 'object'
					? (parsed as JsonRecord)
					: { result: parsed };
		} catch {
			payload = { result: text };
		}
		if (!response.ok || payload.error || payload.error_description)
			throw new Error(
				stringValue(
					payload.error_description ?? payload.error ?? payload.message
				) || `CustomCat request failed (${response.status})`
			);

		return payload;
	};

	return {
		cancelOrder: async (providerOrderId) => {
			const payload = await request(
				`/order/${encodeURIComponent(providerOrderId)}`,
				{ method: 'DELETE' },
				true
			);

			return normalizeOrder(payload, providerOrderId);
		},
		getOrder: async (providerOrderId) => {
			const payload = await request(
				`/order/status/${encodeURIComponent(providerOrderId)}`,
				undefined,
				true
			);

			return normalizeOrder(payload, providerOrderId);
		},
		id: 'customcat',
		parseWebhook: async (webhookRequest): Promise<FulfillmentEvent> => {
			const payload = (await webhookRequest.json()) as JsonRecord;
			const normalized = normalizeOrder(
				payload,
				stringValue(payload.ORDER_ID ?? payload.order_id)
			);
			const type =
				normalized.status === 'shipped'
					? 'shipped'
					: normalized.status === 'cancelled'
						? 'cancelled'
						: normalized.status === 'failed'
							? 'failed'
							: normalized.status === 'in_production'
								? 'production'
								: 'accepted';

			return {
				externalOrderId: normalized.externalOrderId,
				id: stringValue(payload.EVENT_ID ?? payload.event_id) || undefined,
				providerOrderId: normalized.providerOrderId,
				raw: payload,
				status: normalized.status,
				tracking: normalized.tracking,
				type
			};
		},
		submitOrder: async (order) => {
			const validation = validateCustomCatOrder(order);
			if (!validation.valid)
				throw new Error(
					validation.errors.map((error) => error.message).join('; ')
				);
			const items = order.lines.map((line) => {
				const front = line.artwork.find(
					(artwork) => artwork.placement.toLowerCase() === 'front'
				);
				const back = line.artwork.find(
					(artwork) => artwork.placement.toLowerCase() === 'back'
				);

				return {
					catalog_sku: line.providerSku,
					design_url: front?.url ?? back?.url,
					...(front && back ? { design_url_back: back.url } : {}),
					...(front?.presetId ? { preset_id: front.presetId } : {}),
					quantity: line.quantity
				};
			});
			const body = {
				api_key: config.apiKey,
				items,
				sandbox: (order.sandbox ?? config.sandbox) ? '1' : '0',
				shipping_address1: order.recipient.address1,
				shipping_address2: order.recipient.address2 ?? '',
				shipping_city: order.recipient.city,
				shipping_country: order.recipient.country,
				shipping_email: order.recipient.email ?? '',
				shipping_first_name: order.recipient.firstName,
				shipping_last_name: order.recipient.lastName,
				shipping_method:
					order.shippingMethod ?? config.shippingMethod ?? 'Economy',
				shipping_phone: order.recipient.phone ?? '',
				shipping_state: order.recipient.state ?? '',
				shipping_zip: order.recipient.postalCode
			};
			const payload = await request(
				`/order/${encodeURIComponent(order.externalOrderId)}`,
				{
					body: JSON.stringify(body),
					headers: { 'content-type': 'application/json' },
					method: 'POST'
				}
			);

			return normalizeOrder(payload, order.externalOrderId);
		},
		validateOrder: validateCustomCatOrder
	};
};
