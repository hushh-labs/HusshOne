// New York — BLOCKED.
//
// The NY State Dept. of Financial Services (DFS) licensee lookup runs through the
// interactive DFS Portal (search per licensee, no bulk export, no open dataset):
//   https://myportal.dfs.ny.gov/nydfs/PublicLicenseSearch
// data.ny.gov (the state Socrata portal) carries no DFS insurance-producer licensee
// dataset.
//
// No brittle form-scraper is built (project policy). Yields nothing + records why.

export const NY = {
  code: "NY",
  label: "New York DFS (interactive portal lookup — no open dataset)",
  kind: "blocked",
  datasets: [],
  note:
    "No free bulk source. NY DFS producer licensing is only via the interactive DFS " +
    "Portal (myportal.dfs.ny.gov); data.ny.gov has no DFS licensee dataset. Unblock " +
    "via the paid NIPR Producer Database (PDB) or a NYSDFS FOIL request for a " +
    "licensee data file.",

  // eslint-disable-next-line require-yield
  async *records() {
    return;
  },
};

export default NY;
