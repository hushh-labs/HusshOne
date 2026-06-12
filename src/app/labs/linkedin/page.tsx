import type { Metadata } from "next";
import LinkedInLab from "./LinkedInLab";

export const metadata: Metadata = {
  title: "LinkedIn OAuth 2.0 Lab — One by hussh",
  description: "Experiment: run LinkedIn OAuth 2.0 with the full scope catalog and inspect everything it returns.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <LinkedInLab />;
}
