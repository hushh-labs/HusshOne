"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_SECTIONS } from "@/lib/docs/registry";
import styles from "./docs.module.css";

interface DocsNavProps {
  open?: boolean;
  onNavigate?: () => void;
  theme?: "light" | "dark";
  onToggleTheme?: () => void;
}

export default function DocsNav({ open, onNavigate, theme, onToggleTheme }: DocsNavProps) {
  const pathname = usePathname();
  return (
    <nav className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`} aria-label="Documentation">
      <div className={styles.sidebarHead}>
        <Link href="/docs" className={styles.brand} onClick={onNavigate}>
          🤫 One — Burst Compute
        </Link>
        {onToggleTheme ? (
          <button className={styles.themeToggle} aria-label="Toggle light/dark theme" onClick={onToggleTheme}>
            {theme === "light" ? "🌙" : "☀️"}
          </button>
        ) : null}
      </div>
      <p className={styles.brandSub}>Documentation</p>
      <Link
        href="/docs/onboarding-kit"
        onClick={onNavigate}
        className={`${styles.navLink} ${pathname === "/docs/onboarding-kit" ? styles.navLinkActive : ""}`}
      >
        ⬇ Onboarding kit
      </Link>
      {DOC_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className={styles.sectionTitle}>{section.title}</p>
          {section.docs.map((doc) => {
            const href = `/docs/${doc.slug}`;
            const active = pathname === href;
            return (
              <Link
                key={doc.slug}
                href={href}
                onClick={onNavigate}
                className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}
              >
                {doc.title}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
