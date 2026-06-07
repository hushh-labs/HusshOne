"use client";

/* ============================================================
   CodeBoardHero — the faint hex/code texture band that crowns
   the home hero (thehellowstd.com style). Rows of monospace hex
   drift slowly behind a top/bottom fade. Purely decorative.
   Rows are generated deterministically (no Math.random / Date)
   so server and client markup match — SSR-safe.
   ============================================================ */

const HEX = "0123456789ABCDEF";
const ROWS = 10;
const COLS = 130;

// deterministic 0..1 hash → stable glyphs across SSR / hydration / reloads
function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function buildRow(r: number) {
  let out = "";
  for (let i = 0; i < COLS; i++) {
    // occasional gaps so the band reads like loose hex dumps, not a solid wall
    if (i > 0 && i % 9 === 0 && hash(r * 7.3 + i) > 0.6) {
      out += "  ";
      continue;
    }
    out += HEX[Math.floor(hash(r * 131.7 + i * 1.37) * 16)];
  }
  return out;
}

const LINES = Array.from({ length: ROWS }, (_, r) => buildRow(r));

export function CodeBoardHero() {
  return (
    <div className="code-board" aria-hidden="true">
      <div className="cb-stack">
        {LINES.map((line, i) => (
          <div className="cb-row" key={i} style={{ ["--d" as string]: i }}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

export default CodeBoardHero;
