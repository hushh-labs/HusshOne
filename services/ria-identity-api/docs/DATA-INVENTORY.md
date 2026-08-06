# Claimed-Profile Data Inventory

Everything the public regulatory record publishes about an adviser or a firm, where each field comes
from, and whether we need to parse a PDF to get it.

Measured live on **2026-08-06** against real CRDs. Every value in this document was copied out of a
response captured that day. Nothing here is recalled, inferred, or asked of a model. Raw captures:
`/Users/ankitkumarsingh/Desktop/HusshOne/docs/samples/`.

---

## THE PDF VERDICT (read this first)

**For a FIRM: no. PDF parsing / OCR is NOT necessary — and would be a mistake.**
Every fact in the 21-page Form ADV Part 1 PDF is published as structured XML in the SEC's daily
compilation feed. We found it, downloaded it (7.2 MB gzipped, 82 MB XML, one file, all
SEC-registered advisers), and extracted Robinswood's complete record. AUM, client counts by
category, employee counts, custody answers, all of Item 11's disciplinary yes/no answers — all
there as attributes. See "Source F" below.

**For an INDIVIDUAL: yes, but only for five things.** The JSON is far better than the product
owner fears. We diffed the FINRA BrokerCheck PDF against the JSON row by row for CRD 1096328 (the
31-state broker whose PDF the owner has open):

| Check | Result |
|---|---|
| Per-state registration table: state + category + status + **approved date** | **33 rows in the PDF, 33 rows in the JSON, zero difference.** PDF-only rows: none. JSON-only rows: none. |
| Branch office locations | PDF lists 2. JSON lists the same 2 **plus** branch ID, lat/long, ZIP+4, private-residence flag, and the date the adviser started at each branch. **JSON wins.** |
| Exams (category, name, date) | Identical. 2 product + 2 state exams, same dates. |
| Previous registrations (firm, CRD, city/state, date range) | Identical, 3 rows both sides. |
| SRO registrations | 22 in both — but the JSON carries **no approval date** per SRO. **PDF-only.** |

So the "every state and the date it was approved" requirement — the thing that motivated the
question — is **already in the JSON, exactly**. Verification script output:

```
PDF state rows : 33
JSON state rows: 33
PDF-only : []
JSON-only: []
```

### The five things only the individual PDF has

1. **Employment History with job title.** The PDF's "Employment History" section is U4-reported
   employment for the last ~10 years including *non-securities* jobs and the person's **position**.
   No JSON endpoint carries a job title anywhere.
   Real example, Robert MacRae (CRD 6844196), from `iapd-report-6844196.txt`:
   `07/2017 - Present | Robinswood Financial LLC | Investment Advisor Representative | Y | Kirkland, WA`
   `04/2013 - 06/2017 | VMware, Inc. | Manager Technical Account Management Services | N | Palo Alto, CA`
   The VMware row exists in **no** API response. Neither does the title "Investment Advisor
   Representative". For a claimed profile, the title is probably the single most valuable
   PDF-only field.
2. **Other Business Activities (OBA).** Free-text U4 disclosure of outside businesses.
   MacRae: `Fortitude LLC (s-corp), 16704 NE 98th Place, Redmond, WA 98052, A personal, solely
   owned, holding company … for work as an independent contractor …`
   Tammy Staub: `NAME OF ENTITY: ARBONNE INTERNATIONAL; … CAPACITY: INDEPENDENT
   CONTRACTOR/CONSULTANT; START DATE: 10/2019; HOURS DEVOTED PER MONTH: 3-4;`
   Absent from every JSON endpoint. This is also the field most likely to *hurt* a claimed profile,
   so treat it as opt-in.
3. **Professional Designations.** The PDF has a dedicated section (CFP, CFA … as declared in U4
   Question 8 and verified by the issuer). All four test subjects reported 0, so we have no
   populated example — but the section exists in the PDF and has no JSON counterpart.
4. **Per-SRO approval date.** JSON `registeredSROs[]` = `{sro, status, CategoriesList}`. The PDF
   adds the date: `BOX Exchange LLC | General Securities Representative | Approved | 06/05/2019`.
   Only matters for brokers, not pure RIAs (pure RIAs have 0 SROs).
5. **Full disclosure-event detail.** This is the big one. The JSON gives a *summary* of each
   disclosure; the PDF gives the filed record, and it gives it **once per reporting source**.
   Quantified on CRD 1018196, one Customer Dispute:

   | Field | JSON | PDF |
   |---|---|---|
   | Reporting Source (Firm vs Broker vs Regulator) | absent — collapsed into one record | present, **two separate versions** of the same event with different allegations, product type, and disposition |
   | Employing firm when activity occurred | absent | `SHEARSON LEHMAN BROTHERS` |
   | Product Type | absent | `Equity - OTC` |
   | Date Complaint Received | absent | `05/16/1988` |
   | Complaint Pending? | absent | `No` |
   | Status Date | absent | `07/07/1989` |
   | Arbitration forum + docket no. | empty strings in JSON | `National Association of Securities Dealers, Inc.` |
   | Date Notice/Process Served | absent | `05/16/1988` |
   | Disposition / Disposition Date | absent | `Award to Customer` / `07/07/1989` |
   | Individual Contribution Amount | absent | `$0.00` |
   | Firm Statement | absent | `SETTLED FOR $132,982.50. SHEARSON PAID…` |
   | Allegations, Damage Amount, Damages Granted, Broker Comment | present | present |

   Same story for Regulatory events (CRD 810315): PDF adds `Sanction(s) Sought`,
   `Docket/Case Number` (`99-463` — the JSON's `DocketNumberFDA`/`DocketNumberAAO` are empty
   strings), `Date Initiated`, `Resolution Date` (`08/21/2001`), `Current Status`, `Product Type`,
   and `Regulator Statement` (present in JSON for only 4 of 29 sampled regulatory disclosures).

**Recommendation.** Ship v1 entirely off JSON + the ADV feed. It gives you the registration
history, the exams, every state with its approval date, employment history at firm granularity,
branch offices, and disclosure summaries. Add individual-PDF extraction as a **second, per-profile,
on-demand pass** for job title, OBA, designations, and full disclosure detail. Note that it is text
extraction, **not OCR** — these PDFs have a real text layer, `pypdf` reads them cleanly, no image
processing required. (`pypdf 6.11.0` is already present in the system Python 3 on this machine;
`pdftotext`, `mutool`, and `qpdf` are not installed.)

---

## Sources

Every source is public and unauthenticated. Always send
`User-Agent: hushh-ria-identity-api/0.1 (+https://hushh.ai; contact ankit@hushh.ai)`.

| ID | What | URL | Notes |
|---|---|---|---|
| **A** | IAPD firm roster | `https://api.adviserinfo.sec.gov/search/individual?firm=<firmCRD>&nrows=100&wt=json` | `firm=` also matches **previous** employers. Filter on `ind_ia_current_employments[].firm_id`. |
| **B** | IAPD individual | `https://api.adviserinfo.sec.gov/search/individual/<CRD>?wt=json` | Payload at `hits.hits[0]._source.iacontent`, a **JSON string** — parse twice. |
| **C** | FINRA BrokerCheck individual | `https://api.brokercheck.finra.org/search/individual/<CRD>?wt=json` | Payload at `hits.hits[0]._source.content`, also double-encoded. |
| **D** | IAPD firm | `https://api.adviserinfo.sec.gov/search/firm/<CRD>?wt=json` | `_source.iacontent`, double-encoded. For a dual BD/IA firm this returns **both** the BD and IA blocks — it is a superset of source E. |
| **E** | BrokerCheck firm | `https://api.brokercheck.finra.org/search/firm/<CRD>?wt=json` | `_source.content`. For an IA-only firm it returns the same IA-only content as D (723 bytes for CRD 143417). |
| **F** | **SEC Form ADV compilation feed** | `https://reports.adviserinfo.sec.gov/reports/CompilationReports/IA_FIRM_SEC_Feed_MM_DD_YYYY.xml.gz` | **The find of this exercise.** Complete Form ADV Part 1A for every SEC-registered adviser as XML attributes. 7.2 MB gz → 82 MB XML, regenerated daily (verified `Last-Modified: Thu, 06 Aug 2026 09:29:09 GMT`). State-registered advisers: `IA_FIRM_STATE_Feed_MM_DD_YYYY.xml.gz`. The date is discoverable from source D at `iacontent.compilationData[]` (`{editionID, type, generatedOn}`). No individual-level feed exists under any name we probed. |
| **G** | IAPD individual report PDF | `https://reports.adviserinfo.sec.gov/reports/individual/individual_<CRD>.pdf` | **Use this one.** Works for pure-RIA people. |
| **H** | BrokerCheck individual report PDF | `https://files.brokercheck.finra.org/individual/individual_<CRD>.pdf` | **403s for anyone with no broker record** — confirmed on CRD 6844196. Richer than G for brokers (more SRO/state rows), useless for IA-only. |
| **I** | Firm Form ADV Part 1 PDF | `https://reports.adviserinfo.sec.gov/reports/ADV/<firmCRD>/PDF/<firmCRD>.pdf` | Superseded by F. Keep only as a human-facing download link. |
| **J** | Firm brochure (ADV Part 2) PDF | `https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=<id>` | `<id>` = `brochures.brochuredetails[].brochureVersionID` from D. Narrative only — fee schedules, strategies, conflicts. Never structured. |
| **K** | Form CRS PDF | `https://reports.adviserinfo.sec.gov/crs/crs_<firmCRD>.pdf` | Client relationship summary. Existence is signalled by `basicInformation.crs` in D. |

**Both B and C are required — neither is a superset of the other.** Measured:

| CRD | Person | IAPD (B) | BrokerCheck (C) |
|---|---|---|---|
| 2486426 Robert Guild | pure RIA, ex-broker | `currentIAEmployments`: 1 (with branch office) — `previousEmployments`: **0** | `currentIAEmployments`: **0** — `previousEmployments`: **3** (Allstate, etc.) |
| 6844196 Robert MacRae | pure RIA | `currentIAEmployments`: 1 (with branch office) | `currentIAEmployments`: **0** |
| 1096328 Tammy Staub | dual | `currentIAEmployments`: **2** branches | `currentIAEmployments`: 1 branch |

IAPD drops a pure-RIA's broker employment history; BrokerCheck drops a pure-RIA's current IA
employment. IAPD also uniquely carries `iaDisclosures[]`,
`registrationCount.hasInactiveRegistration`, and `registrationCount.hasSuspendedRegistration`.
**Call both, union the results.**

---

## Field inventory — INDIVIDUAL

Scope is per-person unless stated. "Path" is relative to `iacontent` (B) / `content` (C) after the
double parse. Examples are verbatim from the captures.

### Identity

| Field | Source | Type | Example |
|---|---|---|---|
| `basicInformation.individualId` | B, C | int | `1096328` |
| `basicInformation.firstName` | B, C, A(`ind_firstname`) | string | `TAMMY` |
| `basicInformation.middleName` | B, C, A(`ind_middlename`) | string | `DEANNE` |
| `basicInformation.lastName` | B, C, A(`ind_lastname`) | string | `STAUB` |
| `ind_namesuffix` | A only | string | `MRS.` (note: IAPD stores honorifics in the suffix field, sometimes wrongly — CRD 4661439 JANET WEISMAN is `MRS.`) |
| `basicInformation.otherNames[]` | B, C, A(`ind_other_names`) | string[] | `["TAMMY D GREGORY"]`, `["BOB  GUILD"]` |
| `basicInformation.iaScope` | B, C, A(`ind_ia_scope`) | enum | `Active`, `InActive` |
| `basicInformation.bcScope` | B, C, A(`ind_bc_scope`) | enum | `Active`, `NotInScope`, `InActive` |
| `basicInformation.daysInIndustryCalculatedDateIAPD` | B | date string | `2/23/1983` — industry start date |
| `basicInformation.daysInIndustryCalculatedDate` | C | date string | `2/23/1983` (same value, different key name) |
| `ind_industry_cal_date_iapd` | A | ISO date | `2007-06-17` (A uses ISO; B/C use M/D/YYYY) |
| `ind_employments_count` | A | int | `1` |
| `brokerDetails.hasBCComments` / `hasIAComments` | B, C | `Y`/`N` | `N` |
| `brokerDetails.legacyReportStatusDescription` | B, C | string | `Not Requested` |

### Registration counts

| Field | Source | Type | Example |
|---|---|---|---|
| `registrationCount.approvedStateRegistrationCount` | B, C, | int | `31` (BD-side states) |
| `registrationCount.approvedIAStateRegistrationCount` | B, C (missing on C for some pure RIAs) | int | `2` |
| `registrationCount.approvedSRORegistrationCount` | B, C | int | `22` |
| `registrationCount.approvedFinraRegistrationCount` | B, C, A | int | `1` |
| `registrationCount.hasInactiveRegistration` | **B only** | `Y`/`N` | `N` |
| `registrationCount.hasSuspendedRegistration` | **B only** | `Y`/`N` | `N` |

### State / jurisdiction registrations — `registeredStates[]`

Confirmed byte-for-byte identical to the PDF's per-state table.

| Field | Source | Type | Example |
|---|---|---|---|
| `state` | B, C | string | `Alaska`, `Washington` |
| `regScope` | B, C | enum `BC` \| `IA` | `BC` → PDF category "Agent"; `IA` → PDF category "Investment Adviser Representative" |
| `status` | B, C | enum | `APPROVED` |
| `regDate` | B, C | date string | `4/23/2020` (= PDF `04/23/2020`) — **this is the approved date** |

### SRO registrations — `registeredSROs[]`

| Field | Source | Type | Example |
|---|---|---|---|
| `sro` | B, C | string | `BOX Exchange LLC`, `FINRA`, `New York Stock Exchange` |
| `status` | B, C | enum | `APPROVED` |
| `CategoriesList[]` | B, C | string[] | `["Full Registration/General Securities Representative"]` |
| *approval date* | **G/H PDF only** | date | `06/05/2019` — **the only registration date the JSON omits** |

### Exams

Three parallel arrays, same shape: `principalExamCategory[]`, `productExamCategory[]`,
`stateExamCategory[]`. Counts mirrored in `examsCount.{principalExamCount, productExamCount,
stateExamCount}`.

| Field | Source | Type | Example |
|---|---|---|---|
| `examCategory` | B, C | string | `Series 7`, `Series 65`, `Series 63`, `SIE` |
| `examName` | B, C | string | `Uniform Investment Adviser Law Examination` |
| `examTakenDate` | B, C | date string | `4/25/2017` |
| `examScope` | B, C | enum `BC` \| `IA` | `IA` |

### Current employment — `currentEmployments[]` (BD side) and `currentIAEmployments[]` (IA side)

| Field | Source | Type | Example |
|---|---|---|---|
| `firmId` | B, C, A(`firm_id`) | int/string | `31194`, `143417` |
| `firmName` | B, C, A(`firm_name`) | string | `RBC CAPITAL MARKETS, LLC` |
| `registrationBeginDate` | B, C | date string | `6/5/2019` |
| `iaOnly` | B, C, A(`ia_only`) | `Y`/`N` | `Y` |
| `iaSECNumber` / `iaSECNumberType` | B, C, A | string | `13059` / `801` |
| `firm_ia_full_sec_number` | A | string | `801-68234` (pre-joined; B/C make you concatenate) |
| `bdSECNumber` | B, C | string | `45411` |
| `firmBCScope` / `firmIAScope` | B, C | enum | `ACTIVE`, `NOTINSCOPE` |
| *employer main office address* | **PDF (G/H) or source D/E** | object | `200 VESEY ST., NEW YORK, NY 10281` — not on the individual JSON record |

### Branch offices — `currentEmployments[].branchOfficeLocations[]`

Richer in JSON than in the PDF.

| Field | Source | Type | Example |
|---|---|---|---|
| `branchOfficeId` | B, C | string | `74134` |
| `street1`, `street2` | B, C | string | `3760 CARILLON POINT`, `BUILDING 3000, 4TH FLOOR` |
| `city` | B, C, A(`branch_city`) | string | `KIRKLAND` |
| `cityAlias[]` | B, C | string[] | `["HOUGHTON","JUANITA","KIRKLAND","REDMOND","TOTEM LAKE"]` |
| `state` | B, C, A(`branch_state`) | string | `WA` |
| `zipCode` | B, C, A(`branch_zip`) | string | `98033-7455` (B/C give ZIP+4; A gives 5-digit) |
| `country` | B, C | string | `United States` |
| `latitude`, `longitude`, `geoLocation` | B, C | string | `47.673156`, `-122.197628`, `47.673156,-122.197628` — **PDF-free geocoding** |
| `elaBeginDate` | B, C | date string | `06/05/2019` — when this person started at this branch |
| `locatedAtFlag` | B, C | `Y`/`N` | `Y` |
| `supervisedFromFlag` | B, C | `Y`/`N` | `N` |
| `privateResidenceFlag` | B, C | `Y`/`N` | `Y` (Staub's second Redmond location) |
| `nonRegisteredOfficeFlag` | B, C | `Y`/`N` | `N` |
| `displayOrder` | B, C | int | `1` |

### Previous registrations — `previousEmployments[]` / `previousIAEmployments[]`

| Field | Source | Type | Example |
|---|---|---|---|
| `firmId`, `firmName` | B, C | int/string | `665`, `PIPER JAFFRAY INC.` |
| `city`, `state`, `country` | B, C | string | `MINNEAPOLIS`, `MN`, `UNITED STATES` |
| `registrationBeginDate` | B, C | date string | `2/24/1983` |
| `registrationEndDate` | B, C | date string | `10/13/1998` |
| `iaOnly`, `iaSECNumber`, `iaSECNumberType`, `bdSECNumber`, `firmBCScope`, `firmIAScope` | B, C | as above | — |

### Disclosures — `disclosures[]` (B, C) and `iaDisclosures[]` (B only)

Envelope (same on every disclosure, verified over 108 disclosures across 59 individuals):

| Field | Source | Type | Example |
|---|---|---|---|
| `disclosureFlag` / `iaDisclosureFlag` | B, C, A(`ind_ia_disclosure_fl`) | `Y`/`N` | `Y` |
| `eventDate` | B, C | date string | `5/24/2021` |
| `disclosureType` | B, C | enum | `Regulatory`, `Customer Dispute`, `Criminal`, `Financial`, `Judgment / Lien`, `Employment Separation After Allegations`, `Investigation` |
| `disclosureResolution` | B, C | enum | `Final`, `Award / Judgment`, `Settled`, `Pending` |
| `bcCtgryType` / `iaCtgryType` | B, C | int | `10`, `20` |
| `isBcExcludedCCFlag` / `isIapdExcludedCCFlag` | B, C | `Y`/`N` | `N` |

`disclosureDetail` is a type-dependent bag. Complete observed key set (frequency out of the sampled
disclosures of that type):

| Type | Keys present in JSON |
|---|---|
| Regulatory | `Initiated By` (29), `SanctionDetails[].Sanctions` (29), `DocketNumberFDA` (29, always empty in sample), `DocketNumberAAO` (29, always empty), `Resolution` (28), `Allegations` (26), `Broker Comment[]` (12), `Sanction Details` (10), `Sanctions` (8), `Regulator Statement` (4) |
| Customer Dispute | `Allegations` (57), `DisplayAAOLinkIfExists` (57), `arbitrationClaimFiledDetail` (57), `arbitrationDocketNumber` (57), `Damage Amount Requested` (34), `Broker Comment[]` (34), `Settlement Amount` (20), `Damages Granted` (7) |
| Criminal | `criminalCharges` (11), `Broker Comment[]` (9) |
| Employment Separation After Allegations | `Firm Name`, `Termination Type`, `Allegations`, `Broker Comment[]` |
| Financial | `Type` (e.g. `Compromise`), `Disposition` (e.g. `Discharged`), `Broker Comment[]` |
| Judgment / Lien | `Judgment/Lien Amount`, `Judgment/Lien Type`, `Broker Comment[]` |
| Investigation | `Initiated By`, `Description of Investigation`, `Broker Comment[]` |

### PDF-only individual fields (sources G and H)

| Field | Type | Example |
|---|---|---|
| `employmentHistory[].dateRange` | string | `04/2013 - 06/2017` |
| `employmentHistory[].employerName` | string | `VMware, Inc.` |
| `employmentHistory[].position` | string | `Manager Technical Account Management Services`, `Senior Investment Associate` |
| `employmentHistory[].investmentRelated` | `Y`/`N` | `N` |
| `employmentHistory[].location` | string | `Palo Alto, CA, United States` |
| `otherBusinessActivities` | free text | `Fortitude LLC (s-corp), 16704 NE 98th Place, Redmond, WA 98052, …` |
| `professionalDesignations[]` | string[] | section present; all four subjects reported 0 |
| `registeredSROs[].approvedDate` | date | `06/05/2019` |
| `reportLastUpdated` | date | `07/09/2024` (IAPD report only: "last updated by the representative … on") |
| `employerMainOfficeAddress` | object | `200 VESEY ST., NEW YORK, NY 10281` |
| `disclosures[].reportingSource` | enum | `Regulator` \| `Firm` \| `Broker` — and each source gets its own full record |
| `disclosures[].{docketCaseNumber, sanctionsSought, dateInitiated, resolutionDate, currentStatus, productType, employingFirmWhenActivityOccurred, dateComplaintReceived, complaintPending, statusDate, arbitrationForum, dateNoticeServed, arbitrationPending, disposition, dispositionDate, monetaryCompensationAmount, individualContributionAmount, firmStatement, regulatorStatement}` | mixed | see the verdict table above |

---

## Field inventory — FIRM

### From the IAPD/BrokerCheck firm APIs (D, E)

| Field | Source | Type | Example (143417 unless noted) |
|---|---|---|---|
| `basicInformation.firmId` | D, E | int | `143417` |
| `basicInformation.firmName` | D, E | string | `ROBINSWOOD FINANCIAL` |
| `basicInformation.otherNames[]` | D, E | string[] | `["ROBINSWOOD FINANCIAL","ROBINSWOOD FINANCIAL LLC"]` |
| `basicInformation.iaSECNumber` / `iaSECNumberType` | D, E | string | `68234` / `801` → **801-68234** |
| `basicInformation.iaScope` | D, E | enum | `ACTIVE` |
| `basicInformation.isIAFirm` | D, E | `Y`/`N` | `Y` |
| `basicInformation.advFilingDate` | D | date | `07/28/2026` |
| `basicInformation.hasPdf` | D | `Y`/`N` | `Y` |
| `basicInformation.legacyReportStatus` | D, E | string | `Not Requested` |
| `basicInformation.crs.{crsType, fileId}` | D, E | object | `IA` / `dccdb114-5980-4724-9879-7a11380c1cfe` — signals source K exists |
| `iaFirmAddressDetails.officeAddress.{street1,street2,city,state,country,postalCode}` | D, E | object | `3425 CARILLON POINT / BUILDING 3000, 4TH FLOOR / KIRKLAND / WA / United States / 98033` |
| `orgScopeStatusFlags.{isSECRegistered,isStateRegistered,isERARegistered,isSECERARegistered,isStateERARegistered}` | D, E | `Y`/`N` | `Y,N,N,N,N` |
| `registrationStatus[].{secJurisdiction, status, effectiveDate}` | D, E | array | `SEC / Approved / 8/20/2007`; `Washington / Terminated / 8/24/2007` |
| `noticeFilings[].{jurisdiction, status, effectiveDate}` | D, E | array | `Arizona / Notice Filed / 3/26/2018` (6 states) |
| `brochures.part2ExemptFlag` | D | `Y`/`N` | `N` |
| `brochures.brochuredetails[].{brochureVersionID, brochureName, dateSubmitted, lastConfirmed}` | D | array | `1053041 / ROBINSWOOD BROCHURE ADV 2B JULY 2026 / 7/28/2026` |
| `accountantSurpriseExams[].{accountantFirmName, filingDate, fileStatus, encryptedFilingID}` | D | array | empty for 143417; `PRICEWATERHOUSECOOPERS LLP / 10/28/2025` for CRD 31194 |
| `exemptReportingAdvisers[]` | D | array | `[]` |
| `compilationData[].{editionID, type, generatedOn}` | D | array | `52821 / IA_FIRM_SEC / 7/29/2026` — **use this to build the source-F URL** |

### BD-side firm fields (D for a dual registrant, or E) — CRD 31194 examples

| Field | Type | Example |
|---|---|---|
| `basicInformation.bdSECNumber` | string | `45411` |
| `basicInformation.bcScope` | enum | `ACTIVE` |
| `basicInformation.firmStatus` / `firmStatusDate` | string/date | `Approved` / `12/30/1992` |
| `basicInformation.firmType` | string | `Limited Liability Company` |
| `basicInformation.firmSize` | enum | `Large` |
| `basicInformation.formedDate` / `formedState` | date/string | `11/01/2010` / `Minnesota` |
| `basicInformation.fiscalMonthEndCode` | string | `October` |
| `basicInformation.districtName` | string | `New York` |
| `basicInformation.regulator` | string | `SEC` |
| `basicInformation.finraRegistered` / `finraLastApprovalDate` | `Y`/`N` / date | `Y` / `03/19/1993` |
| `basicInformation.isLegacy` | `Y`/`N` | `N` |
| `firmAddressDetails.businessPhoneNumber` | string | `(612) 371-2811` |
| `firmAddressDetails.officeAddress.*`, `.mailingAddress.*` | object | `200 VESEY ST., NEW YORK, NY 10281` / `250 NICOLLET MALL SUITE 1600, MINNEAPOLIS, MN 55401` |
| `directOwners[].{legalName, position, crdNumber, bcScope}` | array | `RBC USA HOLDCO CORPORATION / DIRECT OWNER` |
| `disclosures[].{disclosureType, disclosureCount}` | array | `Regulatory Event / 377` |
| `bdDisclosureFlag` / `iaDisclosureFlag` | `Y`/`N` | `Y` / `Y` |
| `affiliateDisclosures.nonRegisteredAffiliateDisclosureCount` | int | `13` |
| `registrations.{approvedSECRegistrationCount, approvedFinraRegistrationCount, approvedSRORegistrationCount, approvedStateRegistrationCount, businessTypeCount, hasAffliation, referOtherBd}` | object | `1, 1, 24, 53, 21, Y, N` (note the SEC's own typo `hasAffliation`) |
| `registrations.stateList[].state` | string[] | `Alabama`, … |

### From the SEC Form ADV compilation feed (F) — the whole of Form ADV Part 1A

Verbatim from `docs/samples/adv-feed-143417.xml`. This replaces the 21-page PDF entirely.

| XML path | Meaning | Example |
|---|---|---|
| `Info/@SECRgnCD` | SEC regional office | `SFRO` |
| `Info/@FirmCrdNb`, `@SECNb` | CRD, SEC file number | `143417`, `801-68234` |
| `Info/@BusNm`, `@LegalNm` | business name, legal name | `ROBINSWOOD FINANCIAL`, `ROBINSWOOD FINANCIAL LLC` |
| `Info/@UmbrRgstn` | umbrella registration | `N` |
| `MainAddr/@Strt1,@Strt2,@City,@State,@Cntry,@PostlCd` | principal office | `3425 CARILLON POINT / BUILDING 3000, 4TH FLOOR / KIRKLAND / WA / 98033` |
| `MainAddr/@PhNb`, `@FaxNb` | **phone, fax** | `452-296-1611`, `425-296-1612` — the real number is 425-296-1611; the filing has a transposition typo. Normalise/fuzz when matching. |
| `MailingAddr/@*` | mailing address | empty here |
| `Rgstn/@FirmType,@St,@Dt` | registration | `Registered / APPROVED / 2007-08-20` |
| `NoticeFiled/States/@RgltrCd,@St,@Dt` | notice filings | `AZ / FILED / 2018-03-26` (6 rows) |
| `Filing/@Dt`, `@FormVrsn` | last ADV filing | `2026-07-28`, `10/2021` |
| `Part1A/Item1/WebAddrs/WebAddr` | **firm website** | `HTTP://WWW.ROBINSWOOD.COM` |
| `Item1/@Q1I,@Q1M,@Q1N,@Q1O,@Q1F5` | Item 1 flags (website/social, etc.) | `Y,N,N,N,0` |
| `Item2A/@Q2A1…Q2A13` | basis for SEC registration | `Q2A1="Y"` (AUM ≥ $100M) |
| `Item3A/@OrgFormNm` | legal form | `Limited Liability Company` |
| `Item3B/@Q3B` | fiscal year end | `DECEMBER` |
| `Item3C/@StateCD,@CntryNm` | state of organization | `WA`, `United States` |
| `Item5A/@TtlEmp` | **total employees** | `6` |
| `Item5B/@Q5B1…Q5B6` | employees by function: advisory, BD reg reps, IARs, IARs for others, insurance agents, solicitors | `6,0,0,0,0,0` |
| `Item5C/@Q5C1,@Q5C2` | client counts (advisory clients / non-US) | `0,0` |
| `Item5D/@Q5D{A..N}{1,2,3}` | **clients and AUM by client type** — `1`=count, `2`="fewer than 5", `3`=RAUM | `Q5DA1="360" Q5DA3="113743483"` (individuals), `Q5DB1="128" Q5DB3="324271708"` (high net worth), `Q5DH3="7397579"` (charities), `Q5DM3="7745743"` (corporations) |
| `Item5E/@Q5E1…Q5E7` | **compensation arrangements** | `Q5E1=Y` % of AUM, `Q5E2=Y` hourly, `Q5E4=Y` fixed fees |
| `Item5F/@Q5F1` | provides continuous supervisory services | `Y` |
| `Item5F/@Q5F2A,@Q5F2D` | **discretionary RAUM / accounts** | `453158469` / `1403` |
| `Item5F/@Q5F2B,@Q5F2E` | non-discretionary RAUM / accounts | `44` / `1` |
| `Item5F/@Q5F2C,@Q5F2F,@Q5F3` | **total RAUM / total accounts** | `453158513` / `1404` / `453158513` |
| `Item5G/@Q5G1…Q5G12` | advisory services offered (financial planning, portfolio mgmt for individuals, pension consulting, …) | `Q5G1=Y,Q5G2=Y,Q5G6=Y` |
| `Item5H/@Q5H` | financial-planning client bucket | `1-10` |
| `Item5I,5J,5K,5L` | wrap fee, research, separately managed accounts, marketing/social | `Q5K1=Y`, `Q5K4=Y` |
| `Item6A,6B` | other business activities of the firm | — |
| `Item7A,7B` | financial industry affiliations, private funds | `Q7B="N"` |
| `Item8A…8I` | participation in client transactions, soft dollars, brokerage | `Q8C1=Y,Q8C2=Y,Q8E=Y` |
| `Item9A…9F` | **custody** — whether firm has custody of cash/securities and how much | `Q9A1A="N"` |
| `Item10A` | control persons | `N` |
| `Item11 / Item11A…Item11H` | **the full disciplinary questionnaire** — criminal, regulatory, civil, SRO, self-regulatory, foreign | `Q11="N"` and every sub-answer `N` |
| Schedule D sections (also in the feed for firms that file them) | branch offices, other names, control persons, private funds | — |

### Firm PDFs (I, J, K) — what is left

| Source | What it adds | Structured alternative |
|---|---|---|
| I — ADV Part 1 PDF | nothing | **F** |
| J — brochure / ADV Part 2A+2B | narrative: fee schedules in prose, investment strategies, conflicts, adviser bios | none — genuinely PDF-only, but it is prose, not fields |
| K — Form CRS | 2-page client relationship summary | none |

---

## The two schemas

Every property is annotated with `x-source` naming the source ID from the table above. Nothing
appears here that is not published by one of those sources.

### `IndividualProfile`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://hushh.ai/schemas/ria/IndividualProfile.json",
  "title": "IndividualProfile",
  "description": "Maximal public regulatory record for one adviser/broker. Built from the union of IAPD (B) and FINRA BrokerCheck (C); the pdf-derived block is optional and populated by a second pass over source G (preferred) or H.",
  "type": "object",
  "required": ["crd", "name", "scope", "source"],
  "properties": {
    "crd": { "type": "integer", "x-source": "B/C basicInformation.individualId; A ind_source_id", "examples": [1096328] },
    "name": {
      "type": "object",
      "properties": {
        "first":  { "type": "string", "x-source": "B/C basicInformation.firstName", "examples": ["TAMMY"] },
        "middle": { "type": "string", "x-source": "B/C basicInformation.middleName", "examples": ["DEANNE"] },
        "last":   { "type": "string", "x-source": "B/C basicInformation.lastName", "examples": ["STAUB"] },
        "suffix": { "type": "string", "x-source": "A ind_namesuffix (roster only)", "examples": ["MRS."] },
        "otherNames": { "type": "array", "items": { "type": "string" }, "x-source": "B/C basicInformation.otherNames", "examples": [["TAMMY D GREGORY"]] }
      }
    },
    "scope": {
      "type": "object",
      "properties": {
        "ia": { "enum": ["Active", "InActive", "NotInScope"], "x-source": "B/C basicInformation.iaScope" },
        "bc": { "enum": ["Active", "InActive", "NotInScope"], "x-source": "B/C basicInformation.bcScope" }
      }
    },
    "industryStartDate": { "type": "string", "x-source": "B basicInformation.daysInIndustryCalculatedDateIAPD | C ...daysInIndustryCalculatedDate | A ind_industry_cal_date_iapd", "examples": ["2/23/1983"] },
    "comments": {
      "type": "object",
      "properties": {
        "hasBCComments": { "enum": ["Y", "N"], "x-source": "B/C brokerDetails.hasBCComments" },
        "hasIAComments": { "enum": ["Y", "N"], "x-source": "B/C brokerDetails.hasIAComments" },
        "legacyReportStatus": { "type": "string", "x-source": "B/C brokerDetails.legacyReportStatusDescription" }
      }
    },
    "registrationCounts": {
      "type": "object",
      "properties": {
        "stateBD":  { "type": "integer", "x-source": "B/C registrationCount.approvedStateRegistrationCount", "examples": [31] },
        "stateIA":  { "type": "integer", "x-source": "B registrationCount.approvedIAStateRegistrationCount", "examples": [2] },
        "sro":      { "type": "integer", "x-source": "B/C registrationCount.approvedSRORegistrationCount", "examples": [22] },
        "finra":    { "type": "integer", "x-source": "B/C registrationCount.approvedFinraRegistrationCount", "examples": [1] },
        "hasInactiveRegistration":  { "enum": ["Y", "N"], "x-source": "B only" },
        "hasSuspendedRegistration": { "enum": ["Y", "N"], "x-source": "B only" }
      }
    },
    "stateRegistrations": {
      "type": "array",
      "description": "Verified identical to the per-state table in the BrokerCheck PDF, 33/33 rows for CRD 1096328.",
      "items": {
        "type": "object",
        "properties": {
          "state":    { "type": "string",  "x-source": "B/C registeredStates[].state", "examples": ["Alaska"] },
          "scope":    { "enum": ["BC", "IA"], "x-source": "B/C registeredStates[].regScope" },
          "category": { "enum": ["Agent", "Investment Adviser Representative"], "x-source": "derived from regScope; the PDF prints this literal string" },
          "status":   { "type": "string",  "x-source": "B/C registeredStates[].status", "examples": ["APPROVED"] },
          "approvedDate": { "type": "string", "x-source": "B/C registeredStates[].regDate", "examples": ["4/23/2020"] }
        }
      }
    },
    "sroRegistrations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "sro":        { "type": "string", "x-source": "B/C registeredSROs[].sro", "examples": ["BOX Exchange LLC"] },
          "status":     { "type": "string", "x-source": "B/C registeredSROs[].status", "examples": ["APPROVED"] },
          "categories": { "type": "array", "items": { "type": "string" }, "x-source": "B/C registeredSROs[].CategoriesList", "examples": [["Full Registration/General Securities Representative"]] },
          "approvedDate": { "type": "string", "x-source": "PDF G/H ONLY — absent from all JSON", "examples": ["06/05/2019"] }
        }
      }
    },
    "exams": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind":     { "enum": ["principal", "product", "state"], "x-source": "B/C which of principalExamCategory/productExamCategory/stateExamCategory the row came from" },
          "category": { "type": "string", "x-source": "B/C *.examCategory", "examples": ["Series 65"] },
          "name":     { "type": "string", "x-source": "B/C *.examName", "examples": ["Uniform Investment Adviser Law Examination"] },
          "takenDate":{ "type": "string", "x-source": "B/C *.examTakenDate", "examples": ["4/25/2017"] },
          "scope":    { "enum": ["BC", "IA"], "x-source": "B/C *.examScope" }
        }
      }
    },
    "examCounts": {
      "type": "object",
      "properties": {
        "principal": { "type": "integer", "x-source": "B/C examsCount.principalExamCount" },
        "product":   { "type": "integer", "x-source": "B/C examsCount.productExamCount" },
        "state":     { "type": "integer", "x-source": "B/C examsCount.stateExamCount" }
      }
    },
    "employments": {
      "type": "array",
      "description": "Union of currentEmployments, currentIAEmployments, previousEmployments, previousIAEmployments from BOTH B and C. Neither source alone is complete.",
      "items": {
        "type": "object",
        "properties": {
          "current":  { "type": "boolean", "x-source": "which array the row came from" },
          "side":     { "enum": ["BD", "IA"], "x-source": "which array the row came from" },
          "firmCrd":  { "type": "integer", "x-source": "B/C *.firmId; A firm_id", "examples": [31194] },
          "firmName": { "type": "string",  "x-source": "B/C *.firmName; A firm_name", "examples": ["RBC CAPITAL MARKETS, LLC"] },
          "iaSecNumber":     { "type": "string", "x-source": "B/C *.iaSECNumber", "examples": ["13059"] },
          "iaSecNumberType": { "type": "string", "x-source": "B/C *.iaSECNumberType", "examples": ["801"] },
          "iaFullSecNumber": { "type": "string", "x-source": "A firm_ia_full_sec_number (pre-joined)", "examples": ["801-68234"] },
          "bdSecNumber":     { "type": "string", "x-source": "B/C *.bdSECNumber", "examples": ["45411"] },
          "iaOnly":          { "enum": ["Y", "N"], "x-source": "B/C *.iaOnly; A ia_only" },
          "firmBcScope":     { "type": "string", "x-source": "B/C *.firmBCScope" },
          "firmIaScope":     { "type": "string", "x-source": "B/C *.firmIAScope" },
          "registrationBeginDate": { "type": "string", "x-source": "B/C *.registrationBeginDate", "examples": ["6/5/2019"] },
          "registrationEndDate":   { "type": "string", "x-source": "B/C previous*.registrationEndDate", "examples": ["10/13/1998"] },
          "city":    { "type": "string", "x-source": "B/C previous*.city", "examples": ["MINNEAPOLIS"] },
          "state":   { "type": "string", "x-source": "B/C previous*.state", "examples": ["MN"] },
          "country": { "type": "string", "x-source": "B/C previous*.country" },
          "branchOffices": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "branchOfficeId": { "type": "string", "x-source": "B/C *.branchOfficeLocations[].branchOfficeId", "examples": ["74134"] },
                "street1": { "type": "string", "x-source": "…street1", "examples": ["3760 CARILLON POINT"] },
                "street2": { "type": "string", "x-source": "…street2", "examples": ["BUILDING 3000, 4TH FLOOR"] },
                "city":    { "type": "string", "x-source": "…city; A branch_city", "examples": ["KIRKLAND"] },
                "cityAlias": { "type": "array", "items": { "type": "string" }, "x-source": "…cityAlias", "examples": [["HOUGHTON", "JUANITA", "KIRKLAND", "REDMOND", "TOTEM LAKE"]] },
                "state":   { "type": "string", "x-source": "…state; A branch_state", "examples": ["WA"] },
                "zipCode": { "type": "string", "x-source": "…zipCode; A branch_zip", "examples": ["98033-7455"] },
                "country": { "type": "string", "x-source": "…country", "examples": ["United States"] },
                "latitude":  { "type": "string", "x-source": "…latitude", "examples": ["47.673156"] },
                "longitude": { "type": "string", "x-source": "…longitude", "examples": ["-122.197628"] },
                "startDate": { "type": "string", "x-source": "…elaBeginDate", "examples": ["06/05/2019"] },
                "locatedAt":         { "enum": ["Y", "N"], "x-source": "…locatedAtFlag" },
                "supervisedFrom":    { "enum": ["Y", "N"], "x-source": "…supervisedFromFlag" },
                "privateResidence":  { "enum": ["Y", "N"], "x-source": "…privateResidenceFlag" },
                "nonRegisteredOffice": { "enum": ["Y", "N"], "x-source": "…nonRegisteredOfficeFlag" },
                "displayOrder": { "type": "integer", "x-source": "…displayOrder" }
              }
            }
          }
        }
      }
    },
    "disclosureFlags": {
      "type": "object",
      "properties": {
        "bc": { "enum": ["Y", "N"], "x-source": "B/C disclosureFlag" },
        "ia": { "enum": ["Y", "N"], "x-source": "B/C iaDisclosureFlag; A ind_ia_disclosure_fl" }
      }
    },
    "disclosures": {
      "type": "array",
      "description": "Union of B.disclosures, B.iaDisclosures and C.disclosures. Summary level. Full filed detail requires the PDF (see pdfOnly.disclosureDetails).",
      "items": {
        "type": "object",
        "properties": {
          "eventDate":  { "type": "string", "x-source": "B/C disclosures[].eventDate", "examples": ["5/24/2021"] },
          "type":       { "enum": ["Regulatory", "Customer Dispute", "Criminal", "Financial", "Judgment / Lien", "Employment Separation After Allegations", "Investigation"], "x-source": "B/C disclosures[].disclosureType" },
          "resolution": { "type": "string", "x-source": "B/C disclosures[].disclosureResolution", "examples": ["Final", "Award / Judgment"] },
          "bcCtgryType": { "type": "integer", "x-source": "B/C disclosures[].bcCtgryType" },
          "iaCtgryType": { "type": "integer", "x-source": "B disclosures[].iaCtgryType" },
          "isBcExcludedCC":   { "enum": ["Y", "N"], "x-source": "B/C disclosures[].isBcExcludedCCFlag" },
          "isIapdExcludedCC": { "enum": ["Y", "N"], "x-source": "B/C disclosures[].isIapdExcludedCCFlag" },
          "detail": {
            "type": "object",
            "description": "Type-dependent; only these keys were ever observed across 108 disclosures.",
            "properties": {
              "Initiated By":               { "type": "string", "x-source": "Regulatory / Investigation", "examples": ["OHIO DIVISION OF SECURITIES"] },
              "Allegations":                { "type": "string", "x-source": "Regulatory / Customer Dispute / Employment Separation" },
              "Resolution":                 { "type": "string", "x-source": "Regulatory", "examples": ["Decision", "Consent"] },
              "SanctionDetails":            { "type": "array", "items": { "type": "object", "properties": { "Sanctions": { "type": "string" } } }, "x-source": "Regulatory", "examples": [[{ "Sanctions": "Censure" }, { "Sanctions": "Suspension" }]] },
              "Sanction Details":           { "type": "string", "x-source": "Regulatory" },
              "Sanctions":                  { "type": "string", "x-source": "Regulatory" },
              "Regulator Statement":        { "type": "string", "x-source": "Regulatory (present in only 4 of 29 sampled)" },
              "DocketNumberFDA":            { "type": "string", "x-source": "Regulatory (empty in every sample)" },
              "DocketNumberAAO":            { "type": "string", "x-source": "Regulatory (empty in every sample)" },
              "Damage Amount Requested":    { "type": "string", "x-source": "Customer Dispute", "examples": ["$323,556.00"] },
              "Damages Granted":            { "type": "string", "x-source": "Customer Dispute", "examples": ["$132,982.50"] },
              "Settlement Amount":          { "type": "string", "x-source": "Customer Dispute" },
              "arbitrationClaimFiledDetail":{ "type": "string", "x-source": "Customer Dispute" },
              "arbitrationDocketNumber":    { "type": "string", "x-source": "Customer Dispute" },
              "DisplayAAOLinkIfExists":     { "enum": ["Y", "N"], "x-source": "Customer Dispute" },
              "criminalCharges":            { "type": "string", "x-source": "Criminal" },
              "Firm Name":                  { "type": "string", "x-source": "Employment Separation After Allegations" },
              "Termination Type":           { "type": "string", "x-source": "Employment Separation After Allegations" },
              "Type":                       { "type": "string", "x-source": "Financial", "examples": ["Compromise"] },
              "Disposition":                { "type": "string", "x-source": "Financial", "examples": ["Discharged"] },
              "Judgment/Lien Amount":       { "type": "string", "x-source": "Judgment / Lien" },
              "Judgment/Lien Type":         { "type": "string", "x-source": "Judgment / Lien" },
              "Description of Investigation": { "type": "string", "x-source": "Investigation" },
              "Broker Comment":             { "type": "array", "items": { "type": "string" }, "x-source": "all types" }
            }
          }
        }
      }
    },
    "pdfOnly": {
      "type": "object",
      "description": "Second-pass enrichment. Text-extracted (NOT OCR) from source G https://reports.adviserinfo.sec.gov/reports/individual/individual_<CRD>.pdf, which works for pure RIAs; source H https://files.brokercheck.finra.org/individual/individual_<CRD>.pdf is richer for brokers but 403s for anyone with no broker record.",
      "properties": {
        "reportLastUpdated": { "type": "string", "x-source": "G report summary line", "examples": ["07/09/2024"] },
        "employmentHistory": {
          "type": "array",
          "description": "U4 employment for ~10 years INCLUDING non-securities jobs. The only place a job title exists.",
          "items": {
            "type": "object",
            "properties": {
              "dateRange":        { "type": "string", "x-source": "G/H Employment History", "examples": ["04/2013 - 06/2017"] },
              "employerName":     { "type": "string", "x-source": "G/H", "examples": ["VMware, Inc."] },
              "position":         { "type": "string", "x-source": "G/H", "examples": ["Manager Technical Account Management Services", "Senior Investment Associate"] },
              "investmentRelated":{ "enum": ["Y", "N"], "x-source": "G/H", "examples": ["N"] },
              "location":         { "type": "string", "x-source": "G/H", "examples": ["Palo Alto, CA, United States"] }
            }
          }
        },
        "otherBusinessActivities": { "type": "string", "x-source": "G/H Other Business Activities", "examples": ["Fortitude LLC (s-corp), 16704 NE 98th Place, Redmond, WA 98052, A personal, solely owned, holding company and business platform, established in 2017 …"] },
        "professionalDesignations": { "type": "array", "items": { "type": "string" }, "x-source": "G/H Professional Designations (U4 Q8, issuer-verified)" },
        "employerMainOfficeAddress": { "type": "string", "x-source": "G/H Registrations block", "examples": ["200 VESEY ST., NEW YORK, NY 10281"] },
        "disclosureDetails": {
          "type": "array",
          "description": "One entry PER REPORTING SOURCE per event. The JSON collapses these into a single record and drops ~12 fields.",
          "items": {
            "type": "object",
            "properties": {
              "reportingSource":  { "enum": ["Regulator", "Firm", "Broker"], "x-source": "G/H", "examples": ["Firm"] },
              "docketCaseNumber": { "type": "string", "x-source": "G/H", "examples": ["99-463"] },
              "sanctionsSought":  { "type": "string", "x-source": "G/H (Regulatory)", "examples": ["Denial"] },
              "dateInitiated":    { "type": "string", "x-source": "G/H", "examples": ["11/04/1999"] },
              "resolutionDate":   { "type": "string", "x-source": "G/H", "examples": ["08/21/2001"] },
              "currentStatus":    { "type": "string", "x-source": "G/H", "examples": ["Final"] },
              "productType":      { "type": "string", "x-source": "G/H", "examples": ["Equity - OTC"] },
              "employingFirmWhenActivityOccurred": { "type": "string", "x-source": "G/H", "examples": ["SHEARSON LEHMAN BROTHERS"] },
              "dateComplaintReceived": { "type": "string", "x-source": "G/H (Customer Dispute)", "examples": ["05/16/1988"] },
              "complaintPending":  { "enum": ["Yes", "No"], "x-source": "G/H (Customer Dispute)" },
              "statusDate":        { "type": "string", "x-source": "G/H", "examples": ["07/07/1989"] },
              "arbitrationForum":  { "type": "string", "x-source": "G/H", "examples": ["National Association of Securities Dealers, Inc."] },
              "dateNoticeServed":  { "type": "string", "x-source": "G/H", "examples": ["05/16/1988"] },
              "arbitrationPending":{ "enum": ["Yes", "No"], "x-source": "G/H" },
              "disposition":       { "type": "string", "x-source": "G/H", "examples": ["Award to Customer", "Settled"] },
              "dispositionDate":   { "type": "string", "x-source": "G/H", "examples": ["07/07/1989"] },
              "monetaryCompensationAmount": { "type": "string", "x-source": "G/H", "examples": ["$132,982.50"] },
              "individualContributionAmount": { "type": "string", "x-source": "G/H", "examples": ["$0.00"] },
              "firmStatement":      { "type": "string", "x-source": "G/H" },
              "regulatorStatement": { "type": "string", "x-source": "G/H" },
              "brokerStatement":    { "type": "string", "x-source": "G/H" }
            }
          }
        }
      }
    },
    "reportUrls": {
      "type": "object",
      "properties": {
        "iapdReportPdf":       { "type": "string", "x-source": "G, constructed", "examples": ["https://reports.adviserinfo.sec.gov/reports/individual/individual_6844196.pdf"] },
        "brokercheckReportPdf":{ "type": "string", "x-source": "H, constructed; only when bcScope != NotInScope", "examples": ["https://files.brokercheck.finra.org/individual/individual_1096328.pdf"] }
      }
    },
    "source": {
      "type": "object",
      "description": "Provenance. Never populated by a model.",
      "properties": {
        "fetchedAt": { "type": "string", "format": "date-time" },
        "endpoints": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

### `FirmProfile`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://hushh.ai/schemas/ria/FirmProfile.json",
  "title": "FirmProfile",
  "description": "Maximal public regulatory record for an advisory firm. Sources D/E for the registration shell, F (the SEC Form ADV compilation feed) for all of Form ADV Part 1A. No PDF parsing required.",
  "type": "object",
  "required": ["crd", "name", "source"],
  "properties": {
    "crd":  { "type": "integer", "x-source": "D basicInformation.firmId; F Info/@FirmCrdNb", "examples": [143417] },
    "name": {
      "type": "object",
      "properties": {
        "business": { "type": "string", "x-source": "D basicInformation.firmName; F Info/@BusNm", "examples": ["ROBINSWOOD FINANCIAL"] },
        "legal":    { "type": "string", "x-source": "F Info/@LegalNm", "examples": ["ROBINSWOOD FINANCIAL LLC"] },
        "other":    { "type": "array", "items": { "type": "string" }, "x-source": "D basicInformation.otherNames", "examples": [["ROBINSWOOD FINANCIAL", "ROBINSWOOD FINANCIAL LLC"]] }
      }
    },
    "secNumber":     { "type": "string", "x-source": "F Info/@SECNb; or D iaSECNumberType + '-' + iaSECNumber", "examples": ["801-68234"] },
    "secRegionCode": { "type": "string", "x-source": "F Info/@SECRgnCD", "examples": ["SFRO"] },
    "umbrellaRegistration": { "enum": ["Y", "N"], "x-source": "F Info/@UmbrRgstn" },
    "isIAFirm":  { "enum": ["Y", "N"], "x-source": "D basicInformation.isIAFirm" },
    "iaScope":   { "type": "string", "x-source": "D basicInformation.iaScope", "examples": ["ACTIVE"] },
    "bcScope":   { "type": "string", "x-source": "D/E basicInformation.bcScope (dual registrants)", "examples": ["ACTIVE"] },
    "bdSecNumber": { "type": "string", "x-source": "D/E basicInformation.bdSECNumber", "examples": ["45411"] },
    "scopeFlags": {
      "type": "object",
      "x-source": "D orgScopeStatusFlags",
      "properties": {
        "isSECRegistered":      { "enum": ["Y", "N"] },
        "isStateRegistered":    { "enum": ["Y", "N"] },
        "isERARegistered":      { "enum": ["Y", "N"] },
        "isSECERARegistered":   { "enum": ["Y", "N"] },
        "isStateERARegistered": { "enum": ["Y", "N"] }
      }
    },
    "mainAddress": {
      "type": "object",
      "x-source": "D iaFirmAddressDetails.officeAddress; F MainAddr",
      "properties": {
        "street1":    { "type": "string", "examples": ["3425 CARILLON POINT"] },
        "street2":    { "type": "string", "examples": ["BUILDING 3000, 4TH FLOOR"] },
        "city":       { "type": "string", "examples": ["KIRKLAND"] },
        "state":      { "type": "string", "examples": ["WA"] },
        "postalCode": { "type": "string", "examples": ["98033"] },
        "country":    { "type": "string", "examples": ["United States"] }
      }
    },
    "mailingAddress": { "type": "object", "x-source": "F MailingAddr; E firmAddressDetails.mailingAddress" },
    "phone": { "type": "string", "x-source": "F MainAddr/@PhNb (as filed — may contain filer typos); E firmAddressDetails.businessPhoneNumber", "examples": ["452-296-1611"] },
    "fax":   { "type": "string", "x-source": "F MainAddr/@FaxNb", "examples": ["425-296-1612"] },
    "website": { "type": "string", "x-source": "F Part1A/Item1/WebAddrs/WebAddr", "examples": ["HTTP://WWW.ROBINSWOOD.COM"] },
    "organization": {
      "type": "object",
      "properties": {
        "legalForm":     { "type": "string", "x-source": "F Item3A/@OrgFormNm; E basicInformation.firmType", "examples": ["Limited Liability Company"] },
        "fiscalYearEnd": { "type": "string", "x-source": "F Item3B/@Q3B; E basicInformation.fiscalMonthEndCode", "examples": ["DECEMBER"] },
        "stateOfOrganization": { "type": "string", "x-source": "F Item3C/@StateCD", "examples": ["WA"] },
        "countryOfOrganization": { "type": "string", "x-source": "F Item3C/@CntryNm", "examples": ["United States"] },
        "formedDate":    { "type": "string", "x-source": "E basicInformation.formedDate (BD side)", "examples": ["11/01/2010"] },
        "formedState":   { "type": "string", "x-source": "E basicInformation.formedState", "examples": ["Minnesota"] },
        "firmSize":      { "type": "string", "x-source": "E basicInformation.firmSize", "examples": ["Large"] },
        "districtName":  { "type": "string", "x-source": "E basicInformation.districtName", "examples": ["New York"] },
        "regulator":     { "type": "string", "x-source": "E basicInformation.regulator", "examples": ["SEC"] }
      }
    },
    "registrationStatus": {
      "type": "array",
      "x-source": "D registrationStatus[]; F Rgstn",
      "items": {
        "type": "object",
        "properties": {
          "jurisdiction":  { "type": "string", "examples": ["SEC", "Washington"] },
          "status":        { "type": "string", "examples": ["Approved", "Terminated"] },
          "effectiveDate": { "type": "string", "examples": ["8/20/2007"] }
        }
      }
    },
    "noticeFilings": {
      "type": "array",
      "x-source": "D noticeFilings[]; F NoticeFiled/States",
      "items": {
        "type": "object",
        "properties": {
          "jurisdiction":  { "type": "string", "examples": ["Arizona"] },
          "status":        { "type": "string", "examples": ["Notice Filed"] },
          "effectiveDate": { "type": "string", "examples": ["3/26/2018"] }
        }
      }
    },
    "lastAdvFiling": {
      "type": "object",
      "properties": {
        "date":        { "type": "string", "x-source": "D basicInformation.advFilingDate; F Filing/@Dt", "examples": ["07/28/2026"] },
        "formVersion": { "type": "string", "x-source": "F Filing/@FormVrsn", "examples": ["10/2021"] }
      }
    },
    "advPart1A": {
      "type": "object",
      "description": "The whole of Form ADV Part 1A, structured. Source F only. This is exactly what the 21-page PDF at https://reports.adviserinfo.sec.gov/reports/ADV/<crd>/PDF/<crd>.pdf contains.",
      "properties": {
        "employees": {
          "type": "object",
          "properties": {
            "total":                { "type": "integer", "x-source": "F Item5A/@TtlEmp", "examples": [6] },
            "advisoryFunctions":    { "type": "integer", "x-source": "F Item5B/@Q5B1", "examples": [6] },
            "registeredRepsOfBD":   { "type": "integer", "x-source": "F Item5B/@Q5B2", "examples": [0] },
            "stateRegisteredIARs":  { "type": "integer", "x-source": "F Item5B/@Q5B3", "examples": [0] },
            "iarsForOtherAdvisers": { "type": "integer", "x-source": "F Item5B/@Q5B4", "examples": [0] },
            "insuranceAgents":      { "type": "integer", "x-source": "F Item5B/@Q5B5", "examples": [0] },
            "solicitors":           { "type": "integer", "x-source": "F Item5B/@Q5B6", "examples": [0] }
          }
        },
        "clientsByType": {
          "type": "array",
          "description": "Item 5.D — one row per client category (a…n).",
          "items": {
            "type": "object",
            "properties": {
              "category":     { "type": "string",  "x-source": "F Item5D attribute letter", "examples": ["individuals", "highNetWorthIndividuals", "charitableOrganizations", "corporationsOrOtherBusinesses"] },
              "clientCount":  { "type": "integer", "x-source": "F Item5D/@Q5D{X}1", "examples": [360, 128] },
              "fewerThan5":   { "type": "string",  "x-source": "F Item5D/@Q5D{X}2", "examples": ["Fewer than 5 clients"] },
              "raum":         { "type": "integer", "x-source": "F Item5D/@Q5D{X}3", "examples": [113743483, 324271708, 7397579, 7745743] }
            }
          }
        },
        "compensationArrangements": {
          "type": "object",
          "x-source": "F Item5E/@Q5E1..Q5E7",
          "properties": {
            "percentOfAum":     { "enum": ["Y", "N"], "examples": ["Y"] },
            "hourlyCharges":    { "enum": ["Y", "N"], "examples": ["Y"] },
            "subscriptionFees": { "enum": ["Y", "N"] },
            "fixedFees":        { "enum": ["Y", "N"], "examples": ["Y"] },
            "commissions":      { "enum": ["Y", "N"] },
            "performanceBasedFees": { "enum": ["Y", "N"] },
            "other":            { "enum": ["Y", "N"] }
          }
        },
        "regulatoryAssetsUnderManagement": {
          "type": "object",
          "x-source": "F Item5F",
          "properties": {
            "providesContinuousSupervision": { "enum": ["Y", "N"], "x-source": "F Item5F/@Q5F1", "examples": ["Y"] },
            "discretionaryUsd":     { "type": "integer", "x-source": "F Item5F/@Q5F2A", "examples": [453158469] },
            "nonDiscretionaryUsd":  { "type": "integer", "x-source": "F Item5F/@Q5F2B", "examples": [44] },
            "totalUsd":             { "type": "integer", "x-source": "F Item5F/@Q5F2C", "examples": [453158513] },
            "discretionaryAccounts":    { "type": "integer", "x-source": "F Item5F/@Q5F2D", "examples": [1403] },
            "nonDiscretionaryAccounts": { "type": "integer", "x-source": "F Item5F/@Q5F2E", "examples": [1] },
            "totalAccounts":            { "type": "integer", "x-source": "F Item5F/@Q5F2F", "examples": [1404] }
          }
        },
        "advisoryServices":         { "type": "object", "x-source": "F Item5G/@Q5G1..Q5G12 — financial planning, portfolio management for individuals / businesses / pooled vehicles, pension consulting, selection of other advisers, publications, etc." },
        "financialPlanningClients": { "type": "string", "x-source": "F Item5H/@Q5H", "examples": ["1-10"] },
        "wrapFeePrograms":          { "type": "object", "x-source": "F Item5I" },
        "separatelyManagedAccounts":{ "type": "object", "x-source": "F Item5J" },
        "marketingAndSocial":       { "type": "object", "x-source": "F Item5K/@Q5K1..Q5K4" },
        "otherBusinessActivities":  { "type": "object", "x-source": "F Item6A, Item6B" },
        "affiliations":             { "type": "object", "x-source": "F Item7A" },
        "privateFunds":             { "type": "object", "x-source": "F Item7B" },
        "clientTransactions":       { "type": "object", "x-source": "F Item8A..Item8I — proprietary trading, soft dollars, brokerage practices" },
        "custody":                  { "type": "object", "x-source": "F Item9A..Item9F — whether the firm has custody of client cash/securities, and how much" },
        "controlPersons":           { "type": "object", "x-source": "F Item10A" },
        "disciplinary": {
          "type": "object",
          "description": "The full Form ADV disciplinary questionnaire — every answer, not just a summary flag.",
          "x-source": "F Item11 and Item11A..Item11H",
          "properties": {
            "anyDisciplinary":        { "enum": ["Y", "N"], "x-source": "F Item11/@Q11", "examples": ["N"] },
            "criminalFelony":         { "type": "object", "x-source": "F Item11A/@Q11A1,@Q11A2" },
            "criminalMisdemeanor":    { "type": "object", "x-source": "F Item11B" },
            "secOrCftcAction":        { "type": "object", "x-source": "F Item11C/@Q11C1..Q11C5" },
            "otherRegulatoryAction":  { "type": "object", "x-source": "F Item11D/@Q11D1..Q11D5" },
            "sroAction":              { "type": "object", "x-source": "F Item11E/@Q11E1..Q11E4" },
            "authorizationRevoked":   { "type": "object", "x-source": "F Item11F" },
            "foreignAction":          { "type": "object", "x-source": "F Item11G" },
            "civilAction":            { "type": "object", "x-source": "F Item11H/@Q11H1A,@Q11H1B,@Q11H1C,@Q11H2" }
          }
        }
      }
    },
    "bdDisclosureSummary": {
      "type": "array",
      "description": "Broker-dealer side only.",
      "x-source": "E disclosures[]",
      "items": {
        "type": "object",
        "properties": {
          "disclosureType":  { "type": "string",  "examples": ["Regulatory Event"] },
          "disclosureCount": { "type": "integer", "examples": [377] }
        }
      }
    },
    "disclosureFlags": {
      "type": "object",
      "properties": {
        "bd": { "enum": ["Y", "N"], "x-source": "E bdDisclosureFlag" },
        "ia": { "enum": ["Y", "N"], "x-source": "E iaDisclosureFlag" }
      }
    },
    "directOwners": {
      "type": "array",
      "x-source": "E directOwners[]",
      "items": {
        "type": "object",
        "properties": {
          "legalName": { "type": "string", "examples": ["RBC USA HOLDCO CORPORATION"] },
          "position":  { "type": "string", "examples": ["DIRECT OWNER"] },
          "crdNumber": { "type": "string" },
          "bcScope":   { "type": "string" }
        }
      }
    },
    "affiliateDisclosures": { "type": "object", "x-source": "E affiliateDisclosures.nonRegisteredAffiliateDisclosureCount", "examples": [{ "nonRegisteredAffiliateDisclosureCount": 13 }] },
    "bdRegistrations": {
      "type": "object",
      "x-source": "E registrations",
      "properties": {
        "approvedSECRegistrationCount":   { "type": "integer", "examples": [1] },
        "approvedFinraRegistrationCount": { "type": "integer", "examples": [1] },
        "approvedSRORegistrationCount":   { "type": "integer", "examples": [24] },
        "approvedStateRegistrationCount": { "type": "integer", "examples": [53] },
        "businessTypeCount":              { "type": "integer", "examples": [21] },
        "hasAffliation":                  { "enum": ["Y", "N"], "description": "SEC's own spelling" },
        "referOtherBd":                   { "enum": ["Y", "N"] },
        "stateList":                      { "type": "array", "items": { "type": "object", "properties": { "state": { "type": "string" } } } }
      }
    },
    "accountantSurpriseExams": {
      "type": "array",
      "x-source": "D accountantSurpriseExams[]",
      "items": {
        "type": "object",
        "properties": {
          "accountantFirmName": { "type": "string", "examples": ["PRICEWATERHOUSECOOPERS LLP"] },
          "filingDate":         { "type": "string", "examples": ["10/28/2025"] },
          "fileStatus":         { "type": "string", "examples": ["FILE"] },
          "encryptedFilingID":  { "type": "string" }
        }
      }
    },
    "exemptReportingAdvisers": { "type": "array", "x-source": "D exemptReportingAdvisers[]" },
    "brochures": {
      "type": "object",
      "x-source": "D brochures",
      "properties": {
        "part2ExemptFlag": { "enum": ["Y", "N"] },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "brochureVersionID": { "type": "integer", "examples": [1053041] },
              "brochureName":      { "type": "string",  "examples": ["ROBINSWOOD BROCHURE ADV 2B JULY 2026"] },
              "dateSubmitted":     { "type": "string",  "examples": ["7/28/2026"] },
              "lastConfirmed":     { "type": "string",  "examples": ["1/28/2026"] },
              "url":               { "type": "string",  "x-source": "J, constructed", "examples": ["https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx?BRCHR_VRSN_ID=1053041"] }
            }
          }
        }
      }
    },
    "formCrs": {
      "type": "object",
      "properties": {
        "crsType": { "type": "string", "x-source": "D basicInformation.crs.crsType", "examples": ["IA", "DU"] },
        "fileId":  { "type": "string", "x-source": "D basicInformation.crs.fileId", "examples": ["dccdb114-5980-4724-9879-7a11380c1cfe"] },
        "url":     { "type": "string", "x-source": "K, constructed", "examples": ["https://reports.adviserinfo.sec.gov/crs/crs_143417.pdf"] }
      }
    },
    "advPdfUrl": { "type": "string", "x-source": "I, constructed — human-facing link only, do not parse", "examples": ["https://reports.adviserinfo.sec.gov/reports/ADV/143417/PDF/143417.pdf"] },
    "compilationData": {
      "type": "array",
      "description": "Tells you which feed edition to pull for source F.",
      "x-source": "D compilationData[]",
      "items": {
        "type": "object",
        "properties": {
          "editionID":   { "type": "integer", "examples": [52821] },
          "type":        { "type": "string",  "examples": ["IA_FIRM_SEC", "IA_FIRM_STATE", "IA_INDVL"] },
          "generatedOn": { "type": "string",  "examples": ["7/29/2026"] }
        }
      }
    },
    "roster": {
      "type": "array",
      "description": "Current advisers. Source A. MUST be filtered on ind_ia_current_employments[].firm_id == this crd, because firm= also matches former employers.",
      "x-source": "A",
      "items": { "$ref": "https://hushh.ai/schemas/ria/IndividualProfile.json" }
    },
    "source": {
      "type": "object",
      "properties": {
        "fetchedAt": { "type": "string", "format": "date-time" },
        "endpoints": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

---

## Operational notes

- **Never let a model fill any field above.** Re-confirming the ground truth: a web-grounded LLM
  asked for Robinswood's advisers returned 2 of the 7 the live roster carries. The seven, from
  `iapd-roster-143417.parsed.json` fetched today: 2486426 Robert Guild, 2848710 Edward Ward,
  4661439 Janet Weisman (`ind_namesuffix: "MRS."`), 6844196 Robert MacRae, 6742656 Christopher
  Simon-Wallace, 6786615 Colleen Bracy, 6689626 Kelsey Curtis. Note three of the seven are
  `ind_ia_scope: "InActive"` — the roster is not the same as "currently registered".
- **Date formats are inconsistent across sources.** A uses `2007-06-17`; B/C use `6/17/2007`
  (no zero-padding); F uses `2007-08-20`; branch `elaBeginDate` uses `06/05/2019`. Normalise once
  at ingest.
- **The firm's filed phone number can be wrong.** Robinswood filed `452-296-1611` where the real
  number is `425-296-1611`. Phone→firm resolution must tolerate digit transposition.
- **`firm=` on the roster endpoint matches former employers too.** Always filter.
- **Both individual endpoints must be called.** See the asymmetry table above.
- **Build the source-F URL from `compilationData[].generatedOn`,** not from today's date — the feed
  is regenerated on the SEC's schedule, not ours. `IA_FIRM_SEC_Feed_08_06_2026.xml.gz` returned 200
  with `Last-Modified: Thu, 06 Aug 2026 09:29:09 GMT`; `IA_FIRM_STATE_Feed_08_06_2026.xml.gz` also
  200. No individual-level feed exists under any name probed
  (`IA_INDVL_Feed`, `IA_Indvl_Feed`, `IA_INDVL_FEED`, `IAPD_INDVL_Feed`, `IA_INDVL_Report`,
  `IA_INDVL_SEC`, `IA_IND_Feed`, `IAIndvlFeed`, `.xml`, `.zip`) — all S3 `AccessDenied`.
- **PDF text extraction, not OCR.** `pypdf` reads the text layer directly. `pdftotext`, `mutool`,
  `qpdf`, `pdftk` are all absent on this machine; `/usr/bin/python3` already has `pypdf 6.11.0`.

## Raw captures

`/Users/ankitkumarsingh/Desktop/HusshOne/docs/samples/` — for each subject, `*.json` is the raw
response and `*.parsed.json` is the same after recursive double-decoding; each `*.pdf` has a
matching `*.txt` of its extracted text.

| File | What |
|---|---|
| `iapd-roster-143417.json` | source A, 7 advisers |
| `iapd-ind-{1096328,2486426,6844196,1731327,810315}.json` | source B |
| `bc-ind-{1096328,2486426,6844196,1731327,810315,1018196}.json` | source C |
| `iapd-firm-{143417,31194}.json` | source D |
| `bc-firm-{143417,31194}.json` | source E |
| `adv-feed-143417.xml` | Robinswood's record extracted from source F |
| `iapd-report-{1096328,2486426,6844196,1731327}.pdf/.txt` | source G |
| `bc-report-{1096328,2486426,1731327,810315,1018196}.pdf/.txt` | source H (no file for 6844196 — 403, IA-only) |
| `adv-firm-143417.pdf/.txt` | source I |
