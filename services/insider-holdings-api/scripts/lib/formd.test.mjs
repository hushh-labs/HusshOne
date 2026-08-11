import assert from "node:assert/strict";
import test from "node:test";

import { buildRoster, parseFormD } from "./formd.mjs";

/** Modelled on the real filing 0002133962-26-000001, where the issuer address IS a house. */
const FILING = `<?xml version="1.0"?>
<edgarSubmission>
  <primaryIssuer>
    <cik>0002133962</cik>
    <entityName>INANAM Holdings Fund 2026-A LLC</entityName>
    <entityType>Limited Liability Company</entityType>
    <jurisdictionOfInc>TEXAS</jurisdictionOfInc>
    <yearOfInc><withinFiveYears>true</withinFiveYears><value>2026</value></yearOfInc>
    <issuerAddress>
      <street1>2312 CASA GRANDE DRIVE</street1>
      <city>LEAGUE CITY</city>
      <stateOrCountry>TX</stateOrCountry>
      <zipCode>77573</zipCode>
    </issuerAddress>
    <issuerPhoneNumber>281-555-0100</issuerPhoneNumber>
  </primaryIssuer>
  <offeringData>
    <industryGroupType>Pooled Investment Fund</industryGroupType>
    <offeringSalesAmounts>
      <totalOfferingAmount>50000000</totalOfferingAmount>
      <totalAmountSold>1250000</totalAmountSold>
      <totalRemaining>48750000</totalRemaining>
    </offeringSalesAmounts>
    <investors><totalNumberAlreadyInvested>7</totalNumberAlreadyInvested></investors>
    <minimumInvestmentAccepted>25000</minimumInvestmentAccepted>
  </offeringData>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Edward</firstName><lastName>Ellingsworth</lastName></relatedPersonName>
      <relatedPersonAddress>
        <street1>2312 Casa Grande Dr.</street1><city>League City</city>
        <stateOrCountry>TX</stateOrCountry><zipCode>77573</zipCode>
      </relatedPersonAddress>
      <relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList>
      <relationshipClarification>Co-Manager of the Manager</relationshipClarification>
    </relatedPersonInfo>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Suzanne</firstName><lastName>Ellingsworth</lastName></relatedPersonName>
      <relatedPersonAddress>
        <street1>2312 Casa Grande Dr.</street1><city>League City</city>
        <stateOrCountry>TX</stateOrCountry><zipCode>77573</zipCode>
      </relatedPersonAddress>
      <relatedPersonRelationshipList><relationship>Executive Officer</relationship></relatedPersonRelationshipList>
    </relatedPersonInfo>
  </relatedPersonsList>
</edgarSubmission>`;

test("named officers and directors of a private company are extracted", () => {
  const filing = parseFormD(FILING, { accession: "0002133962-26-000001" });
  assert.equal(filing.issuer.name, "INANAM Holdings Fund 2026-A LLC");
  assert.equal(filing.people.length, 2);
  assert.equal(filing.people[0].name, "Edward Ellingsworth");
  assert.deepEqual(filing.people[0].roles, ["Director"]);
  assert.equal(filing.people[0].roleNote, "Co-Manager of the Manager");
});

test("NO street address survives — not the issuer's, not the person's", () => {
  // This is the whole reason Form D is not on the proximity map: the issuer address and
  // the related-person address are the SAME HOUSE in this real filing.
  const serialised = JSON.stringify(parseFormD(FILING));
  assert.equal(serialised.includes("CASA GRANDE"), false, "issuer street leaked");
  assert.equal(serialised.includes("Casa Grande"), false, "person street leaked");
  assert.equal(serialised.includes("77573"), false, "postcode leaked — too identifying at this granularity");
  for (const field of ["street1", "relatedPersonAddress", "zipCode"]) {
    assert.equal(serialised.includes(field), false, `${field} leaked`);
  }
});

test("city and state are kept — coarse enough to be safe, useful enough to matter", () => {
  const filing = parseFormD(FILING);
  assert.equal(filing.issuer.city, "LEAGUE CITY");
  assert.equal(filing.issuer.state, "TX");
});

test("no coordinates are ever produced", () => {
  const filing = parseFormD(FILING);
  for (const field of ["lat", "lng", "distanceMiles", "geoPrecision"]) {
    assert.equal(field in filing.issuer, false, `${field} must not exist on a Form D issuer`);
  }
});

test("the money is the COMPANY's raise, never the person's wealth", () => {
  const filing = parseFormD(FILING);
  assert.equal(filing.raised.totalOfferingAmount, 50000000);
  assert.equal(filing.raised.totalAmountSold, 1250000);
  assert.equal(filing.raised.investorCount, 7);
  // Form D states no ownership share for any related person, so no per-person value
  // can honestly be derived from it.
  assert.equal("value" in filing.people[0], false);
  assert.equal("netWorth" in filing.people[0], false);
});

test("people with no governance role are not indexed", () => {
  const xml = FILING.replace("<relationship>Director</relationship>", "<relationship>Spouse</relationship>")
    .replace("<relationship>Executive Officer</relationship>", "<relationship>Investor</relationship>");
  assert.equal(parseFormD(xml), null, "a filing naming nobody indexable returns null");
});

test("malformed and empty input is survivable", () => {
  assert.equal(parseFormD(""), null);
  assert.equal(parseFormD(null), null);
  assert.equal(parseFormD("<html>not a filing</html>"), null);
});

test("the roster merges repeat filings but keeps same-name people at different companies apart", () => {
  const a = parseFormD(FILING, { accession: "acc-1" });
  const b = parseFormD(FILING, { accession: "acc-2" });
  const other = parseFormD(FILING.replace("<cik>0002133962</cik>", "<cik>0009999999</cik>"), { accession: "acc-3" });

  const roster = buildRoster([a, b, other]);
  const edwards = roster.filter((r) => r.name === "Edward Ellingsworth");

  assert.equal(edwards.length, 2, "same name at two different companies stays two entries");
  const merged = edwards.find((r) => r.issuer.cik === "0002133962");
  assert.equal(merged.offerings.length, 2, "two filings for one company merge into one person");
  assert.equal(merged.largestOfferingAmount, 1250000, "largest AMOUNT SOLD, not the target");
});
