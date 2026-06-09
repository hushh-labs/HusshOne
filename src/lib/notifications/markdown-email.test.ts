import { describe, expect, it } from "vitest";
import type { OneDashboardResult } from "@/lib/ria/types";
import { renderDossierMarkdownToEmailHtml } from "./markdown-email";
import { buildScanResultEmailHtml } from "./scan-email-template";

const SAMPLE = [
  "## Executive Summary",
  "Arvind is a **software engineer** based in Mumbai. See [profile](https://example.com/p).",
  "",
  "> The open-source trail is the strongest evidence.",
  "",
  "## Public Profiles",
  "- LinkedIn",
  "- GitHub",
  "",
  "## Evidence Table",
  "",
  "| Claim | Source | Confidence |",
  "| --- | --- | --- |",
  "| Based in Mumbai | LinkedIn | High |",
].join("\n");

describe("renderDossierMarkdownToEmailHtml", () => {
  const html = renderDossierMarkdownToEmailHtml(SAMPLE);

  it("renders headings, bold, links, lists, blockquote and tables", () => {
    expect(html).toContain("Executive Summary");
    expect(html).toContain("<strong");
    expect(html).toContain('href="https://example.com/p"');
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("Based in Mumbai");
  });

  it("escapes raw HTML in the markdown", () => {
    expect(renderDossierMarkdownToEmailHtml("a <script>x</script> b")).not.toContain("<script>");
  });

  it("uses inline styles (email clients strip <style>/classes)", () => {
    expect(html).toContain("style=");
    expect(html).not.toContain("class=");
  });
});

function deepResearchResult(): OneDashboardResult {
  return {
    scanRunId: "scan-123",
    mode: "precise",
    source: "deep_research",
    subject: { name: "Arvind Mehta", email: "arvind@example.com" },
    summary: "One compiled a deep research dossier from public sources.",
    entityId: "Arvind Mehta",
    categories: {
      newsAndMedia: [],
      socials: [],
      education: [],
      government: [],
      otherFootprints: [],
      connectedIdentities: [],
    },
    privateDataEstimation: [],
    locationIntelligence: null,
    auditJobId: null,
    redactions: [],
    warnings: [],
    rich: null,
    report: SAMPLE,
    citations: [],
  };
}

describe("buildScanResultEmailHtml — Deep Research", () => {
  const completedAt = new Date("2026-06-09T10:00:00Z");

  it("renders the dossier (not the empty Shadow sections) in the user email", () => {
    const html = buildScanResultEmailHtml({
      result: deepResearchResult(),
      audit: null,
      audience: "user",
      completedAt,
    });
    expect(html).toContain("Deep research dossier");
    expect(html).toContain("Evidence Table");
    expect(html).toContain("Based in Mumbai");
    // the old Shadow empty-list placeholder must not appear for a DR report
    expect(html).not.toContain("No returned data");
  });

  it("includes the dossier plus the raw payload in the admin email", () => {
    const html = buildScanResultEmailHtml({
      result: deepResearchResult(),
      audit: null,
      audience: "admin",
      completedAt,
    });
    expect(html).toContain("Deep research dossier");
    expect(html).toContain("Complete normalized payload");
    expect(html).toContain("Based in Mumbai");
  });
});
