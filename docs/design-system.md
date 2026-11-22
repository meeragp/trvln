# Travellin' design system

Warm paper, warm ink, one teal accent. Editorial rather than app-like: ruled
lines instead of cards where possible, a light serif for the big moments,
and colour used for meaning, not decoration.

The tokens live in `src/index.css` (`:root`) and are exposed to Tailwind in
`tailwind.config.ts`. Use the token classes below, never raw Tailwind palette
colours (`bg-blue-100`, `text-amber-600`…) or hex values in components.

## Colour

| Role | Token / class | Value | Use |
| --- | --- | --- | --- |
| Paper | `bg-background` | `#FBF6EE` | Page ground |
| Card | `bg-card` | `#FFFDF9` | Raised surfaces, inputs |
| Ink | `text-foreground`, `bg-foreground` | `#2A2420` | Text, rules, selected options |
| Muted ink | `text-muted-foreground` | warm grey | Secondary text, hints |
| Tint | `bg-accent` / `bg-muted` | warm beige | Quiet highlight blocks |
| Rule | `border-border` | warm grey | Hairlines between rows |
| Input edge | `border-input` | darker warm grey | Unselected option and field borders |
| Teal | `text-primary`, `bg-primary` | `#0E7490` | Primary button, links, the route line |
| Marigold | `bg-marigold` | `#F5B93B` | Marks what the app filled in for you; never text |
| Success | `text-success`, `bg-success-soft` | deep green | Liked items, "Free", confirmations |
| Warning | `text-warning`, `bg-warning-soft` | amber-brown | Assumptions, near misses, caveats |
| Error | `text-destructive`, `bg-destructive-soft` | warm red | Errors, removing, disliked items |

The strong status colours are safe as text on paper, on card and on their own
soft tint. Marigold is not: use it only as a fill (dots, the sun, the pin).

There is no dark theme. The `.dark` block in `index.css` is unused.

## Type

- **Instrument Serif** (`font-display`), one weight, regular: page titles,
  step titles, place names, wish prompts, big numbers. `h1`–`h3` get it by
  default. Never bold it: `font-synthesis: none` stops browsers faking one.
- **Geist** (`font-body`, the default): everything else, including `h4`–`h6`.
  A serif under ~20px reads as weak, so small headings stay sans.
- Sentence case everywhere. No uppercase, letter-spaced labels.

## Shape and surface

- Radius: 12px (`rounded-xl`) for options, inputs and buttons; 16px
  (`rounded-2xl`) for cards.
- Sections are separated by 1px rules (`border-t border-border`); a section's
  top edge can be a full ink rule (`border-foreground`).
- No gradients, no glows, no gradient text. Shadow only on the one card that
  holds the itinerary (`shadow-medium`, a soft warm drop).

## Controls

- **Primary button**: teal fill, white text, 52px tall for the main action.
- **Secondary action**: underlined text link, not a second button.
- **Options** (single or multi choice): outlined `border-input`; selected =
  ink fill (`bg-foreground text-background`). Same for the theme switcher.
- **Pre-filled by the app**: a small marigold square after the label.
- Touch targets at least 44px.

## Iconography and illustration

- Lucide line icons at 16px, in ink or teal. No emoji in UI chrome (theme
  names from the model still carry theirs).
- The loading scene is an ink line drawing at 1.6px: ink walker and ground,
  faint ink scenery, teal route and carried item, marigold sun, and the
  route lands on the app's pin.
- App icon: paper pin with a marigold dot on an ink tile.
