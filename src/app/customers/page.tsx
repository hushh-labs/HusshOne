import type { Metadata } from "next";
import Link from "next/link";
import { CASE_STUDIES, PORTFOLIO } from "@/lib/stories/case-studies";
import styles from "./customers.module.css";

export const dynamic = "force-static";

const TITLE = "Customer stories — Xtreme Super Computing Burst, a capability of 🤫 One";
const DESC =
  "Xtreme Super Computing Burst is a capability of your 🤫 One agent: it runs heavy AI and data workloads in your own cloud — matching the best hardware for the job, saving time and money, and shipping better output. Real placement, real completion.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: { canonical: "https://one.hushh.ai/customers" },
  openGraph: { title: TITLE, description: DESC, url: "https://one.hushh.ai/customers", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
  keywords: ["personal supercomputing", "BYOC GPU", "cloud burst", "AI training", "TPU", "Apple Silicon", "Mac supercomputer"],
};

export default function CustomersPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Xtreme Super Computing Burst (a capability of 🤫 One) — customer stories",
    itemListElement: CASE_STUDIES.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `https://one.hushh.ai/customers/${c.slug}`,
      name: c.title,
    })),
  };

  return (
    <div className={styles.page}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className={styles.wrap}>
        <p className={styles.kicker}>Xtreme Super Computing Burst · a capability of 🤫 One</p>
        <h1 className={styles.h1}>The best hardware for every workload — in your own cloud.</h1>
        <p className={styles.lede}>
          Xtreme Super Computing Burst is one of your 🤫 One agent&apos;s capabilities: One understands each workload,
          benchmarks the options, and runs it where it finishes best — on your Mac when it fits, or burst to a
          right-sized cloud supercomputer when it doesn&apos;t. Here&apos;s what that looks like.
        </p>
        <p style={{ marginTop: -20, marginBottom: 36 }}>
          <Link href="/adam" style={{ color: "#2997ff", textDecoration: "none", fontWeight: 600, marginRight: 18 }}>
            Try Adam on your phone →
          </Link>
          <Link href="/network" style={{ color: "#2997ff", textDecoration: "none", fontWeight: 600 }}>
            Part of the One network of agents →
          </Link>
        </p>

        <div className={styles.stats}>
          <div className={styles.stat}><div className={styles.statV}>${PORTFOLIO.savedMonthly.toLocaleString()}</div><div className={styles.statK}>saved / month ({PORTFOLIO.savedPct}%)</div></div>
          <div className={styles.stat}><div className={styles.statV}>+12–18</div><div className={styles.statK}>accuracy points on heavy jobs</div></div>
          <div className={styles.stat}><div className={styles.statV}>{PORTFOLIO.bursted} of 6</div><div className={styles.statK}>workloads bursted, {PORTFOLIO.keptOnDevice} kept local</div></div>
          <div className={styles.stat}><div className={styles.statV}>{PORTFOLIO.utilizationPct}%</div><div className={styles.statK}>utilization (pay-per-use)</div></div>
        </div>

        <div className={styles.grid}>
          {CASE_STUDIES.map((c) => (
            <Link key={c.slug} href={`/customers/${c.slug}`} className={styles.card}>
              <div className={styles.cardIndustry}>{c.industry}</div>
              <div className={styles.cardTitle}>{c.title}</div>
              <p className={styles.cardSummary}>{c.summary}</p>
            </Link>
          ))}
        </div>

        <div className={styles.cta}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.4px" }}>Bring your own cloud. Keep your keys.</div>
          <Link href="/docs/onboarding-kit">Get the onboarding kit →</Link>
        </div>

        <p className={styles.foot}>
          Stories are representative composites; placement, hardware matching, and job completion are real system behavior
          (run <code>npm run sim:burst</code>). Prices, runtimes, and accuracy figures are transparent, editable model inputs.
        </p>
      </div>
    </div>
  );
}
