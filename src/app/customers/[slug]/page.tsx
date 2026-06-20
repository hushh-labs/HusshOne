import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CASE_STUDIES, getCaseStudy } from "@/lib/stories/case-studies";
import styles from "../customers.module.css";

export const dynamic = "force-static";

export function generateStaticParams() {
  return CASE_STUDIES.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const c = getCaseStudy(slug);
  if (!c) return { title: "Customer story — One" };
  const url = `https://one.hushh.ai/customers/${c.slug}`;
  return {
    title: `${c.title} — One Burst Compute`,
    description: c.summary,
    alternates: { canonical: url },
    openGraph: { title: c.title, description: c.summary, url, type: "article" },
    twitter: { card: "summary_large_image", title: c.title, description: c.summary },
    keywords: c.tags,
  };
}

export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = getCaseStudy(slug);
  if (!c) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: c.title,
    description: c.summary,
    articleSection: c.industry,
    keywords: c.tags.join(", "),
    author: { "@type": "Organization", name: "Hushh", url: "https://hushh.ai" },
    publisher: { "@type": "Organization", name: "Hushh", url: "https://hushh.ai" },
    about: { "@type": "Product", name: "One — Xtreme Compute Burst" },
    mainEntityOfPage: `https://one.hushh.ai/customers/${c.slug}`,
  };

  return (
    <div className={styles.page}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className={styles.wrap}>
        <div className={styles.crumbs}>
          <Link href="/customers">Customer stories</Link> · {c.industry}
        </div>
        <p className={styles.persona}>{c.persona}</p>
        <h1 className={styles.h1}>{c.title}</h1>
        <p className={styles.lede}>{c.summary}</p>

        <div className={styles.section}><h2>The challenge</h2><p>{c.challenge}</p></div>
        <div className={styles.section}><h2>Workload understanding</h2><p>{c.understanding}</p></div>
        <div className={styles.section}><h2>Best hardware for the job</h2><p>{c.hardware}</p></div>

        {c.benchmark && (
          <div className={styles.section}>
            <h2>Benchmark</h2>
            <table className={styles.bench}>
              <thead><tr><th>Pick</th><th>Hardware</th><th>Time</th><th>Cost</th><th>Verdict</th></tr></thead>
              <tbody>
                {c.benchmark.map((b) => (
                  <tr key={b.role} className={b.role === "matched" ? styles.matched : undefined}>
                    <td>{b.role === "matched" ? "One's match" : b.role}</td>
                    <td>{b.hardware}</td><td>{b.time}</td><td>{b.cost}</td><td>{b.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className={styles.section}><h2>Completion</h2><p>{c.completion}</p></div>

        <div className={styles.section}>
          <h2>Outcome</h2>
          <div className={styles.outcomes}>
            {c.outcomes.map((o) => (
              <div key={o.label} className={styles.outcome}>
                <div className={styles.outcomeV}>{o.value}</div>
                <div className={styles.outcomeK}>{o.label}</div>
              </div>
            ))}
          </div>
        </div>

        <blockquote className={styles.quote}>&ldquo;{c.quote}&rdquo;</blockquote>

        <div className={styles.cta}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.4px" }}>Run your workload in your own cloud.</div>
          <Link href="/docs/onboarding-kit">Get the onboarding kit →</Link>
        </div>

        <p className={styles.foot}>
          Representative composite story. Placement, hardware matching, and completion are real system behavior;
          figures are transparent, editable model inputs (see the simulation and hardware recommender).
        </p>
      </div>
    </div>
  );
}
