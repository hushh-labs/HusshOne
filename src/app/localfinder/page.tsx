import type { Metadata } from "next";
import LocalFinder from "./LocalFinder";

export const metadata: Metadata = {
  title: "LocalFinder — hushh Directory API",
  description:
    "Coordinate-driven directory API. One request returns hotels, healthcare providers, RIA firms and insurance producers by geographic distance from any latitude/longitude or ZIP. Interactive lookup + full developer documentation.",
  alternates: { canonical: "/localfinder" },
  openGraph: {
    title: "LocalFinder — hushh Directory API",
    description:
      "One request, four verticals, returned by true geographic distance. Try it with a ZIP or your location, then read the API docs.",
    url: "/localfinder",
    type: "website",
  },
};

export default function Page() {
  return <LocalFinder />;
}
