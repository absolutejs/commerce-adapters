/* eslint-disable absolute/prefer-inline-exports -- one sorted public contract keeps the domain surface auditable */
export type KitPrice =
	| { mode: 'component_total' }
	| { amountCents: number; mode: 'fixed' };

export type KitComponent = {
	id: string;
	listingId: string;
	name: string;
	quantity: number;
	required: boolean;
	selectionMode: 'fixed_variant' | 'shopper_variant';
	variantId?: string;
};

export type CommerceKit = {
	components: KitComponent[];
	description: string;
	id: string;
	name: string;
	price: KitPrice;
	status: 'active' | 'archived' | 'draft';
};

const kitIssues = (kit: CommerceKit) => {
	const issues: string[] = [];
	if (!kit.name.trim()) issues.push('Give the kit a name.');
	if (!['active', 'archived', 'draft'].includes(kit.status))
		issues.push('Choose a valid kit status.');
	if (kit.components.length < 2)
		issues.push('A kit needs at least two items.');
	if (
		new Set(kit.components.map(({ id }) => id)).size !==
		kit.components.length
	)
		issues.push('Every kit item needs a unique identity.');
	for (const component of kit.components) {
		if (
			typeof component.required !== 'boolean' ||
			!['fixed_variant', 'shopper_variant'].includes(
				component.selectionMode
			)
		)
			issues.push(
				'Choose a valid kit selection mode and required status.'
			);
		if (
			!component.id.trim() ||
			!component.listingId.trim() ||
			!component.name.trim()
		)
			issues.push('Complete every kit item.');
		if (!Number.isSafeInteger(component.quantity) || component.quantity < 1)
			issues.push(
				`${component.name || 'Kit item'} needs a whole-number quantity.`
			);
		if (
			component.selectionMode === 'fixed_variant' &&
			!component.variantId?.trim()
		)
			issues.push(
				`${component.name || 'Kit item'} needs a fixed variant.`
			);
	}
	if (
		kit.price.mode === 'fixed' &&
		(!Number.isSafeInteger(kit.price.amountCents) ||
			kit.price.amountCents < 0)
	)
		issues.push('The fixed kit price must be a non-negative amount.');

	return [...new Set(issues)];
};

const kitIsSellable = (kit: CommerceKit) =>
	kit.status === 'active' && kitIssues(kit).length === 0;

const kitPriceCents = (
	price: KitPrice,
	components: Array<{ quantity: number; unitPriceCents: number }>
) =>
	price.mode === 'fixed'
		? price.amountCents
		: components.reduce(
				(total, component) =>
					total + component.quantity * component.unitPriceCents,
				0
			);

export type StoreCreditLedgerKind =
	| 'allocation'
	| 'allocation_reversal'
	| 'expiration'
	| 'funding'
	| 'funding_reversal'
	| 'redemption'
	| 'redemption_release'
	| 'refund';

export type StoreCreditLedgerEntry = {
	amountCents: number;
	kind: StoreCreditLedgerKind;
	status?: 'available' | 'pending' | 'void';
};

const activeAmount = (entry: StoreCreditLedgerEntry) =>
	entry.status === 'void' ? 0 : entry.amountCents;

const storeCreditProgramBalance = (entries: StoreCreditLedgerEntry[]) =>
	entries
		.filter(
			({ kind, status }) =>
				(kind === 'funding' || kind === 'funding_reversal') &&
				status !== 'pending'
		)
		.reduce((total, entry) => total + activeAmount(entry), 0) -
	entries
		.filter(
			({ kind, status }) =>
				(kind === 'allocation' || kind === 'allocation_reversal') &&
				status !== 'pending'
		)
		.reduce((total, entry) => total + activeAmount(entry), 0);

const employeeStoreCreditBalance = (entries: StoreCreditLedgerEntry[]) =>
	Math.max(
		0,
		entries
			.filter(
				({ kind, status }) =>
					status !== 'pending' || kind === 'redemption'
			)
			.reduce((total, entry) => total + activeAmount(entry), 0)
	);

const normalizeCreditRecipient = (email: string) => email.trim().toLowerCase();

const authorizeStoreCredit = (input: {
	availableCents: number;
	orderTotalCents: number;
	requestedCents?: number;
}) => {
	const availableCents = Math.max(0, Math.floor(input.availableCents));
	const orderTotalCents = Math.max(0, Math.floor(input.orderTotalCents));
	const requestedCents = Math.max(
		0,
		Math.floor(input.requestedCents ?? orderTotalCents)
	);
	const appliedCents = Math.min(
		availableCents,
		orderTotalCents,
		requestedCents
	);

	return {
		appliedCents,
		paymentDueCents: orderTotalCents - appliedCents
	};
};

const storeCreditRefundPlan = (
	redemptions: Array<{
		amountCents: number;
		id: string;
		refundedCents?: number;
	}>,
	requestedCents?: number
) => {
	const refundableCents = redemptions.reduce(
		(sum, redemption) =>
			sum +
			Math.max(
				0,
				-redemption.amountCents - (redemption.refundedCents ?? 0)
			),
		0
	);
	let remainingCents = Math.min(
		refundableCents,
		Math.max(0, Math.floor(requestedCents ?? refundableCents))
	);
	const plan: Array<{ amountCents: number; redemptionId: string }> = [];
	for (const redemption of redemptions) {
		if (remainingCents < 1) break;
		const availableCents = Math.max(
			0,
			-redemption.amountCents - (redemption.refundedCents ?? 0)
		);
		const amountCents = Math.min(availableCents, remainingCents);
		if (amountCents > 0)
			plan.push({ amountCents, redemptionId: redemption.id });
		remainingCents -= amountCents;
	}

	return plan;
};

export {
	authorizeStoreCredit,
	employeeStoreCreditBalance,
	kitIsSellable,
	kitIssues,
	kitPriceCents,
	normalizeCreditRecipient,
	storeCreditRefundPlan,
	storeCreditProgramBalance
};

/** Allocate an authoritative kit total without losing pennies on multi-unit lines. */
export const allocateFixedKitPrice = (
	totalCents: number,
	lines: Array<{ id: string; quantity: number; unitPriceCents: number }>
) => {
	if (
		!Number.isSafeInteger(totalCents) ||
		totalCents < 0 ||
		!lines.length ||
		new Set(lines.map((line) => line.id)).size !== lines.length
	)
		throw new Error('Invalid fixed kit allocation');
	for (const line of lines)
		if (
			!Number.isSafeInteger(line.quantity) ||
			line.quantity < 1 ||
			!Number.isSafeInteger(line.unitPriceCents) ||
			line.unitPriceCents < 0
		)
			throw new Error('Invalid kit line price or quantity');
	const weights = lines.map(
		(line) => BigInt(line.quantity) * BigInt(line.unitPriceCents)
	);
	const sum = weights.reduce((total, weight) => total + weight, 0n);
	const effective = sum
		? weights
		: lines.map((line) => BigInt(line.quantity));
	const denominator = effective.reduce((total, weight) => total + weight, 0n);
	const shares = lines.map((line, index) => ({
		id: line.id,
		index,
		remainder: (BigInt(totalCents) * effective[index]!) % denominator,
		totalCents: Number(
			(BigInt(totalCents) * effective[index]!) / denominator
		)
	}));
	let remaining =
		totalCents -
		shares.reduce((total, share) => total + share.totalCents, 0);
	for (const share of [...shares].sort((a, b) => {
		if (a.remainder === b.remainder) return a.index - b.index;

		return a.remainder > b.remainder ? -1 : 1;
	})) {
		if (remaining-- <= 0) break;
		share.totalCents++;
	}

	return shares.map((share) => ({
		id: share.id,
		totalCents: share.totalCents
	}));
};

/** Validate one instance against the current kit, never the shopper's snapshot. */
export const kitCartIssues = (
	kit: CommerceKit,
	lines: Array<{
		kitId: string;
		componentId: string;
		listingId: string;
		variantId?: string;
		quantity: number;
	}>
) => {
	const issues: string[] = [];
	if (!lines.length) return ['The kit has no selected items.'];
	for (const line of lines) {
		if (
			line.kitId !== kit.id ||
			!kit.components.some(
				(component) => component.id === line.componentId
			)
		)
			issues.push('The kit contains an unrelated item.');
		if (!Number.isSafeInteger(line.quantity) || line.quantity < 1)
			issues.push('Kit quantities must be positive whole numbers.');
	}
	for (const component of kit.components) {
		const selected = lines.filter(
			(line) => line.componentId === component.id
		);
		if (!selected.length && !component.required) continue;
		if (
			selected.reduce((sum, line) => sum + line.quantity, 0) !==
			component.quantity
		)
			issues.push(
				`${component.name} requires exactly ${component.quantity} pieces when selected.`
			);
		if (
			selected.some(
				(line) =>
					line.listingId !== component.listingId ||
					(component.selectionMode === 'fixed_variant' &&
						line.variantId !== component.variantId)
			)
		)
			issues.push(
				`${component.name} must use its configured product and variant.`
			);
	}

	return [...new Set(issues)];
};
