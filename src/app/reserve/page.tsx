import type { Metadata } from "next";
import ReserveExperience from "./ReserveExperience";

const TITLE = "Reserve — book the person, pay in the same tap";
const DESC =
  "Pick who you need. One already knows the fair fee, you choose within the band, and the payment rides along with " +
  "the booking — captured on confirmation, refunded in full if they can't make it. Payments become a non-thought.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: { canonical: "https://one.hushh.ai/reserve" },
  openGraph: { title: TITLE, description: DESC, url: "https://one.hushh.ai/reserve", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
  keywords: ["Reserve", "booking", "payments", "AP2", "reservation fee", "seamless commerce", "One"],
};

export default function ReservePage() {
  return <ReserveExperience />;
}
