import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep the OpenTelemetry Node SDK out of the bundle so its runtime
  // monkey-patching (require/import-in-the-middle) works in standalone mode.
  serverExternalPackages: [
    "@opentelemetry/sdk-node",
    "@opentelemetry/auto-instrumentations-node",
    "@google-cloud/opentelemetry-cloud-trace-exporter",
    "nodemailer",
  ],
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/openai/oauth/protected-resource",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/openai/oauth/authorization-server",
      },
      {
        source: "/.well-known/openid-configuration",
        destination: "/api/openai/oauth/authorization-server",
      },
      {
        source: "/.well-known/openai-apps-challenge",
        destination: "/api/openai/apps-challenge",
      },
      {
        source: "/__/auth/:path*",
        destination: "https://hushone-app.firebaseapp.com/__/auth/:path*",
      },
    ];
  },
  async headers() {
    // The app shell (the `/` document) is a statically prerendered page, so Next
    // serves it with the default `Cache-Control: s-maxage=31536000` (1 year). That
    // let CDNs/browsers keep serving a STALE shell after a deploy — users never
    // pulled the new code or the new intelligence layer until a hard refresh.
    //
    // Force the document to always revalidate. The build is content-addressed via
    // an ETag, so revalidation is a cheap 304 when nothing changed, and a fresh
    // pull the moment we ship. Hash-named `/_next/static/*` chunks stay `immutable`
    // (Next ignores overrides for those by design — and they're safe to cache
    // forever because their filenames change on every build).
    return [
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
