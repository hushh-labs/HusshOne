import type { Metadata } from "next";
import DocsShell from "./DocsShell";

export const metadata: Metadata = {
  title: "One Developer API — Docs",
  description: "Documentation for the One Developer API: run One's intelligence over HTTP — dossier + preference & lifestyle profile, with live SSE streaming.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
