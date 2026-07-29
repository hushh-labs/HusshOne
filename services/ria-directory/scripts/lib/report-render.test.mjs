import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "./report-render.mjs";

const sampleProgress = {
  firmsTotal: 15234,
  firmsGeocoded: 15010,
  advisersTotal: 812345,
  statesCovered: 54,
  totalAum: 128_500_000_000_000,
  zipsCovered: 6120,
  zipsTotal: 41000,
  pctZips: 14.9,
  lastFirmFile: "IA_FIRM_SEC_Feed_07_01_2026.xml.gz",
  lastFirmAt: "2026-07-02T03:00:00Z",
  lastIndividualFile: "IA_INDVL_Feed_07_01_2026.xml.zip",
  lastIndividualAt: "2026-07-02T03:20:00Z",
  nextRefreshDue: "2026-08-01T00:00:00Z",
};

test("buildReport subject reports firm count and ZIP coverage", () => {
  const { subject } = buildReport(sampleProgress);
  assert.equal(subject, "Hushh RIA Directory — 15,234 firms, 14.9% of US ZIPs covered");
});

test("buildReport html surfaces the key counters and formatted AUM", () => {
  const { html } = buildReport(sampleProgress);
  assert.match(html, /15,234/); // firms
  assert.match(html, /812,345/); // advisers
  assert.match(html, /54 \/ 56/); // states
  assert.match(html, /\$128\.50T/); // AUM in trillions
  assert.match(html, /6,120 \/ 41,000 \(14\.9%\)/); // zip coverage
  assert.match(html, /IA_FIRM_SEC_Feed_07_01_2026\.xml\.gz/);
  assert.match(html, /IA_INDVL_Feed_07_01_2026\.xml\.zip/);
  assert.match(html, /2026-07-02/); // formatted ingest date
});

test("buildReport tolerates an empty/undefined progress object", () => {
  const { subject, html } = buildReport(undefined);
  assert.equal(subject, "Hushh RIA Directory — 0 firms, 0% of US ZIPs covered");
  assert.match(html, /0 \/ 56/); // states default
  assert.match(html, /—/); // em-dash for missing files/dates
});

test("buildReport formats AUM in billions and millions below the trillion threshold", () => {
  assert.match(buildReport({ ...sampleProgress, totalAum: 2_500_000_000 }).html, /\$2\.50B/);
  assert.match(buildReport({ ...sampleProgress, totalAum: 750_000_000 }).html, /\$750\.00M/);
});
