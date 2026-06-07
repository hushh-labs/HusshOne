"use client";

import { useEffect } from "react";

/**
 * Reveal-on-scroll: adds `.in` to every `.reveal` / `.rtext` element when it
 * enters the viewport. Mirrors lóvi's scroll-driven section + word reveals.
 * No animation library — IntersectionObserver + CSS transitions only.
 */
export function useScrollReveal() {
  useEffect(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(".reveal:not(.in), .rtext:not(.in)"),
    );
    if (!els.length) return;

    if (typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("in"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

/**
 * Word-by-word reveal text (gray → indigo as it scrolls in). Each word is a
 * span with a staggered transition-delay; `useScrollReveal` toggles `.in`.
 */
export function RevealText({ text, className = "" }: { text: string; className?: string }) {
  const words = text.split(" ");
  return (
    <p className={`rtext ${className}`}>
      {words.map((w, i) => (
        <span className="w" key={i} style={{ transitionDelay: `${i * 24}ms` }}>
          {w}
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </p>
  );
}
