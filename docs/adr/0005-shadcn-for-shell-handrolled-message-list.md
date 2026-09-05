# shadcn/ui for the application shell, hand-rolled virtualized message list

The UI uses shadcn/ui for all standard surfaces — dialogs (GIF and sticker pickers), avatars,
buttons, inputs, dropdowns, toasts (moderation rejections), skeletons. The virtualized message
list is built directly on TanStack Virtual with plain elements styled by the same Tailwind
tokens.

shadcn/ui is copy-in source rather than a dependency, so every component in the tree can be
read and explained — which the task requires of library choices. It is also Tailwind-based,
making the Vercel-derived palette in DESIGN.md straightforward to apply as theme tokens.

## Why the message list is different

No shadcn component covers a virtualized list with dynamic row measurement and scroll
anchoring. Wrapping message bubbles in `Card` would add DOM depth and padding in the one hot
path the performance requirement actually measures — 10,000+ messages with variable heights.
Rows therefore use plain elements with `cn()` and the shared tokens, keeping them visually
identical to the rest of the UI without the wrapper cost.

## Consequences

Typography deviates from the shadcn default: Geist replaces Inter, with negative letter-spacing
on display headings per DESIGN.md. Applied at project setup, since retrofitting a type system
after components are built is significantly more work.

The README notes that the message list is deliberately hand-built, so its plain markup reads as
a performance decision rather than an inconsistency.
