import { describe, expect, test } from 'bun:test';
import {
	defaultStoreOperatingPolicy,
	parseStoreOperatingPolicy,
	storeProductSelectionIssues,
	storeRetailPriceCents,
	storeShippingQuote
} from './policies';

describe('store operating policies', () => {
	test('validates contact data and rejects invalid monetary or shipping rules', () => {
		const policy = defaultStoreOperatingPolicy();
		expect(parseStoreOperatingPolicy(policy)).toEqual(policy);
		expect(() =>
			parseStoreOperatingPolicy({
				...policy,
				company: { ...policy.company, email: 'not-an-email' }
			})
		).toThrow('email');
		expect(() =>
			parseStoreOperatingPolicy({ ...policy, retailMarginBps: 10000 })
		).toThrow('margin');
		expect(() =>
			parseStoreOperatingPolicy({
				...policy,
				billing: { ...policy.billing, renewalMonths: 0 }
			})
		).toThrow('Renewal');
		expect(() =>
			parseStoreOperatingPolicy({
				...policy,
				secondImpressionCents: { dtf: -1 }
			})
		).toThrow('Second impression');
		expect(() =>
			parseStoreOperatingPolicy({
				...policy,
				shipping: { ...policy.shipping, countries: ['United States'] }
			})
		).toThrow('country codes');
	});
	test('requires destination approval even when an order qualifies for free shipping', () => {
		const policy = {
			...defaultStoreOperatingPolicy().shipping,
			enabled: true,
			freeThresholdCents: 10000
		};
		const order = {
			carrierCents: 1200,
			country: 'US',
			state: 'NY',
			subtotalCents: 10000
		};
		expect(storeShippingQuote(policy, order).amountCents).toBe(0);
		expect(() =>
			storeShippingQuote(policy, { ...order, state: 'AK' })
		).toThrow('not available');
		expect(() =>
			storeShippingQuote(policy, { ...order, country: 'CA' })
		).toThrow('not available');
		expect(() =>
			storeShippingQuote({ ...policy, enabled: false }, order)
		).toThrow('not available');
	});
	test('keeps regional and international surcharges separate from waived base freight', () => {
		const policy = {
			...defaultStoreOperatingPolicy().shipping,
			alaskaSurchargeCents: 700,
			allowAlaska: true,
			allowHawaii: true,
			countries: ['US', 'CA'],
			enabled: true,
			freeThresholdCents: 10000,
			hawaiiSurchargeCents: 900,
			internationalSurchargeCents: 1500
		};
		const order = {
			carrierCents: 1200,
			country: 'US',
			state: 'AK',
			subtotalCents: 12000
		};
		expect(storeShippingQuote(policy, order).amountCents).toBe(1900);
		expect(
			storeShippingQuote({ ...policy, freeNonContiguous: true }, order)
				.amountCents
		).toBe(700);
		expect(
			storeShippingQuote(policy, { ...order, state: 'HI' }).amountCents
		).toBe(2100);
		expect(
			storeShippingQuote(policy, { ...order, country: 'CA', state: 'ON' })
				.amountCents
		).toBe(2700);
	});
	test('prices additional impressions by their own method and rounds margin upward', () => {
		expect(
			storeRetailPriceCents({
				costCents: 1000,
				currentPriceCents: 1000,
				marginBps: 3333,
				methods: ['embroidery', 'dtf', 'embroidery'],
				secondImpressionCents: { dtf: 500, embroidery: 700 }
			})
		).toBe(2700);
		expect(() =>
			storeRetailPriceCents({
				costCents: null,
				currentPriceCents: 1000,
				marginBps: 4000,
				methods: [],
				secondImpressionCents: {}
			})
		).toThrow('verified cost');
	});
	test('blocks a forbidden color, decoration method or placement', () => {
		const policy = {
			category: 'Polos',
			colors: ['Navy'],
			methods: ['embroidery'],
			placements: ['left-chest']
		};
		expect(
			storeProductSelectionIssues(policy, {
				color: 'Navy',
				methods: ['embroidery'],
				placements: ['left-chest']
			})
		).toEqual([]);
		expect(
			storeProductSelectionIssues(policy, {
				color: 'Red',
				methods: ['dtf'],
				placements: ['back']
			})
		).toHaveLength(3);
	});
});
