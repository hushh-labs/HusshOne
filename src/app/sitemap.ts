import type { MetadataRoute } from "next";
import { CASE_STUDIES } from "@/lib/stories/case-studies";

const BASE = "https://one.hushh.ai";
const DOCS = ["overview","getting-started","provisioning","whitepaper","placement","agent-registry","macos-agent","experience","security","onboarding-kit"];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${BASE}/`, lastModified: now, priority: 1 },
    { url: `${BASE}/adam`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${BASE}/reserve`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${BASE}/enterprise`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${BASE}/network`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${BASE}/customers`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    ...CASE_STUDIES.map((c) => ({ url: `${BASE}/customers/${c.slug}`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.8 })),
    { url: `${BASE}/docs`, lastModified: now, priority: 0.7 },
    ...DOCS.map((d) => ({ url: `${BASE}/docs/${d}`, lastModified: now, priority: 0.6 })),
  ];
}
