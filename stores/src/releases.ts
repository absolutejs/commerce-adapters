import type { StoreTheme } from './index';

export const STOREFRONT_PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const STOREFRONT_RELEASE_SCHEMA = 'cbs-storefront-release-v1' as const;

export type StorefrontReleaseStatus =
	| 'preview'
	| 'pending_approval'
	| 'changes_requested'
	| 'approved'
	| 'scheduled'
	| 'published'
	| 'cancelled';

export type StorefrontReleaseListing = {
	id: string;
	position: number;
	productId: string;
	slug: string;
	status: string;
};

export type StorefrontReleaseCollection = {
	description: string | null;
	id: string;
	imageUrl: string | null;
	listingIds: string[];
	position: number;
	slug: string;
	status: string;
	title: string;
};

export type StorefrontReleasePage = {
	id: string;
	metadata: Record<string, unknown>;
	position: number;
	sections: StoreTheme['sections'];
	slug: string;
	title: string;
};

export type StorefrontReleaseSnapshot = {
	capturedAt: string;
	catalog: {
		currency: string;
		id: string;
		locale: string;
		slug: string;
	};
	collections: StorefrontReleaseCollection[];
	listings: StorefrontReleaseListing[];
	pages: StorefrontReleasePage[];
	schema: typeof STOREFRONT_RELEASE_SCHEMA;
	theme: StoreTheme;
};

export type StorefrontReleaseEntityDiff = {
	added: string[];
	changed: string[];
	removed: string[];
};

export type StorefrontReleaseDiff = {
	collections: StorefrontReleaseEntityDiff;
	hasChanges: boolean;
	listings: StorefrontReleaseEntityDiff;
	pages: StorefrontReleaseEntityDiff;
	theme: string[];
};

const entityDiff = <Entity extends { id: string }>(
	previous: Entity[],
	next: Entity[],
	label: (entity: Entity) => string
): StorefrontReleaseEntityDiff => {
	const before = new Map(previous.map((entity) => [entity.id, entity]));
	const after = new Map(next.map((entity) => [entity.id, entity]));

	return {
		added: next.filter((entity) => !before.has(entity.id)).map(label),
		changed: next
			.filter((entity) => {
				const prior = before.get(entity.id);

				return (
					prior && JSON.stringify(prior) !== JSON.stringify(entity)
				);
			})
			.map(label),
		removed: previous.filter((entity) => !after.has(entity.id)).map(label)
	};
};

export const applyReleaseCatalogOrder = <Item extends { id: string }>(
	items: Item[],
	snapshot?: StorefrontReleaseSnapshot | null
) => {
	if (!snapshot) return items;
	const positions = new Map(
		releaseVisibleProductIds(snapshot).map((id, position) => [id, position])
	);

	return items
		.filter((item) => positions.has(item.id))
		.sort(
			(left, right) =>
				(positions.get(left.id) ?? 0) - (positions.get(right.id) ?? 0)
		);
};
export const diffStorefrontReleases = (
	previous: StorefrontReleaseSnapshot | null,
	next: StorefrontReleaseSnapshot
): StorefrontReleaseDiff => {
	const before = previous ?? {
		...next,
		collections: [],
		listings: [],
		pages: []
	};
	const themeFields: Array<keyof StoreTheme> = [
		'headerText',
		'footerText',
		'colors',
		'faviconUrl',
		'fonts',
		'hero',
		'logoUrl',
		'navigation',
		'sections',
		'templateKey'
	];
	const theme = themeFields.filter(
		(field) =>
			JSON.stringify(before.theme[field]) !==
			JSON.stringify(next.theme[field])
	);
	const collections = entityDiff(
		before.collections,
		next.collections,
		(collection) => collection.title
	);
	const listings = entityDiff(
		before.listings,
		next.listings,
		(listing) => listing.slug
	);
	const pages = entityDiff(before.pages, next.pages, (page) => page.title);
	const groups = [collections, listings, pages];

	return {
		collections,
		hasChanges:
			theme.length > 0 ||
			groups.some((group) =>
				[group.added, group.changed, group.removed].some(
					(items) => items.length > 0
				)
			),
		listings,
		pages,
		theme
	};
};
export const releaseCollection = (
	snapshot: StorefrontReleaseSnapshot,
	slug: string
) =>
	snapshot.collections.find(
		(collection) =>
			collection.slug === slug && collection.status === 'active'
	) ?? null;
export const releasePage = (
	snapshot: StorefrontReleaseSnapshot,
	slug: string
) => snapshot.pages.find((page) => page.slug === slug) ?? null;
export const releaseVisibleProductIds = (snapshot: StorefrontReleaseSnapshot) =>
	snapshot.listings
		.filter((listing) => listing.status === 'active')
		.sort((left, right) => left.position - right.position)
		.map((listing) => listing.productId);
export const storefrontPreviewPath = (token: string, href: string) =>
	storefrontScopedPreviewPath(
		`/store-preview/releases/${encodeURIComponent(token)}`,
		href
	);
export const storefrontPreviewSections = (
	sections: StoreTheme['sections'],
	token: string
) =>
	sections.map((section) => ({
		...section,
		settings: {
			...section.settings,
			...(typeof section.settings.href === 'string'
				? {
						href: storefrontPreviewPath(
							token,
							section.settings.href
						)
					}
				: {}),
			...(typeof section.settings.collection === 'string'
				? {
						href: storefrontPreviewPath(
							token,
							`/collections/${section.settings.collection}`
						)
					}
				: {})
		}
	}));
export const storefrontPreviewTheme = (theme: StoreTheme, token: string) =>
	storefrontScopedPreviewTheme(
		theme,
		`/store-preview/releases/${encodeURIComponent(token)}`
	);
export const storefrontReleaseContent = (
	snapshot: StorefrontReleaseSnapshot
) => ({
	catalog: snapshot.catalog,
	collections: snapshot.collections,
	listings: snapshot.listings,
	pages: snapshot.pages,
	schema: snapshot.schema,
	theme: snapshot.theme
});
const stableJson = (value: unknown): string => {
	if (Array.isArray(value))
		return `[${value
			.map((item) => (item === undefined ? 'null' : stableJson(item)))
			.join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(',')}}`;

	return JSON.stringify(value);
};
export const serializeStorefrontReleaseContent = (
	snapshot: StorefrontReleaseSnapshot
) => stableJson(storefrontReleaseContent(snapshot));
export const storefrontReleaseTransition = (
	status: StorefrontReleaseStatus,
	action: 'approve' | 'publish' | 'request_changes' | 'schedule' | 'submit'
) => {
	const transitions: Partial<
		Record<
			StorefrontReleaseStatus,
			Partial<Record<typeof action, StorefrontReleaseStatus>>
		>
	> = {
		approved: { publish: 'published', schedule: 'scheduled' },
		pending_approval: {
			approve: 'approved',
			request_changes: 'changes_requested'
		},
		preview: { submit: 'pending_approval' },
		scheduled: { publish: 'published' }
	};

	return transitions[status]?.[action] ?? null;
};
export const storefrontScopedPreviewPath = (base: string, href: string) => {
	if (href === '/' || href.startsWith('/#')) return `${base}${href.slice(1)}`;
	for (const prefix of ['/pages/', '/collections/', '/products/'])
		if (href.startsWith(prefix)) return `${base}${href}`;
	if (href.startsWith('#')) return `${base}${href}`;
	if (href.startsWith('https://')) return href;

	return `${base}#preview-only`;
};
export const storefrontScopedPreviewSections = (
	sections: StoreTheme['sections'],
	base: string
) =>
	sections.map((section) => ({
		...section,
		settings: {
			...section.settings,
			...(typeof section.settings.href === 'string'
				? {
						href: storefrontScopedPreviewPath(
							base,
							section.settings.href
						)
					}
				: {}),
			...(typeof section.settings.collection === 'string'
				? {
						href: storefrontScopedPreviewPath(
							base,
							`/collections/${section.settings.collection}`
						)
					}
				: {})
		}
	}));
export const storefrontScopedPreviewTheme = (
	theme: StoreTheme,
	base: string
) => {
	const navigation = (
		items: StoreTheme['navigation']
	): StoreTheme['navigation'] =>
		items.map((item) => ({
			...item,
			...(item.children ? { children: navigation(item.children) } : {}),
			href: storefrontScopedPreviewPath(base, item.href)
		}));

	return {
		...theme,
		hero: {
			...theme.hero,
			...(theme.hero.callToAction
				? {
						callToAction: {
							...theme.hero.callToAction,
							href: storefrontScopedPreviewPath(
								base,
								theme.hero.callToAction.href
							)
						}
					}
				: {})
		},
		navigation: navigation(theme.navigation)
	};
};
