/* The public documentation site for the One Developer API (rendered at /docs) — One's intelligence
   over HTTP: dossier + preference/lifestyle profile, with live SSE streaming. Sourced from the repo
   markdown so the site and the repo never drift. The separate "One Burst Compute" product docs live
   in the repo but are intentionally NOT published on this site.

   The nav is a set of collapsible SECTIONS, each holding ITEMS. Most items are markdown docs (a `slug`
   + a `source` path read at build time); a few are plain route links (an `href`, e.g. the live status
   dashboard). This module is CLIENT-SAFE (pure data + link resolution). The filesystem read lives in
   ./read.ts so node:fs never enters the browser bundle. */

export interface DocMeta {
  slug: string;
  title: string;
  blurb: string;
  /** Repo-relative path to the source markdown (read at build time). */
  source: string;
}

export interface NavItem {
  title: string;
  blurb?: string;
  /** Markdown doc: rendered at /docs/<slug> from <source>. */
  slug?: string;
  source?: string;
  /** Plain link (a route that isn't a markdown doc, e.g. the live status page). */
  href?: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Getting started",
    items: [
      { title: "Overview", slug: "overview", source: "docs/one-overview.md", blurb: "What the One intelligence API is and what you can build with it." },
      { title: "Authentication", slug: "authentication", source: "docs/api/authentication.md", blurb: "API keys, the Bearer header, and per-key scan ownership." },
      { title: "Quickstart", slug: "quickstart", source: "docs/api/quickstart.md", blurb: "From key to your first dossier in three calls." },
    ],
  },
  {
    title: "Using the API",
    items: [
      { title: "API overview & contract", slug: "api-overview", source: "docs/one-api-overview.md", blurb: "Auth, the full request/response contract, the endpoint map, and error codes." },
      { title: "Start a scan", slug: "start-a-scan", source: "docs/api/start-a-scan.md", blurb: "POST /api/v1/scan — inputs, live scraping, and the 202 response." },
      { title: "Streaming (SSE)", slug: "api-streaming", source: "docs/one-api-streaming.md", blurb: "Live progress → dossier → preferences over one SSE connection." },
      { title: "Polling", slug: "polling", source: "docs/api/polling.md", blurb: "GET /api/v1/scan/{id} — poll status, dossier, and preferences." },
      { title: "Preferences & lifestyle", slug: "preferences", source: "docs/api/preferences.md", blurb: "The 6-section preference profile + v5 lifestyle facts." },
      { title: "Health & status", slug: "health", source: "docs/api/health.md", blurb: "GET /api/v1/health — public, sanitized service status." },
    ],
  },
  {
    title: "Guides",
    items: [
      { title: "Choosing inputs", slug: "choosing-inputs", source: "docs/api/choosing-inputs.md", blurb: "Which identity fields and profile URLs to send, and why." },
      { title: "Long scans & timeouts", slug: "long-scans", source: "docs/api/long-scans.md", blurb: "Client timeouts, the soft deadline, and re-attaching a stream." },
      { title: "Consent & privacy", slug: "consent-privacy", source: "docs/api/consent-privacy.md", blurb: "Consent flags, what's used, and what's never inferred." },
      { title: "Error handling", slug: "error-handling", source: "docs/api/error-handling.md", blurb: "Status codes, the error envelope, and when to retry." },
    ],
  },
  {
    title: "Reference",
    items: [
      { title: "Profile data contracts", slug: "profile-contracts", source: "docs/api/profile-contracts.md", blurb: "The per-platform scraped `profiles` shapes (LinkedIn / Instagram / X / Threads)." },
      { title: "Status & error codes", slug: "status-codes", source: "docs/api/status-codes.md", blurb: "Every HTTP status and machine code, per endpoint." },
      { title: "OpenAPI spec", slug: "openapi", source: "docs/api/openapi.md", blurb: "The machine-readable OpenAPI 3.1 document." },
    ],
  },
  {
    title: "Resources",
    items: [
      { title: "API status", href: "/docs/status", blurb: "Live status dashboard." },
      { title: "Changelog", slug: "changelog", source: "docs/api/changelog.md", blurb: "What's new in the One Developer API." },
    ],
  },
];

/** All markdown-backed docs (for static params + slug lookup). Route-only items (href) are excluded. */
export const ALL_DOCS: DocMeta[] = NAV_SECTIONS.flatMap((s) => s.items)
  .filter((i): i is NavItem & { slug: string; source: string } => Boolean(i.slug && i.source))
  .map((i) => ({ slug: i.slug, title: i.title, blurb: i.blurb ?? "", source: i.source }));

export function getDoc(slug: string): DocMeta | undefined {
  return ALL_DOCS.find((d) => d.slug === slug);
}

/* Ordered [needle, slug] map for rewriting in-doc `*.md` links to site routes. First match wins, so more
   specific needles come before generic substrings. Anything unmatched falls back to the GitHub repo (so
   links to the unpublished Burst Compute source docs still resolve, just to source). New pages should
   cross-link with absolute `/docs/<slug>` paths, which pass through untouched (see resolveDocHref). */
const LINK_MAP: Array<[string, string]> = [
  ["one-api-overview", "api-overview"],
  ["one-api-streaming", "api-streaming"],
  ["one-api", "start-a-scan"],
  ["one-overview", "overview"],
];

const GITHUB_BLOB = "https://github.com/hushh-labs/HusshOne/blob/main/";

/** Resolve an in-markdown href to a site route, an external URL, or a GitHub fallback. */
export function resolveDocHref(href: string): { href: string; external: boolean } {
  if (/^https?:\/\//i.test(href) || href.startsWith("mailto:")) return { href, external: true };
  if (href.startsWith("#")) return { href, external: false }; // in-page anchor

  const clean = href.split("#")[0];
  // Absolute site routes (the convention for new docs) pass through unchanged.
  if (clean === "/docs" || clean.startsWith("/docs/")) return { href: clean, external: false };

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
