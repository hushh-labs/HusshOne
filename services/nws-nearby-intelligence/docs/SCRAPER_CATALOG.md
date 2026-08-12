# Public-Source Collector and Scraper Catalog

This catalog distinguishes **bulk-data collectors**, **official-page crawlers**, and **discovery crawlers**. The fastest reliable service is not the one with the most scrapers; it is the one where every scraper has a narrow fact contract and every material claim is corroborated.


## Implemented collector/parser foundation

The repository includes executable primitives for controlled acquisition and parsing:

```text
SourceRegistry.from_yaml
ControlledPublicFetcher
ContentAddressedArtifactStore
ParserRegistry
ObservationPolicyGate
OfficialJsonLdParser
SecForm4Parser
```

The remaining entries in this catalog are source-specific adapters built on those contracts. Every parser emits versioned observations; no collector or parser can write a score directly.

## Common collector contract

Every collector must provide:

```text
source_id
artifact URI and final URI
retrieval timestamp
HTTP metadata
SHA-256
fetcher version
parser hint/version
source partition and release date
```

Every parsed observation must provide:

```text
fact type
external subject/object identifiers
observed date
confidence
attributes
artifact SHA-256
parser version
```

No collector may directly write NWS.

---

## P0 collectors — launch-critical

## 1. Census Gazetteer ZCTA collector

**Purpose:** Resolve a ZIP entry to representative coordinates and area identifiers.

**Acquisition:** Annual national compressed file.

**Parse:**

```text
GEOID/ZCTA code
land/water area
representative latitude
representative longitude
```

**Output:** `postal_area`.

**Important:** A ZCTA is a statistical geography, not a claim that a person lives at the ZIP centroid.

## 2. Census TIGER/ZCTA and place-boundary collector

**Purpose:** Point-in-polygon, ZIP/city crosswalks, metro assignment, border handling.

**Acquisition:** Annual shapefiles.

**Parse:**

```text
ZCTA polygon
place/city polygon
county and metro crosswalk
internal point
source vintage
```

**Output:** PostGIS boundary tables.

## 3. SEC EDGAR index and ownership collector

**Purpose:** High-confidence public-company person/organization relationships.

**Discovery:** Daily/full EDGAR indexes.

**Forms:**

```text
3, 4, 5 and amendments
13D, 13G and amendments
DEF 14A
S-1
8-K
10-K
```

**Parse ownership forms:**

```text
reporting-owner CIK/name
issuer CIK/name/ticker
role flags
security title
direct/indirect ownership
transaction date/code
post-transaction shares
footnotes
```

**Graph output:**

```text
OFFICER_OF
DIRECTOR_OF
REPORTING_OWNER_OF
FOUNDER_OF when explicitly supported
```

**Score use:** Roles, institutional context, capital access, identity anchor. A filing does not establish a private residence.

## 4. Official company/team-page crawler

**Purpose:** Current role, official bio, organization domain, and public office association.

**Seeds:** Canonical domains from SEC, state registries, press releases, or reviewed analyst input.

**Page discovery:**

```text
/about
/team
/leadership
/company
/people
/board
/contact or /locations
JSON-LD Person/Organization
sitemaps
```

**Parse:**

```text
name
title
bio text hash
canonical profile URL
organization
public office/city label
linked official profiles
page effective/modified date
```

**Controls:**

- Robots-aware.
- Central host rate limit.
- No login/session requirement.
- No generic email/phone harvesting.
- No private-home inference.

## 5. IRS Form 990 XML collector

**Purpose:** Nonprofit officers, trustees, organization scale, civic leadership.

**Acquisition:** Monthly XML archives and index CSV.

**Parse:**

```text
EIN
organization name/location
officer/director/trustee names and titles
compensation context
assets/revenue/program service values
filing period
```

**Graph output:**

```text
OFFICER_OF_NONPROFIT
TRUSTEE_OF
NONPROFIT_CHAIR
```

**Score use:** Civic/institutional network. Nonprofit or foundation assets are not personal wealth.

## 6. USPTO PatentsView bulk collector

**Purpose:** Inventors, assignees, coinventor graph, knowledge output.

**Acquisition:** Bulk tables from the USPTO Open Data Portal.

**Parse:**

```text
patent/application ID
title/date/type
inventor disambiguation ID and name
assignee ID/name/location
CPC/technology classification
citation relationships
```

**Graph output:**

```text
INVENTED
COINVENTED_WITH
ASSIGNED_TO
```

**Normalization:** Patent counts and citations are field- and age-normalized before percentile conversion.

## 7. OpenAlex snapshot collector

**Purpose:** Authors, works, institutions, coauthors, topics, citations.

**Acquisition:** Snapshot Parquet or JSONL.

**Load only required entities:**

```text
authors
works
institutions
sources
topics/concepts
```

**Parse:**

```text
OpenAlex IDs
ORCID where present
author display names and alternatives
institution history
work date/type
coauthor relation
cited-by count
field/topic
```

**Graph output:**

```text
AUTHORED
COAUTHORED_WITH
AFFILIATED_WITH
```

**Normalization:** Field/year expected citations, career age, and author disambiguation confidence.

---

## P1 collectors — major quality improvement

## 8. Official press-release crawler

**Purpose:** Appointments, acquisitions, funding events, partnerships, awards, exits.

**Sources:** Company, government, university, nonprofit, and investor domains.

**Discovery:** RSS/Atom, sitemap, press/news index.

**Parse:**

```text
headline
publication date
named entities
appointment role
organization relationships
funding/acquisition event
quoted official
canonical URL
```

**Rule:** A press release is a primary claim from the issuing organization; material outcome claims should be corroborated where possible.

## 9. Official fund/team/portfolio crawler

**Purpose:** Partner roles and publicly documented investment relationships.

**Parse:**

```text
partner/team member
role and bio
portfolio company
investment stage/category where public
office location
```

**Graph output:**

```text
PARTNER_AT
PUBLICLY_INVESTED_IN
BOARD_ROLE when explicitly stated
```

**Rule:** Portfolio appearance does not prove personal deal ownership or personal wealth.

## 10. State corporation-registry connectors

**Purpose:** Verify entity existence, filing role, status, formation date, and public business location.

**Implementation:** One adapter per state because schemas and access patterns differ.

**Parse:**

```text
state entity ID
legal name
status
formation date
filing role/title
principal public business address where permitted
registered agent separately labelled
filing history
```

**Rule:** A registered agent is never automatically treated as an owner, founder, or operating executive.

## 11. Official government-directory crawler

**Purpose:** Public office, agency leadership, jurisdiction, and official bios.

**Sources:** Federal, state, county, city, public commission, and agency domains.

**Parse:**

```text
name
office/title
jurisdiction
term/start date
committee/commission
official biography
public office location
```

**Graph output:**

```text
PUBLIC_OFFICIAL
LEADS_AGENCY
SERVES_ON_COMMISSION
```

**Rule:** Political affiliation is not a generic NWS feature. Public-office responsibility and civic graph relationships may be used.

## 12. University and research-institution bio crawler

**Purpose:** Faculty, lab leadership, institution affiliation, public awards.

**Parse:**

```text
name/title
department/lab
institution
official profile URL
research areas
public city/campus
ORCID and OpenAlex links
awards/leadership
```

**Graph output:**

```text
FACULTY_AT
LEADS_LAB
AFFILIATED_WITH
```

## 13. Public event agenda and speaker crawler

**Purpose:** Trusted reach, topic expertise, and corroboration.

**Sources:** Official event sites, public PDFs, host institutions.

**Parse:**

```text
event name/date/host
speaker/panelist/moderator
session title/topic
organization/title as printed
```

**Graph output:** `SPOKE_AT` with low base weight and short half-life.

**Rule:** Event attendance alone cannot establish current residence or stable local association.

## 14. Award and fellowship directory crawler

**Purpose:** Verified achievements and institutional recognition.

**Sources:** Awarding institutions only.

**Parse:**

```text
recipient
award/fellowship
awarding body
year
category
official citation
```

**Rule:** Self-listed awards without awarding-body confirmation remain discovery-only.

---

## P2 collectors — discovery and niche coverage

## 15. Wikidata dump collector

**Purpose:** Alias discovery, official website, cross-identifiers, occupations, public relationships.

**Acquisition:** JSON/RDF dumps and incremental dumps.

**Parse only selected properties:**

```text
labels/aliases
instance of human/organization
occupation/position held
employer/educated at
official website
ORCID and external IDs
city-level public affiliation when referenced
```

**Rule:** Unreferenced claims do not directly enter NWS. Use Wikidata to locate primary sources and generate entity candidates.

## 16. Common Crawl and CC-NEWS collector

**Purpose:** Discover official pages, preserve historical public-page evidence, identify new source URLs.

**Acquisition:** Crawl index, WAT metadata, WARC/WET ranges for selected domains.

**Workflow:**

```text
approved domain seed
→ Common Crawl index lookup
→ fetch only matching records/ranges
→ classify page
→ extract canonical links and candidate claims
→ verify on current primary source
```

**Rule:** Common Crawl text is discovery-only until corroborated. It never creates a direct identity merge or score input by itself.

## 17. Claimed public GitHub/profile collector

**Purpose:** Open-source maintainership and public collaboration.

**Eligibility:** The account must be linked from an official bio/domain or verified through a strong identity match.

**Parse:**

```text
public account
public repositories
maintainer/owner role
release activity
contributors/collaboration
stars/forks only as heavily capped context
```

**Graph output:**

```text
MAINTAINS_OPEN_SOURCE
COLLABORATED_WITH
```

**Rule:** Do not infer home location from commit timezone or activity hours. Do not access private repositories.

## 18. Public verified social-profile connector

**Purpose:** Identity corroboration, official link discovery, small bounded public-reach signal.

**Eligibility:** Public profile that is verified or linked from an official domain.

**Allowed extraction:**

```text
profile URL
public display name
bio role claim
official website link
verified status where visible
bounded follower/reach count
```

**Never extract or score:**

```text
private posts
family members
faces
home/location from images
check-ins
cars, travel, clothing, houses
followers as a proxy for wealth
```

**Score cap:** At most 15% of the reach component and approximately 1.05% of the unpenalized total NWS.

---

## Parser implementation pattern

```python
class Parser(Protocol):
    source_id: str
    parser_version: str

    def supports(self, manifest: ArtifactManifest, content: bytes) -> bool: ...
    def parse(self, manifest: ArtifactManifest, content: bytes) -> Iterable[ParsedObservation]: ...
```

Parser requirements:

- Deterministic for the same artifact and version.
- No network calls during parse.
- Bounded decompression and document size.
- Safe XML processing.
- Main-text and structured-data extraction kept separate.
- Observation schema validation.
- Reject or quarantine unexpected schema changes.

## Source reliability

Starting trust tiers:

```text
Authoritative government filing/bulk source  0.95–0.99
Official organization primary source         0.85–0.94
Research/open-data primary graph              0.80–0.92
Corroborative structured knowledge source     0.55–0.80
Discovery web archive                         0.25–0.55
```

Final observation reliability:

```text
base source reliability
× parser confidence
× identity confidence
× date/freshness confidence
× attribution confidence
```

## Recommended implementation order

```text
Sprint 1  Census + SEC + official company pages
Sprint 2  IRS + OpenAlex + USPTO
Sprint 3  location review + graph snapshot + NWS
Sprint 4  press releases + fund pages + state registries
Sprint 5  university/government/event crawlers
Sprint 6  Wikidata/Common Crawl discovery
Sprint 7  claimed GitHub and optional verified social
```
