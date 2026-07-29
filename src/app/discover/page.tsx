import type { Metadata } from "next";
import Discover from "./Discover";

export const metadata: Metadata = {
  title: "Discover — Real-time nearby, live",
  description:
    "Real-time, location-aware discovery. Share your location or enter a postal code and watch hotels and healthcare stream in by true geographic distance — seeded from hushh's directory, verified against official registries, and enriched live.",
  alternates: { canonical: "/discover" },
  openGraph: {
    title: "Discover — Real-time nearby, live",
    description:
      "Location-aware discovery that streams results as each category resolves. GPS or postal code, radius and filters, source-verified profiles.",
    url: "/discover",
    type: "website",
  },
};

export default function Page() {
  return <Discover />;
}
