import type { DecorationArea, ProductMedia } from "@absolutejs/commerce";
import { storeUrlIsSafe } from "./urls";

export type StoreMockupOverride = {
  color: string;
  placement: string;
  artworkUrl: string;
  photoUrl?: string;
  box?: [number, number, number, number];
  finishedImageUrl?: string;
};
const validBox = (box: unknown): box is [number, number, number, number] =>
  Array.isArray(box) &&
  box.length === 4 &&
  box.every(
    (value) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
  ) &&
  box[2] > 0 &&
  box[3] > 0 &&
  box[0] + box[2] <= 1 &&
  box[1] + box[3] <= 1;
export const parseStoreMockupOverrides = (
  raw: unknown,
): StoreMockupOverride[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 240)
    throw new Error("Use at most 240 product mockups.");
  const keys = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== "object")
      throw new Error("Invalid product mockup.");
    const item = value as Record<string, unknown>;
    for (const key of ["color", "placement"])
      if (
        typeof item[key] !== "string" ||
        !item[key].trim() ||
        item[key].length > 160
      )
        throw new Error("Choose a mockup color and placement.");
    for (const key of ["artworkUrl", "photoUrl", "finishedImageUrl"])
      if (
        (key === "artworkUrl" || item[key] !== undefined) &&
        (typeof item[key] !== "string" ||
          !item[key] ||
          item[key].length > 2000 ||
          !storeUrlIsSafe(item[key]))
      )
        throw new Error("Use safe mockup image URLs.");
    if (!item.finishedImageUrl && (!item.photoUrl || !validBox(item.box)))
      throw new Error(
        "Choose a supplier image and keep artwork inside its bounds.",
      );
    if (item.box !== undefined && !validBox(item.box))
      throw new Error("Keep artwork inside the mockup bounds.");
    const key = JSON.stringify([item.color, item.placement]);
    if (keys.has(key))
      throw new Error("Each color and placement can have one manual mockup.");
    keys.add(key);
    return {
      color: item.color as string,
      placement: item.placement as string,
      artworkUrl: item.artworkUrl as string,
      ...(item.photoUrl ? { photoUrl: item.photoUrl as string } : {}),
      ...(item.box ? { box: item.box as StoreMockupOverride["box"] } : {}),
      ...(item.finishedImageUrl
        ? { finishedImageUrl: item.finishedImageUrl as string }
        : {}),
    };
  });
};

export type StoreMockup = {
  finishedImageUrl?: string;
  color: string;
  placement: string;
  photoUrl: string;
  artworkUrl: string;
  box: [number, number, number, number];
};
/** Regenerate from current approved artwork and exact supplier photography. No guessed positions. */
export const storeMockups = (input: {
  colors: string[];
  overrides?: StoreMockupOverride[];
  areas: DecorationArea[];
  media: ProductMedia[];
  artwork: { url: string; method: string | null; placements: string[] };
}): StoreMockup[] =>
  input.colors.flatMap((color) =>
    input.areas.flatMap((area) => {
      if (input.artwork.method && !area.methods.includes(input.artwork.method))
        return [];
      if (
        input.artwork.placements.length &&
        !input.artwork.placements.includes(area.id)
      )
        return [];

      const manual = input.overrides?.find(
        (entry) =>
          entry.color === color &&
          entry.placement === area.id &&
          entry.artworkUrl === input.artwork.url,
      );
      if (manual?.finishedImageUrl && storeUrlIsSafe(manual.finishedImageUrl))
        return [
          {
            color,
            placement: area.id,
            photoUrl: manual.finishedImageUrl,
            artworkUrl: input.artwork.url,
            box: [0, 0, 1, 1] as StoreMockup["box"],
            finishedImageUrl: manual.finishedImageUrl,
          },
        ];
      if (
        manual?.photoUrl &&
        validBox(manual.box) &&
        input.media.some(
          (photo) =>
            photo.source === "supplier" &&
            photo.color === color &&
            photo.url === manual.photoUrl,
        )
      )
        return [
          {
            color,
            placement: area.id,
            photoUrl: manual.photoUrl,
            artworkUrl: input.artwork.url,
            box: manual.box,
          },
        ];
      const raw = area.metadata?.previewBox;
      const record =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      let box: unknown = null;
      if (Array.isArray(raw)) box = raw;
      else if (raw && typeof raw === "object")
        box = [record.x, record.y, record.width, record.height];
      if (
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every(
          (value) =>
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 1,
        ) ||
        box[2] <= 0 ||
        box[3] <= 0 ||
        box[0] + box[2] > 1 ||
        box[1] + box[3] > 1
      )
        return [];
      const view =
        area.metadata?.view ??
        (["front", "back", "left", "right"].includes(area.id)
          ? area.id
          : undefined);
      if (typeof view !== "string") return [];
      const photo = input.media.find(
        (media) =>
          media.color === color &&
          media.view === view &&
          media.source === "supplier",
      );

      return photo
        ? [
            {
              artworkUrl: input.artwork.url,
              box: box as StoreMockup["box"],
              color,
              photoUrl: photo.url,
              placement: area.id,
            },
          ]
        : [];
    }),
  );
