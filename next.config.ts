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
        source: "/__/auth/:path*",
        destination: "https://hushone-app.firebaseapp.com/__/auth/:path*",
      },
    ];
  },
};

export default nextConfig;
