#!/usr/bin/env bash
# render-pdf.sh — turn a hand-drawn flowchart SVG into a white-background A4 PDF.
#
# macOS has no rsvg-convert / inkscape / cairosvg by default, but it DOES ship
# Google Chrome, which renders SVG feTurbulence filters + handwriting fonts
# faithfully. So we wrap the SVG in a white A4 HTML page and print-to-pdf.
#
# Usage:
#   ./render-pdf.sh <input.svg> [output.pdf] [--landscape]
#
# Defaults:
#   output.pdf  -> alongside the input, same basename, .pdf
#
set -euo pipefail

IN="${1:?usage: render-pdf.sh <input.svg> [output.pdf] [--landscape]}"
OUT="${2:-}"
ORIENT="portrait"
for a in "$@"; do [ "$a" = "--landscape" ] && ORIENT="landscape"; done

[ -f "$IN" ] || { echo "input not found: $IN" >&2; exit 1; }
case "$IN" in *.svg) ;; *) echo "input must be an .svg" >&2; exit 1;; esac

if [ -z "$OUT" ] || [ "$OUT" = "--landscape" ]; then
  OUT="${IN%.svg}.pdf"
fi

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome not found at: $CHROME" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
WRAP="$TMP/wrap.html"

# Inline the SVG straight into the page so there are no file:// fetch races.
SVG_CONTENT="$(cat "$IN")"

SIZE="A4 $ORIENT"

cat > "$WRAP" <<HTML
<!doctype html><html><head><meta charset="utf-8">
<style>
  @page { size: $SIZE; margin: 0; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  .page {
    width: 210mm; height: 297mm;
    background: #ffffff;
    box-sizing: border-box; padding: 10mm;
    display: flex; align-items: center; justify-content: center;
  }
  .page svg { width: 100%; height: auto; max-height: 100%; }
</style></head>
<body><div class="page">
$SVG_CONTENT
</div></body></html>
HTML

# swap page size for landscape wrapper (A4 landscape = width>height container)
if [ "$ORIENT" = "landscape" ]; then
  /usr/bin/sed -i '' 's/width: 210mm; height: 297mm/width: 297mm; height: 210mm/' "$WRAP"
fi

"$CHROME" \
  --headless=new --disable-gpu --no-sandbox \
  --no-pdf-header-footer \
  --run-all-compositor-stages-before-draw \
  --virtual-time-budget=5000 \
  --user-data-dir="$TMP/chrome" \
  --print-to-pdf="$OUT" \
  "file://$WRAP" 2> "$TMP/chrome.log" || { cat "$TMP/chrome.log" >&2; exit 1; }

[ -s "$OUT" ] || { echo "PDF was not produced" >&2; cat "$TMP/chrome.log" >&2; exit 1; }
echo "$OUT"
