import { defineImplementation, defineManifest } from '@absolutejs/manifest';
import type { FulfillmentProvider } from '@absolutejs/commerce';
import { Type } from '@sinclair/typebox';
import type { CustomCatConfig } from './index';

export const manifest = defineManifest<CustomCatConfig, FulfillmentProvider>()({
	contract: 1,
	identity: {
		accent: '#f05a28',
		category: 'commerce',
		description:
			'CustomCat print-on-demand adapter implementing `FulfillmentProvider` for `@absolutejs/commerce`: submit external-design orders, poll production status, cancel orders, and normalize shipment tracking.',
		docsUrl:
			'https://github.com/absolutejs/commerce-adapters/tree/main/customcat',
		name: '@absolutejs/commerce-customcat',
		tagline: 'Print and drop-ship commerce orders with CustomCat.'
	},
	implements: [
		defineImplementation<CustomCatConfig>()({
			contract: 'commerce/fulfillment-provider',
			factory: 'createCustomCatFulfillment',
			from: '@absolutejs/commerce-customcat',
			requires: {
				env: [
					{
						description: 'CustomCat API Store read/write key',
						docsUrl: 'https://help.customcat.com/generate-an-api-key',
						key: 'CUSTOMCAT_API_KEY',
						secret: true
					}
				]
			},
			settings: Type.Object({
				sandbox: Type.Optional(
					Type.Boolean({
						default: true,
						description:
							'Simulate submissions without creating paid production orders.',
						title: 'Sandbox mode'
					})
				),
				shippingMethod: Type.Optional(
					Type.String({
						default: 'Economy',
						description:
							'Default CustomCat shipping method when an order does not choose one.',
						title: 'Default shipping method'
					})
				)
			}),
			title: 'CustomCat fulfillment',
			wiring: {
				code: 'createCustomCatFulfillment({ apiKey: ${env.CUSTOMCAT_API_KEY} ?? "", ...${settings} })',
				imports: [
					{
						from: '@absolutejs/commerce-customcat',
						names: ['createCustomCatFulfillment']
					}
				]
			}
		})
	],
	settings: Type.Object({}),
	wiring: []
});
