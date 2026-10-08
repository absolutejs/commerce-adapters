import { describe, expect, test } from 'bun:test';
import {
	authorizeStoreCredit,
	employeeStoreCreditBalance,
	kitIsSellable,
	kitPriceCents,
	storeCreditRefundPlan,
	storeCreditProgramBalance,
	type CommerceKit
} from '.';

const kit: CommerceKit = {
	components: [
		{
			id: 'shirt',
			listingId: 'listing-shirt',
			name: 'Shirt',
			quantity: 2,
			required: true,
			selectionMode: 'shopper_variant'
		},
		{
			id: 'hat',
			listingId: 'listing-hat',
			name: 'Hat',
			quantity: 1,
			required: true,
			selectionMode: 'fixed_variant',
			variantId: 'hat-black'
		}
	],
	description: 'New hire uniform',
	id: 'kit-1',
	name: 'New hire kit',
	price: { mode: 'component_total' },
	status: 'active'
};

describe('commerce kits', () => {
	test('requires a valid active multi-item kit', () => {
		expect(kitIsSellable(kit)).toBeTrue();
		expect(
			kitIsSellable({ ...kit, components: kit.components.slice(0, 1) })
		).toBeFalse();
	});

	test('supports component totals and a fixed program price', () => {
		const components = [
			{ quantity: 2, unitPriceCents: 1_500 },
			{ quantity: 1, unitPriceCents: 2_000 }
		];
		expect(kitPriceCents({ mode: 'component_total' }, components)).toBe(
			5_000
		);
		expect(
			kitPriceCents({ amountCents: 4_500, mode: 'fixed' }, components)
		).toBe(4_500);
	});
});

describe('employer-funded store credit', () => {
	test('keeps company funding and employee allocations independently auditable', () => {
		expect(
			storeCreditProgramBalance([
				{ amountCents: 100_000, kind: 'funding' },
				{ amountCents: 15_000, kind: 'allocation' },
				{ amountCents: -5_000, kind: 'allocation_reversal' }
			])
		).toBe(90_000);
		expect(
			employeeStoreCreditBalance([
				{ amountCents: 15_000, kind: 'allocation' },
				{ amountCents: -4_000, kind: 'redemption' },
				{ amountCents: -2_000, kind: 'redemption', status: 'pending' }
			])
		).toBe(9_000);
	});

	test('uses available credit first and leaves only the remainder for payment', () => {
		expect(
			authorizeStoreCredit({
				availableCents: 7_500,
				orderTotalCents: 10_000
			})
		).toEqual({ appliedCents: 7_500, paymentDueCents: 2_500 });
	});

	test('restores each original redemption once and caps partial refunds', () => {
		expect(
			storeCreditRefundPlan(
				[
					{ amountCents: -5_000, id: 'first', refundedCents: 1_000 },
					{ amountCents: -3_000, id: 'second' }
				],
				5_000
			)
		).toEqual([
			{ amountCents: 4_000, redemptionId: 'first' },
			{ amountCents: 1_000, redemptionId: 'second' }
		]);
		expect(
			storeCreditRefundPlan([
				{ amountCents: -5_000, id: 'first', refundedCents: 5_000 }
			])
		).toEqual([]);
	});
});
