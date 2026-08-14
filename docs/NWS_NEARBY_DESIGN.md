---
name: One by hussh
description: Calm, evidence-led Net Worth Score discovery.
colors:
  ink: "#1d1d1f"
  canvas: "#ffffff"
  wash: "#f5f5f7"
  hairline: "#e5e5ea"
  muted: "#6e6e73"
  gold: "#b7793f"
  danger: "#9a1b1b"
rounded:
  control: "12px"
  surface: "16px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "64px"
---

# NWS nearby design system

## North star

**Quiet balance sheet.** The interface makes one estimate, one score, and its evidence easy
to read. Secondary detail waits until requested. Empty space remains empty.

## First viewport

1. `Net worth nearby`
2. `Verified public financial disclosures.`
3. One ZIP field and `Find people`
4. Secondary `Use location`
5. The first result or one truthful coverage state

## Hierarchy

- Short display headline, then one optional sentence.
- Estimated Net Worth is the primary result value.
- NWS is secondary; confidence never appears inside the score.
- Components, liquidity, location relationship, freshness, and citations expand in place.
- Use open ranked rows rather than a dashboard or card wall.

## Visual language

- White canvas, off-black type, neutral wash, hairline separators.
- One restrained warm accent for a meaningful score or selection.
- Flat at rest; no ornamental gradients, glass, heavy shadows, or decorative icons.
- System typography with strong size and weight contrast.
- Controls use 12px corners; permanent content does not float.

## Copy

- Headlines: 2–6 words.
- Buttons: 1–3 words.
- Supporting text: one short sentence.
- Say `Unavailable`, never `$0`, when evidence is absent.
- Say `Included, not itemized` for a sworn whole total without public schedules.
- Say `Public office association`, never `lives nearby`.

## Result row

At rest, show only:

- rank, name, and public role;
- estimated net-worth range;
- NWS and confidence;
- public location relationship;
- `View details`.

Expanded detail shows six balance-sheet categories, liquid wealth, last financial update,
and official citations. It must not reveal exact addresses, coordinates, contacts, or raw
filing fields.

## States

- **Insufficient:** `No verified NWS` / `Nearby profiles lack enough public financial data.`
- **Empty:** `No eligible profiles` / `Try a wider area.`
- **Unresolved:** `Check ZIP` / `Enter a valid U.S. ZIP.`
- **Source down:** `Financial source unavailable` / `Try again soon.`
- **Partial:** show available results and one concise count of profiles lacking evidence.

## Accessibility

Keyboard navigation, visible focus, semantic headings, native disclosure controls, live
loading and error states, readable contrast, reduced motion, mobile reflow, long-name
wrapping, and a ZIP fallback when location permission is denied are required.
