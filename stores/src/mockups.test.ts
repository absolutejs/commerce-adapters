import { expect, test } from 'bun:test';
import { storeMockups } from './mockups';
const input: Parameters<typeof storeMockups>[0] = {
	areas: [
		{
			heightIn: 4,
			id: 'front',
			metadata: { previewBox: [0.3, 0.2, 0.4, 0.4], view: 'front' },
			methods: ['dtf'],
			name: 'Front',
			widthIn: 4
		}
	],
	artwork: {
		method: 'dtf',
		placements: ['front'],
		url: 'https://artwork.example/logo.png'
	},
	colors: ['Black', 'Red'],
	media: [
		{
			color: 'Black',
			kind: 'image',
			source: 'supplier',
			url: 'https://supplier.example/black.jpg',
			view: 'front'
		}
	]
};
test('thumbnails require exact color photography and compatible calibrated artwork', () => {
	expect(storeMockups(input)).toHaveLength(1);
	expect(
		storeMockups({
			...input,
			artwork: { ...input.artwork, method: 'embroidery' }
		})
	).toHaveLength(0);
	expect(
		storeMockups({
			...input,
			areas: input.areas.map((area) => ({ ...area, metadata: {} }))
		})
	).toHaveLength(0);
	expect(
		storeMockups({
			...input,
			areas: input.areas.map((area) => ({
				...area,
				metadata: { previewBox: [0.9, 0.2, 0.4, 0.4], view: 'front' }
			}))
		})
	).toHaveLength(0);
});
