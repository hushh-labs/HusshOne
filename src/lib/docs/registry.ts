/* The public documentation site for the One Developer API (rendered at /docs) — One's intelligence
   over HTTP: dossier + preference/lifestyle profile, with live SSE streaming. Sourced from the repo
   markdown so the site and the repo never drift. The separate "One Burst Compute" product docs live
   in the repo but are intentionally NOT published on this site.

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
      { slug: "overview", title: "Overview", blurb: "What the One intelligence API is and what you can do with it.", source: "docs/one-overview.md" },
      { slug: "api-overview", title: "API overview & contract", blurb: "Auth, the full request/response contract, the endpoint map, and every status/error code.", source: "docs/one-api-overview.md" },
    ],
  },
  {
    title: "Guides",
    docs: [
      { slug: "api-streaming", title: "Streaming + preferences", blurb: "The live SSE flow and the preference & lifestyle payload in detail.", source: "docs/one-api-streaming.md" },
      { slug: "api-basics", title: "Scan API basics", blurb: "The minimal two-call flow (start a scan, poll for the dossier) + per-platform data contracts.", source: "docs/one-api.md" },
    ],
  },
];

export const ALL_DOCS: DocMeta[] = DOC_SECTIONS.flatMap((s) => s.docs);

export function getDoc(slug: string): DocMeta | undefined {
  return ALL_DOCS.find((d) => d.slug === slug);
}

/* Ordered [needle, slug] map for rewriting in-doc links to site routes. First match wins, so more
   specific needles come before generic substrings. A link with no match falls back to the GitHub repo
   (so links to the unpublished Burst Compute docs still resolve, just to source). */
const LINK_MAP: Array<[string, string]> = [
  // One intelligence API docs — specific needles first ("one-api" is a substring of the others).
  ["one-api-overview", "api-overview"],
  ["one-api-streaming", "api-streaming"],
  ["one-api", "api-basics"],
  ["one-overview", "overview"],
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
