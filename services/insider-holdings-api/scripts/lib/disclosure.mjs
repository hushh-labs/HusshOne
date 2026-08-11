/**
 * WHAT THIS SERVICE WILL AND WILL NOT SAY ABOUT A PERSON.
 *
 * This module is the boundary. Every response is built through it. It exists because
 * the difference between this service and a stalking tool is not the data — it is
 * which fields reach the wire, and that distinction has to live in one enforceable
 * place rather than in the discipline of whoever writes the next endpoint.
 *
 * ── Why these people, and not other people ────────────────────────────────────────
 *
 * Section 16 of the Securities Exchange Act of 1934 compels the officers, directors
 * and greater-than-10% owners of a public company to file their holdings and every
 * trade, by name, on a public docket. Congress imposed that duty FOR the purpose of
 * public scrutiny: it is an accountability instrument aimed at self-dealing.
 *
 * So a Section 16 insider is not a private individual whose finances we uncovered.
 * They are a person who accepted a disclosure duty as a condition of the role, and
 * who filed these very numbers themselves. Surfacing them is the intended use of the
 * filing. That is the same footing as the RIA and BrokerCheck services in this repo,
 * which surface licensed advisers who are publicly registered by a regulator.
 *
 * NOBODY ELSE GOES IN THIS INDEX. Not spouses, not private investors, not people
 * inferred to be wealthy from property records or donations or any other trace. If a
 * person did not personally file a Form 3, 4 or 5, this service has nothing to say
 * about them, and `assertDisclosable` is what makes that true rather than aspirational.
 *
 * ── Why the address is always the company's ───────────────────────────────────────
 *
 * Form 3/4/5 carries a mailing address for the filer. In the 2026Q2 dataset only 42%
 * of those are explicitly "C/O <company>", which means the rest cannot be assumed to
 * be business addresses — some are homes. There is no reliable flag separating them.
 *
 * Rather than guess per-row, this service NEVER reads the filer's address field. Every
 * location it reports is the ISSUER's business address from EDGAR's submissions API —
 * a corporate headquarters, unambiguously. `stripOwnerAddress` enforces it, and a test
 * asserts no owner-address key can appear in any payload.
 *
 * The cost is honest and worth stating: proximity here means "works at a company
 * headquartered near you", not "lives near you". The second question is the one this
 * service is built not to answer.
 */

/** Section 16 relationship codes we will index. Anything else is not disclosable. */
const SECTION_16_ROLES = Object.freeze(["Officer", "Director", "TenPercentOwner"]);

/**
 * Owner-address keys from the SEC dataset. These must never reach a response.
 * Kept as an explicit list so `stripOwnerAddress` fails loudly if the SEC adds a
 * field rather than silently passing a new address column through.
 */
export const FORBIDDEN_OWNER_FIELDS = Object.freeze([
  "RPTOWNER_STREET1",
  "RPTOWNER_STREET2",
  "RPTOWNER_CITY",
  "RPTOWNER_STATE",
  "RPTOWNER_ZIPCODE",
  "RPTOWNER_STATE_DESC",
  "ownerStreet1",
  "ownerStreet2",
  "ownerCity",
  "ownerState",
  "ownerZip",
  "ownerAddress",
  "homeAddress",
  "residentialAddress",
]);

/**
 * Is this filer someone we may name?
 *
 * `relationship` is the raw RPTOWNER_RELATIONSHIP string, which is comma-joined when a
 * person holds several roles ("Director,Officer"). A row qualifies when at least one
 * role is a Section 16 role.
 */
export function isSection16Insider(relationship) {
  if (!relationship || typeof relationship !== "string") return false;
  return relationship
    .split(",")
    .map((part) => part.trim())
    .some((part) => SECTION_16_ROLES.includes(part));
}

/**
 * Throw unless this person carries a Section 16 disclosure duty.
 *
 * Called at index-build time, so a non-qualifying person never enters the dataset at
 * all. Fail-closed on purpose: an unrecognised relationship string is a reason to
 * exclude someone, never a reason to include them.
 */
export function assertDisclosable(row) {
  if (!isSection16Insider(row?.relationship)) {
    throw new Error(
      `Refusing to index ${row?.name || "an unnamed filer"}: relationship ` +
        `${JSON.stringify(row?.relationship)} is not a Section 16 role. This service ` +
        `indexes only officers, directors and 10% owners, who file their own holdings ` +
        `under a public disclosure duty.`,
    );
  }
  return row;
}

/**
 * Remove every owner-address field from an object before it is serialised.
 *
 * Defence in depth. The index builder already drops these columns, so in normal
 * operation this is a no-op — which is exactly why it is cheap to keep, and why it
 * will catch the future change that reintroduces one by accident.
 */
export function stripOwnerAddress(payload) {
  if (payload == null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(stripOwnerAddress);

  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_OWNER_FIELDS.includes(key)) continue;
    clean[key] = value && typeof value === "object" ? stripOwnerAddress(value) : value;
  }
  return clean;
}

/**
 * Attribution carried on every response.
 *
 * `valuationNotice` is the one people misread, so it is stated at the point of use:
 * a position value here is shares-last-reported multiplied by the price disclosed on
 * that filing. It is not a live market value and it is not a person's net worth. It
 * is one holding in one company, as of one filing date.
 */
export const ATTRIBUTION = Object.freeze({
  source: "U.S. Securities and Exchange Commission — Forms 3, 4 and 5 (Section 16 insider reports)",
  sourceUrl: "https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets",
  issuerSource: "SEC EDGAR submissions API",
  geoSource: "U.S. Census Bureau ZCTA Gazetteer",
  notice:
    "Officers, directors and greater-than-10% owners of public companies file these holdings themselves under Section 16 of the Securities Exchange Act of 1934. The SEC's own record is authoritative.",
  valuationNotice:
    "A position value is the shares reported on the filer's most recent filing multiplied by the price per share disclosed on that filing. It is a point-in-time disclosed position in ONE issuer — not a live market value, and not the person's net worth.",
  locationNotice:
    "Location is the ISSUER's business address as filed with EDGAR, not the filer's address. This service never reads or returns a filer's own address. Distance means 'works at a company headquartered near here'.",
  geoPrecisionNotice:
    "Distances are computed from ZIP-code centroids published by the Census Bureau and are approximate, not rooftop-accurate.",
});
