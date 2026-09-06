"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * The send box.
 *
 * Sending is fire-and-forget from here: the caller renders the Message
 * optimistically and settles it when the server acks, so the composer clears
 * immediately rather than waiting for a round trip. That is what makes the
 * Conversation feel instant on a slow connection.
 *
 * It stays writable while offline. The caller records a Message durably before
 * it goes near the socket and retries it on reconnection, so what an outage
 * costs is a delay rather than the Message -- and a box that locks itself the
 * moment the network dips would discard whatever was half-typed in it.
 */
export function Composer({
  onSend,
  offline = false,
  onTyping,
}: {
  onSend: (body: string) => void;
  /** Changes what the box says, never whether it accepts what is typed. */
  offline?: boolean;
  /**
   * Called on each keystroke, and with false when the box empties. Throttling
   * belongs to the caller, not here -- the composer's job is to report what
   * the user did, and how often that reaches the server is a decision about
   * the wire rather than about this box.
   */
  onTyping?: (typing: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const body = value.trim();
    if (body.length === 0) return;
    onSend(body);
    setValue("");
    // Sending ends composing. The caller stops announcing on send as well, so
    // this is belt-and-braces rather than the only path -- but a composer that
    // clears itself while still reporting "typing" would be lying about its
    // own state.
    onTyping?.(false);
    // Height was grown to fit the draft; a cleared box should not stay tall.
    if (inputRef.current) inputRef.current.style.height = "auto";
  }

  return (
    <form
      className="flex items-end gap-2 px-4 py-3 sm:px-6"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        placeholder={
          offline ? "Offline - messages will send when you reconnect" : "Write a message"
        }
        aria-label="Message"
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          // Emptying the box is stopping, not typing. A reader who deletes
          // their draft has visibly stopped composing, and leaving the
          // indicator up until the idle timer noticed would say otherwise.
          onTyping?.(next.trim().length > 0);
          // Grows with the draft up to a cap, past which it scrolls -- so a
          // long message never pushes the Conversation off the screen.
          const element = event.target;
          element.style.height = "auto";
          element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
        }}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line -- the convention every
          // chat client shares, so it needs no explaining in the UI.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        className="bg-elevated text-foreground placeholder:text-muted shadow-border max-h-40 min-h-10 flex-1 resize-none rounded-[6px] px-3 py-2 text-[14px] leading-5 outline-none focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Button type="submit" size="sm" disabled={value.trim().length === 0}>
        Send
      </Button>
    </form>
  );
}
