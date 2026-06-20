import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/mcp", "/connector/", "/labs/"] }],
    sitemap: "https://one.hushh.ai/sitemap.xml",
    host: "https://one.hushh.ai",
  };
}
