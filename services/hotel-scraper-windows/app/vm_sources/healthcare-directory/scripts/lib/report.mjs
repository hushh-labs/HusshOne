// Pure daily-report renderer for the healthcare directory. Kept side-effect free
// (no DB, no email) so it can be unit-tested with a fabricated progress object; the
// scripts/report.mjs wrapper fetches progress, calls this, and sends the email.

import { KIRKLAND } from "./config.mjs";

const fmt = (n) => Number(n || 0).toLocaleString("en-US");

// Build the { subject, html } for a progress snapshot (see db.getProgress). The
// subject leads with total providers and the % of US ZIPs with at least one provider.
export function buildReport(progress) {
  const p = progress || {};
  const subject = `Hushh Healthcare Directory — ${fmt(p.providersTotal)} providers, ${p.pctZipsCovered ?? 0}% of US ZIPs covered`;

  const specialtyRows = (p.topSpecialties || [])
    .map((s) => `&nbsp;&nbsp;• ${s.specialty}: ${fmt(s.count)}`)
    .join("<br>");

  const rows = [
    ["Providers total", fmt(p.providersTotal)],
    ["&nbsp;&nbsp;• individuals", fmt(p.providersIndividual)],
    ["&nbsp;&nbsp;• organizations", fmt(p.providersOrganization)],
    ["Geo-tagged (ZIP matched)", fmt(p.providersGeocoded)],
    ["States/territories covered", `${fmt(p.statesCovered)} / 56`],
    ["ZIPs with ≥1 provider", `${fmt(p.zipsWithProviders)} / ${fmt(p.zipsTotal)} (${p.pctZipsCovered ?? 0}%)`],
    ["Top specialties", specialtyRows || "—"],
    ["Last ingest", p.lastIngestFile ? `${p.lastIngestFile} (${p.lastIngestKind || "?"})` : "—"],
    ["Last ingest at", p.lastIngestAt ? new Date(p.lastIngestAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—"],
    ["Next refresh due", p.nextRefreshDue ? new Date(p.nextRefreshDue).toISOString().slice(0, 10) : "—"],
  ];

  const trs = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#555;white-space:nowrap;vertical-align:top">${k}</td>` +
        `<td style="padding:6px 0;font-weight:600;color:#111">${v}</td></tr>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:28px 22px">
      <div style="background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:26px 26px 20px">
        <div style="font-size:18px;font-weight:700;color:#111">US Healthcare Directory — daily progress</div>
        <div style="font-size:13px;color:#777;margin-top:2px">Every NPI in the national NPPES registry (individuals + organizations), geo-tagged by practice ZIP and refreshed from the monthly + weekly bulk files, 24/7.</div>
        <table style="border-collapse:collapse;margin-top:18px;font-size:14px;width:100%">${trs}</table>
      </div>
      <div style="font-size:11px;color:#9aa0a6;text-align:center;margin-top:14px">
        Hushh Healthcare Directory · NPPES NPI Registry (CMS, public domain) · geo origin Kirkland, WA (${KIRKLAND.zip}) · automated report
      </div>
    </div></body></html>`;
  return { subject, html };
}
