"use client";

/**
 * "<Name> is typing", as three animating dots.
 *
 * Rendered in a fixed-height row that is present whether or not anybody is
 * typing. An indicator that appears and disappears from the layout would push
 * the Conversation up and down by its own height every time the other person
 * starts or stops a sentence -- a jump right above the composer, at the exact
 * moment the reader is watching for a reply.
 */
export function TypingIndicator({
  name,
  typing,
}: {
  name: string;
  /** When false the row stays, holding its space, and says nothing. */
  typing: boolean;
}) {
  return (
    <div
      className="flex h-5 shrink-0 items-center gap-1.5 px-4 sm:px-6"
      role="status"
      aria-live="polite"
    >
      {typing ? (
        <>
          <span className="flex items-center gap-0.5" aria-hidden>
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className="bg-muted size-1 animate-pulse rounded-full"
                // Staggered, so the three read as a wave rather than as one
                // blinking block.
                style={{ animationDelay: `${dot * 150}ms` }}
              />
            ))}
          </span>
          <span className="text-muted text-[12px] leading-4">
            {name} is typing
          </span>
        </>
      ) : null}
    </div>
  );
}
