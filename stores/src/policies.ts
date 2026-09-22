/* eslint-disable absolute/no-useless-function -- fresh policy/contact objects prevent shared mutable defaults */
/** Provider-neutral store operating rules. All monetary amounts are integer cents. */
export type BusinessContact = {
	name: string;
	email: string;
	phone: string;
	address: string;
};
export type StoreOperatingPolicy = {
	version: 1;
	commercialConfigured?: boolean;
	company: BusinessContact;
	verticalOwner: BusinessContact;
	storeOwner: BusinessContact;
	division: string;
	decorators: string[];
	retailMarginBps: number | null;
	secondImpressionCents: Record<string, number>;
	shipping: {
		enabled: boolean;
		countries: string[];
		allowAlaska: boolean;
		allowHawaii: boolean;
		freeThresholdCents: number | null;
		freeNonContiguous: boolean;
		freeInternational: boolean;
		alaskaSurchargeCents: number;
		hawaiiSurchargeCents: number;
		internationalSurchargeCents: number;
	};
	billing: {
		registrationCents: number;
		renewalCents: number;
		renewalMonths: number;
	};
	coupons: {
		enabled: boolean;
		allowedCodes: string[];
	};
	notifications: {
		ownerSales: boolean;
		ownerProduction: boolean;
		buyerProduction: boolean;
		cbsProduction: boolean;
	};
};
const emptyContact = (): BusinessContact => ({
	address: '',
	email: '',
	name: '',
	phone: ''
});
export const defaultStoreOperatingPolicy = (): StoreOperatingPolicy => ({
	billing: { registrationCents: 0, renewalCents: 0, renewalMonths: 12 },
	commercialConfigured: false,
	company: emptyContact(),
	coupons: { allowedCodes: [], enabled: false },
	decorators: [],
	division: '',
	notifications: {
		buyerProduction: true,
		cbsProduction: true,
		ownerProduction: true,
		ownerSales: true
	},
	retailMarginBps: null,
	secondImpressionCents: {},
	shipping: {
		alaskaSurchargeCents: 0,
		allowAlaska: false,
		allowHawaii: false,
		countries: ['US'],
		enabled: false,
		freeInternational: false,
		freeNonContiguous: false,
		freeThresholdCents: null,
		hawaiiSurchargeCents: 0,
		internationalSurchargeCents: 0
	},
	storeOwner: emptyContact(),
	version: 1,
	verticalOwner: emptyContact()
});
const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Expected a settings object');
	return value as Record<string, unknown>;
};
const text = (value: unknown, label: string, max = 240) => {
	if (typeof value !== 'string' || value.length > max)
		throw new Error(`${label} must be text of at most ${max} characters`);
	return value.trim();
};
const money = (value: unknown, label: string, max = 100000000) => {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > max
	)
		throw new Error(
			`${label} must be a non-negative whole number within range`
		);
	return value;
};
const flag = (value: unknown, label: string) => {
	if (typeof value !== 'boolean')
		throw new Error(`${label} must be enabled or disabled`);
	return value;
};
const strings = (value: unknown, label: string) => {
	if (!Array.isArray(value) || value.length > 250)
		throw new Error(`${label} must be a list of at most 250 entries`);
	return [
		...new Set(
			value.map((entry) => text(entry, label, 120)).filter(Boolean)
		)
	];
};
const contact = (value: unknown): BusinessContact => {
	const input = object(value);
	const email = text(input.email, 'Email').toLowerCase();
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
		throw new Error('Enter a valid contact email');
	return {
		address: text(input.address, 'Address', 1000),
		email,
		name: text(input.name, 'Name'),
		phone: text(input.phone, 'Phone', 60)
	};
};
export const parseStoreOperatingPolicy = (
	raw: unknown
): StoreOperatingPolicy => {
	const input = object(raw);
	const shipping = object(input.shipping),
		billing = object(input.billing),
		coupons = object(input.coupons),
		notifications = object(input.notifications);
	const countries = strings(shipping.countries, 'Countries').map((country) =>
		country.toUpperCase()
	);
	if (countries.some((country) => !/^[A-Z]{2}$/u.test(country)))
		throw new Error('Use two-letter country codes');
	const decorators = strings(input.decorators, 'Decorators');
	if (
		decorators.some(
			(provider) => !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(provider)
		)
	)
		throw new Error(
			'Decorator identifiers must use lowercase letters, numbers, underscores or hyphens'
		);
	const charges = object(input.secondImpressionCents);
	if (Object.keys(charges).length > 30)
		throw new Error('Too many decoration methods');
	const secondImpressionCents: Record<string, number> = {};
	for (const [method, value] of Object.entries(charges)) {
		if (!/^[a-z][a-z0-9_-]{0,59}$/u.test(method))
			throw new Error('Invalid decoration method');
		secondImpressionCents[method] = money(value, 'Second impression');
	}
	const renewalMonths = money(billing.renewalMonths, 'Renewal interval', 120);
	if (renewalMonths < 1)
		throw new Error('Renewal interval must be at least one month');
	return {
		billing: {
			registrationCents: money(
				billing.registrationCents,
				'Registration fee'
			),
			renewalCents: money(billing.renewalCents, 'Renewal fee'),
			renewalMonths
		},
		commercialConfigured: input.commercialConfigured === true,
		company: contact(input.company),
		coupons: {
			allowedCodes: strings(coupons.allowedCodes, 'Coupon codes').map(
				(code) => code.toUpperCase()
			),
			enabled: flag(coupons.enabled, 'Coupons')
		},
		decorators,
		division: text(input.division, 'Division', 120),
		notifications: {
			buyerProduction: flag(
				notifications.buyerProduction,
				'Buyer production updates'
			),
			cbsProduction: flag(
				notifications.cbsProduction,
				'CBS production updates'
			),
			ownerProduction: flag(
				notifications.ownerProduction,
				'Owner production updates'
			),
			ownerSales: flag(notifications.ownerSales, 'Owner sales updates')
		},
		retailMarginBps:
			input.retailMarginBps === null
				? null
				: money(input.retailMarginBps, 'Retail margin', 9900),
		secondImpressionCents,
		shipping: {
			alaskaSurchargeCents: money(
				shipping.alaskaSurchargeCents,
				'Alaska surcharge'
			),
			allowAlaska: flag(shipping.allowAlaska, 'Alaska'),
			allowHawaii: flag(shipping.allowHawaii, 'Hawaii'),
			countries,
			enabled: flag(shipping.enabled, 'Shipping'),
			freeInternational: flag(
				shipping.freeInternational,
				'Free international shipping'
			),
			freeNonContiguous: flag(
				shipping.freeNonContiguous,
				'Free shipping to Alaska/Hawaii'
			),
			freeThresholdCents:
				shipping.freeThresholdCents === null
					? null
					: money(
							shipping.freeThresholdCents,
							'Free shipping minimum'
						),
			hawaiiSurchargeCents: money(
				shipping.hawaiiSurchargeCents,
				'Hawaii surcharge'
			),
			internationalSurchargeCents: money(
				shipping.internationalSurchargeCents,
				'International surcharge'
			)
		},
		storeOwner: contact(input.storeOwner),
		version: 1,
		verticalOwner: contact(input.verticalOwner)
	};
};
export const storeRetailPriceCents = (input: {
	currentPriceCents: number;
	costCents: number | null;
	marginBps: number | null;
	methods: string[];
	secondImpressionCents: Record<string, number>;
}) => {
	money(input.currentPriceCents, 'Price');
	let price = input.currentPriceCents;
	if (input.marginBps !== null) {
		money(input.marginBps, 'Margin', 9900);
		if (input.costCents === null)
			throw new Error(
				'A verified cost is required for target-margin pricing'
			);
		money(input.costCents, 'Cost');
		price = Math.max(
			price,
			Math.ceil((input.costCents * 10000) / (10000 - input.marginBps))
		);
	}
	return (
		price +
		input.methods
			.slice(1)
			.reduce(
				(total, method) =>
					total + (input.secondImpressionCents[method] ?? 0),
				0
			)
	);
};
export const storeShippingQuote = (
	policy: StoreOperatingPolicy['shipping'],
	input: {
		country: string;
		state: string;
		subtotalCents: number;
		carrierCents: number;
	}
) => {
	const country = input.country.toUpperCase(),
		state = input.state.toUpperCase();
	const alaska = country === 'US' && state === 'AK',
		hawaii = country === 'US' && state === 'HI',
		international = country !== 'US';
	if (
		!policy.enabled ||
		!policy.countries.includes(country) ||
		(alaska && !policy.allowAlaska) ||
		(hawaii && !policy.allowHawaii)
	)
		throw new Error(
			'Shipping is not available to this destination for this store'
		);
	money(input.carrierCents, 'Carrier quote');
	money(input.subtotalCents, 'Merchandise subtotal');
	const free =
		policy.freeThresholdCents !== null &&
		input.subtotalCents >= policy.freeThresholdCents &&
		(!(alaska || hawaii) || policy.freeNonContiguous) &&
		(!international || policy.freeInternational);
	let surchargeCents = 0;
	if (alaska) surchargeCents = policy.alaskaSurchargeCents;
	else if (hawaii) surchargeCents = policy.hawaiiSurchargeCents;
	else if (international) surchargeCents = policy.internationalSurchargeCents;
	return {
		amountCents: (free ? 0 : input.carrierCents) + surchargeCents,
		carrierCents: free ? 0 : input.carrierCents,
		free,
		surchargeCents
	};
};
export type StoreProductPolicy = {
	artworkDesignId?: string;
	colors: string[];
	methods: string[];
	placements: string[];
	category: string;
};
export const isManualDecorator = (
	provider: string
): provider is 'halftone' | `manual-${string}` =>
	provider === 'halftone' ||
	/^manual-[a-z0-9][a-z0-9-]{0,60}$/u.test(provider);
export const parseStoreProductPolicy = (raw: unknown): StoreProductPolicy => {
	const input = object(raw);
	return {
		...(input.artworkDesignId
			? {
					artworkDesignId: text(
						input.artworkDesignId,
						'Artwork design',
						80
					)
				}
			: {}),
		category: text(input.category, 'Category', 160),
		colors: strings(input.colors, 'Colors'),
		methods: strings(input.methods, 'Methods'),
		placements: strings(input.placements, 'Placements')
	};
};
export const storeProductSelectionIssues = (
	policy: StoreProductPolicy,
	input: {
		color: string;
		methods: string[];
		placements: string[];
	}
) => [
	...(policy.colors.length && !policy.colors.includes(input.color)
		? ['This color is not offered by this store']
		: []),
	...(policy.methods.length &&
	input.methods.some((method) => !policy.methods.includes(method))
		? ['This decoration method is not offered by this store']
		: []),
	...(policy.placements.length &&
	input.placements.some((placement) => !policy.placements.includes(placement))
		? ['This decoration location is not offered by this store']
		: [])
];
