import type { Metadata } from "next";
import Link from "next/link";
import styles from "../customers/customers.module.css";

export const dynamic = "force-static";

const TITLE = "The One Network of Agents — with the Xtreme Super Computing Burst Agent";
const DESC =
  "One is a network of agents. Your One agent summons specialists — Kai for finance, Nav for privacy, KYC for identity, and the Xtreme Super Computing Burst Agent for supercomputing — each doing a bounded job under your consent, in your own cloud.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: { canonical: "https://one.hushh.ai/network" },
  openGraph: { title: TITLE, description: DESC, url: "https://one.hushh.ai/network", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
  keywords: ["One network of agents", "personal agent", "A2A", "agent network", "supercomputing", "Xtreme Super Computing Burst"],
};

/* The One network: the specialist agents One summons. Grounded in the One product model
   (Kai / Nav / KYC) plus the Xtreme Super Computing Burst Agent (the supercomputing specialist). */
const AGENTS = [
  {
    label: "Supercomputing",
    name: "🤫 Xtreme Super Computing Burst Agent",
    summary:
      "The one that hands you a supercomputer. Runs each heavy AI or data workload where it finishes best — on your Mac when it fits, or burst to the right-sized accelerator (GPU/TPU) in your own cloud when it doesn't, then brings the result home and tears it down. BYOC; your keys are never persisted.",
    href: "/customers",
    cta: "See what it does →",
    highlight: true,
  },
  {
    label: "Finance & investing",
    name: "Kai",
    summary:
      "The finance and investor specialist. Warm, present, brief — assembles your financial context, portfolio and import state, market questions, and clear decision receipts.",
    href: null,
    cta: null,
    highlight: false,
  },
  {
    label: "Privacy & consent",
    name: "Nav",
    summary:
      "The privacy and consent guardian. Precise and audit-grade — makes scope, exposure, revocation, and audit legible, so you always know who can see what and can take it back.",
    href: null,
    cta: null,
    highlight: false,
  },
  {
    label: "Identity",
    name: "KYC",
    summary:
      "The identity and verification specialist. Handles identity proof as its own bounded job — never collapsed into the assistant that helps you or the guardian that protects you.",
    href: null,
    cta: null,
    highlight: false,
  },
];

export default function NetworkPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "The One Network of Agents",
    itemListElement: AGENTS.map((a, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: a.name,
    })),
  };

  return (
    <div className={styles.page}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className={styles.wrap}>
        <p className={styles.kicker}>The One network of agents</p>
        <h1 className={styles.h1}>One is a network of agents. Burst is the one that hands you a supercomputer.</h1>
        <p className={styles.lede}>
          🤫 One is the relationship layer that owns your context and answers to you. It doesn&apos;t try to be one
          generic assistant — it summons specialists, each doing a bounded job under your consent. The{" "}
          <strong>Xtreme Super Computing Burst Agent</strong> is the newest member: the supercomputing specialist that
          runs heavy work where it finishes best, in your own cloud.
        </p>

        <div className={styles.grid}>
          {AGENTS.map((a) => {
            const card = (
              <>
                <div className={styles.cardIndustry}>{a.label}</div>
                <div className={styles.cardTitle}>{a.name}</div>
                <p className={styles.cardSummary}>{a.summary}</p>
                {a.cta && <p className={styles.cardSummary} style={{ color: "#2997ff", marginTop: 12, fontWeight: 600 }}>{a.cta}</p>}
              </>
            );
            const style = a.highlight ? { borderColor: "#2997ff", background: "#10212e" } : undefined;
            return a.href ? (
              <Link key={a.name} href={a.href} className={styles.card} style={style}>{card}</Link>
            ) : (
              <div key={a.name} className={styles.card} style={style}>{card}</div>
            );
          })}
        </div>

        <div className={styles.cta}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.4px" }}>
            An open network — discoverable by other agents.
          </div>
          <p className={styles.cardSummary} style={{ maxWidth: 640, margin: "10px auto 0" }}>
            Every agent in the One network is built on open standards. The Burst Agent publishes an A2A agent card and an
            AP2 offer catalog, so other agents and platforms can discover it, price it, and put it to work.
          </p>
          <Link href="/customers">See the Burst Agent in action →</Link>
        </div>

        <p className={styles.foot}>
          One is the relationship layer; specialists do bounded jobs under scoped consent. The specialist that helps you
          and the guardian that protects you are deliberately not the same unchecked authority. The Xtreme Super
          Computing Burst Agent runs in your own cloud (BYOC) and never persists your keys.
        </p>
      </div>
    </div>
  );
}
