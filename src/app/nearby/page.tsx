import type { Metadata } from "next";
import NearbyPeople from "./NearbyPeople";

export const metadata: Metadata = {
  title: "Net worth nearby — hussh",
  description: "Net Worth Scores from verified public financial disclosures.",
  alternates: { canonical: "/nearby" },
  openGraph: {
    title: "Net worth nearby — hussh",
    description: "Verified public financial disclosures.",
    url: "/nearby",
    type: "website",
  },
};

export default function NearbyPage() {
  return <NearbyPeople />;
}
