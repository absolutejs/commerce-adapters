import { expect, test } from "bun:test";
import { parseStoreMockupOverrides, storeMockups } from "./mockups";
const input: Parameters<typeof storeMockups>[0] = {
  areas: [
    {
      heightIn: 4,
      id: "front",
      metadata: { previewBox: [0.3, 0.2, 0.4, 0.4], view: "front" },
      methods: ["dtf"],
      name: "Front",
      widthIn: 4,
    },
  ],
  artwork: {
    method: "dtf",
    placements: ["front"],
    url: "https://artwork.example/logo.png",
  },
  colors: ["Black", "Red"],
  media: [
    {
      color: "Black",
      kind: "image",
      source: "supplier",
      url: "https://supplier.example/black.jpg",
      view: "front",
    },
  ],
};
test("thumbnails require exact color photography and compatible calibrated artwork", () => {
  expect(storeMockups(input)).toHaveLength(1);
  expect(
    storeMockups({
      ...input,
      artwork: { ...input.artwork, method: "embroidery" },
    }),
  ).toHaveLength(0);
  expect(
    storeMockups({
      ...input,
      areas: input.areas.map((area) => ({ ...area, metadata: {} })),
    }),
  ).toHaveLength(0);
  expect(
    storeMockups({
      ...input,
      areas: input.areas.map((area) => ({
        ...area,
        metadata: { previewBox: [0.9, 0.2, 0.4, 0.4], view: "front" },
      })),
    }),
  ).toHaveLength(0);
});

test("manual previews bind exact supplier color and artwork without changing production areas", () => {
  const override = {
    color: "Black",
    placement: "front",
    artworkUrl: input.artwork.url,
    photoUrl: input.media[0]!.url,
    box: [0.1, 0.1, 0.2, 0.2] as [number, number, number, number],
  };
  const overrides = parseStoreMockupOverrides([override]);
  const uncalibrated = {
    ...input,
    areas: input.areas.map((area) => ({ ...area, metadata: {} })),
    overrides,
  };
  expect(storeMockups(uncalibrated)[0]?.box).toEqual(override.box);
  expect(storeMockups({ ...uncalibrated, colors: ["Red"] })).toHaveLength(0);
  expect(
    storeMockups({
      ...uncalibrated,
      artwork: { ...input.artwork, url: "https://artwork.example/changed.png" },
    }),
  ).toHaveLength(0);
  expect(
    storeMockups({
      ...uncalibrated,
      artwork: { ...input.artwork, method: "embroidery" },
    }),
  ).toHaveLength(0);
  expect(
    storeMockups({
      ...uncalibrated,
      overrides: [{ ...override, photoUrl: "https://wrong.example/red.jpg" }],
    }),
  ).toHaveLength(0);
  expect(input.areas[0]?.metadata?.previewBox).toEqual([0.3, 0.2, 0.4, 0.4]);
});
test("finished mockups are previews and unsafe or ambiguous overrides are rejected", () => {
  const finished = {
    color: "Black",
    placement: "front",
    artworkUrl: input.artwork.url,
    finishedImageUrl: "https://upload.example/finished.png",
  };
  expect(
    storeMockups({
      ...input,
      overrides: parseStoreMockupOverrides([finished]),
    })[0]?.finishedImageUrl,
  ).toBe(finished.finishedImageUrl);
  for (const value of [
    [finished, finished],
    [{ ...finished, finishedImageUrl: "javascript:alert(1)" }],
    [{ ...finished, box: [0.9, 0, 0.5, 1] }],
    [{ color: "Black", placement: "front", artworkUrl: input.artwork.url }],
  ])
    expect(() => parseStoreMockupOverrides(value)).toThrow();
});
