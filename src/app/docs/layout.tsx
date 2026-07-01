import type { Metadata } from "next";
import DocsShell from "./DocsShell";

export const metadata: Metadata = {
  title: "Docs — One Burst Compute",
  description: "Documentation for One Burst Compute: personal supercomputing for your Mac with bring-your-own-cloud burst.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
