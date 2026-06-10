"use client";

/* ============================================================
   DossierReport — renders the Deep Research markdown dossier as a
   Swiss-style modular grid: a sticky "On this page" section nav
   (left on desktop, a dropdown on mobile) + boxed, hairline-divided
   sections parsed from the report's "##" headings. Scroll-spy keeps
   the nav in sync with what's on screen. Falls back to a single
   block when the report has no real sections.
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Section {
  id: string;
  title: string;
  body: string;
}

function slugify(value: string, index: number): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || `section-${index + 1}`;
}

/** Split the dossier markdown into an intro (before the first "##") + "##" sections.
   "#" (title) and "###" (sub-headings) stay inside their owning block. */
function splitDossier(md: string): { intro: string; sections: Section[] } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const introLines: string[] = [];
  const sections: { id: string; title: string; body: string[] }[] = [];
  const used = new Set<string>();
  let current: { id: string; title: string; body: string[] } | null = null;

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith("###")) {
      const title = m[1].replace(/[*_`#]/g, "").trim();
      let id = slugify(title, sections.length);
      if (used.has(id)) {
        let n = 2;
        const base = id;
        while (used.has(id)) id = `${base}-${n++}`;
      }
      used.add(id);
      current = { id, title, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      introLines.push(line);
    }
  }

  // The masthead already shows the title, so drop a bare "# …" title line from the intro.
  const intro = introLines
    .filter((l) => !/^#\s+/.test(l))
    .join("\n")
    .trim();

  return { intro, sections: sections.map((s) => ({ id: s.id, title: s.title, body: s.body.join("\n").trim() })) };
}

const MD_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

function Markdown({ children }: { children: string }) {
  return (
    <div className="research-report dossier-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Subtle "more sections on the way" affordance shown while the background deep tier runs. */
function DeepeningChip() {
  return (
    <div className="dossier-deepening" aria-live="polite">
      <i className="scan-live-dot" aria-hidden="true" />
      <span>One is digging deeper — more sections arriving…</span>
    </div>
  );
}

export default function DossierReport({ report, deepening }: { report: string; deepening?: boolean }) {
  const { intro, sections } = useMemo(() => splitDossier(report), [report]);
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionEls = useRef<Record<string, HTMLElement | null>>({});

  // Scroll-spy: highlight the section nearest the top of the scroll viewport.
  useEffect(() => {
    if (sections.length < 2) return;
    const scrollRoot = (rootRef.current?.closest(".dash") as HTMLElement | null) ?? null;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive((visible[0].target as HTMLElement).id);
      },
      { root: scrollRoot, rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );
    sections.forEach((s) => {
      const el = sectionEls.current[s.id];
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [sections]);

  const goTo = (id: string) => {
    setActive(id);
    sectionEls.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Fallback: a report with no real sections renders as a single block (today's behavior).
  if (sections.length < 2) {
    return (
      <div className="dossier-fallback screen-enter">
        <Markdown>{report}</Markdown>
        {deepening ? <DeepeningChip /> : null}
      </div>
    );
  }

  return (
    <div className="dossier screen-enter" ref={rootRef}>
      {/* Mobile: jump-to dropdown (sticky under the brand bar). */}
      <div className="dossier-jump">
        <label className="dossier-jump-label" htmlFor="dossier-jump-select">
          On this page
        </label>
        <select
          id="dossier-jump-select"
          className="dossier-select"
          value={active}
          onChange={(e) => goTo(e.target.value)}
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop: sticky section rail. */}
      <nav className="dossier-nav" aria-label="Dossier sections">
        <div className="dossier-nav-label">On this page</div>
        <ul>
          {sections.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={"dossier-nav-link" + (active === s.id ? " active" : "")}
                aria-current={active === s.id ? "true" : undefined}
                onClick={() => goTo(s.id)}
              >
                {s.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="dossier-main">
        {intro ? (
          <div className="dossier-intro">
            <Markdown>{intro}</Markdown>
          </div>
        ) : null}
        {sections.map((s) => (
          <section
            key={s.id}
            id={s.id}
            ref={(el) => {
              sectionEls.current[s.id] = el;
            }}
            className="dossier-section"
          >
            <h2 className="dossier-section-title">{s.title}</h2>
            <Markdown>{s.body}</Markdown>
          </section>
        ))}
        {deepening ? <DeepeningChip /> : null}
      </div>
    </div>
  );
}
