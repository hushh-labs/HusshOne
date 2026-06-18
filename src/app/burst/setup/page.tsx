import type { Metadata } from "next";
import BurstSetup from "./BurstSetup";

export const metadata: Metadata = {
  title: "Connect your cloud — One by hushh",
  description: "Connect your own Google Cloud so One can borrow a supercomputer when your Mac needs more power.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <BurstSetup />;
}
