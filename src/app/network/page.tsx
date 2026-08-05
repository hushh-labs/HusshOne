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
      "The one that hands you a supercomputer. Vertically integrated with your Mac's OS and silicon — a native agent reads live memory and hardware headroom — so it places each workload where it finishes best and tunnels it across the compute continuum: on-device on Apple Silicon, then burst to the right-sized GPU/TPU in your own cloud when a job outgrows the Mac. BYOC; keys never persisted.",
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

        {/* The compute continuum — the core differentiator: deep vertical integration with the
            device OS/hardware, and placement across device → edge → cloud → supercomputing AI infra. */}
        <div style={{ margin: "48px 0 0" }}>
          <p className={styles.kicker}>Why it&apos;s the best supercomputing agent</p>
          <h2 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-.5px", margin: "8px 0 10px", lineHeight: 1.15 }}>
            Vertically integrated with your device — built to tunnel work across the whole compute continuum.
          </h2>
          <p className={styles.cardSummary} style={{ maxWidth: 760, marginBottom: 22 }}>
            A supercomputing agent is only as good as how deeply it reaches into the hardware and software it runs on.
            A native macOS agent reads your Apple-Silicon Mac in real time — memory pressure, unified-memory headroom,
            thermal and hardware profile — so One places every workload where it finishes best and moves it seamlessly
            outward from your device, only as far as the job actually needs.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {[
              { t: "On-device", s: "Apple Silicon, via the One Puppy macOS agent. Runs local when it fits — $0, private, instant.", tag: "Live" },
              { t: "Edge", s: "Nearby capacity for latency-sensitive steps and pipeline pre/post-processing.", tag: "Expanding" },
              { t: "Your cloud", s: "Right-sized GPU/TPU in your OWN cloud (BYOC). Pay-per-second, keys never persisted, torn down after.", tag: "Live" },
              { t: "Supercomputing AI infra", s: "Full-scale accelerator fleets for the biggest training runs, backtests, and simulations.", tag: "Expanding" },
            ].map((x, i) => (
              <div key={x.t} className={styles.card} style={{ padding: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div className={styles.cardIndustry}>{`0${i + 1}`}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: x.tag === "Live" ? "#57e0a6" : "#8a8a92", textTransform: "uppercase", letterSpacing: ".5px" }}>{x.tag}</div>
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, margin: "6px 0 8px", letterSpacing: "-.2px" }}>{x.t}</div>
                <p className={styles.cardSummary} style={{ fontSize: 13.5 }}>{x.s}</p>
              </div>
            ))}
          </div>
          <p className={styles.foot} style={{ marginTop: 14 }}>
            On-device and BYOC cloud bursting are live in the product today; edge and full supercomputing-scale tiers are
            expanding. One decides the tier per workload and tunnels the job — and the result — across every boundary for you.
          </p>
        </div>

        <div className={styles.cta} style={{ marginTop: 40 }}>
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
