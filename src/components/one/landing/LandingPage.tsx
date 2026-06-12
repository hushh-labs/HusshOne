"use client";

/* ============================================================
   LandingPage — public home for One by hussh.
   thehellowstd.com style: off-white canvas, a faint animated
   hex/code band, a two-tone Space Grotesk hero, and a single
   squared "Continue with Google" CTA. No marketing sections,
   no device mockup — the type is the hero.
   The CTA calls `onStart` → the existing Google auth flow.
   ============================================================ */

import { Icons } from "../Icons";
import { CodeBoardHero } from "./CodeBoardHero";

export default function LandingPage({ onStart, error }: { onStart: () => void; error?: string }) {
  return (
    <div className="landing">
      <section className="l-hero">
        <h1 className="sr-only">One by hussh, your personal intelligence agent</h1>
        <CodeBoardHero />
        <div className="l-hero-inner">
          <h2 className="l-h">
            <span className="muted">Meet</span> One.
          </h2>
          <p className="l-lead">Your personal intelligence agent.</p>
          <div className="l-hero-cta">
            <button className="l-cta l-cta-google" onClick={onStart}>
              {Icons.google()}
              <span>Continue with Google</span>
            </button>
          </div>
          {error ? <p className="l-hero-error">{error}</p> : null}
        </div>
      </section>
    </div>
  );
}
