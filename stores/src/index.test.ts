import { describe, expect, test } from 'bun:test';
import {
	calculateStoreEarningsCents,
	defaultStoreHostname,
	normalizeStoreHostname,
	normalizeStoreSlug,
	storeEarningBalance,
	storeEarningsReversal,
	storeLaunchReadiness,
	storeMemberCan,
	storeOwnerReviewIssues,
	storeThemeIssues,
	storeThemeIsValid,
	type StoreTheme
} from './index';

const theme: StoreTheme = {
	colors: {
		accent: '#0ea5e9',
		background: '#ffffff',
		foreground: '#111827',
		primary: '#1d4ed8',
		secondary: '#475569'
	},
	fonts: { body: 'Inter', heading: 'Inter' },
	hero: { headline: 'Company store' },
	navigation: [{ href: '/collections/all', label: 'Shop' }],
	sections: [
		{ enabled: true, id: 'featured', settings: {}, type: 'collection' }
	],
	templateKey: 'classic'
};

describe('store identity', () => {
	test('normalizes a customer name and creates its default domain', () => {
		expect(normalizeStoreSlug(' Acmé North East ')).toBe('acme-north-east');
		expect(
			defaultStoreHostname('Acme', 'https://corporatebrandstores.com')
		).toBe('acme.corporatebrandstores.com');
	});

	test('normalizes custom domains without paths, ports, or trailing dots', () => {
		expect(
			normalizeStoreHostname('HTTPS://Store.Example.com.:443/catalog')
		).toBe('store.example.com');
	});
});

describe('earnings ledger math', () => {
	test('holds accruals until available while applying reversals immediately', () => {
		const now = new Date('2026-09-01T12:00:00Z');
		expect(
			storeEarningBalance(
				[
					{
						amountCents: 2_000,
						availableAt: new Date('2026-09-10T12:00:00Z'),
						kind: 'accrual'
					},
					{
						amountCents: -500,
						availableAt: now,
						kind: 'refund'
					}
				],
				now
			)
		).toEqual({
			availableCents: 0,
			balanceCents: 1_500,
			pendingCents: 2_000
		});
	});

	test('a reversal can never exceed the earnings being replaced', () => {
		expect(
			storeEarningsReversal({
				currentEarningsCents: 1_200,
				nextEarningsCents: 300
			})
		).toBe(-900);
		expect(
			storeEarningsReversal({
				currentEarningsCents: 1_200,
				nextEarningsCents: -5_000
			})
		).toBe(-1_200);
	});
});

describe('store templates', () => {
	test('accepts the bounded template contract', () => {
		expect(storeThemeIsValid(theme)).toBeTrue();
	});

	test('rejects unsafe links and unknown template or section code', () => {
		expect(
			storeThemeIsValid({
				...theme,
				navigation: [{ href: 'javascript:alert(1)', label: 'Unsafe' }]
			})
		).toBeFalse();
		expect(
			storeThemeIsValid({ ...theme, templateKey: 'arbitrary' })
		).toBeFalse();
		expect(
			storeThemeIsValid({
				...theme,
				sections: [
					{ enabled: true, id: 'x', settings: {}, type: 'script' }
				]
			})
		).toBeFalse();
	});

	test('explains every correction needed by the template studio', () => {
		expect(
			storeThemeIssues({
				...theme,
				hero: {
					...theme.hero,
					headline: '',
					imageUrl: 'http://unsafe.example/hero.jpg'
				},
				navigation: [{ href: 'javascript:alert(1)', label: 'Unsafe' }]
			})
		).toEqual([
			'Add a hero headline.',
			'Use a secure hero image URL or an uploaded image.',
			'Correct every navigation label and destination.'
		]);
	});
});

describe('launch and earnings', () => {
	test('requires commercial terms before launch', () => {
		expect(
			storeLaunchReadiness({
				activeArtworkCount: 1,
				activeCatalogCount: 1,
				activeDomainCount: 1,
				activeOwnerCount: 1,
				earningsPolicy: null,
				paymentConfigured: true,
				theme
			})
		).toEqual({ issues: ['earnings_policy_missing'], ready: false });
	});

	test('requires a product catalog and approved artwork', () => {
		expect(
			storeLaunchReadiness({
				activeArtworkCount: 0,
				activeCatalogCount: 0,
				activeDomainCount: 1,
				activeOwnerCount: 1,
				earningsPolicy: {
					basisPoints: 1000,
					mode: 'percentage_of_sale'
				},
				paymentConfigured: true,
				theme
			})
		).toEqual({
			issues: ['catalog_missing', 'artwork_missing'],
			ready: false
		});
	});

	test('adds operational evidence to the production launch gate', () => {
		expect(
			storeLaunchReadiness({
				activeArtworkCount: 1,
				activeCatalogCount: 1,
				activeDomainCount: 1,
				activeOwnerCount: 1,
				earningsPolicy: {
					basisPoints: 1000,
					mode: 'percentage_of_sale'
				},
				operationalIssues: [
					'catalog_provider_sku_missing',
					'fulfillment_provider_missing'
				],
				paymentConfigured: true,
				theme
			})
		).toEqual({
			issues: [
				'catalog_provider_sku_missing',
				'fulfillment_provider_missing'
			],
			ready: false
		});
	});

	test('calculates a share of margin after production and payment costs', () => {
		expect(
			calculateStoreEarningsCents({
				paymentFeeCents: 300,
				policy: { basisPoints: 5000, mode: 'percentage_of_net_margin' },
				productionCents: 4000,
				quantity: 2,
				saleCents: 10_000
			})
		).toBe(2850);
	});
});

describe('store member permissions', () => {
	test('defines the complete least-privilege matrix', () => {
		const capabilities = [
			'manage_catalog',
			'manage_commercial_terms',
			'manage_members',
			'manage_theme',
			'publish_theme',
			'request_payout',
			'submit_artwork',
			'view_orders'
		] as const;
		const enabled = (role: Parameters<typeof storeMemberCan>[0]) =>
			capabilities.filter((capability) =>
				storeMemberCan(role, capability)
			);

		expect(enabled('owner')).toEqual([
			'manage_catalog',
			'manage_members',
			'manage_theme',
			'publish_theme',
			'request_payout',
			'submit_artwork',
			'view_orders'
		]);
		expect(enabled('admin')).toEqual(enabled('owner'));
		expect(enabled('designer')).toEqual(['manage_theme', 'submit_artwork']);
		expect(enabled('catalog_manager')).toEqual(['manage_catalog']);
		expect(enabled('order_manager')).toEqual(['view_orders']);
		expect(enabled('viewer')).toEqual(['view_orders']);
	});

	test('keeps commercial terms under CBS control', () => {
		for (const role of [
			'owner',
			'admin',
			'designer',
			'catalog_manager',
			'order_manager',
			'viewer'
		] as const)
			expect(storeMemberCan(role, 'manage_commercial_terms')).toBe(false);
	});

	test('separates design, catalog, order and payout responsibilities', () => {
		expect(storeMemberCan('designer', 'submit_artwork')).toBe(true);
		expect(storeMemberCan('designer', 'manage_catalog')).toBe(false);
		expect(storeMemberCan('catalog_manager', 'manage_catalog')).toBe(true);
		expect(storeMemberCan('order_manager', 'view_orders')).toBe(true);
		expect(storeMemberCan('viewer', 'request_payout')).toBe(false);
		expect(storeMemberCan('owner', 'request_payout')).toBe(true);
	});

	test('lets owners submit work while CBS finishes platform setup', () => {
		expect(
			storeOwnerReviewIssues([
				'artwork_missing',
				'artwork_provider_mapping_missing',
				'earnings_policy_missing',
				'fulfillment_provider_missing',
				'payment_missing'
			])
		).toEqual(['artwork_missing']);
	});
});


describe('homepage slides', () => {
 test('keeps legacy themes valid and accepts distinct additional slides', () => {
  expect(storeThemeIsValid(theme)).toBe(true);
  expect(storeThemeIsValid({...theme, hero: {...theme.hero, slides: [{id: 'campaign', headline: 'Team collection', imageUrl: 'https://example.com/banner.jpg', callToAction: {label: 'Shop team', href: '/collections/team'}}]}})).toBe(true);
 });
 test('rejects unsafe links, duplicate identities and too many slides', () => {
  const slide = {id: 'campaign', headline: 'Team collection'};
  for (const slides of [[{...slide, imageUrl: 'javascript:alert(1)'}], [{...slide, callToAction: {label: 'Shop', href: 'javascript:alert(1)'}}], [slide, slide], [{...slide, id: 'primary'}], Array.from({length: 8}, (_, index) => ({...slide, id: `slide-${index}`})), [{...slide, headline: ''}]]) {
   expect(storeThemeIsValid({...theme, hero: {...theme.hero, slides}})).toBe(false);
  }
 });
});
