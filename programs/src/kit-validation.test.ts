import { describe, expect, test } from 'bun:test';
import {
	allocateFixedKitPrice,
	kitCartIssues,
	type CommerceKit
} from './index';
const kit: CommerceKit = {
	components: [
		{
			id: 'shirt',
			listingId: 'shirt-listing',
			name: 'Shirt',
			quantity: 2,
			required: true,
			selectionMode: 'fixed_variant',
			variantId: 'black-large'
		},
		{
			id: 'cap',
			listingId: 'cap-listing',
			name: 'Cap',
			quantity: 1,
			required: false,
			selectionMode: 'shopper_variant'
		}
	],
	description: '',
	id: 'kit',
	name: 'Uniform set',
	price: { amountCents: 1001, mode: 'fixed' },
	status: 'active'
};
const shirt = {
	componentId: 'shirt',
	kitId: 'kit',
	listingId: 'shirt-listing',
	quantity: 2,
	variantId: 'black-large'
};
describe('authoritative kit membership', () => {
	test('optional items may be omitted while fixed quantity and variant remain enforced', () => {
		expect(kitCartIssues(kit, [shirt])).toEqual([]);
		expect(kitCartIssues(kit, [{ ...shirt, quantity: 1 }])).not.toEqual([]);
		expect(
			kitCartIssues(kit, [{ ...shirt, variantId: 'red-small' }])
		).not.toEqual([]);
		expect(
			kitCartIssues(kit, [{ ...shirt, listingId: 'unrelated' }])
		).not.toEqual([]);
	});
	test('included optional items require exact quantity', () => {
		const cap = {
			componentId: 'cap',
			kitId: 'kit',
			listingId: 'cap-listing',
			quantity: 1
		};
		expect(kitCartIssues(kit, [shirt, cap])).toEqual([]);
		expect(
			kitCartIssues(kit, [shirt, { ...cap, quantity: 2 }])
		).not.toEqual([]);
	});
	test('split lines sum quantities but cannot mix kits or unknown components', () => {
		expect(
			kitCartIssues(kit, [
				{ ...shirt, quantity: 1 },
				{ ...shirt, quantity: 1 }
			])
		).toEqual([]);
		expect(kitCartIssues(kit, [{ ...shirt, kitId: 'other' }])).not.toEqual(
			[]
		);
		expect(
			kitCartIssues(kit, [shirt, { ...shirt, componentId: 'invented' }])
		).not.toEqual([]);
		expect(kitCartIssues(kit, [])).not.toEqual([]);
		expect(kitCartIssues(kit, [{ ...shirt, quantity: NaN }])).not.toEqual(
			[]
		);
	});
});
describe('fixed kit allocation', () => {
	test('keeps every penny across unequal multiple-unit lines', () => {
		const result = allocateFixedKitPrice(1001, [
			{ id: 'shirt', quantity: 2, unitPriceCents: 300 },
			{ id: 'cap', quantity: 1, unitPriceCents: 300 }
		]);
		expect(result).toEqual([
			{ id: 'shirt', totalCents: 667 },
			{ id: 'cap', totalCents: 334 }
		]);
		expect(result.reduce((sum, line) => sum + line.totalCents, 0)).toBe(
			1001
		);
	});
	test('zero base prices and sub-unit-cent allocations remain exact', () => {
		expect(
			allocateFixedKitPrice(1, [
				{ id: 'a', quantity: 2, unitPriceCents: 0 },
				{ id: 'b', quantity: 1, unitPriceCents: 0 }
			])
		).toEqual([
			{ id: 'a', totalCents: 1 },
			{ id: 'b', totalCents: 0 }
		]);
		expect(
			allocateFixedKitPrice(0, [
				{ id: 'a', quantity: 2, unitPriceCents: 99 }
			])
		).toEqual([{ id: 'a', totalCents: 0 }]);
	});
	test('rejects ambiguous IDs or invalid money', () => {
		expect(() =>
			allocateFixedKitPrice(1, [
				{ id: 'a', quantity: 0, unitPriceCents: 1 }
			])
		).toThrow();
		expect(() =>
			allocateFixedKitPrice(1, [
				{ id: 'a', quantity: 1, unitPriceCents: -1 }
			])
		).toThrow();
		expect(() =>
			allocateFixedKitPrice(1.1, [
				{ id: 'a', quantity: 1, unitPriceCents: 1 }
			])
		).toThrow();
		expect(() =>
			allocateFixedKitPrice(1, [
				{ id: 'a', quantity: 1, unitPriceCents: 1 },
				{ id: 'a', quantity: 1, unitPriceCents: 1 }
			])
		).toThrow();
	});
});
