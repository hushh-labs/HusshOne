// Firm-level records. FINRA models firms and people in separate endpoints, and the
// CONTACT details live on the firm — an individual's payload has a branch street address
// but no phone number. So "how do I reach this adviser" is only answerable by joining the
// person to their employer, which is what enrichBranchesWithFirms does.
//
// Example: CRD 149777 (Morgan Stanley) carries office address, mailing address, business
// phone, firm type/size, registrations, direct owners and disclosures.

/** Build a firm profile from a parsed detail payload. */
export function buildFirmProfile(crd, detail) {
  const basic = detail?.basicInformation || {};
  const address = detail?.firmAddressDetails || {};
  const ia = detail?.iaFirmAddressDetails || {};

  return {
    firmId: String(crd),
    firmName: basic.firmName || null,
    advisorFirmName: basic.iaFirmName || null,
    otherNames: Array.isArray(basic.otherNames) ? basic.otherNames : [],

    isBrokerDealer: String(basic.bcScope || "").toUpperCase() === "ACTIVE",
    isInvestmentAdvisor: String(basic.iaScope || "").toUpperCase() === "ACTIVE",
    finraRegistered: basic.finraRegistered === "Y",
    regulator: basic.regulator || null,
    firmType: basic.firmType || null,
    firmSize: basic.firmSize || null,
    firmStatus: basic.firmStatus || null,
    formedState: basic.formedState || null,
    formedDate: basic.formedDate || null,
    district: basic.districtName || null,
    secNumbers: {
      advisor: basic.iaSECNumber || null,
      brokerDealer: basic.bdSECNumber || null,
    },

    // The contact block — the reason this endpoint exists.
    contact: {
      phone: address.businessPhoneNumber || ia.businessPhoneNumber || null,
      officeAddress: normalizeAddress(address.officeAddress || ia.officeAddress),
      mailingAddress: normalizeAddress(address.mailingAddress || ia.mailingAddress),
    },

    hasDisclosures: detail?.bdDisclosureFlag === "Y" || detail?.iaDisclosureFlag === "Y",
    disclosureCount: Array.isArray(detail?.disclosures) ? detail.disclosures.length : 0,
    disclosures: Array.isArray(detail?.disclosures) ? detail.disclosures : [],
    registrations: Array.isArray(detail?.registrations) ? detail.registrations : [],
    directOwners: Array.isArray(detail?.directOwners)
      ? detail.directOwners.map((o) => ({
          name: o?.fullName || o?.entityName || null,
          ownershipPercentage: o?.ownershipPercentage || null,
          controlPerson: o?.controlPerson === "Y",
          publiclyTraded: o?.publicallyTraded === "Y" || o?.publiclyTraded === "Y",
        }))
      : [],

    reportUrl: `https://files.brokercheck.finra.org/firm/firm_${crd}.pdf`,
  };
}

function normalizeAddress(address) {
  if (!address || typeof address !== "object") return null;
  const parts = [address.street1, address.street2, address.city, address.state, address.postalCode];
  if (!parts.some(Boolean)) return null;
  return {
    street1: address.street1 || null,
    street2: address.street2 || null,
    city: address.city || null,
    state: address.state || null,
    postalCode: address.postalCode || null,
    country: address.country || null,
    formatted: [
      [address.street1, address.street2].filter(Boolean).join(", "),
      address.city,
      [address.state, address.postalCode].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(", "),
  };
}
