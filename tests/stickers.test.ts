import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findSticker, stickerPacks, stickerUrl } from "@/lib/sticker-packs";

/**
 * The bundled sticker packs, tested as the closed registry they are.
 *
 * A sticker is the one asset kind that legitimately skips classification, and
 * the reason is entirely in this module: the artwork ships with the
 * application, so it was looked at before it was committed rather than at send
 * time. That reasoning holds only while the set is closed, which is what these
 * tests are really pinning -- `findSticker` is the gate the send path asks,
 * and a sticker it does not recognise must not be sendable.
 */

describe("stickerPacks", () => {
  it("offers at least one usable pack", () => {
    const packs = stickerPacks();
    expect(packs.length).toBeGreaterThan(0);
    expect(packs[0]!.stickers.length).toBeGreaterThan(0);
  });

  it("gives every sticker the dimensions a bubble reserves its space from", () => {
    for (const pack of stickerPacks()) {
      for (const sticker of pack.stickers) {
        expect(sticker.width).toBeGreaterThan(0);
        expect(sticker.height).toBeGreaterThan(0);
      }
    }
  });

  it("identifies every sticker uniquely across packs", () => {
    const seen = new Set<string>();
    for (const pack of stickerPacks()) {
      for (const sticker of pack.stickers) {
        const identity = `${pack.id}/${sticker.id}`;
        expect(seen.has(identity)).toBe(false);
        seen.add(identity);
      }
    }
  });
});

describe("findSticker", () => {
  it("finds a sticker that a pack actually contains", () => {
    const pack = stickerPacks()[0]!;
    const sticker = pack.stickers[0]!;

    const found = findSticker(pack.id, sticker.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(sticker.id);
  });

  it("refuses a sticker id no pack contains", () => {
    const pack = stickerPacks()[0]!;
    expect(findSticker(pack.id, "not-a-sticker")).toBeNull();
  });

  it("refuses a pack that does not exist", () => {
    expect(findSticker("not-a-pack", "waving")).toBeNull();
  });

  /**
   * The traversal case. A sticker's url is built from the pack and sticker ids,
   * so an id carrying path segments would be a way to name a file the pack
   * never contained -- and a sticker skips moderation, so that file would be
   * delivered unexamined. Lookup against the registry rather than string
   * assembly is what makes this impossible rather than merely guarded.
   */
  it("refuses ids that try to escape the pack", () => {
    expect(findSticker("../../etc", "passwd")).toBeNull();
    expect(findSticker(stickerPacks()[0]!.id, "../../../secret")).toBeNull();
  });
});

describe("stickerUrl", () => {
  /**
   * The registry claims the artwork is bundled, and that claim is what excuses
   * a sticker from classification. A registered sticker whose file is missing
   * would render as a broken bubble -- so the two are pinned together here
   * rather than left to drift as packs are edited.
   */
  it("names a file that actually ships with the application", () => {
    const publicDir = fileURLToPath(new URL("../public", import.meta.url));

    for (const pack of stickerPacks()) {
      for (const sticker of pack.stickers) {
        const url = stickerUrl(pack.id, sticker);
        expect(existsSync(`${publicDir}${url}`)).toBe(true);
      }
    }
  });
});
