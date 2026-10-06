// Pure renderer for the daily RIA progress email: progress snapshot → { subject, html }.
// No DB, no network — imported by both scripts/report.mjs (to send) and the unit tests.

const fmt = (n) => Number(n || 0).toLocaleString("en-US");

// Compact currency for AUM totals (registry-wide sums run into the trillions).
function fmtUsd(n) {
  const v = Number(n || 0);
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${fmt(Math.round(v))}`;
}

function fmtDate(value) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

export function buildReport(progress) {
  const p = progress || {};
  const pctZips = Number(p.pctZips || 0);
  const subject =
    `Hushh RIA Directory — ${fmt(p.firmsTotal)} firms, ` +
    `${pctZips}% of US ZIPs covered`;

  const rows = [
    ["RIA firms", fmt(p.firmsTotal)],
    ["&nbsp;&nbsp;• geocoded (ZIP matched)", fmt(p.firmsGeocoded)],
    ["Individual advisers", fmt(p.advisersTotal)],
    ["States / territories covered", `${fmt(p.statesCovered)} / 56`],
    ["Total regulatory AUM", fmtUsd(p.totalAum)],
    ["ZIPs with ≥1 firm", `${fmt(p.zipsCovered)} / ${fmt(p.zipsTotal)} (${pctZips}%)`],
    ["Last firm ingest", `${p.lastFirmFile || "—"}`],
    ["&nbsp;&nbsp;• at", fmtDate(p.lastFirmAt)],
    ["Last individual ingest", `${p.lastIndividualFile || "—"}`],
    ["&nbsp;&nbsp;• at", fmtDate(p.lastIndividualAt)],
    ["Next refresh due", fmtDate(p.nextRefreshDue)],
  ];

  const trs = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#555;white-space:nowrap">${k}</td>` +
        `<td style="padding:6px 0;font-weight:600;color:#111">${v}</td></tr>`,
    )
    .join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:28px 22px">
      <div style="background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:26px 26px 20px">
        <div style="font-size:18px;font-weight:700;color:#111">US RIA Directory — daily progress</div>
        <div style="font-size:13px;color:#777;margin-top:2px">Bulk ingest of the SEC Form ADV / IAPD compilation feeds (every SEC-registered investment adviser firm + individual, nationwide).</div>
        <table style="border-collapse:collapse;margin-top:18px;font-size:14px;width:100%">${trs}</table>
      </div>
      <div style="font-size:11px;color:#9aa0a6;text-align:center;margin-top:14px">
        Hushh RIA Directory · source: SEC IAPD / Form ADV compilation · automated report
      </div>
    </div></body></html>`;

  return { subject, html };
}
