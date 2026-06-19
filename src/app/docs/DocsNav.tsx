"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_SECTIONS } from "@/lib/docs/registry";
import styles from "./docs.module.css";

export default function DocsNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.sidebar}>
      <Link href="/docs" className={styles.brand}>
        🤫 One — Burst Compute
      </Link>
      <p className={styles.brandSub}>Documentation</p>
      <Link
        href="/docs/onboarding-kit"
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
              <Link key={doc.slug} href={href} className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}>
                {doc.title}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
