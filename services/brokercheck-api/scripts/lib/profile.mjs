// Maps FINRA's detail payload into our profile shape.
//
// Two headline fields the product needs are NOT given by FINRA and must be derived.
// Both derivations are copied from BrokerCheck's own SPA so our numbers match theirs:
//
//   yearsExperience — there is no yearsOfExperience field. FINRA populates EITHER
//     basicInformation.daysInIndustry (an integer, present when the person is INACTIVE)
//     OR basicInformation.daysInIndustryCalculatedDate (M/D/YYYY, present when ACTIVE,
//     meaning "now minus this date"). Never both.
//
//   firmCount — uniqBy(firmId) across all four employment arrays. The search field
//     `ind_employments_count` is a DIFFERENT, smaller number: on CRD 2013441 it reported
//     3 while the true unique-firm count was 7. Do not substitute it.

import { GEO_PRECISION } from "./geo.mjs";

const MS_PER_DAY = 86_400_000;

/** Parse a FINRA date. The two endpoints disagree on format — DETAIL uses M/D/YYYY
 *  (daysInIndustryCalculatedDate) while SEARCH uses ISO YYYY-MM-DD (ind_industry_cal_date)
 *  — so both are accepted. Returns null on anything unparseable rather than an Invalid
 *  Date, so bad upstream data degrades to "unknown" instead of NaN. */
export function parseFinraDate(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  let year;
  let mo;
  let day;

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (slash) [, mo, day, year] = slash;
  else if (iso) [, year, mo, day] = iso;
  else return null;

  const date = new Date(Date.UTC(Number(year), Number(mo) - 1, Number(day)));
  if (!Number.isFinite(date.getTime())) return null;
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(day)) return null; // rejects 2/31
  return date;
}

/** Years in the industry, to one decimal.
 *
 *  FINRA populates exactly one of two signals, and which one depends on whether the
 *  person is still active — so both paths are required, on BOTH endpoints:
 *    days      — an elapsed-day integer, present when the person is INACTIVE
 *    sinceDate — an entry date, present when ACTIVE (meaning "now minus this")
 *
 *  `now` is injectable so tests are deterministic. */
export function yearsInIndustry({ days, sinceDate } = {}, now = new Date()) {
  const asDays = Number(days);
  if (Number.isFinite(asDays) && asDays > 0) return Math.round((asDays / 365) * 10) / 10;

  const start = parseFinraDate(sinceDate);
  if (!start) return null;
  const elapsed = (now.getTime() - start.getTime()) / MS_PER_DAY;
  if (elapsed < 0) return null;
  return Math.round((elapsed / 365) * 10) / 10;
}

/** Years in the industry from a DETAIL payload's basicInformation block.
 *
 *  THREE field spellings exist across FINRA's two endpoints, and a profile carries exactly one:
 *    daysInIndustry                  BrokerCheck, individual is inactive  (integer)
 *    daysInIndustryCalculatedDate    BrokerCheck, individual is active    (M/D/YYYY)
 *    daysInIndustryCalculatedDateIAPD  SEC IAPD, adviser-only individual  (M/D/YYYY)
 *  Missing the third is why adviser-only profiles used to report null experience. */
export function deriveYearsExperience(basicInformation, now = new Date()) {
  return yearsInIndustry(
    {
      days: basicInformation?.daysInIndustry,
      sinceDate:
        basicInformation?.daysInIndustryCalculatedDate || basicInformation?.daysInIndustryCalculatedDateIAPD,
    },
    now,
  );
}

/** Merge an IAPD payload into a BrokerCheck-derived profile.
 *
 *  BrokerCheck is authoritative for broker-side data; IAPD fills the adviser-only gaps it
 *  genuinely does not hold. Only ever ADDS — a value BrokerCheck already provided is never
 *  overwritten, so this cannot regress a broker's record. */
export function mergeIapdProfile(profile, iapd, now = new Date()) {
  if (!iapd) return profile;
  const basic = iapd.basicInformation || {};

  const merged = { ...profile };
  merged.yearsExperience = profile.yearsExperience ?? deriveYearsExperience(basic, now);
  merged.dataSources = [...new Set([...(profile.dataSources || ["brokercheck"]), "sec_iapd"])];

  // IAPD keeps adviser disclosures in their own array as well as the shared one.
  const iapdDisclosures = deriveDisclosures({
    disclosures: [...(iapd.disclosures || []), ...(iapd.iaDisclosures || [])],
  });
  if (!profile.disclosures.length && iapdDisclosures.length) merged.disclosures = iapdDisclosures;
  merged.hasDisclosures = profile.hasDisclosures || iapd.iaDisclosureFlag === "Y" || iapd.disclosureFlag === "Y";

  // Adviser-only people have no BrokerCheck employment rows at all, so firm history, exams,
  // registrations and branch addresses all come from here.
  if (!profile.firmHistory.length) {
    merged.firmHistory = deriveFirmHistory(iapd);
    merged.firmCount = deriveFirmCount(iapd);
  }
  if (!profile.exams.length) merged.exams = deriveExams(iapd);
  if (!profile.branches.length) merged.branches = deriveBranches(iapd);
  if (!profile.registeredStates.length && Array.isArray(iapd.registeredStates)) {
    merged.registeredStates = iapd.registeredStates.map((s) => ({
      state: s?.state || null,
      scope: s?.regScope || null,
      status: s?.status || null,
      date: s?.regDate || null,
    }));
  }
  if (!profile.examCounts.state && !profile.examCounts.principal && !profile.examCounts.product) {
    merged.examCounts = {
      state: Number(iapd?.examsCount?.stateExamCount) || 0,
      principal: Number(iapd?.examsCount?.principalExamCount) || 0,
      product: Number(iapd?.examsCount?.productExamCount) || 0,
    };
  }
  return merged;
}

const EMPLOYMENT_KEYS = ["currentEmployments", "currentIAEmployments", "previousEmployments", "previousIAEmployments"];

function allEmployments(detail) {
  return EMPLOYMENT_KEYS.flatMap((key) => (Array.isArray(detail?.[key]) ? detail[key] : []));
}

/** Distinct employers across every employment array. */
export function deriveFirmCount(detail) {
  const ids = new Set();
  for (const employment of allEmployments(detail)) {
    if (employment?.firmId != null) ids.add(String(employment.firmId));
  }
  return ids.size;
}

/** Employment history, current first, each with its date range. */
export function deriveFirmHistory(detail) {
  const seen = new Map();
  for (const key of EMPLOYMENT_KEYS) {
    const isCurrent = key.startsWith("current");
    for (const employment of Array.isArray(detail?.[key]) ? detail[key] : []) {
      if (employment?.firmId == null) continue;
      const id = String(employment.firmId);
      const existing = seen.get(id);
      // A firm can appear in both the BD and IA arrays; keep the richer/current entry.
      if (existing && !(isCurrent && !existing.current)) continue;
      seen.set(id, {
        firmId: id,
        firmName: employment.firmName || null,
        current: isCurrent,
        city: employment.city || null,
        state: employment.state || null,
        registrationBeginDate: employment.registrationBeginDate || null,
        registrationEndDate: employment.registrationEndDate || null,
        investmentAdvisorOnly: employment.iaOnly === "Y",
      });
    }
  }
  return [...seen.values()].sort((a, b) => Number(b.current) - Number(a.current));
}

/** Every exam, flattened across the three category arrays. */
export function deriveExams(detail) {
  return ["stateExamCategory", "principalExamCategory", "productExamCategory"]
    .flatMap((key) => (Array.isArray(detail?.[key]) ? detail[key] : []))
    .map((exam) => ({
      category: exam?.examCategory || null,
      name: exam?.examName || null,
      takenDate: exam?.examTakenDate || null,
      scope: exam?.examScope || null,
    }))
    .filter((exam) => exam.category || exam.name);
}

/** Disclosures. `disclosureDetail` is an OPEN, type-dependent key/value bag with no fixed
 *  schema (keys seen: Allegations, Resolution, SanctionDetails, "Initiated By",
 *  "Broker Comment", arbitration docket numbers). We pass it through verbatim rather than
 *  forcing it into a shape it does not have. */
export function deriveDisclosures(detail) {
  if (!Array.isArray(detail?.disclosures)) return [];
  return detail.disclosures.map((d) => ({
    eventDate: d?.eventDate || null,
    type: d?.disclosureType || null,
    resolution: d?.disclosureResolution || null,
    detail: d?.disclosureDetail && typeof d.disclosureDetail === "object" ? d.disclosureDetail : null,
  }));
}

/** All branch offices, de-duplicated by FINRA's branchOfficeId.
 *
 *  The coordinates FINRA ships here are ZIP-CENTROID, not rooftop — three different
 *  Kirkland buildings all return 47.673156,-122.197628 — so they are labelled as such
 *  and are only a fallback for when we cannot geocode the street address ourselves. */
export function deriveBranches(detail) {
  const out = new Map();
  for (const employment of allEmployments(detail)) {
    const locations = Array.isArray(employment?.branchOfficeLocations) ? employment.branchOfficeLocations : [];
    for (const loc of locations) {
      const id = loc?.branchOfficeId != null ? String(loc.branchOfficeId) : null;
      const key = id || [loc?.street1, loc?.zipCode].filter(Boolean).join("|");
      if (!key || out.has(key)) continue;
      const lat = Number(loc?.latitude);
      const lng = Number(loc?.longitude);
      out.set(key, {
        branchOfficeId: id,
        firmId: employment.firmId != null ? String(employment.firmId) : null,
        firmName: employment.firmName || null,
        street1: loc?.street1 || null,
        street2: loc?.street2 || null,
        city: loc?.city || null,
        state: loc?.state || null,
        zip: loc?.zipCode || null,
        isPrivateResidence: loc?.privateResidenceFlag === "Y",
        // FINRA's own coordinate — usable, but never call it rooftop.
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        geoPrecision: Number.isFinite(lat) && Number.isFinite(lng) ? GEO_PRECISION.ZIP_CENTROID : GEO_PRECISION.UNKNOWN,
      });
    }
  }
  return [...out.values()];
}

/** Full profile from a parsed FINRA detail payload. */
export function buildProfile(crd, detail, now = new Date()) {
  const basic = detail?.basicInformation || {};
  return {
    crd: String(crd),
    firstName: basic.firstName || null,
    middleName: basic.middleName || null,
    lastName: basic.lastName || null,
    nameSuffix: basic.nameSuffix || null,
    name: [basic.firstName, basic.middleName, basic.lastName, basic.nameSuffix].filter(Boolean).join(" ") || null,
    otherNames: Array.isArray(basic.otherNames) ? basic.otherNames : [],

    brokerScope: basic.bcScope || null,
    advisorScope: basic.iaScope || null,
    isBroker: String(basic.bcScope || "").toLowerCase() === "active",
    isInvestmentAdvisor: String(basic.iaScope || "").toLowerCase() === "active",

    yearsExperience: deriveYearsExperience(basic, now),
    firmCount: deriveFirmCount(detail),
    firmHistory: deriveFirmHistory(detail),

    exams: deriveExams(detail),
    examCounts: {
      state: Number(detail?.examsCount?.stateExamCount) || 0,
      principal: Number(detail?.examsCount?.principalExamCount) || 0,
      product: Number(detail?.examsCount?.productExamCount) || 0,
    },

    registrationCounts: {
      sro: Number(detail?.registrationCount?.approvedSRORegistrationCount) || 0,
      finra: Number(detail?.registrationCount?.approvedFinraRegistrationCount) || 0,
      state: Number(detail?.registrationCount?.approvedStateRegistrationCount) || 0,
      advisorState: Number(detail?.registrationCount?.approvedIAStateRegistrationCount) || 0,
    },
    registeredStates: Array.isArray(detail?.registeredStates)
      ? detail.registeredStates.map((s) => ({
          state: s?.state || null,
          scope: s?.regScope || null,
          status: s?.status || null,
          date: s?.regDate || null,
        }))
      : [],
    registeredSROs: Array.isArray(detail?.registeredSROs)
      ? detail.registeredSROs.map((s) => ({
          sro: s?.sro || null,
          status: s?.status || null,
          categories: Array.isArray(s?.CategoriesList) ? s.CategoriesList : [],
        }))
      : [],

    hasDisclosures: detail?.disclosureFlag === "Y" || detail?.iaDisclosureFlag === "Y",
    disclosures: deriveDisclosures(detail),
    // Present only for barred/limited individuals; absent on a clean record.
    sanctions: basic.sanctions || null,
    isBarred: basic?.sanctions?.permanentBar === "Y",

    branches: deriveBranches(detail),
    // Which registries contributed. Adviser-only individuals get "sec_iapd" added, because
    // BrokerCheck does not hold their experience or disclosures at all.
    dataSources: ["brokercheck"],
    reportUrl: `https://files.brokercheck.finra.org/individual/individual_${crd}.pdf`,
  };
}
