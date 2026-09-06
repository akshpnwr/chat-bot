/**
 * The sticker packs bundled with the application.
 *
 * Stickers are the one asset kind that skips classification, and this module is
 * the whole justification for that. The artwork ships in `public/stickers/`, so
 * it was reviewed when it was committed rather than at send time -- there is no
 * user-supplied content anywhere in a sticker send, only a choice from a fixed
 * set. That makes the check cheap and total: a sticker either is in this
 * registry or is not sendable at all.
 *
 * The registry is therefore a closed set rather than a naming convention. The
 * send path asks `findSticker` rather than assembling a path from the ids it
 * was given, which is what stops an id carrying `../` from naming a file the
 * packs never contained -- a file that would then be delivered unexamined,
 * since a sticker is not classified.
 *
 * Pure and free of any server import, because both sides need it: the picker
 * renders from these packs and the send path validates against them. One
 * registry rather than a client list and a server list that could disagree
 * about what exists.
 */

/** One sticker: a bundled image, with the size its bubble reserves. */
export interface Sticker {
  /** Unique within its pack, and stable -- it is stored on the Message. */
  id: string;
  /** What it depicts, used as the bubble's alt text. */
  label: string;
  /**
   * Intrinsic dimensions, recorded here rather than measured in the browser.
   * The artwork is known at build time, so unlike an uploaded image there is
   * nothing to measure -- and having them up front is what lets the bubble
   * reserve its space before the file loads.
   */
  width: number;
  height: number;
}

/** A named group of stickers, as the picker presents them. */
export interface StickerPack {
  id: string;
  name: string;
  stickers: Sticker[];
}

/**
 * Every sticker is square at this size.
 *
 * A uniform size is what lets the picker lay out a grid without measuring, and
 * what makes a sticker bubble a predictable shape in the thread. It is a
 * property of the bundled artwork rather than a constraint on the type --
 * `Sticker` carries its own dimensions, so a future pack of a different shape
 * needs no change here.
 */
const STICKER_SIZE_PX = 160;

function sticker(id: string, label: string): Sticker {
  return { id, label, width: STICKER_SIZE_PX, height: STICKER_SIZE_PX };
}

const PACKS: StickerPack[] = [
  {
    id: "reactions",
    name: "Reactions",
    stickers: [
      sticker("thumbs-up", "Thumbs up"),
      sticker("heart", "Heart"),
      sticker("laughing", "Laughing"),
      sticker("thinking", "Thinking"),
      sticker("celebrate", "Celebrating"),
      sticker("waving", "Waving"),
      sticker("sleeping", "Sleeping"),
      sticker("shrug", "Shrug"),
    ],
  },
];

/** The packs the picker offers, in the order it shows them. */
export function stickerPacks(): StickerPack[] {
  return PACKS;
}

/**
 * The sticker a pack and sticker id name, or null if there is no such sticker.
 *
 * Null rather than a throw because every caller is answering the same question
 * -- may this be sent -- and a refusal is an ordinary answer to it rather than
 * an exceptional one.
 */
export function findSticker(packId: string, stickerId: string): Sticker | null {
  const pack = PACKS.find((candidate) => candidate.id === packId);
  if (!pack) return null;
  return pack.stickers.find((candidate) => candidate.id === stickerId) ?? null;
}

/**
 * Where a sticker's artwork is served from.
 *
 * Built only from a `Sticker` that came out of the registry, never from raw
 * ids -- so the path cannot name anything the packs do not contain. Callers
 * that hold ids go through `findSticker` first, which is what makes that true
 * rather than merely conventional.
 */
export function stickerUrl(packId: string, sticker: Sticker): string {
  return `/stickers/${packId}/${sticker.id}.svg`;
}
