import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./report.mjs";

const progress = {
  providersTotal: 8123456,
  providersIndividual: 6000000,
  providersOrganization: 2123456,
  providersGeocoded: 8000000,
  statesCovered: 56,
  zipsWithProviders: 30000,
  zipsTotal: 41000,
  pctZipsCovered: 73.2,
  topSpecialties: [
    { specialty: "Family Medicine", count: 250000 },
    { specialty: "Nurse Practitioner", count: 180000 },
  ],
  lastIngestFile: "NPPES_Data_Dissemination_April_2026.zip",
  lastIngestKind: "bulk",
  lastIngestAt: "2026-04-15T00:00:00.000Z",
  nextRefreshDue: "2026-05-15T00:00:00.000Z",
};

test("buildReport subject leads with total providers and ZIP coverage %", () => {
  const { subject } = buildReport(progress);
  assert.match(subject, /Hushh Healthcare Directory/);
  assert.match(subject, /8,123,456 providers/);
  assert.match(subject, /73\.2% of US ZIPs covered/);
});

test("buildReport HTML includes key metrics and top specialties", () => {
  const { html } = buildReport(progress);
  assert.match(html, /8,123,456/); // providers total
  assert.match(html, /6,000,000/); // individuals
  assert.match(html, /2,123,456/); // organizations
  assert.match(html, /30,000 \/ 41,000 \(73\.2%\)/); // ZIP coverage
  assert.match(html, /Family Medicine: 250,000/);
  assert.match(html, /NPPES_Data_Dissemination_April_2026\.zip/);
});

test("buildReport tolerates an empty progress object", () => {
  const { subject, html } = buildReport({});
  assert.match(subject, /0 providers/);
  assert.match(html, /—/); // dashes for missing last-ingest fields
});
