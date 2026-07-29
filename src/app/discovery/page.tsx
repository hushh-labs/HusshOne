import type { Metadata } from "next";
import Discovery from "./Discovery";

export const metadata: Metadata = {
  title: "Discovery — Real-time nearby, live",
  description:
    "Real-time, location-aware discovery. Share your location or enter a postal code and watch hotels and healthcare stream in by true geographic distance — seeded from hushh's directory, verified against official registries, and enriched live.",
  alternates: { canonical: "/discovery" },
  openGraph: {
    title: "Discovery — Real-time nearby, live",
    description:
      "Location-aware discovery that streams results as each category resolves. GPS or postal code, radius and filters, source-verified profiles.",
    url: "/discovery",
    type: "website",
  },
};

export default function Page() {
  return <Discovery />;
}
