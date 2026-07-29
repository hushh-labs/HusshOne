// California — BLOCKED.
//
// The California Department of Insurance (CDI) license lookup is an interactive
// web inquiry (search by name/license number, one record at a time, no bulk export):
//   https://interactive.web.insurance.ca.gov/webuser/idb_prd_lce_ext.startup
// The state open-data portal (data.ca.gov, a CKAN site) was checked and carries no
// CDI producer/agent licensee dataset.
//
// No brittle form-scraper is built (project policy). Yields nothing + records why.

export const CA = {
  code: "CA",
  label: "California CDI (interactive license lookup — no open dataset)",
  kind: "blocked",
  datasets: [],
  note:
    "No free bulk source. CDI producer licensing is only via an interactive lookup " +
    "(interactive.web.insurance.ca.gov); data.ca.gov (CKAN) has no CDI licensee " +
    "dataset. Unblock via the paid NIPR Producer Database (PDB) or a CDI Public " +
    "Records Act request for a licensee data file.",

  // eslint-disable-next-line require-yield
  async *records() {
    return;
  },
};

export default CA;
