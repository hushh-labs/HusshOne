/* The public documentation site for One Burst Compute (rendered at /docs).
   A curated, customer- and developer-facing set sourced from the repo markdown so the
   site and the repo never drift. Internal-ops docs (SLO/observability, the FDE rollback
   runbook, the QA test plan) are intentionally NOT published here — they live in the
   repo and the internal wiki.

   This module is CLIENT-SAFE (pure data + link resolution). The filesystem read lives in
   ./read.ts so it never enters the browser bundle. */

export interface DocMeta {
  slug: string;
  title: string;
  blurb: string;
  /** Repo-relative path to the source markdown (read at build time). */
  source: string;
}

export interface DocSection {
  title: string;
  docs: DocMeta[];
}

export const DOC_SECTIONS: DocSection[] = [
  {
    title: "Start here",
    docs: [
      { slug: "overview", title: "Overview", blurb: "What One Burst Compute is and how it works.", source: "docs/xtreme-compute-burst.md" },
      { slug: "getting-started", title: "Getting started", blurb: "Connect your cloud and run your first burst.", source: "docs/customer/getting-started.md" },
      { slug: "provisioning", title: "Provision your cloud", blurb: "One command or Terraform to set up your BYOC project.", source: "provisioning/README.md" },
    ],
  },
  {
    title: "Developer API",
    docs: [
      { slug: "api-overview", title: "API overview & contract", blurb: "One's intelligence over HTTP: auth, the full request/response contract, endpoints, and error codes.", source: "docs/one-api-overview.md" },
      { slug: "api-streaming", title: "Streaming + preferences", blurb: "Submit a subject, stream live progress (SSE), get the dossier + preference & lifestyle profile.", source: "docs/one-api-streaming.md" },
      { slug: "api-basics", title: "Scan API basics", blurb: "The two-call poll flow: start a scan, poll for the dossier.", source: "docs/one-api.md" },
    ],
  },
  {
    title: "How it works",
    docs: [
      { slug: "whitepaper", title: "White paper", blurb: "The architecture, security, and reliability model.", source: "docs/whitepaper-xtreme-compute-burst.md" },
      { slug: "placement", title: "Placement & autoscale", blurb: "How One decides on-device vs cloud, and when to burst.", source: "docs/specs/placement-autoscale.md" },
      { slug: "agent-registry", title: "Agent registry & A2A", blurb: "Publishing One to the Gemini Enterprise Agent Platform.", source: "docs/specs/agent-registry-and-card.md" },
      { slug: "macos-agent", title: "macOS agent", blurb: "The native One Puppy on-device agent.", source: "docs/specs/one-puppy-macos-agent.md" },
    ],
  },
  {
    title: "Design & trust",
    docs: [
      { slug: "experience", title: "Product experience", blurb: "The bar for how a burst should feel.", source: "docs/specs/macos-experience.md" },
      { slug: "security", title: "Security & privacy", blurb: "BYOC trust model: your keys and data stay yours.", source: "docs/specs/byoc-security-privacy.md" },
    ],
  },
];

export const ALL_DOCS: DocMeta[] = DOC_SECTIONS.flatMap((s) => s.docs);

export function getDoc(slug: string): DocMeta | undefined {
  return ALL_DOCS.find((d) => d.slug === slug);
}

/* Ordered [needle, slug] map for rewriting in-doc links to site routes. First match
   wins, so more specific needles (e.g. the test-plan / whitepaper) come before the
   generic "xtreme-compute-burst". A link with no match falls back to the GitHub repo. */
const LINK_MAP: Array<[string, string]> = [
  ["customer/getting-started", "getting-started"],
  ["provisioning/README", "provisioning"],
  ["provisioning/", "provisioning"],
  // Developer API cross-links — specific needles first ("one-api" is a substring of the others).
  ["one-api-overview", "api-overview"],
  ["one-api-streaming", "api-streaming"],
  ["one-api", "api-basics"],
  ["xtreme-compute-burst-test-plan", ""], // not published → GitHub
  ["whitepaper-xtreme-compute-burst", "whitepaper"],
  ["xtreme-compute-burst", "overview"],
  ["placement-autoscale", "placement"],
  ["byoc-security-privacy", "security"],
  ["agent-registry-and-card", "agent-registry"],
  ["one-puppy-macos-agent", "macos-agent"],
  ["macos-experience", "experience"],
];

const GITHUB_BLOB = "https://github.com/hushh-labs/HusshOne/blob/main/";

/** Resolve an in-markdown href to a site route, an external URL, or a GitHub fallback. */
export function resolveDocHref(href: string): { href: string; external: boolean } {
  if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) return { href, external: true };
  if (href.startsWith("#")) return { href, external: false }; // in-page anchor

  const clean = href.split("#")[0];
  for (const [needle, slug] of LINK_MAP) {
    if (clean.includes(needle)) {
      if (slug) return { href: `/docs/${slug}`, external: false };
      break; // matched a known-but-unpublished doc → fall through to GitHub
    }
  }
  // Unknown repo path (code, internal-ops doc) → link to it on GitHub.
  const repoPath = clean.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  return { href: `${GITHUB_BLOB}${repoPath}`, external: true };
}
