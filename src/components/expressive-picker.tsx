"use client";

import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stickerPacks, stickerUrl, type Sticker } from "@/lib/sticker-packs";
// The wire shape, from the module that owns it. Deliberately not from the
// provider adapter: that module holds the key, and this one ships to a browser.
import type { WireGif } from "@/lib/wire";

/**
 * The GIF and sticker picker.
 *
 * One panel with two tabs rather than two buttons in the composer: they are
 * the same gesture from the sender's point of view -- send a picture that is
 * not a photograph -- and splitting them would put two more controls beside a
 * text box that already has three.
 *
 * The two tabs are not symmetric underneath, and the panel does not pretend
 * they are. Stickers are bundled with the application, so that tab works in
 * every checkout and needs no network at all. GIFs come from a third party
 * behind a credential, so that tab can be *unavailable* -- and says so, rather
 * than showing an empty grid that looks like a search with no results.
 */



/**
 * How long a keystroke waits before it becomes a search.
 *
 * Every search costs a request against this application's quota at the
 * provider, so searching per keystroke would spend a dozen of them writing one
 * word. Long enough to let a word finish, short enough that a deliberate pause
 * feels like it was noticed.
 */
const SEARCH_DEBOUNCE_MS = 350;

type Tab = "stickers" | "gifs";

function StickerGrid({ onPick }: { onPick: (packId: string, stickerId: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {stickerPacks().map((pack) => (
        <div key={pack.id} className="flex flex-col gap-1.5">
          <span className="text-muted px-1 text-[11px] leading-4">{pack.name}</span>
          <div className="grid grid-cols-4 gap-1">
            {pack.stickers.map((sticker: Sticker) => (
              <button
                key={sticker.id}
                type="button"
                onClick={() => onPick(pack.id, sticker.id)}
                // The label is the accessible name rather than alt text on the
                // image inside: the control is what gets activated, so the
                // description belongs to it and the artwork is decoration.
                aria-label={sticker.label}
                className="hover:bg-hover flex aspect-square items-center justify-center rounded-[6px] p-1 outline-none focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)]"
              >
                <img
                  src={stickerUrl(pack.id, sticker)}
                  alt=""
                  aria-hidden
                  className="h-full w-full object-contain"
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function GifGrid({ onPick }: { onPick: (gif: WireGif) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WireGif[]>([]);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }

    // Every superseded search is abandoned rather than merely ignored on
    // arrival. Typing a word starts several, and without this the slowest one
    // to come back would be the one rendered -- results for a prefix of what
    // the user actually typed.
    const controller = new AbortController();
    setSearching(true);

    const timer = setTimeout(() => {
      fetch(`/api/gifs/search?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.status === 503) {
            setUnavailable(true);
            setResults([]);
            return;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as { results: WireGif[] };
          setUnavailable(false);
          setResults(body.results);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          console.error("[gifs] search failed", cause);
          setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  if (unavailable) {
    return (
      <p className="text-muted p-3 text-[12px] leading-4">
        GIF search is not available in this deployment. Stickers still work.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        placeholder="Search GIFs"
        aria-label="Search GIFs"
        onChange={(event) => setQuery(event.target.value)}
        className="bg-elevated text-foreground placeholder:text-muted shadow-border rounded-[6px] px-2 py-1.5 text-[13px] leading-5 outline-none focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)]"
      />
      {/*
        Announced politely rather than rendered silently: the grid changing
        underneath is invisible to a screen reader otherwise, and a search that
        found nothing is a result rather than an absence of one.
      */}
      <div aria-live="polite" className="min-h-0">
        {searching && results.length === 0 ? (
          <p className="text-muted p-3 text-[12px] leading-4">Searching…</p>
        ) : results.length === 0 && query.trim().length > 0 ? (
          <p className="text-muted p-3 text-[12px] leading-4">No GIFs found.</p>
        ) : (
          <div className="grid grid-cols-2 gap-1">
            {results.map((gif) => (
              <button
                key={gif.id}
                type="button"
                onClick={() => onPick(gif)}
                aria-label={gif.description}
                className="hover:bg-hover overflow-hidden rounded-[6px] outline-none focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)]"
              >
                {/*
                  The preview copy, not the full GIF: a grid of two dozen
                  full-size GIFs would be several megabytes of animation to
                  choose one from. What gets sent is the id, and the server
                  resolves the full copy itself.

                  Shown whole rather than cropped to a tidy grid. The point of
                  this tile is that the sender sees what they are about to
                  send, and `object-cover` on a fixed height would hide the
                  edges of a wide GIF -- which is exactly where the joke
                  usually is. Uneven tile heights are the price, and they are
                  worth it.
                */}
                <img
                  src={gif.previewUrl}
                  alt=""
                  aria-hidden
                  className="block max-h-40 w-full object-contain"
                  // Reserved from the dimensions the provider gave, so the
                  // grid does not reflow as each animation decodes.
                  style={{ aspectRatio: `${gif.width} / ${gif.height}` }}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ExpressivePicker({
  onSendGif,
  onSendSticker,
}: {
  onSendGif: (gif: WireGif) => void;
  onSendSticker: (packId: string, stickerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("stickers");
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * Closes on a click elsewhere or on Escape.
   *
   * Both, rather than either: a pointer user dismisses a panel by clicking
   * away and a keyboard user has no "away" to click, so a panel that only
   * handled one of them would be a trap for the other.
   */
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="GIFs and stickers"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Smile className="size-4" aria-hidden />
      </Button>

      {open ? (
        <div className="bg-background shadow-border absolute bottom-full left-0 z-10 mb-2 flex max-h-80 w-72 flex-col gap-2 overflow-y-auto rounded-[8px] p-2">
          <div role="tablist" aria-label="Pick a GIF or sticker" className="flex gap-1">
            {(["stickers", "gifs"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={tab === candidate}
                onClick={() => setTab(candidate)}
                className={
                  tab === candidate
                    ? "bg-hover text-foreground flex-1 rounded-[6px] px-2 py-1 text-[12px] leading-4 capitalize outline-none focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)]"
                    : "text-muted hover:bg-hover flex-1 rounded-[6px] px-2 py-1 text-[12px] leading-4 capitalize outline-none focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)]"
                }
              >
                {candidate === "gifs" ? "GIFs" : "Stickers"}
              </button>
            ))}
          </div>

          {/*
            Picking closes the panel. Sending is the point of opening it, and a
            panel left standing over the Conversation would hide the Message
            that was just sent.
          */}
          {tab === "stickers" ? (
            <StickerGrid
              onPick={(packId, stickerId) => {
                onSendSticker(packId, stickerId);
                setOpen(false);
              }}
            />
          ) : (
            <GifGrid
              onPick={(gif) => {
                onSendGif(gif);
                setOpen(false);
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
