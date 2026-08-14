import type { Metadata } from "next";
import NearbyPeople from "./NearbyPeople";

export const metadata: Metadata = {
  title: "Net worth nearby — hussh",
  description: "Public financial signals by U.S. area.",
  alternates: { canonical: "/nearby" },
  openGraph: {
    title: "Net worth nearby — hussh",
    description: "Public financial signals by U.S. area.",
    url: "/nearby",
    type: "website",
  },
};

export default function NearbyPage() {
  return <NearbyPeople />;
}
