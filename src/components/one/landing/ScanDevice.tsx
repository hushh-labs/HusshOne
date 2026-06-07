"use client";

import { Icons } from "../Icons";

/* ── Liquid-glass intelligence device ────────────────────────
   The hero centerpiece, reinterpreting the reference (face-scan
   phone with floating insight cards) for One's use case: a sculpted
   glass device with a *forming intelligence layer* inside — a
   constellation "connecting the pieces", a tracing scan line, and an
   "Ask One anything…" command bar — ringed by floating glass insight
   cards (Identity / Work / Mentions) linked by thin signal lines.
   ──────────────────────────────────────────────────────────── */

const CARDS = [
  { cls: "o-1", title: "Identity", pill: "Verified", color: "var(--green)", icon: Icons.check(14), delay: "0.5s" },
  { cls: "o-2", title: "Work", pill: "Recognized", color: "var(--teal)", icon: Icons.work(14), delay: "0.66s" },
  { cls: "o-3", title: "Mentions", pill: "Connected", color: "var(--accent)", icon: Icons.mention(14), delay: "0.82s" },
];

export function ScanDevice() {
  return (
    <div className="device-scene" aria-hidden="true">
      <div className="scene-glow" />

      {/* floating insight cards with signal connectors */}
      {CARDS.map((c) => (
        <div className={"orbit " + c.cls} key={c.title} style={{ animationDelay: c.delay }}>
          <div className="orbit-inner">
            <div className="orbit-card">
              <div className="oc-title">{c.title}</div>
              <div className="oc-pill">
                <span className="oc-ico" style={{ color: c.color }}>
                  {c.icon}
                </span>
                {c.pill}
              </div>
            </div>
            <span className="oc-conn" />
          </div>
        </div>
      ))}

      {/* the device */}
      <div className="device">
        <div className="device-screen">
          <div className="dv-notch">
            <i />
            <i />
          </div>
          <span className="dv-scan-line" />

          {/* forming intelligence constellation — glossy spheres + clean links */}
          <div className="dv-net">
            <svg viewBox="0 0 100 204" preserveAspectRatio="xMidYMid meet">
              <defs>
                <radialGradient id="dvSphere" cx="38%" cy="32%" r="72%">
                  <stop offset="0" stopColor="#ffffff" />
                  <stop offset="0.55" stopColor="#f3f4fb" />
                  <stop offset="1" stopColor="#d7dcf0" />
                </radialGradient>
                <filter id="dvShadow" x="-60%" y="-60%" width="220%" height="220%">
                  <feDropShadow dx="0" dy="1.4" stdDeviation="1.6" floodColor="#363c78" floodOpacity="0.38" />
                </filter>
              </defs>
              <line className="edge" x1="26" y1="65" x2="50" y2="94" />
              <line className="edge" x1="50" y1="94" x2="76" y2="78" />
              <line className="edge" x1="76" y1="78" x2="72" y2="139" />
              <line className="edge" x1="50" y1="94" x2="72" y2="139" />
              <line className="edge" x1="50" y1="94" x2="40" y2="147" />
              <line className="edge" x1="40" y1="147" x2="72" y2="139" />
              <circle className="node" cx="26" cy="65" r="3.4" />
              <circle className="node pulse" cx="50" cy="94" r="5.6" />
              <circle className="node" cx="76" cy="78" r="3.6" />
              <circle className="node pulse b" cx="40" cy="147" r="3.4" />
              <circle className="node" cx="72" cy="139" r="3.6" />
            </svg>
          </div>

          <div className="dv-head">
            <p className="dv-title">
              One is
              <br />
              getting ready…
            </p>
            <p className="dv-sub">Connecting the pieces around you</p>
          </div>

          <div className="ask-bar">
            <span className="ask-text">Ask One anything…</span>
            <span className="ask-wave" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ScanDevice;
