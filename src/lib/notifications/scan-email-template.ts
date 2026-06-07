import type { DashboardCategoryMap, OneDashboardResult, PersonAuditStatus } from "@/lib/ria/types";

type Audience = "user" | "admin";

const CATEGORY_LABELS: Record<keyof DashboardCategoryMap, string> = {
  newsAndMedia: "News and media",
  socials: "Social profiles",
  education: "Education",
  government: "Public records",
  otherFootprints: "Public web",
  connectedIdentities: "Connected identities",
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getSiteUrl(override?: string | null) {
  // Prefer the real request origin (threaded from the route), then explicit env,
  // and finally the production host — never leak localhost into a delivered email.
  const configured =
    override ||
    process.env.ONE_SITE_URL ||
    process.env.NEXT_PUBLIC_ONE_SITE_URL ||
    process.env.PUBLIC_SITE_URL ||
    process.env.SITE_URL;
  if (configured?.trim()) return configured.trim().replace(/\/+$/, "");
  if (process.env.VERCEL_URL?.trim()) return `https://${process.env.VERCEL_URL.trim().replace(/\/+$/, "")}`;
  return "https://one.hushh.ai";
}

function renderList(items: string[]) {
  if (!items.length) {
    return `<p style="margin:0;color:#8e8e93;font-size:13px;line-height:1.6;">No returned data.</p>`;
  }

  return `
    <ol style="margin:0;padding-left:20px;color:#1d1d1f;font-size:13px;line-height:1.7;">
      ${items.map((item) => `<li style="margin:0 0 8px 0;word-break:break-word;">${escapeHtml(item)}</li>`).join("")}
    </ol>
  `;
}

function renderSection(title: string, content: string) {
  return `
    <tr>
      <td style="padding:0 32px 18px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;border:1px solid #e8e8e8;border-radius:12px;background:#ffffff;">
          <tr>
            <td style="padding:14px 18px;border-bottom:1px solid #eeeeee;background:#fafafa;border-radius:12px 12px 0 0;">
              <div style="font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;color:#8e8e93;">${escapeHtml(title)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:18px;">
              ${content}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderCategorySections(result: OneDashboardResult) {
  return (Object.keys(CATEGORY_LABELS) as (keyof DashboardCategoryMap)[])
    .map((key) => renderSection(CATEGORY_LABELS[key], renderList(result.categories[key] || [])))
    .join("");
}

function renderPrivateSignals(result: OneDashboardResult) {
  if (!result.privateDataEstimation.length) {
    return renderSection("Private data estimation", renderList([]));
  }

  const items = result.privateDataEstimation.map(
    (finding) => `${finding.label} (${finding.confidence}): ${finding.detail}`,
  );
  return renderSection("Private data estimation", renderList(items));
}

function renderKeyValues(rows: [string, string | null | undefined][]) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rows
        .map(
          ([label, value], index) => `
            <tr>
              <td style="width:34%;padding:${index ? "12px" : "0"} 14px 12px 0;border-bottom:1px solid #eeeeee;color:#6a6a6a;font-size:12px;line-height:1.5;">${escapeHtml(label)}</td>
              <td style="padding:${index ? "12px" : "0"} 0 12px 0;border-bottom:1px solid #eeeeee;color:#1d1d1f;font-size:13px;line-height:1.5;font-weight:600;word-break:break-word;">${escapeHtml(value || "None")}</td>
            </tr>
          `,
        )
        .join("")}
    </table>
  `;
}

function renderRichSections(result: OneDashboardResult) {
  const rich = result.rich;
  if (!rich) return "";
  const sections: string[] = [];

  const confRows: [string, string | null | undefined][] = [];
  if (rich.overallConfidence) confRows.push(["Overall confidence", rich.overallConfidence]);
  if (typeof rich.sourceCount === "number") confRows.push(["Sources", String(rich.sourceCount)]);
  if (confRows.length) sections.push(renderSection("Confidence", renderKeyValues(confRows)));

  if (rich.professional) {
    const items = [
      rich.professional.currentRole ? `Current role: ${rich.professional.currentRole}` : "",
      ...rich.professional.validatedClaims,
      ...rich.professional.unverifiedClaims.map((c) => `Unverified: ${c}`),
    ].filter(Boolean);
    if (items.length) sections.push(renderSection("Professional", renderList(items)));
  }

  if (rich.education) {
    const items = [rich.education.summary || "", ...rich.education.validatedClaims].filter(Boolean);
    if (items.length) sections.push(renderSection("Education", renderList(items)));
  }

  if (rich.network && rich.network.associates.length) {
    const items = rich.network.associates.map((a) => [a.name, a.relation].filter(Boolean).join(" — "));
    sections.push(renderSection("Network", renderList(items)));
  }

  if (rich.evidence.length) {
    const items = rich.evidence.map((e) => {
      const head = [e.confidence ? `(${e.confidence})` : "", e.claim].filter(Boolean).join(" ");
      const support = e.support ? ` — ${e.support}` : "";
      const sources = e.sources.length ? ` [${e.sources.join(", ")}]` : "";
      return `${head}${support}${sources}`;
    });
    sections.push(renderSection("Evidence ledger", renderList(items)));
  }

  if (rich.conflicts.length) sections.push(renderSection("Conflicts", renderList(rich.conflicts)));
  if (rich.missingEvidence.length) sections.push(renderSection("Missing evidence", renderList(rich.missingEvidence)));
  if (rich.sourceCards.length || rich.verifiedWebCount || rich.sourceUrls.length) {
    const items = rich.sourceCards.length
      ? rich.sourceCards.map((c) => `${c.label}${c.domain && c.domain !== c.label ? ` — ${c.domain}` : ""}`)
      : [...rich.sourceUrls];
    if (rich.verifiedWebCount > 0) {
      items.push(`Verified across ${rich.verifiedWebCount} more public web source${rich.verifiedWebCount === 1 ? "" : "s"}`);
    }
    sections.push(renderSection("Sources", renderList(items)));
  }

  return sections.join("");
}

export function buildScanResultEmailHtml(params: {
  result: OneDashboardResult;
  audit: PersonAuditStatus | null;
  audience: Audience;
  completedAt: Date;
  siteUrl?: string | null;
}) {
  const { result, audit, audience, completedAt } = params;
  const isAdmin = audience === "admin";
  const siteUrl = getSiteUrl(params.siteUrl);
  // Deep-link straight to this saved report; Part 1 restores it after sign-in.
  const reportUrl = `${siteUrl}/?scan=${encodeURIComponent(result.scanRunId ?? "")}`;
  const ctaHref = isAdmin ? siteUrl : reportUrl;
  const ctaLabel = isAdmin ? "Open Hussh One" : "View your report";

  const eyebrow = isAdmin ? "Internal scan copy" : "Your report is ready";
  const intro = isAdmin
    ? "A Hussh One scan completed. The full normalized scan data returned to the dashboard is included below."
    : "Your Hussh One scan is complete. Here's a quick summary — open your full, interactive report any time with the button below.";

  // The user gets a clean, readable email; the heavy data lives in the report.
  // The admin copy stays exhaustive (every section + the raw normalized payload).
  let body: string;
  if (isAdmin) {
    const payload = { result, audit, completedAt: completedAt.toISOString() };
    body = `
            ${renderSection(
              "Scan metadata",
              renderKeyValues([
                ["Name", result.subject.name],
                ["Email", result.subject.email],
                ["Scan ID", result.scanRunId],
                ["Audit job ID", result.auditJobId],
                ["Scan mode", result.mode],
                ["Audit status", audit ? `${audit.status} (${audit.completedShards}/${audit.totalShards} shards)` : "Not available"],
                ["Completed at", completedAt.toISOString()],
              ]),
            )}
            ${renderRichSections(result)}
            ${renderCategorySections(result)}
            ${renderPrivateSignals(result)}
            ${renderSection("Location intelligence", renderList(result.locationIntelligence ? [result.locationIntelligence] : []))}
            ${renderSection("Warnings", renderList(result.warnings))}
            ${renderSection(
              "Redactions",
              renderList(result.redactions.length ? result.redactions : ["No private contact data rendered"]),
            )}
            ${renderSection(
              "Complete normalized payload",
              `<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;color:#1d1d1f;background:#fafafa;border:1px solid #eeeeee;border-radius:8px;padding:14px;">${escapeHtml(
                JSON.stringify(payload, null, 2),
              )}</pre>`,
            )}`;
  } else {
    const glance: [string, string | null | undefined][] = [];
    if (result.rich?.overallConfidence) glance.push(["Overall confidence", result.rich.overallConfidence]);
    if (typeof result.rich?.sourceCount === "number") glance.push(["Sources reviewed", String(result.rich.sourceCount)]);
    const glanceSection = glance.length ? renderSection("At a glance", renderKeyValues(glance)) : "";
    body = `
            ${renderSection(
              "Your scan",
              renderKeyValues([
                ["Name", result.subject.name],
                ["Email", result.subject.email],
                ["Completed", completedAt.toUTCString()],
              ]),
            )}
            ${glanceSection}`;
  }

  const privacyLine = isAdmin
    ? "This email contains the full normalized scan result. Keep it private."
    : "Your full report — including every source and finding — stays private to your account.";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hussh One scan results</title>
  </head>
  <body style="margin:0;padding:0;background:#f7f7f5;color:#1d1d1f;font-family:Inter,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f7f7f5;">
      <tr>
        <td align="center" style="padding:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;border-collapse:collapse;background:#ffffff;">
            <tr>
              <td style="padding:34px 32px 38px 32px;background:#0a0a0a;color:#ffffff;">
                <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#8fc9ff;font-weight:700;">${escapeHtml(eyebrow)}</div>
                <h1 style="margin:16px 0 0 0;font-size:34px;line-height:1.08;font-weight:600;color:#ffffff;">Hussh One scan results</h1>
                <p style="margin:14px 0 0 0;font-size:14px;line-height:1.7;color:#d7d7d7;">${escapeHtml(intro)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 32px 18px 32px;">
                <p style="margin:0;color:#1d1d1f;font-size:15px;line-height:1.7;">${escapeHtml(result.summary)}</p>
              </td>
            </tr>
            ${body}
            <tr>
              <td style="padding:8px 32px 36px 32px;">
                <a href="${escapeHtml(ctaHref)}" style="display:block;text-align:center;text-decoration:none;background:#0a0a0a;color:#ffffff;border-radius:12px;padding:16px 18px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;">${escapeHtml(ctaLabel)}</a>
                <p style="margin:18px 0 0 0;color:#8e8e93;font-size:12px;line-height:1.7;">${escapeHtml(privacyLine)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
