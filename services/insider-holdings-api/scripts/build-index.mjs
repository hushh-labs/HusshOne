#!/usr/bin/env node
/**
 * Build the served index from free public sources.
 *
 *   node scripts/build-index.mjs --quarter 2026q2
 *
 * Three inputs, all free, none scraped:
 *   1. The SEC's quarterly Form 3/4/5 dataset zip  (positions, prices, names, roles)
 *   2. EDGAR's submissions API                      (issuer business addresses)
 *   3. The Census ZCTA gazetteer, bundled           (postcode -> coordinates)
 *
 * Issuer lookups dominate the runtime: one HTTP call per distinct issuer, throttled to
 * stay inside the SEC's published rate. A quarter has roughly 5,000 distinct issuers,
 * so a cold build takes on the order of twenty minutes. It is meant to run on a
 * schedule, not in a request.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { config } from "./lib/config.mjs";
import { buildPositions, parseTsv, valuePosition } from "./lib/dataset.mjs";
import { fetchIssuer } from "./lib/issuer.mjs";
import { loadCentroids } from "./lib/geo.mjs";
import { isUsAddress } from "./lib/geo-us.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const log = (...parts) => console.log(`[build-index]`, ...parts);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Download with backoff on throttling.
 *
 * A multi-quarter build fetches several hundred MB back to back and the SEC answers
 * `429 Too Many Requests` when pushed — which is exactly what happened the first time
 * this ran for four quarters. 429 and 5xx are transient and must be retried; a 404 is
 * a wrong URL and retrying it only wastes the SEC's capacity, so it fails immediately.
 */
async function download(url, destination, { attempts = 4 } = {}) {
  let wait = 5000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": config.sec.userAgent } });

    if (response.ok) {
      fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
      return;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }

    // Honour Retry-After when the SEC sends one; otherwise back off exponentially.
    const header = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(header) && header > 0 ? header * 1000 : wait;
    log(`${response.status} from the SEC, waiting ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts})`);
    await sleep(delay);
    wait *= 2;
  }
}

async function fetchQuarter(quarter, workDir, { cacheDir = null } = {}) {
  const zip = path.join(workDir, `${quarter}.zip`);
  const extractTo = path.join(workDir, quarter);

  const unpack = () => {
    fs.mkdirSync(extractTo, { recursive: true });
    execFileSync("unzip", ["-o", "-q", zip, "-d", extractTo]);
    return extractTo;
  };

  // A local cache lets a rebuild skip the network entirely. Each quarterly archive is
  // immutable once published, so a cached copy is as good as a fresh fetch and spares
  // the SEC a repeat of several hundred MB.
  if (cacheDir) {
    const cached = path.join(cacheDir, `${quarter}.zip`);
    if (fs.existsSync(cached)) {
      log(`using cached ${quarter}`);
      fs.copyFileSync(cached, zip);
      return unpack();
    }
  }

  // The SEC reorganised these paths mid-2026; newer quarters live under the new prefix.
  // Try both rather than pinning to whichever happened to be current at write time.
  const candidates = [
    `${config.sec.datasetBaseAlt}/${quarter}_form345.zip`,
    `${config.sec.datasetBase}/${quarter}_form345.zip`,
  ];

  let lastError = null;
  for (const url of candidates) {
    try {
      log(`fetching ${url}`);
      await download(url, zip);
      if (cacheDir) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.copyFileSync(zip, path.join(cacheDir, `${quarter}.zip`));
      }
      return unpack();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not fetch ${quarter}: ${lastError?.message}`);
}

const readTable = (dir, name) => [...parseTsv(fs.readFileSync(path.join(dir, `${name}.tsv`), "utf8"))];

async function main() {
  /**
   * One quarter is a badly biased sample of who files.
   *
   * Measured across 16 consecutive quarters (2022q3–2026q2), distinct qualifying
   * filers under our role filter:
   *     1 quarter   33,088
   *     4 quarters  60,994   (1.84x)
   *     8 quarters  72,464   (2.19x)
   *    16 quarters  93,872   (2.84x)
   *
   * People do not merely refile. Two things drive the growth: Q1 is roughly 50%
   * larger than Q3 because annual Form 5s and year-end vesting land there, and
   * genuine churn adds ~2,000 new filers every quarter even after three years of
   * accumulation. A single-quarter index — especially a Q3 one — systematically
   * under-reports who is out there.
   *
   * So the default is now the last four quarters. Later quarters are processed last
   * so that the newest filing wins the tie-break inside buildPositions().
   */
  const quarters = arg("quarters", arg("quarter", "2025q3,2025q4,2026q1,2026q2"))
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean)
    .sort();

  const dataDir = path.resolve(arg("out", config.dataDir));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "insider-"));

  fs.mkdirSync(dataDir, { recursive: true });

  const submissions = [];
  const owners = [];
  const transactions = [];
  const holdings = [];
  const derivTransactions = [];
  const derivHoldings = [];

  const cacheDir = arg("cache", null);

  for (const quarter of quarters) {
    const extracted = await fetchQuarter(quarter, workDir, { cacheDir });
    log(`parsing ${quarter}`);
    submissions.push(...readTable(extracted, "SUBMISSION"));
    owners.push(...readTable(extracted, "REPORTINGOWNER"));
    transactions.push(...readTable(extracted, "NONDERIV_TRANS"));
    holdings.push(...readTable(extracted, "NONDERIV_HOLDING"));
    derivTransactions.push(...readTable(extracted, "DERIV_TRANS"));
    derivHoldings.push(...readTable(extracted, "DERIV_HOLDING"));
    // Each quarter is ~12 MB zipped but several hundred MB expanded; drop it once
    // parsed so a sixteen-quarter build does not fill the disk.
    fs.rmSync(extracted, { recursive: true, force: true });
  }

  log(`merged ${quarters.length} quarter(s): ${submissions.length} filings, ${owners.length} filer rows`);

  const positions = buildPositions({
    submissions, owners, transactions, holdings, derivTransactions, derivHoldings,
  });
  const derivativeCount = [...positions.values()].filter((p) => p.kind === "derivative").length;
  log(`positions: ${positions.size} (${derivativeCount} derivative)`);

  // Group by person.
  const people = new Map();
  const issuerCiks = new Set();

  for (const position of positions.values()) {
    issuerCiks.add(position.issuerCik);
    const value = valuePosition(position);

    if (!people.has(position.personCik)) {
      people.set(position.personCik, {
        cik: position.personCik,
        name: position.personName,
        roles: new Set(),
        titles: new Set(),
        positions: [],
        disclosedValue: 0,
        positionsValued: 0,
      });
    }

    const person = people.get(position.personCik);
    for (const role of position.relationship.split(",")) person.roles.add(role.trim());
    if (position.title) person.titles.add(position.title);

    person.positions.push({
      issuerCik: position.issuerCik,
      issuerName: position.issuerName,
      ticker: position.ticker,
      security: position.security,
      // "direct" = shares owned outright. "derivative" = options/RSUs/warrants, whose
      // `shares` is the UNDERLYING count and whose value is intrinsic only.
      kind: position.kind || "direct",
      shares: position.shares,
      pricePerShare: position.pricePerShare,
      strikePrice: position.strikePrice ?? null,
      value,
      asOf: position.asOf,
      formType: position.formType,
      title: position.title,
    });

    if (value != null) {
      person.disclosedValue += value;
      person.positionsValued += 1;
    }
  }

  log(`people: ${people.size}   distinct issuers: ${issuerCiks.size}`);

  // Issuer addresses, then place each on the map via its postcode.
  const centroids = loadCentroids(dataDir);
  if (centroids.size === 0) {
    throw new Error(
      `No ZIP centroids at ${dataDir}/zcta-centroids.tsv. Run scripts/fetch-centroids.mjs first.`,
    );
  }

  const issuers = new Map();
  let done = 0;
  let placed = 0;
  let foreign = 0;
  let unplaceableUs = 0;

  /**
   * `--max-issuers N` stops after N issuers. A full quarter is ~4,500 EDGAR calls at
   * the SEC's rate, which is roughly 45 minutes — far too slow for a smoke test. A
   * bounded build produces a real, correctly-shaped index in about a minute.
   *
   * It is recorded in meta as `partial: true` so a truncated index can never be
   * mistaken for a complete one by /health or by anything reading the file.
   */
  const maxIssuers = Number(arg("max-issuers", "")) || Infinity;
  const targets = [...issuerCiks].slice(0, Number.isFinite(maxIssuers) ? maxIssuers : undefined);

  for (const cik of targets) {
    const issuer = await fetchIssuer(cik);
    done += 1;
    if (done % 250 === 0 || done === targets.length) {
      log(`issuers ${done}/${targets.length} (${placed} placed)`);
    }
    if (!issuer) continue;

    // Placement keys off a US state-code whitelist, not EDGAR's isForeign flag, which
    // is wrong often enough to matter — see geo-us.mjs. A foreign issuer stays in the
    // index with full detail; it simply carries no coordinates and so never appears in
    // a location search.
    const centroid = isUsAddress(issuer.address)
      ? centroids.get(String(issuer.address.zip).slice(0, 5).padStart(5, "0"))
      : null;
    if (centroid) placed += 1;
    else if (isUsAddress(issuer.address)) unplaceableUs += 1;
    else foreign += 1;

    issuers.set(cik, {
      ...issuer,
      lat: centroid?.lat ?? null,
      lng: centroid?.lng ?? null,
      geoTier: centroid ? "zip_centroid" : null,
    });
  }

  const output = {
    meta: {
      built: true,
      builtAt: new Date().toISOString(),
      quarters,
      quarter: quarters[quarters.length - 1],
      people: people.size,
      issuers: issuers.size,
      issuersPlaced: placed,
      issuersForeign: foreign,
      issuersUsUnplaceable: unplaceableUs,
      // A bounded build is a real index over fewer issuers. Flagging it keeps a smoke
      // -test artefact from being read as full quarterly coverage.
      partial: targets.length < issuerCiks.size,
      issuersAvailable: issuerCiks.size,
      source: "SEC Forms 3/4/5 quarterly datasets + EDGAR submissions + Census ZCTA gazetteer",
    },
    people: [...people.values()].map((person) => ({
      ...person,
      roles: [...person.roles].filter(Boolean),
      titles: [...person.titles],
    })),
    issuers: [...issuers.values()],
  };

  const target = path.join(dataDir, "index.json");
  fs.writeFileSync(target, JSON.stringify(output));
  log(`wrote ${target} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
  fs.rmSync(workDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("[build-index] failed:", error.message);
  process.exit(1);
});
