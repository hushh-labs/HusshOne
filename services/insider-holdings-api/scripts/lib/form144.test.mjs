import assert from "node:assert/strict";
import test from "node:test";

import { buildLiquidity, parseForm144 } from "./form144.mjs";

/** Shaped on the real filing 0001892682-26-000021 (Expensify / David Barrett). */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<own:edgarSubmission xmlns:com="http://www.sec.gov/edgar/common" xmlns:own="http://www.sec.gov/edgar/ownership">
  <own:headerData>
    <own:submissionType>144</own:submissionType>
    <own:filerInfo><own:filer><own:filerCredentials>
      <own:cik>0001892682</own:cik>
    </own:filerCredentials></own:filer></own:filerInfo>
  </own:headerData>
  <own:formData>
    <own:issuerInfo>
      <own:issuerCik>0001476840</own:issuerCik>
      <own:issuerName>Expensify, Inc.</own:issuerName>
      <own:issuerAddress><com:street1>88 Kearny St</com:street1><com:city>San Francisco</com:city></own:issuerAddress>
    </own:issuerInfo>
    <own:securitiesInformation>
      <own:securitiesClassTitle>Class A Common</own:securitiesClassTitle>
      <own:brokerOrMarketmakerDetails>
        <own:name>Raymod James &amp; Associates Inc</own:name>
        <own:address><com:street1>880 Carillon Parkway</com:street1><com:city>St. Petersburg</com:city></own:address>
      </own:brokerOrMarketmakerDetails>
      <own:noOfUnitsSold>19123</own:noOfUnitsSold>
      <own:aggregateMarketValue>24859.9</own:aggregateMarketValue>
      <own:noOfUnitsOutstanding>84278255</own:noOfUnitsOutstanding>
      <own:approxSaleDate>06/15/2026</own:approxSaleDate>
      <own:securitiesExchangeName>NASDAQ</own:securitiesExchangeName>
    </own:securitiesInformation>
    <own:securitiesToBeSold>
      <own:nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>David Barrett</own:nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>
      <own:relationshipToIssuer>Director</own:relationshipToIssuer>
      <own:relationshipToIssuer>Officer</own:relationshipToIssuer>
    </own:securitiesToBeSold>
    <own:securitiesSoldInPast3Months>
      <own:sellerDetails>
        <own:name>David Barrett</own:name>
        <own:address>
          <com:street1>88 Kearny St</com:street1><com:street2>Ste 1600</com:street2>
          <com:city>San Francisco</com:city><com:zipCode>94108</com:zipCode>
        </own:address>
      </own:sellerDetails>
      <own:grossProceeds>2045.92</own:grossProceeds>
    </own:securitiesSoldInPast3Months>
  </own:formData>
</own:edgarSubmission>`;

test("the namespaced XML parses — a naive scan returns nothing at all", () => {
  const notice = parseForm144(XML, { accession: "0001892682-26-000021" });
  assert.equal(notice.name, "David Barrett");
  assert.equal(notice.issuerName, "Expensify, Inc.");
  assert.deepEqual(notice.roles, ["Director", "Officer"]);
});

test("the sale value is exact dollars from the filing", () => {
  const notice = parseForm144(XML);
  assert.equal(notice.proposedSaleValue, 24859.9);
  assert.equal(notice.unitsToBeSold, 19123);
  assert.equal(notice.approxSaleDate, "06/15/2026");
  assert.equal(notice.exchange, "NASDAQ");
});

test("NO seller or broker address survives — the guidance saying there is none is wrong", () => {
  // sellerDetails/address genuinely exists and is seller-supplied. Here it is an office;
  // nothing in the form requires that, so it is never read.
  const serialised = JSON.stringify(parseForm144(XML));
  for (const leak of ["88 Kearny", "Ste 1600", "94108", "Carillon", "St. Petersburg", "sellerDetails", "address"]) {
    assert.equal(serialised.includes(leak), false, `${leak} leaked out of a Form 144`);
  }
});

test("the CIK join key is reported as the FILER's, not asserted to be the person's", () => {
  // Most Form 144s carry the person's own CIK, which is what joins to the Section 16
  // index — but some carry a filing agent's, so the field is named for what it is.
  const notice = parseForm144(XML);
  assert.equal(notice.filerCik, "1892682", "leading zeroes stripped for joining");
  assert.equal("personCik" in notice, false, "must not claim to be the person's CIK");
});

test("a filing with no indexable role is skipped", () => {
  const xml = XML.replace(/<own:relationshipToIssuer>Director<\/own:relationshipToIssuer>/, "")
    .replace(/<own:relationshipToIssuer>Officer<\/own:relationshipToIssuer>/, "<own:relationshipToIssuer>Other</own:relationshipToIssuer>");
  assert.equal(parseForm144(xml), null);
});

test("10% variants normalise to the same role used elsewhere", () => {
  const xml = XML.replace("<own:relationshipToIssuer>Director</own:relationshipToIssuer>",
    "<own:relationshipToIssuer>10% Owner</own:relationshipToIssuer>");
  assert.ok(parseForm144(xml).roles.includes("TenPercentOwner"));
});

test("the OTHER live XML shape parses too — default namespace, no prefix", () => {
  // EDGAR serves both. Hardcoding the `own:` prefix skipped 91% of a real quarter.
  const unprefixed = `<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/ownership" xmlns:com="http://www.sec.gov/edgar/common">
  <headerData><submissionType>144</submissionType>
    <filerInfo><filer><filerCredentials><cik>0001786391</cik></filerCredentials></filer></filerInfo>
  </headerData>
  <formData>
    <issuerInfo><issuerCik>0001770787</issuerCik><issuerName>10x Genomics, Inc.</issuerName></issuerInfo>
    <securitiesInformation>
      <noOfUnitsSold>9430</noOfUnitsSold>
      <aggregateMarketValue>232732.40</aggregateMarketValue>
    </securitiesInformation>
    <securitiesToBeSold>
      <nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>Hindson Benjamin J.</nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>
      <relationshipToIssuer>Officer</relationshipToIssuer>
    </securitiesToBeSold>
  </formData>
</edgarSubmission>`;

  const notice = parseForm144(unprefixed, { accession: "0001786391-26-000002" });
  assert.equal(notice.name, "Hindson Benjamin J.");
  assert.equal(notice.issuerName, "10x Genomics, Inc.");
  assert.equal(notice.proposedSaleValue, 232732.4);
  assert.equal(notice.filerCik, "1786391");
});

test("XML entities in names are decoded", () => {
  // "PAULSON &amp; CO. INC." reached the live roster with the entity intact.
  const xml = XML.replace("David Barrett", "PAULSON &amp; CO. INC.")
    .replace("Expensify, Inc.", "Smith &amp; Wesson &#39;Brands&#39;");
  const notice = parseForm144(xml);
  assert.equal(notice.name, "PAULSON & CO. INC.");
  assert.equal(notice.issuerName, "Smith & Wesson 'Brands'");
});

test("a non-144 submission and malformed input are refused", () => {
  assert.equal(parseForm144(XML.replace("<own:submissionType>144<", "<own:submissionType>4<")), null);
  assert.equal(parseForm144(""), null);
  assert.equal(parseForm144(null), null);
  assert.equal(parseForm144("<html>not a filing</html>"), null);
});

test("a filing with no sale value is skipped rather than valued at zero", () => {
  assert.equal(parseForm144(XML.replace(/<own:aggregateMarketValue>.*?<\/own:aggregateMarketValue>/, "")), null);
});

test("liquidity reports the LARGEST notice, never a sum", () => {
  // The same shares can be noticed repeatedly and a notice is an intention, not a sale.
  // Summing would double-count someone who re-filed.
  const a = parseForm144(XML, { accession: "a1" });
  const b = { ...parseForm144(XML, { accession: "a2" }), proposedSaleValue: 500000 };
  const [person] = buildLiquidity([a, b]);

  assert.equal(person.noticeCount, 2);
  assert.equal(person.largestProposedSale, 500000, "largest, not 524,859.90");
  assert.equal("totalProposedSale" in person, false, "no sum is offered");
});

test("people sharing a filing agent are not merged when the CIK is the agent's", () => {
  const a = { ...parseForm144(XML), filerCik: null, name: "Alice A", issuerCik: "1" };
  const b = { ...parseForm144(XML), filerCik: null, name: "Bob B", issuerCik: "1" };
  assert.equal(buildLiquidity([a, b]).length, 2);
});
