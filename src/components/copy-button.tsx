"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Copies one value to the clipboard and says so.
 *
 * Every demo credential gets its own button rather than one that copies a
 * whole account, because the sign-in form takes the email and the password in
 * separate fields: a combined copy would have to be pulled apart by hand
 * between the two pastes.
 *
 * The confirmation is the point. `navigator.clipboard.writeText` resolves
 * silently, so without a visible change a click looks identical whether it
 * worked or not -- and a reviewer who cannot tell will paste into the field to
 * find out, which is the check the button exists to spare them.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  // Clears the confirmation so a second copy of the same value still reads as
  // a fresh one. Keyed on `copied`, so re-copying while the tick is showing
  // restarts the window rather than letting the first timer cut it short.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function onCopy() {
    // Absent over plain HTTP on anything but localhost, and refusable by the
    // browser besides. Neither is worth an error state on a convenience
    // affordance -- the credential is on screen and can still be selected by
    // hand -- but silently claiming success would be a lie, so the tick is
    // only shown once the write has actually resolved.
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      // Names the value, not the control: "Copy" repeated four times down the
      // page tells someone listening to it nothing about which one they are on.
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      className="size-6 px-0"
      onClick={onCopy}
    >
      {copied ? (
        <Check className="text-status-green size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </Button>
  );
}
