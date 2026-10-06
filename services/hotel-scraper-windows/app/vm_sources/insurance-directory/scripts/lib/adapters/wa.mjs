// Washington — BLOCKED.
//
// The WA Office of the Insurance Commissioner exposes producer/agent licensing ONLY
// through an interactive ASP.NET consumer lookup (viewstate + per-query form posts,
// no bulk export, no open dataset):
//   https://fortress.wa.gov/oic/consumertoolkit/Search.aspx
// data.wa.gov (the state Socrata portal) carries no OIC producer-license dataset.
//
// Per project policy we DO NOT build a brittle viewstate/CAPTCHA-bypass scraper.
// This adapter yields nothing and records why + how to unblock.

export const WA = {
  code: "WA",
  label: "Washington OIC (interactive consumer lookup — no open dataset)",
  kind: "blocked",
  datasets: [],
  note:
    "No free bulk source. WA OIC producer data is only behind an interactive ASP.NET " +
    "search (fortress.wa.gov/oic/consumertoolkit/Search.aspx); data.wa.gov has no OIC " +
    "licensee dataset. Unblock via the paid NIPR Producer Database (PDB) or a WA OIC " +
    "public-records request for a licensee data file.",

  // eslint-disable-next-line require-yield
  async *records() {
    return; // blocked: nothing to yield
  },
};

export default WA;
