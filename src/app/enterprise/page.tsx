import type { Metadata } from "next";
import Link from "next/link";
import styles from "../customers/customers.module.css";

const TITLE = "Adam for the enterprise — every employee already carries a supercomputer";
const DESC =
  "Land in a day: Adam runs free on every employee's phone and laptop. Expand on your terms: workloads that outgrow " +
  "devices burst to right-sized GPU/TPU capacity in your company's own Google Cloud — pay-per-second, keys never " +
  "persisted, torn down the moment the answer lands.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: { canonical: "https://one.hushh.ai/enterprise" },
  openGraph: { title: TITLE, description: DESC, url: "https://one.hushh.ai/enterprise", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
  keywords: ["enterprise", "land and expand", "supercomputing", "Google Cloud", "BYOC", "GPU", "TPU", "Adam", "pilot"],
};

const STAGES = [
  {
    n: "01",
    t: "Land — a day, not a quarter",
    s: "Adam installs from a link — a phone, a Mac, a Windows laptop. No agent rollout, no procurement cycle, no IT ticket. Every employee immediately sees what their device can do and what it can't — and what the fix would cost, to the dollar, before anything runs.",
  },
  {
    n: "02",
    t: "Prove — on your own workloads",
    s: "The pilot kit stands up burst capacity in YOUR Google Cloud project in an afternoon: one script or one Terraform module. Your data never leaves your VPC, your keys are never persisted, and every job tears its machine down when the answer lands.",
  },
  {
    n: "03",
    t: "Expand — team by team, on evidence",
    s: "Every burst produces a receipt: what ran, where, how long, what it cost, what the naive alternative would have cost. Adoption spreads on receipts, not on decks — data science first, then research, media, engineering, finance.",
  },
  {
    n: "04",
    t: "Standardize — the compute continuum as policy",
    s: "On-device when it fits ($0, private, instant). Right-sized cloud when it doesn't. No standing GPU fleet burning idle hours, no shadow cloud accounts. Finance gets pay-per-second economics; security gets BYOC and an audit trail.",
  },
];

const FITS = [
  { t: "Data science & AI teams", s: "Full-size training runs (~$118 for a 70B fine-tune, +18 points vs a shrunk proxy) instead of queueing for the shared cluster." },
  { t: "Research & simulation", s: "TPU-class pipelines — protein folding, risk sims — from the laptop they already carry." },
  { t: "Media & rendering", s: "Overnight renders become over-coffee renders, priced per second." },
  { t: "Finance & analytics", s: "Backtest the full history (~$2 for 5 TB) instead of a sample." },
];

export default function EnterprisePage() {
  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <p className={styles.kicker}>Adam for the enterprise</p>
        <h1 className={styles.h1}>Every employee already carries a supercomputer. Turn it on.</h1>
        <p className={styles.lede}>
          Adam runs on the devices your people already have, and bursts the work that outgrows them into{" "}
          <strong>your company&apos;s own Google Cloud</strong> — the newest GPU and TPU machines, pay-per-second,
          keys never persisted, torn down the moment the answer lands. Land in a day. Expand on evidence.
        </p>

        <div className={styles.stats}>
          <div className={styles.stat}><div className={styles.statV}>1 day</div><div className={styles.statK}>to a live pilot in your cloud</div></div>
          <div className={styles.stat}><div className={styles.statV}>~93%</div><div className={styles.statK}>cheaper than a standing GPU box</div></div>
          <div className={styles.stat}><div className={styles.statV}>$0</div><div className={styles.statK}>when work fits on-device</div></div>
          <div className={styles.stat}><div className={styles.statV}>100%</div><div className={styles.statK}>your cloud, your keys, your bill</div></div>
        </div>

        <h2 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.4px", margin: "8px 0 14px" }}>The motion: land, prove, expand, standardize</h2>
        <div className={styles.grid}>
          {STAGES.map((x) => (
            <div key={x.n} className={styles.card}>
              <div className={styles.cardIndustry}>{x.n}</div>
              <div className={styles.cardTitle}>{x.t}</div>
              <p className={styles.cardSummary}>{x.s}</p>
            </div>
          ))}
        </div>

        <h2 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.4px", margin: "40px 0 14px" }}>Where it lands first</h2>
        <div className={styles.grid}>
          {FITS.map((x) => (
            <div key={x.t} className={styles.card}>
              <div className={styles.cardTitle} style={{ marginTop: 0 }}>{x.t}</div>
              <p className={styles.cardSummary}>{x.s}</p>
            </div>
          ))}
        </div>

        <h2 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-.4px", margin: "40px 0 10px" }}>Built for the channel</h2>
        <p className={styles.lede} style={{ marginBottom: 16 }}>
          Adam makes every device more capable and every cloud commitment more productive — which is why it&apos;s built
          to be distributed, not just sold. Device makers ship a reason to buy the better machine; cloud and
          supercomputing providers turn idle commitments into metered, attributable consumption; integrators get a
          land-and-expand play with receipts. Open agent rails (A2A, AP2, MCP) mean platforms can discover and resell
          the capability programmatically.
        </p>

        <div className={styles.cta}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-.4px" }}>Start the pilot this week.</div>
          <p className={styles.cardSummary} style={{ maxWidth: 640, margin: "10px auto 0" }}>
            The onboarding kit stands up burst capacity in your own Google Cloud in an afternoon — one script or one
            Terraform module, fully reversible.
          </p>
          <Link href="/docs/onboarding-kit">Get the pilot kit →</Link>
        </div>

        <p className={styles.foot}>
          <Link href="/adam" style={{ color: "#2997ff", textDecoration: "none" }}>Try Adam on your phone</Link> ·{" "}
          <Link href="/customers" style={{ color: "#2997ff", textDecoration: "none" }}>Customer stories</Link> ·{" "}
          <Link href="/network" style={{ color: "#2997ff", textDecoration: "none" }}>The One network of agents</Link>.
          On-device and BYOC cloud bursting are live in the product; edge and supercomputing-scale tiers are expanding.
        </p>
        <p className={styles.foot} style={{ textAlign: "center", borderTop: "1px solid #1f1f23", paddingTop: 18 }}>
          Built and published by the 🤫 Research &amp; Advisory Team<br />
          <em>Simplicity is the signature of excellence.</em>
        </p>
      </div>
    </div>
  );
}
