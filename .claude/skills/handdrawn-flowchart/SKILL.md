---
name: handdrawn-flowchart
description: >-
  Make whiteboard/marker "hand-drawn" style flowchart diagrams as SVG and render
  them to a clean white-background A4 PDF. Use when the user wants a doodle-style
  flow, sketch diagram, or "explain the system like a drawing / A4 sheet" and
  wants a PDF out of it. Covers the rough-stroke style system (fonts, palette,
  wobble + drop-shadow filters, colour-coded lanes, stat pills, step brackets,
  icon recipes), the clean-routing layout rules, and the macOS SVG->PDF pipeline.
---

# Hand-drawn flowchart → white A4 PDF

Produces flowcharts that look sketched by hand (wobbly ink strokes, marker
colors, handwriting font, soft drop shadows) instead of clean vector boxes — then
prints them to a white-background A4 PDF.

## When to use

- "make it look hand-drawn / like a whiteboard / like a marker doodle"
- "explain the whole system as one diagram / an A4 sheet"
- "give me a PDF of that flowchart"
- "enhance / polish this diagram"
- any flow with numbered steps + icons where a playful sketch reads better than a
  formal architecture diagram

## The three halves (author → verify → render)

1. **Author the SVG** in the hand-drawn style (recipe below). Keep it
   self-contained (bake in the white `<rect>` background).
2. **Verify the layout before rendering.** Open the SVG in the **Browser pane**
   (`mcp__Claude_Browser__navigate` to the `file://` path, then `screenshot`) —
   this is the *same Chrome engine* that prints the PDF, so what you see is what
   you get. Check for the failure modes in "Layout rules" below (loops crossing
   text, headers colliding with labels, groove-lines striking through text). Fix
   and re-screenshot until clean. (`mcp__visualize__show_widget` also works for a
   quick inline preview, but the Browser pane matches the PDF exactly.)
3. **Render to PDF** with `render-pdf.sh`.

`examples/hushh-directories-flow.svg` is the canonical worked example (the 5
directory-services engine as a polished 4-step doodle). **Copy it as a starting
skeleton** — it already contains every technique below.

---

## Style system (what makes it look hand-drawn)

Put a `viewBox` on the `<svg>` and set `width="100%"` — a **viewBox width of 680**
renders 1:1 with CSS px in previews. Height is free; aim the aspect ratio near
**A4's usable area (~1 : 1.45)** so the PDF fills one page with little whitespace
— the example is `0 0 680 1010`. Add `role="img"` with a `<title>` and a detailed
`<desc>` as the first children (the `<desc>` is the screen-reader description of
the whole flow — write it as real prose).

### Fonts (handwriting)

System handwriting stack — present on macOS:

```
font-family:'Comic Sans MS','Chalkboard SE','Bradley Hand',cursive;
```

Two classes: `.hb` (font-weight:700, headings/labels) and `.h` (400, notes).
**Leave text unfiltered** (no wobble filter on `<text>`) — it stays crisp and
readable; the handwriting font already supplies the "drawn" feel.

### Palette

Ink + a small set of **marker accents**. Use accents to *encode meaning* — one
colour per lane/vertical/state — not decoration.

| role        | hex       | use                                   |
|-------------|-----------|---------------------------------------|
| ink         | `#1c1c1c` | all outlines, body text               |
| teal        | `#3f9c96` | accent 1 / primary flow arrows        |
| maroon      | `#b46360` | accent 2                              |
| orange      | `#e2913c` | accent 3 / the repeat loop            |
| indigo      | `#5b6f9c` | accent 4                              |
| green       | `#6f9c5b` | accent 5                              |
| box fill    | `#e9ecee` | buildings / solid icons               |
| light fill  | `#eef1f2` | files, cloud, envelope, pins          |
| window      | `#c3c7ca` | little window squares                 |
| band tint   | `#eef6f5` | title band background                 |
| sticky      | `#f6e7a6` | pinned "post-it" notes (text `#8a5a1c`)|

Up to ~5 accents is fine **when each maps to a distinct thing** (the example
colour-codes 5 verticals and repeats those exact colours on their data-source
dots and their DB tags, so colour = identity across the whole poster). For a
diagram with no such dimension, stay near 2 accents.

Keep the background white: bake `<rect x="0" y="0" width="W" height="H"
fill="#ffffff"/>` right after `</defs>` **and** the render wrapper adds white too.

### Filters — wobble, and wobble+shadow

Two jobs, two filters:

```xml
<!-- rough + soft drop shadow: use on SOLID icon shapes (boxes, db, envelope,
     cloud, pin, pills, sticky notes) to lift them off the page -->
<filter id="rs" x="-20%" y="-20%" width="140%" height="140%">
  <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="7" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" result="d"/>
  <feDropShadow in="d" dx="1.3" dy="2.2" stdDeviation="1.4" flood-color="#000" flood-opacity="0.13"/>
</filter>

<!-- rough only: use on CONNECTORS (arrows), underlines, graph edges, db grooves -->
<filter id="rough" x="-6%" y="-6%" width="112%" height="112%">
  <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="4" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2"/>
</filter>

<!-- a second rough seed for the big loop so it doesn't share the exact wobble
     of nearby strokes -->
<filter id="rough2" x="-6%" y="-6%" width="112%" height="112%">
  <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="9" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="1.7"/>
</filter>
```

- `feDropShadow` renders correctly in Chrome (the PDF engine). One filter does
  both wobble + shadow, so a shape only needs a single `filter="url(#rs)"`.
- Higher displacement `scale` = shakier. **2–2.5 is the sweet spot**; >4 is messy.
- Rounded ends everywhere: `stroke-linecap:round; stroke-linejoin:round`.
- Ink stroke class: `.ln{stroke:#1c1c1c;stroke-width:2.4;fill:none;stroke-linecap:round;stroke-linejoin:round}` plus a `.thin` at width 1.5 for fine detail.

### Hand-drawn arrowhead

Open-V marker (not a filled triangle), inheriting each arrow's colour via
`context-stroke` so one marker serves every accent:

```xml
<marker id="ha" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="7" markerHeight="7"
        orient="auto-start-reverse">
  <path d="M1 1 L11 6 L1 11" fill="none" stroke="context-stroke"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</marker>
```

Draw connectors as **slightly-curved** paths (a gentle `C` control point, never
dead straight) with `marker-end="url(#ha)"` and `filter="url(#rough)"`.

### Step labels

Bracketed, coloured headers set the reading order; colour each with its step's
accent:

```
[ STEP 1 · FIVE 24×7 WORKERS ]   (teal)
[ STEP 2 · FETCH THE DATA ]      (orange)
[ STEP 3 · GEO-LINK → SAVE ]     (maroon)
[ STEP 4 · HOURLY EMAIL ]        (teal)
```

### Polish elements (what "enhanced" means)

- **Title band** — a rounded `rect` in the band tint behind the title (`filter=#rs`),
  a big `.hb` title, a rough teal underline path, a subtitle in `.h`.
- **Stat badge** — a rough `circle` top-right with a headline number (e.g.
  `≈5.5M` / `records · live`). Great for a system total.
- **Stat pills** — small rounded `rect` in an accent colour with white `.hb` text
  (`.wt{fill:#fff}`), placed under a label to show a live count (`42.6k`, `5.20M`).
- **Colour-coded source→target dots** — a small `circle` in the target's accent
  colour beside each data-source row, so the eye ties "NPPES file → HEALTH" to the
  maroon HEALTH lane.
- **Tag row** — a row of tiny accent pills (e.g. the 5 DB names under the
  database) to enumerate members without more boxes.
- **Sticky note** — a slightly-rotated (`transform="rotate(-4 ...)"`) `#f6e7a6`
  rect with `#rs`, used to pin a callout onto a connector (e.g. onto the loop).

### Icon recipes

Solid icons get `filter="url(#rs)"` (wobble + shadow); their inner detail lines
use `.thin`.

- **Building/worker**: a coloured roof `rect` (h≈12) on top of a `#e9ecee` body
  `rect`, + a 2×3 grid of `.win` squares. Name label + a stat pill under it.
- **Database**: `path` cylinder — `M x y a rx ry 0 0 1 (2rx) 0 l 0 H a rx ry 0 0 1 -(2rx) 0 z`
  (example uses rx 92, ry 22, H 84), then a top-rim arc, then **grooves as `.thin`
  arcs placed in the LOWER third** — never at the same y as the label text (that
  reads as a strike-through). Put "Cloud SQL / + PostGIS" in the upper third.
- **Cloud**: one blobby `path` of stacked arcs, light fill.
- **File/doc**: small `rect` + 3 short `.thin` lines for "text".
- **Envelope**: `rect` + a `path` V for the flap in an accent stroke.
- **Person**: a `circle` head + a shoulders arc `path` (repeat 3× clustered).
- **Graph cluster**: N small accent-coloured `circle`s + `.thin` edge paths
  (draw edges first, nodes on top).
- **Map pin**: a teardrop `path` + a small white inner `circle`.
- **Repeat loop**: see the layout rule below.

---

## Layout rules (avoid the classic mistakes)

These are the defects to hunt for in the Browser-pane screenshot:

1. **Route long loops in a reserved margin lane — never across content.** The
   "repeat / feedback" arrow is the #1 source of ugliness. Keep the centre column
   for the main top-to-bottom flow; send the loop out to a **clear left (or right)
   margin lane** (in the example, everything else stays at `x ≥ ~100`, so the loop
   orbits down `x ≈ 14–34` from the DB back up into Step 1). One smooth multi-`C`
   path, `filter=#rough2`. Its arrowhead lands *into* the step it feeds.
2. **Pin the loop's label as a sticky in the margin gap**, not floating over other
   strokes.
3. **Give headers their own row.** A step header and a sub-label (e.g.
   `[ STEP 4 · HOURLY EMAIL ]` and `SOCIAL GRAPH`) must not share a baseline band
   — offset them by ≥30px vertically.
4. **Keep detail text off groove/underline arcs** (see Database recipe).
5. **Main flow arrows down the centre**, loop on the margin → they never cross.

---

## Rendering to PDF

```bash
.claude/skills/handdrawn-flowchart/render-pdf.sh <input.svg> [output.pdf] [--landscape]
```

- Inlines the SVG into an HTML page with `@page{size:A4;margin:0}` and a white
  `.page` container (`padding:10mm`, `svg{width:100%;height:auto}`) → one white A4
  page, drawing centred.
- Renders with Chrome headless: `--headless=new --disable-gpu --no-pdf-header-footer
  --run-all-compositor-stages-before-draw --virtual-time-budget=5000 --print-to-pdf`.
  Chrome is used because it renders `feTurbulence`/`feDropShadow` and the
  handwriting fonts correctly, and macOS ships no rsvg/inkscape/cairosvg.
- Default output = input path with `.pdf`. Prints the final path on success.
- **Known quirk:** headless Chrome often writes the PDF correctly but then lingers
  instead of exiting, so a foreground run may hit the Bash timeout. Run it with
  `run_in_background: true` and poll for the output file, then `TaskStop` the job
  once the file exists. The PDF is valid regardless.

### Verify the PDF

```bash
mdls -name kMDItemNumberOfPages <output.pdf>; file <output.pdf>
```

Expect `= 1` page and `PDF document`. If it spills to 2 pages, the viewBox is too
tall for A4 — trim height or widen. Use `--landscape` for wide flows.

## Notes / gotchas

- Very wide flow → author landscape-ish (viewBox `0 0 1000 620`) + `--landscape`.
- Don't over-shake: displacement `scale` 2–2.5.
- Fonts must exist on the rendering machine. On this Mac: Comic Sans MS,
  Chalkboard SE, Bradley Hand are installed. Porting elsewhere → embed a webfont
  in the HTML wrapper.
- Accents encode meaning; if nothing needs colour-coding, stay near 2 accents.
- Always Browser-pane-verify before rendering — the PDF is an exact copy of what
  that screenshot shows.
