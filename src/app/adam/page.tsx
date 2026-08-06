import type { Metadata } from "next";
import AdamExperience from "./AdamExperience";

const TITLE = "Adam — your phone is a supercomputer";
const DESC =
  "Ask Adam for something your device could never do. Adam runs it where it finishes best — on the device in your " +
  "hand, or burst to Google Cloud's biggest GPU and TPU machines in your own cloud — and brings the answer home.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  alternates: { canonical: "https://one.hushh.ai/adam" },
  openGraph: { title: TITLE, description: DESC, url: "https://one.hushh.ai/adam", type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
  keywords: ["Adam", "supercomputer", "iPhone", "burst compute", "Google Cloud", "GPU", "TPU", "personal supercomputing"],
};

export default function AdamPage() {
  return <AdamExperience />;
}
