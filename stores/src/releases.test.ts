import { describe, expect, test } from 'bun:test';
import {
	diffStorefrontReleases,
	serializeStorefrontReleaseContent,
	storefrontPreviewPath,
	storefrontReleaseContent,
	storefrontScopedPreviewPath,
	storefrontReleaseTransition,
	type StorefrontReleaseSnapshot
} from './releases';

const snapshot = (
	overrides: Partial<StorefrontReleaseSnapshot> = {}
): StorefrontReleaseSnapshot => ({
	capturedAt: '2026-09-01T12:00:00.000Z',
	catalog: { currency: 'USD', id: 'catalog', locale: 'en-US', slug: 'shop' },
	collections: [],
	listings: [],
	pages: [],
	schema: 'cbs-storefront-release-v1',
	theme: {
		colors: {
			accent: '#444444',
			background: '#ffffff',
			foreground: '#111111',
			primary: '#222222',
			secondary: '#333333'
		},
		fonts: { body: 'Inter', heading: 'Inter' },
		hero: { headline: 'Shop' },
		navigation: [],
		sections: [],
		templateKey: 'classic'
	},
	...overrides
});

describe('storefront release contract', () => {
	test('requires CBS approval before publish or scheduling', () => {
		expect(storefrontReleaseTransition('preview', 'publish')).toBeNull();
		expect(storefrontReleaseTransition('preview', 'submit')).toBe(
			'pending_approval'
		);
		expect(storefrontReleaseTransition('pending_approval', 'approve')).toBe(
			'approved'
		);
		expect(storefrontReleaseTransition('approved', 'schedule')).toBe(
			'scheduled'
		);
		expect(storefrontReleaseTransition('scheduled', 'publish')).toBe(
			'published'
		);
	});

	test('scopes internal preview links and disables unsupported commerce paths', () => {
		expect(storefrontPreviewPath('safe token', '/pages/about')).toBe(
			'/store-preview/releases/safe%20token/pages/about'
		);
		expect(storefrontPreviewPath('safe token', '/checkout')).toBe(
			'/store-preview/releases/safe%20token#preview-only'
		);
		expect(
			storefrontScopedPreviewPath(
				'/admin/releases/release-1',
				'/products/tee'
			)
		).toBe('/admin/releases/release-1/products/tee');
		expect(
			storefrontScopedPreviewPath(
				'/admin/releases/release-1',
				'/checkout'
			)
		).toBe('/admin/releases/release-1#preview-only');
	});

	test('diffs release entities and store design fields', () => {
		const previous = snapshot({
			collections: [
				{
					description: null,
					id: 'old-collection',
					imageUrl: null,
					listingIds: [],
					position: 0,
					slug: 'old',
					status: 'active',
					title: 'Old collection'
				}
			],
			pages: [
				{
					id: 'about',
					metadata: {},
					position: 0,
					sections: [],
					slug: 'about',
					title: 'About'
				}
			]
		});
		const next = snapshot({
			listings: [
				{
					id: 'listing',
					position: 0,
					productId: 'tee',
					slug: 'team-tee',
					status: 'active'
				}
			],
			pages: [
				{
					id: 'about',
					metadata: {},
					position: 0,
					sections: [],
					slug: 'our-story',
					title: 'Our story'
				}
			],
			theme: {
				...previous.theme,
				colors: { ...previous.theme.colors, primary: '#0055aa' }
			}
		});
		const diff = diffStorefrontReleases(previous, next);

		expect(diff.hasChanges).toBe(true);
		expect(diff.theme).toEqual(['colors']);
		expect(diff.pages.changed).toEqual(['Our story']);
		expect(diff.listings.added).toEqual(['team-tee']);
		expect(diff.collections.removed).toEqual(['Old collection']);
	});

	test('compares release content without capture timestamps', () => {
		const first = snapshot();
		const second = snapshot({ capturedAt: '2026-09-02T12:00:00.000Z' });

		expect(storefrontReleaseContent(first)).toEqual(
			storefrontReleaseContent(second)
		);
		expect(serializeStorefrontReleaseContent(first)).toBe(
			serializeStorefrontReleaseContent({
				...second,
				theme: {
					colors: second.theme.colors,
					fonts: second.theme.fonts,
					hero: second.theme.hero,
					navigation: second.theme.navigation,
					sections: second.theme.sections,
					templateKey: second.theme.templateKey
				}
			})
		);
	});
});
