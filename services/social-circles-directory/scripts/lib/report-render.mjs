// Pure renderer for the COMBINED hourly roll-up email spanning all five Hushh
// directory verticals plus the derived social-circles graph. No DB, no clock, no
// env — takes a metrics snapshot and returns { subject, html }. Unit-tested with
// fixtures.

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

function row(label, value, { indent = false, muted = false } = {}) {
  const pad = indent ? "padding-left:16px;" : "";
  const color = muted ? "#999" : "#111";
  return (
    `<tr><td style="padding:6px 14px 6px 0;color:#555;white-space:nowrap;${pad}">${label}</td>` +
    `<td style="padding:6px 0;font-weight:600;color:${color}">${value}</td></tr>`
  );
}

function verticalRow(v) {
  const status = v.available ? fmt(v.count) : `<span style="color:#c0392b">unavailable</span>`;
  const note = v.note ? ` <span style="color:#9aa0a6;font-weight:400">(${v.note})</span>` : "";
  return row(v.label, `${status}${note}`);
}

// metrics = {
//   generatedAt, verticals:[{key,label,db,available,count,note?}],
//   graph:{ personsTotal, edgesTotal, personsByProfession, edgesByType,
//           sourcesByVertical, lastBuild }
// }
export function buildCombinedReport(metrics) {
  const g = metrics.graph || {};
  const verticals = metrics.verticals || [];
  const availableCount = verticals.filter((v) => v.available).length;

  const subject =
    `Hushh Directories — hourly roll-up (5 verticals + graph): ` +
    `${fmt(g.personsTotal)} nodes / ${fmt(g.edgesTotal)} edges, ${availableCount}/${verticals.length} sources live`;

  const sourceRows = verticals.map(verticalRow).join("");

  const profRows = Object.entries(g.personsByProfession || {})
    .map(([k, n]) => row(`• ${k}`, fmt(n), { indent: true, muted: true }))
    .join("");
  const edgeRows = Object.entries(g.edgesByType || {})
    .map(([k, n]) => row(`• ${k}`, fmt(n), { indent: true, muted: true }))
    .join("");

  const lb = g.lastBuild || null;
  const lastBuildLine = lb
    ? `${lb.ok ? "ok" : "FAILED"} · ${fmt(lb.persons_upserted)} nodes / ${fmt(lb.edges_upserted)} edges` +
      (lb.finished_at ? ` · ${new Date(lb.finished_at).toISOString().replace("T", " ").slice(0, 16)}Z` : " · (running)")
    : "no build runs yet";

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;padding:28px 22px">
      <div style="background:#fff;border:1px solid #e6e8eb;border-radius:14px;padding:26px 26px 20px">
        <div style="font-size:18px;font-weight:700;color:#111">Hushh Directories — hourly roll-up</div>
        <div style="font-size:13px;color:#777;margin-top:2px">Five source directories and the who-knows-who graph that links them, updated 24/7.</div>

        <div style="font-size:13px;font-weight:700;color:#111;margin-top:22px;text-transform:uppercase;letter-spacing:.04em">Source directories</div>
        <table style="border-collapse:collapse;margin-top:8px;font-size:14px;width:100%">${sourceRows}</table>

        <div style="font-size:13px;font-weight:700;color:#111;margin-top:22px;text-transform:uppercase;letter-spacing:.04em">Social-circles graph</div>
        <table style="border-collapse:collapse;margin-top:8px;font-size:14px;width:100%">
          ${row("Nodes (persons + orgs)", fmt(g.personsTotal))}
          ${profRows}
          ${row("Edges (relationships)", fmt(g.edgesTotal))}
          ${edgeRows}
          ${row("Provenance links", fmt(g.sourcesTotal))}
          ${row("Last build", lastBuildLine)}
        </table>
      </div>
      <div style="font-size:11px;color:#9aa0a6;text-align:center;margin-top:14px">
        Hushh Social Graph · cross-directory entity resolution · automated report
      </div>
    </div></body></html>`;

  return { subject, html };
}
