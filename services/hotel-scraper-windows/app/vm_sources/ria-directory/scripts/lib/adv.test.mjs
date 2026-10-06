import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsvLine,
  hasUnterminatedQuote,
  createCsvRecordAssembler,
  parseAum,
  normalizeCrd,
  buildHeaderIndex,
  FIRM_FIELD_ALIASES,
  ADVISER_FIELD_ALIASES,
  mapAdvRowToFirm,
  mapAdvRowToAdviser,
  parseCompilationManifest,
  extractCompilationLinksFromHtml,
  staticFallbackUrls,
  discoverLatestCompilationUrls,
  looksLikeXml,
  decodeXmlEntities,
  xmlAttrs,
  xmlText,
  createXmlElementExtractor,
  mapFirmXmlElement,
  mapAdviserXmlElement,
} from "./adv.mjs";

// ── CSV parsing ─────────────────────────────────────────────────────────────────────

test("parseCsvLine splits plain fields", () => {
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(parseCsvLine("a,,c"), ["a", "", "c"]);
  assert.deepEqual(parseCsvLine(""), [""]);
});

test("parseCsvLine honors quoted fields, embedded commas, and doubled quotes", () => {
  assert.deepEqual(parseCsvLine('"Smith, John",42'), ["Smith, John", "42"]);
  assert.deepEqual(parseCsvLine('"a ""quoted"" word",x'), ['a "quoted" word', "x"]);
  assert.deepEqual(parseCsvLine('"",""'), ["", ""]);
});

test("hasUnterminatedQuote detects a record that spans physical lines", () => {
  assert.equal(hasUnterminatedQuote('"line one'), true);
  assert.equal(hasUnterminatedQuote('"complete","row"'), false);
  assert.equal(hasUnterminatedQuote('"has ""escaped"" quotes"'), false);
});

test("createCsvRecordAssembler reassembles a quoted field with an embedded newline", () => {
  const asm = createCsvRecordAssembler();
  assert.equal(asm.push('"multi'), null); // quoted field still open
  const rec = asm.push('line",second');
  assert.deepEqual(rec, ["multi\nline", "second"]);
  // A simple complete line passes straight through.
  assert.deepEqual(asm.push("x,y"), ["x", "y"]);
  assert.equal(asm.flush(), null);
});

// ── Value normalizers ─────────────────────────────────────────────────────────────

test("parseAum strips currency formatting and applies k/m/b multipliers", () => {
  assert.equal(parseAum("$1,234,567.89"), 1234567.89);
  assert.equal(parseAum("2.5b"), 2.5e9);
  assert.equal(parseAum("750m"), 750e6);
  assert.equal(parseAum("100k"), 100e3);
  assert.equal(parseAum(""), null);
  assert.equal(parseAum("-"), null);
  assert.equal(parseAum(null), null);
  assert.equal(parseAum("n/a"), null);
});

test("normalizeCrd keeps positive integer ids and rejects junk", () => {
  assert.equal(normalizeCrd("108511"), 108511);
  assert.equal(normalizeCrd("CRD#108511"), 108511);
  assert.equal(normalizeCrd(""), null);
  assert.equal(normalizeCrd(null), null);
  assert.equal(normalizeCrd("abc"), null);
});

// ── Header mapping + row mappers ───────────────────────────────────────────────────

test("buildHeaderIndex matches aliases across spellings (case/space/underscore)", () => {
  const headers = ["Organization CRD#", "Primary Business Name", "Main Office City", "Main_Office_State"];
  const idx = buildHeaderIndex(headers, FIRM_FIELD_ALIASES);
  assert.equal(idx.crd, 0);
  assert.equal(idx.firmName, 1);
  assert.equal(idx.city, 2);
  assert.equal(idx.state, 3);
  assert.equal(idx.zip, -1); // absent → -1
});

test("mapAdvRowToFirm maps a firm row, normalizes zip/state/aum, and keeps raw", () => {
  const headers = [
    "Organization CRD#",
    "SEC#",
    "Primary Business Name",
    "Main Office Street Address 1",
    "Main Office City",
    "Main Office State",
    "Main Office Postal Code",
    "Regulatory Assets Under Management",
    "Total Employees",
  ];
  const fields = ["108511", "801-12345", "Acme Advisers LLC", "1 Main St", "Boston", "ma", "02138-1234", "$2,000,000,000", "42"];
  const rec = mapAdvRowToFirm(headers, fields);
  assert.equal(rec.crd, 108511);
  assert.equal(rec.secNumber, "801-12345");
  assert.equal(rec.firmName, "Acme Advisers LLC");
  assert.equal(rec.city, "Boston");
  assert.equal(rec.state, "MA");
  assert.equal(rec.zip, "02138");
  assert.equal(rec.aum, 2e9);
  assert.equal(rec.totalEmployees, 42);
  assert.equal(rec.raw["Primary Business Name"], "Acme Advisers LLC");
});

test("mapAdvRowToFirm returns null when the row has no numeric CRD", () => {
  const headers = ["Organization CRD#", "Primary Business Name"];
  assert.equal(mapAdvRowToFirm(headers, ["", "No CRD Co"]), null);
});

test("mapAdvRowToAdviser maps an individual row and normalizes firm CRD", () => {
  const headers = ["Individual CRD#", "First Name", "Last Name", "Current Firm CRD", "Current Firm Name", "State"];
  const fields = ["555001", "Jane", "Doe", "108511", "Acme Advisers LLC", "wa"];
  const rec = mapAdvRowToAdviser(headers, fields);
  assert.equal(rec.crd, 555001);
  assert.equal(rec.firstName, "Jane");
  assert.equal(rec.lastName, "Doe");
  assert.equal(rec.currentFirmCrd, 108511);
  assert.equal(rec.currentFirmName, "Acme Advisers LLC");
  assert.equal(rec.state, "WA");
});

// ── Discovery: manifest / html / static ────────────────────────────────────────────

test("parseCompilationManifest picks the newest firm + individual by dated filename", () => {
  const manifest = {
    files: [
      { name: "IA_FIRM_SEC_Feed_06_01_2026.xml.gz", size: 10 },
      { name: "IA_FIRM_SEC_Feed_07_01_2026.xml.gz", size: 12 },
      { name: "IA_INDVL_Feed_07_01_2026.xml.zip", size: 20 },
      { name: "IA_INDVL_Feed_05_01_2026.xml.zip", size: 18 },
      { name: "some_other_report.zip" },
    ],
  };
  const links = parseCompilationManifest(manifest, {
    firmPattern: "IA_FIRM_SEC_Feed",
    individualPattern: "IA_INDVL_Feed",
    baseUrl: "https://reports.adviserinfo.sec.gov/reports/CompilationReports",
  });
  assert.equal(links.firm.name, "IA_FIRM_SEC_Feed_07_01_2026.xml.gz");
  assert.equal(
    links.firm.url,
    "https://reports.adviserinfo.sec.gov/reports/CompilationReports/IA_FIRM_SEC_Feed_07_01_2026.xml.gz",
  );
  assert.equal(links.individual.name, "IA_INDVL_Feed_07_01_2026.xml.zip");
});

test("parseCompilationManifest also reads a `query`-keyed list", () => {
  const manifest = { query: ["IA_FIRM_SEC_Feed_07_01_2026.xml.gz", "IA_INDVL_Feed_07_01_2026.xml.zip"] };
  const links = parseCompilationManifest(manifest, {
    firmPattern: "IA_FIRM_SEC_Feed",
    individualPattern: "IA_INDVL_Feed",
    baseUrl: "https://example.test/base",
  });
  assert.equal(links.firm.name, "IA_FIRM_SEC_Feed_07_01_2026.xml.gz");
  assert.equal(links.individual.url, "https://example.test/base/IA_INDVL_Feed_07_01_2026.xml.zip");
});

test("extractCompilationLinksFromHtml scrapes hrefs and bare feed filenames", () => {
  const html = `
    <a href="/reports/CompilationReports/IA_FIRM_SEC_Feed_07_01_2026.xml.gz">firm</a>
    Latest individual feed: IA_INDVL_Feed_07_01_2026.xml.zip
  `;
  const links = extractCompilationLinksFromHtml(html, {
    firmPattern: "IA_FIRM_SEC_Feed",
    individualPattern: "IA_INDVL_Feed",
    baseUrl: "https://reports.adviserinfo.sec.gov/reports/CompilationReports",
  });
  assert.equal(links.firm.name, "IA_FIRM_SEC_Feed_07_01_2026.xml.gz");
  assert.match(links.firm.url, /^https:\/\/reports\.adviserinfo\.sec\.gov\//);
  assert.equal(links.individual.name, "IA_INDVL_Feed_07_01_2026.xml.zip");
});

test("staticFallbackUrls builds dated .xml.gz/.xml.zip paths flagged verified:false", () => {
  const fb = staticFallbackUrls(new Date(Date.UTC(2026, 6, 1)), { baseUrl: "https://example.test/base" });
  assert.equal(fb.verified, false);
  assert.match(fb.firm.name, /^IA_FIRM_SEC_Feed_\d{2}_\d{2}_2026\.xml\.gz$/);
  assert.match(fb.individual.name, /^IA_INDVL_Feed_\d{2}_\d{2}_2026\.xml\.zip$/);
  assert.equal(fb.firm.verified, false);
});

test("discoverLatestCompilationUrls prefers the manifest when it resolves", async () => {
  const manifest = {
    files: [
      { name: "IA_FIRM_SEC_Feed_07_01_2026.xml.gz" },
      { name: "IA_INDVL_Feed_07_01_2026.xml.zip" },
    ],
  };
  const fetchImpl = async (url) => {
    if (url.includes("manifest")) return { ok: true, json: async () => manifest };
    throw new Error("should not reach html");
  };
  const out = await discoverLatestCompilationUrls({
    fetchImpl,
    manifestUrl: "https://example.test/manifest.json",
    reportsBaseUrl: "https://example.test/base",
    firmPattern: "IA_FIRM_SEC_Feed",
    individualPattern: "IA_INDVL_Feed",
  });
  assert.equal(out.via, "manifest");
  assert.equal(out.firm.name, "IA_FIRM_SEC_Feed_07_01_2026.xml.gz");
});

test("discoverLatestCompilationUrls falls back to HTML, then to static", async () => {
  const html = `<a href="IA_FIRM_SEC_Feed_07_01_2026.xml.gz">f</a> IA_INDVL_Feed_07_01_2026.xml.zip`;
  const htmlFetch = async (url) => {
    if (url.includes("manifest")) return { ok: false, status: 404 };
    return { ok: true, text: async () => html };
  };
  const viaHtml = await discoverLatestCompilationUrls({
    fetchImpl: htmlFetch,
    manifestUrl: "https://example.test/manifest.json",
    compilationPageUrl: "https://example.test/compilation",
    reportsBaseUrl: "https://example.test/base",
    firmPattern: "IA_FIRM_SEC_Feed",
    individualPattern: "IA_INDVL_Feed",
  });
  assert.equal(viaHtml.via, "html");
  assert.equal(viaHtml.firm.name, "IA_FIRM_SEC_Feed_07_01_2026.xml.gz");

  const deadFetch = async () => ({ ok: false, status: 500 });
  const viaStatic = await discoverLatestCompilationUrls({
    fetchImpl: deadFetch,
    manifestUrl: "https://example.test/manifest.json",
    compilationPageUrl: "https://example.test/compilation",
    reportsBaseUrl: "https://example.test/base",
    firmPattern: "IA_FIRM_SEC_Feed",
    individualPattern: "IA_INDVL_Feed",
    now: new Date(Date.UTC(2026, 6, 1)),
  });
  assert.equal(viaStatic.via, "static-fallback");
  assert.equal(viaStatic.verified, false);
});

// ── XML guard ──────────────────────────────────────────────────────────────────────

test("looksLikeXml distinguishes XML feeds from CSV rows", () => {
  assert.equal(looksLikeXml('<?xml version="1.0"?><IAPDFirmSECReport>'), true);
  assert.equal(looksLikeXml("  <Firms>"), true);
  assert.equal(looksLikeXml("Organization CRD#,Primary Business Name"), false);
  assert.equal(looksLikeXml(""), false);
});

// ── XML feed parsing (the SEC's LIVE format) ─────────────────────────────────────────

// Real element shapes captured from the live 2026-07 IAPD feeds (trimmed to the fields we map).
const FIRM_XML = `<Firm>
  <Info FirmCrdNb="283882" SECNb="801-135399" BusNm="RABENOLD ADVISORS, INC." LegalNm="RABENOLD ADVISORS INC"/>
  <MainAddr Strt1="5930 MAIN STREET" Strt2="SUITE 200" City="WILLIAMSVILLE" State="NY" Cntry="United States" PostlCd="14221-5794" PhNb="716-568-8790"/>
  <Rgstn FirmType="Registered" St="Approved"/>
  <Item5A TtlEmp="4"/>
  <Item5F Q5F2C="35557038" Q5F2F="117"/>
  <WebAddrs><WebAddr>HTTP://WWW.RABENOLDADVISORS.COM</WebAddr></WebAddrs>
</Firm>`;

const INDVL_XML = `<Indvl>
  <Info lastNm="REYNOLDS" firstNm="DEBORAH" midNm="R" indvlPK="4209133"/>
  <CrntEmp orgNm="PRINCIPAL SECURITIES, INC." orgPK="1137" str1="711 HIGH STREET" city="DES MOINES" state="IA" postlCd="50392" cntry="United States"/>
</Indvl>`;

test("decodeXmlEntities handles named, decimal, and hex entities", () => {
  assert.equal(decodeXmlEntities("Smith &amp; Jones, &lt;LLC&gt;"), "Smith & Jones, <LLC>");
  assert.equal(decodeXmlEntities("caf&#233;"), "café");
  assert.equal(decodeXmlEntities("caf&#xe9;"), "café");
  assert.equal(decodeXmlEntities("&unknownentity;"), "&unknownentity;"); // left intact
  assert.equal(decodeXmlEntities(null), null);
});

test("xmlAttrs reads the first matching tag's attributes and decodes values", () => {
  const info = xmlAttrs(FIRM_XML, "Info");
  assert.equal(info.FirmCrdNb, "283882");
  assert.equal(info.SECNb, "801-135399");
  assert.equal(info.BusNm, "RABENOLD ADVISORS, INC.");
  const addr = xmlAttrs(FIRM_XML, "MainAddr");
  assert.equal(addr.City, "WILLIAMSVILLE");
  assert.equal(addr.PhNb, "716-568-8790");
  assert.deepEqual(xmlAttrs(FIRM_XML, "NoSuchTag"), {});
});

test("xmlAttrs does not confuse a prefix tag (Info vs InfoExtra)", () => {
  const block = `<Firm><InfoExtra x="wrong"/><Info FirmCrdNb="7"/></Firm>`;
  assert.equal(xmlAttrs(block, "Info").FirmCrdNb, "7");
  assert.equal(xmlAttrs(block, "Info").x, undefined);
});

test("xmlText extracts trimmed element text, or null when absent/empty", () => {
  assert.equal(xmlText(FIRM_XML, "WebAddr"), "HTTP://WWW.RABENOLDADVISORS.COM");
  assert.equal(xmlText(FIRM_XML, "Missing"), null);
  assert.equal(xmlText("<a>   </a>", "a"), null);
});

test("createXmlElementExtractor yields whole elements and survives chunk splits", () => {
  const ex = createXmlElementExtractor("Firm");
  const feed = `<?xml version="1.0" encoding="ISO-8859-1"?><IAPDFirmSECReport><Firms>${FIRM_XML}<Firm><Info FirmCrdNb="999"/></Firm></Firms></IAPDFirmSECReport>`;
  // Feed the whole thing as many tiny chunks to prove buffering across boundaries.
  const blocks = [];
  for (let i = 0; i < feed.length; i += 7) blocks.push(...ex.push(feed.slice(i, i + 7)));
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /RABENOLD ADVISORS/);
  assert.match(blocks[1], /FirmCrdNb="999"/);
});

test("createXmlElementExtractor emits two elements packed in one chunk", () => {
  const ex = createXmlElementExtractor("Indvl");
  const out = ex.push(`<Indvl><Info indvlPK="1"/></Indvl><Indvl><Info indvlPK="2"/></Indvl>`);
  assert.equal(out.length, 2);
  assert.match(out[0], /indvlPK="1"/);
  assert.match(out[1], /indvlPK="2"/);
});

test("mapFirmXmlElement maps a firm element to an upsertFirm record", () => {
  const rec = mapFirmXmlElement(FIRM_XML);
  assert.equal(rec.crd, 283882);
  assert.equal(rec.secNumber, "801-135399");
  assert.equal(rec.firmName, "RABENOLD ADVISORS, INC.");
  assert.equal(rec.street1, "5930 MAIN STREET");
  assert.equal(rec.street2, "SUITE 200");
  assert.equal(rec.city, "WILLIAMSVILLE");
  assert.equal(rec.state, "NY");
  assert.equal(rec.zip, "14221"); // normalizeZip trims the +4
  assert.equal(rec.phone, "716-568-8790");
  assert.equal(rec.website, "HTTP://WWW.RABENOLDADVISORS.COM");
  assert.equal(rec.aum, 35557038);
  assert.equal(rec.totalEmployees, 4);
  assert.equal(rec.numAccounts, 117);
  assert.equal(rec.registrationStatus, "Registered");
  assert.ok(rec.raw && rec.raw.info && rec.raw.mainAddr);
});

test("mapFirmXmlElement falls back to LegalNm and returns null without a CRD", () => {
  const noBus = `<Firm><Info FirmCrdNb="5" LegalNm="ONLY LEGAL LLC"/></Firm>`;
  assert.equal(mapFirmXmlElement(noBus).firmName, "ONLY LEGAL LLC");
  assert.equal(mapFirmXmlElement(`<Firm><Info SECNb="801-1"/></Firm>`), null);
});

test("mapAdviserXmlElement maps an individual element to an upsertAdviser record", () => {
  const rec = mapAdviserXmlElement(INDVL_XML);
  assert.equal(rec.crd, 4209133);
  assert.equal(rec.firstName, "DEBORAH");
  assert.equal(rec.lastName, "REYNOLDS");
  assert.equal(rec.currentFirmCrd, 1137);
  assert.equal(rec.currentFirmName, "PRINCIPAL SECURITIES, INC.");
  assert.equal(rec.street1, "711 HIGH STREET");
  assert.equal(rec.city, "DES MOINES");
  assert.equal(rec.state, "IA");
  assert.equal(rec.zip, "50392");
  assert.ok(rec.raw && rec.raw.info && rec.raw.crntEmp);
});

test("mapAdviserXmlElement returns null without an individual CRD", () => {
  assert.equal(mapAdviserXmlElement(`<Indvl><Info firstNm="NO" lastNm="PK"/></Indvl>`), null);
});
