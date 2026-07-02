import Link from "next/link";
import { NAV_SECTIONS, type NavItem } from "@/lib/docs/registry";
import styles from "./docs.module.css";

const itemHref = (item: NavItem): string => item.href ?? `/docs/${item.slug}`;

export const dynamic = "force-static";

export default function DocsIndex() {
  return (
    <div>
      <div className={styles.hero}>
        <h1>One Developer API</h1>
        <p>
          One&apos;s intelligence, over HTTP. Give the API a person&apos;s identity + public profile URLs and it
          returns a deep, cited dossier and a structured preference &amp; lifestyle profile — the same engine
          that powers one.hushh.ai. Stream it live over SSE, or poll. Key-gated; plain JSON.
        </p>
      </div>

      <Link href="/docs/api-overview" className={styles.featured}>
        <p className={styles.featuredKicker}>→ Start here</p>
        <p className={styles.cardTitle}>API overview &amp; contract</p>
        <p className={styles.cardBlurb}>
          Auth, the full request/response contract, the endpoint map, the profiles legend, and every status
          and error code — everything you need to make your first call.
        </p>
      </Link>

      {NAV_SECTIONS.map((section) => (
        <section key={section.title} style={{ marginBottom: 32 }}>
          <p className={styles.sectionTitle}>{section.title}</p>
          <div className={styles.cardGrid}>
            {section.items.map((item) => (
              <Link key={itemHref(item)} href={itemHref(item)} className={styles.card}>
                <p className={styles.cardTitle}>{item.title}</p>
                <p className={styles.cardBlurb}>{item.blurb}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
