"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import styles from "./docs.module.css";

interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

/* "On this page" right-rail TOC (wide screens only, see CSS). Reads the rendered article headings after
   each navigation and highlights the section in view via IntersectionObserver. Renders nothing when a
   page has fewer than two headings (e.g. the index / status pages). */
export default function DocToc() {
  const pathname = usePathname();
  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState("");

  // Re-scan headings after the new route's content mounts.
  useEffect(() => {
    const scan = () => {
      const article = document.getElementById("doc-article");
      if (!article) return setItems([]);
      const heads = Array.from(article.querySelectorAll("h2[id], h3[id]")) as HTMLElement[];
      setItems(
        heads.map((h) => ({
          id: h.id,
          text: (h.textContent || "").replace(/^#/, "").trim(),
          level: h.tagName === "H2" ? 2 : 3,
        })),
      );
    };
    const t = setTimeout(scan, 60);
    return () => clearTimeout(t);
  }, [pathname]);

  // Scrollspy: highlight the top-most heading currently in the upper portion of the viewport.
  useEffect(() => {
    if (items.length < 2) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive((visible[0].target as HTMLElement).id);
      },
      { rootMargin: "0px 0px -72% 0px", threshold: 0 },
    );
    items.forEach((i) => {
      const el = document.getElementById(i.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [items]);

  if (items.length < 2) return null;

  return (
    <nav className={styles.toc} aria-label="On this page">
      <p className={styles.tocTitle}>On this page</p>
      {items.map((i) => (
        <a
          key={i.id}
          href={`#${i.id}`}
          className={`${styles.tocLink} ${i.level === 3 ? styles.tocLinkSub : ""} ${active === i.id ? styles.tocActive : ""}`}
        >
          {i.text}
        </a>
      ))}
    </nav>
  );
}
