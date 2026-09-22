import type { DecorationArea, ProductMedia } from '@absolutejs/commerce';

export type StoreMockup = {
	color: string;
	placement: string;
	photoUrl: string;
	artworkUrl: string;
	box: [number, number, number, number];
};
/** Regenerate from current approved artwork and exact supplier photography. No guessed positions. */
export const storeMockups = (input: {
	colors: string[];
	areas: DecorationArea[];
	media: ProductMedia[];
	artwork: { url: string; method: string | null; placements: string[] };
}): StoreMockup[] =>
	input.colors.flatMap((color) =>
		input.areas.flatMap((area) => {
			if (
				input.artwork.method &&
				!area.methods.includes(input.artwork.method)
			)
				return [];
			if (
				input.artwork.placements.length &&
				!input.artwork.placements.includes(area.id)
			)
				return [];
			const raw = area.metadata?.previewBox;
			const record =
				raw && typeof raw === 'object'
					? (raw as Record<string, unknown>)
					: {};
			let box: unknown = null;
			if (Array.isArray(raw)) box = raw;
			else if (raw && typeof raw === 'object')
				box = [record.x, record.y, record.width, record.height];
			if (
				!Array.isArray(box) ||
				box.length !== 4 ||
				!box.every(
					(value) =>
						typeof value === 'number' &&
						Number.isFinite(value) &&
						value >= 0 &&
						value <= 1
				) ||
				box[2] <= 0 ||
				box[3] <= 0 ||
				box[0] + box[2] > 1 ||
				box[1] + box[3] > 1
			)
				return [];
			const view =
				area.metadata?.view ??
				(['front', 'back', 'left', 'right'].includes(area.id)
					? area.id
					: undefined);
			if (typeof view !== 'string') return [];
			const photo = input.media.find(
				(media) =>
					media.color === color &&
					media.view === view &&
					media.source === 'supplier'
			);

			return photo
				? [
						{
							artworkUrl: input.artwork.url,
							box: box as StoreMockup['box'],
							color,
							photoUrl: photo.url,
							placement: area.id
						}
					]
				: [];
		})
	);
