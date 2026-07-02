"use client";

import { useEffect, useState } from "react";
import DocsNav from "./DocsNav";
import DocToc from "./DocToc";
import styles from "./docs.module.css";

type Theme = "light" | "dark";

/* Client shell for the docs site: owns the light/dark theme (system default + persisted toggle) and the
   mobile nav drawer. The layout stays a server component (for metadata) and just renders this. */
export default function DocsShell({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme | undefined>(undefined);
  const [navOpen, setNavOpen] = useState(false);

  // Initialize from a saved choice, else the OS preference. Until this runs, CSS `prefers-color-scheme`
  // provides the right default (no wrong-theme flash for system-matched visitors).
  useEffect(() => {
    let initial: Theme = "dark";
    try {
      const saved = localStorage.getItem("docs-theme");
      if (saved === "light" || saved === "dark") initial = saved;
      else if (window.matchMedia?.("(prefers-color-scheme: light)").matches) initial = "light";
    } catch {
      /* no storage / SSR — fall back to dark */
    }
    setTheme(initial);
  }, []);

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNavOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const toggleTheme = () => {
    setTheme((t) => {
      const next: Theme = t === "light" ? "dark" : "light";
      try {
        localStorage.setItem("docs-theme", next);
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div className={styles.shell} data-theme={theme}>
      <header className={styles.topbar}>
        <button className={styles.iconBtn} aria-label="Open navigation" onClick={() => setNavOpen(true)}>
          ☰
        </button>
        <a href="/docs" className={styles.topbarBrand}>
          🤫 One API Docs
        </a>
        <button className={styles.iconBtn} aria-label="Toggle theme" onClick={toggleTheme}>
          {theme === "light" ? "🌙" : "☀️"}
        </button>
      </header>

      <DocsNav open={navOpen} onNavigate={() => setNavOpen(false)} theme={theme} onToggleTheme={toggleTheme} />
      {navOpen ? <div className={styles.scrim} onClick={() => setNavOpen(false)} aria-hidden /> : null}

      <main className={styles.content}>
        <div className={styles.contentInner}>
          <div className={styles.article} id="doc-article">
            {children}
          </div>
          <DocToc />
        </div>
      </main>
    </div>
  );
}
