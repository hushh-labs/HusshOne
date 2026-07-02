"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_SECTIONS, type NavItem } from "@/lib/docs/registry";
import StatusBadge from "./StatusBadge";
import styles from "./docs.module.css";

interface DocsNavProps {
  open?: boolean;
  onNavigate?: () => void;
  theme?: "light" | "dark";
  onToggleTheme?: () => void;
}

const itemHref = (item: NavItem): string => item.href ?? `/docs/${item.slug}`;

export default function DocsNav({ open, onNavigate, theme, onToggleTheme }: DocsNavProps) {
  const pathname = usePathname();
  const activeSection = NAV_SECTIONS.find((s) => s.items.some((i) => itemHref(i) === pathname))?.title;

  // Collapsible sections: the first section is open by default; the section holding the current page
  // auto-opens (and stays open) as you navigate. Manual toggles are preserved.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => ({ [NAV_SECTIONS[0].title]: true }));
  useEffect(() => {
    if (activeSection) setOpenSections((prev) => (prev[activeSection] ? prev : { ...prev, [activeSection]: true }));
  }, [activeSection]);

  const toggle = (title: string) => setOpenSections((prev) => ({ ...prev, [title]: !prev[title] }));

  return (
    <nav className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`} aria-label="Documentation">
      <div className={styles.sidebarHead}>
        <Link href="/docs" className={styles.brand} onClick={onNavigate}>
          🤫 One — Developer API
        </Link>
        {onToggleTheme ? (
          <button className={styles.themeToggle} aria-label="Toggle light/dark theme" onClick={onToggleTheme}>
            {theme === "light" ? "🌙" : "☀️"}
          </button>
        ) : null}
      </div>
      <p className={styles.brandSub}>Documentation</p>
      <StatusBadge />

      {NAV_SECTIONS.map((section) => {
        const isOpen = openSections[section.title] ?? false;
        return (
          <div key={section.title} className={styles.navSection}>
            <button
              className={styles.navSectionHeader}
              onClick={() => toggle(section.title)}
              aria-expanded={isOpen}
              type="button"
            >
              <span>{section.title}</span>
              <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`} aria-hidden>
                ▸
              </span>
            </button>
            {isOpen ? (
              <div className={styles.navSectionItems}>
                {section.items.map((item) => {
                  const href = itemHref(item);
                  const active = pathname === href;
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={onNavigate}
                      className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}
                    >
                      {item.title}
                    </Link>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
