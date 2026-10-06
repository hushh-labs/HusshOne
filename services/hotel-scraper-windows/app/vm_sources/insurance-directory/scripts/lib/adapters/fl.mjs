// Florida — BLOCKED.
//
// The Florida Dept. of Financial Services (MyFloridaCFO) licensee search is an
// interactive web lookup (per-record results, no bulk download):
//   https://licenseesearch.fldfs.com/
// Florida does make licensee data available, but only through a paid/records data
// request — not a free open download. The state open-data portals carry no DFS
// producer licensee dataset.
//
// No brittle form-scraper is built (project policy). Yields nothing + records why.

export const FL = {
  code: "FL",
  label: "Florida DFS/MyFloridaCFO (interactive licensee search — no free bulk file)",
  kind: "blocked",
  datasets: [],
  note:
    "No free bulk source. FL DFS producer data is only via an interactive search " +
    "(licenseesearch.fldfs.com); a bulk licensee file exists only through a paid DFS " +
    "data request. Unblock via the paid NIPR Producer Database (PDB) or a FL DFS " +
    "licensee data-file request.",

  // eslint-disable-next-line require-yield
  async *records() {
    return;
  },
};

export default FL;
