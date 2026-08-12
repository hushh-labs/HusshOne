# NWS Nearby Intelligence — Complete Architecture

## 1. Product definition

### User story

A user either:

1. Enters a postal code plus country, or
2. Grants location permission and sends a coarse coordinate.

The service first returns explicit market coverage. Only a `COVERED` location can return nearby
**verified public or opted-in professionals**, ordered by a query-specific Nearby Rank Score and
accompanied by a stable Global Network Worth Score (NWS), confidence, public professional location,
and explanation. Valid but non-covered and unresolvable locations return an empty result set; they
are never redirected to the Kirkland bootstrap market.

### What “nearby” means

Nearby means **publicly associated with the area through a professional, institutional, civic, or opt-in location**. It does not mean the platform has found the person's home.

### What NWS means

NWS estimates public professional opportunity access through:

- Graph authority.
- Institutional influence.
- Verified track record.
- Capital-access relationships.
- Trusted public reach.
- Freshness and evidence confidence.

It does not estimate a person's bank balance, property equity, private debt, family wealth, or complete financial net worth.

## 2. User experience

### Search input

```text
[ Use my location ]
        or
[ Country ] [ Postal code ] [ Search ]

Show: 100 / 200 / 300 / 400
Radius: Automatic / 10 / 25 / 50 / 100 km
Focus: All / Builders / Capital / Knowledge / Civic / Connectors
```

### Result card

```text
#12  Jordan Example                         NWS 87  A
Founder & board member · Example Systems
Public professional association: Kirkland, WA · within 5 km

Strong graph authority · Verified outcomes · Cross-sector bridge

Global NWS          87
Nearby Rank Score   90

[ View public profile ] [ Why this rank? ]
```

The card does not show a home address, private email, phone, family, or exact person coordinate.

### Result-detail explanation

```text
Graph authority              91
Institutional influence      86
Verified track record        89
Capital access               81
Trusted reach                63
Freshness                    92
Evidence confidence          90

Primary sources
- Current official company biography
- Public filing relationship
- Patent/publication records
- Public board appointment
```

## 3. System diagram

```text
                   PUBLIC / BULK SOURCES
  SEC · IRS · USPTO · OpenAlex · Census · official sites · dumps
                              │
                              ▼
              Source Registry + Crawl Scheduler
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
          Bulk collectors            Public-page collectors
                 │                         │
                 └────────────┬────────────┘
                              ▼
              Immutable content-addressed raw zone
             artifact + headers + hash + fetch manifest
                              │
                              ▼
              Parser registry and observation stream
                              │
       ┌──────────────────────┼───────────────────────┐
       ▼                      ▼                       ▼
 Identity observations   Professional relations   Public locations
       │                      │                       │
       └───────────────┬──────┴───────────────┬──────┘
                       ▼                      ▼
              Entity resolution        Location verification
                       │                      │
                       └──────────┬───────────┘
                                  ▼
                     Canonical professional graph
                                  │
                                  ▼
                     Graph snapshot computation
              PageRank · k-core · community · bridging
                                  │
                                  ▼
                       Feature snapshot builder
                                  │
                                  ▼
                          Global NWS engine
                                  │
             ┌────────────────────┴────────────────────┐
             ▼                                         ▼
    PostGIS candidate index                    Review / suppression
             │                                         │
             └────────────────────┬────────────────────┘
                                  ▼
                         Nearby query service
          radius expansion · local relevance · diversity · explain
                                  │
                                  ▼
                          Public-safe response
```


## 3.1 Executable service boundary

The public request contains no people:

```text
ZIP/coarse coordinate + count + radius + filters
→ CandidateRepository
→ approved PostGIS candidate pool
→ confidence-aware nearby ranking
→ public-safe cards
```

`app/candidate_repository.py` contains an in-memory synthetic repository and a reference PostGIS
query. The deployed `app/main.py` exposes only the location-only public endpoint; scoring-preview
and legacy routes are intentionally absent. See `docs/IMPLEMENTATION_STATUS.md` for the exact line
between the deployed bootstrap and source-specific production adapters.

## 4. Data zones

### Zone 0 — source contracts

Machine-readable configuration defines:

- Authority.
- Acquisition mode.
- Trust tier.
- Rate limit.
- Allowed fact types.
- Forbidden fact types.
- Relation weights.
- Half-lives.
- Parser schema.

A scraper cannot invent its own downstream uses.

### Zone 1 — acquisition manifests

Every fetch writes a manifest before parsing:

```json
{
  "source_id": "uspto_patentsview_bulk",
  "requested_uri": "...",
  "final_uri": "...",
  "retrieved_at": "2026-08-12T00:00:00Z",
  "status_code": 200,
  "content_type": "application/zip",
  "content_length": 123456789,
  "etag": "...",
  "last_modified": "...",
  "sha256": "...",
  "fetcher_version": "patents-fetch-v2.1.0"
}
```

### Zone 2 — immutable raw artifacts

Object key:

```text
raw/{source_id}/{sha256[0:2]}/{sha256}/artifact.bin
```

Properties:

- Write once.
- Content addressed.
- Object lock in production.
- No analyst UI access.
- Malware and decompression-bomb checks.
- Separate encryption key.
- Source-specific retention.

### Zone 3 — parsed observations

A parser produces observations, not final facts:

```json
{
  "observation_id": "obs_...",
  "source_id": "official_company_pages",
  "artifact_sha256": "...",
  "parser_version": "company-bio-v4.2.0",
  "fact_type": "CURRENT_EXECUTIVE_ROLE",
  "subject_external_id": "official-page/person/jordan-example",
  "object_external_id": "domain/example.com",
  "confidence": 0.93,
  "occurred_on": "2026-08-01",
  "attributes": {
    "title": "Chief Technology Officer",
    "office_label": "Kirkland, Washington"
  }
}
```

### Zone 4 — canonical graph

Entity-reviewed people, organizations, roles, locations, achievements, identifiers, and graph edges.

### Zone 5 — model snapshots

- Organization metrics.
- Graph metrics.
- Lane-normalized feature vectors.
- Global NWS.
- Confidence.
- Explanation material.

### Zone 6 — query products

Public-safe result cards and query audit. Raw device coordinates are not persisted; the audit stores a postal code or coarse location cell.

## 5. Acquisition and scraper architecture

### Scheduler

The scheduler reads `config/sources.yaml` and creates idempotent jobs:

```text
source_id
partition
expected_version
not_before
attempt
priority
lease_owner
lease_expiry
```

Use a relational job table for control and Redpanda/Kafka for work distribution.

### Collector worker contract

```text
Discover artifact
→ Check source contract
→ Rate-limit globally by source/host
→ Fetch with declared identity
→ Compute SHA-256 while streaming
→ Validate size/content type
→ Store immutable artifact
→ Emit SOURCE_ARTIFACT_VERIFIED
```

Public-page collectors do not contain proxy rotation, CAPTCHA solving, authentication bypass, or private-session reuse.

### Parser worker contract

```text
Read immutable artifact
→ Select parser by source + content signature
→ Parse into versioned observations
→ Validate against observation schema
→ Apply source allowed/forbidden fact policy
→ Write normalized observations
→ Emit OBSERVATION_CREATED
```

### Crawl prioritization

Do not crawl the entire web. Start from trusted seeds:

1. Government and official bulk sources.
2. Canonical organization domains.
3. Official biography and leadership pages.
4. Official press-release feeds.
5. Public event and institution pages.
6. Common Crawl or Wikidata only to discover candidates for primary-source verification.

### Change detection

Use:

- ETag and Last-Modified where reliable.
- Content hash.
- DOM/main-text hash.
- Structured-data hash.
- Link-set hash.

When only navigation or cookie text changes, avoid unnecessary entity recomputation.

## 6. Identity resolution

### Canonical identifiers

Preferred anchors:

- SEC reporting-owner CIK.
- Official profile URL.
- Organization-domain identity.
- OpenAlex author ID with institution and work overlap.
- USPTO/PatentsView inventor identifier.
- ORCID where publicly and officially linked.
- IRS officer record connected to EIN.
- Claimed public GitHub or social profile linked from an official domain.

### Candidate generation

Generate candidates only through one or more contextual anchors:

```text
stable identifier
same organization + overlapping role period
same official website
same publication/patent + matching institution
same board/company context
```

Do not compare every similar name globally.

### Match score

A production model can use gradient-boosted pair classification, but its features must remain explainable:

```text
stable_identifier_exact
normalized_name_similarity
middle-name consistency
organization overlap
role overlap
date overlap
coauthor/coinventor overlap
official URL overlap
city consistency
conflicting identifier flags
```

Hard rules:

- Name-only match is never automatic.
- Conflicting stable identifiers prevent an automatic merge.
- Ambiguous matches create a review task.
- Merges are reversible.
- Every canonical fact preserves source observations.

## 7. Organization model

A person's institutional component requires an independent organization score.

### Organization dimensions

```text
Operating scale
Public or market impact
Funding / capital scale
Knowledge output
Patent output
Government authority
Nonprofit program scale
Durability and age
Network centrality
```

Normalize by organization type and sector. A university, startup, city agency, nonprofit, and public company should not be judged on one raw revenue scale.

### Avoid circularity

Do not define organization strength as the sum of its people's NWS and then use organization strength to score those same people in the same model iteration.

Safe sequence:

1. Build independent organization priors from public organization facts.
2. Compute graph metrics.
3. Compute person NWS.
4. Optionally use lagged person aggregate as a small organization feature in the next model version, never the same snapshot.

## 8. Public location logic

### Location association records

```text
subject_id
association_kind
label
public point or public area
confidence
source_count
valid_from / valid_to
as_of_date
review state
publication_allowed
```

Association kinds:

```text
SELF_PUBLISHED_PROFESSIONAL
OFFICIAL_BIO
CURRENT_ORGANIZATION_OFFICE
PUBLIC_SERVICE_JURISDICTION
OPT_IN_LOCATION
EVENT_ONLY
```

`EVENT_ONLY` can support topic relevance but not stable nearby eligibility.

### Office-role inference

An organization office alone is not enough to place every global employee there.

For `CURRENT_ORGANIZATION_OFFICE`, require supporting evidence such as:

- Bio names that office/city.
- Role is explicitly regional.
- Public team page groups the person under the office.
- Multiple independent current sources agree.

Otherwise store it as a weak discovery hypothesis, not a publishable association.

### User location

Client behavior:

```text
GPS permission
→ derive coarse cell on device where practical
→ send coordinate only for live query
→ server quantizes before audit
→ raw coordinate removed after response/cache TTL
```

ZIP behavior:

```text
ZIP string
→ normalize
→ resolve against loaded postal/ZCTA crosswalk
→ use representative point and polygon
→ search public professional associations
```

The deployed bootstrap includes one approved ZIP centroid. National Gazetteer and TIGER/ZCTA
ingestion is future data-plane work; do not treat this architecture diagram as evidence that it is
live today.

## 9. Graph computation

### Edge weighting

```text
effective_weight =
    relation_base_weight
  × source_reliability
  × observation_confidence
  × identity_confidence
  × freshness
  × corroboration_adjustment
```

Corroboration adjustment is bounded. Five mirrors of the same press release do not multiply edge weight five times.

### Directed heterogeneous PageRank

- Person-to-organization role edges.
- Organization-to-person authority acknowledgment edges where justified.
- Person-to-person collaboration edges.
- Person-to-output and output-to-institution edges.
- Relation-specific transition normalization.
- Caps on repeated same-pair edges.

### K-core

Use a simplified undirected projection of high-confidence professional edges. Exclude low-weight mentions and one-time events.

### Communities

Production options:

- Leiden on weighted projection.
- Louvain for simpler deployments.
- Label propagation for incremental approximation.

Store community IDs only as model artifacts; they are not identity attributes.

### Bridging

Use cross-community neighbor entropy and, at larger scale, sampled approximate betweenness. The reference implementation provides an entropy-based bridge signal that is fast and deterministic.

### Computation topology

For regional or national graphs:

```text
Object-store Parquet edges
→ Spark / Ray / Rust GraphBLAS batch job
→ graph_snapshot
→ PostgreSQL metric load
```

For a small launch, the supplied pure-Python implementation is sufficient for validation but not for hundreds of millions of edges.

## 10. Feature engineering

### Raw count processing

For counts such as patents, publications, citations, boards, or verified mentions:

```text
1. Deduplicate.
2. Apply source and identity confidence.
3. Apply event-type age decay.
4. log1p transform.
5. Winsorize within peer cohort.
6. Normalize to percentile.
7. Attach missingness and coverage metadata.
```

### Peer cohorts

At minimum:

```text
professional lane
career stage
country/market
sector
organization type
```

Use hierarchical shrinkage when a cohort is small:

```text
cohort_percentile_weighted =
    n/(n+k) × narrow_cohort_percentile
  + k/(n+k) × broad_cohort_percentile
```

### Freshness

Freshness is a quality signal, not a reward for posting constantly. Use current roles and current evidence; do not let frequent social activity dominate.

## 11. NWS scoring

The exact v2 formula is documented in `docs/NWS_LOGIC.md` and implemented in `app/nws.py`.

Primary components:

```text
30% graph authority
20% institutional influence
20% verified track record
10% capital access
 7% trusted reach
 5% freshness
 8% evidence confidence
```

The engine adds a balance term, evidence-coverage multiplier, and anti-gaming penalty.

## 12. Nearby query path

### Synchronous request path

```text
1. Authenticate and authorize product request.
2. Resolve ZIP or quantize current location.
3. Select initial radius.
4. PostGIS query approved public location associations.
5. Join current approved Global NWS snapshots.
6. If pool is too small, expand radius geometrically.
7. Calculate local relevance and Nearby Rank Score.
8. Apply filters and lane preference.
9. Apply organization/community diversification.
10. Generate explanations from stored component/evidence summaries.
11. Return public-safe cards.
12. Write coarse query/result audit asynchronously through outbox.
```

### PostGIS candidate query

Use `ST_DWithin` on geography with a GiST index. Retrieve approximately `1.6 × top_n` candidates before diversification, with a higher multiplier for lane filters or sparse areas.

### Cache key

```text
coarse_query_cell
radius_bucket
requested_count
lane_filter
model_version
source_snapshot_date
```

Cache IDs and scores, not raw user coordinates.

### Pagination

For 100–400 results, prefer stable cursor pagination:

```text
model_version
query_fingerprint
rank_score
person_id
```

Do not use offset alone because a score refresh can produce duplicates or skipped records.

## 13. Explainability service

Precompute explanation candidates during scoring:

```text
component name
strength
supporting evidence family
freshness
confidence
public-safe sentence template
```

At request time, select:

- Top 3 component reasons.
- One local-relevance reason if material.
- Up to 3 warnings.

Avoid generated claims that are not directly mapped to stored evidence.

## 14. Anti-gaming

### Source concentration

Compute the Herfindahl index or dominant-source ratio across evidence families. Penalize profiles built almost entirely from one self-controlled domain.

### Reciprocal-ring detection

Flag:

- Dense reciprocal low-quality links.
- Repeated co-mentions with identical text.
- Sudden collaboration bursts without independent outputs.
- Synthetic event/podcast networks.
- High follower growth with low trusted engagement.

### Promotion versus evidence

Self-published claims can create review candidates. They should not automatically create high-magnitude achievements.

### Duplicate content

Use SimHash/MinHash for press release and biography mirrors. Corroboration requires source independence.

## 15. Event streaming

Topics:

```text
source.artifact.discovered
source.artifact.verified
source.parse.completed
observation.created
entity.match.proposed
entity.match.approved
public.location.changed
professional.edge.changed
graph.snapshot.requested
graph.snapshot.completed
nws.recompute.requested
nws.score.completed
profile.review.required
profile.suppressed
nearby.query.executed
```

Partition keys:

```text
Source artifacts       source_id + source partition
Person observations    canonical or external person ID
Graph edges            source node ID
NWS recomputation      subject ID
Location changes       subject ID
```

### Transactional outbox

Every canonical mutation and event write happen in one PostgreSQL transaction. The outbox publisher provides at-least-once delivery; downstream consumers are idempotent through event and snapshot hashes.

## 16. Incremental recomputation

### Role change

```text
new official appointment
→ observation
→ entity link
→ supersede old role edge
→ update location if supported
→ enqueue subject NWS recompute
→ mark graph snapshot dirty
```

### New patent or publication

```text
bulk release
→ parse inventor/author relation
→ resolve identity
→ update achievement and collaboration edges
→ incremental features immediately
→ full graph metrics on scheduled snapshot
```

### Location change

```text
new verified public professional location
→ review
→ supersede old association
→ invalidate affected geographic caches
→ no need to recompute Global NWS
```

### Graph rebuild

Run a full graph snapshot nightly or weekly depending scale. Use incremental approximate metrics during the day, but publish the model version and snapshot timestamp.

## 17. Storage

### PostgreSQL/PostGIS

System of record for:

- Canonical people and organizations.
- Identities and roles.
- Approved public locations.
- Evidence and reviews.
- Professional edges.
- Graph and feature snapshots.
- NWS snapshots.
- Query audit and suppression.

### Object storage

- Immutable source artifacts.
- Parquet observations and graph edges.
- Model training sets.
- Snapshot exports.
- Reproducibility bundles.

### Redpanda/Kafka

- Work queues.
- Change events.
- Incremental feature triggers.

### ClickHouse, optional

- Large event analytics.
- Source coverage monitoring.
- Rank and query telemetry.
- Model diagnostics.

Do not make ClickHouse or Redis the canonical system of record.

## 18. Infrastructure topology

### Development

```text
1 PostgreSQL/PostGIS
1 Redpanda node
1 MinIO node
1 FastAPI service
Python batch graph job
```

### Regional production

```text
3 PostgreSQL nodes with automated failover
3 Redpanda brokers
4+ object-storage nodes or managed S3-compatible storage
2 API gateway nodes
4–20 query workers
4–20 parser workers
2 entity-resolution workers
scheduled graph compute pool
observability stack
```

### National production

```text
Regional query replicas
Central canonical write region
CDC to read replicas
Object-store lakehouse tables
Spark/Ray/GraphBLAS graph cluster
Autoscaled stateless API workers
Dedicated review and data-quality service
```

### Capacity example

For 10 million public professional profiles and 300 million graph edges:

- Keep current public location and score indexes in PostgreSQL.
- Keep full edge history in object-store Parquet.
- Load only active/high-confidence edge projection for online joins.
- Compute graph snapshots in distributed batch.
- Cache popular ZIP/radius combinations.

## 19. Security

### Roles

```text
source_fetcher
parser
entity_resolver
model_worker
analyst
reviewer
publisher
auditor
break_glass_admin
```

### Controls

- Workload identity; no shared API credentials.
- Mutual TLS service-to-service.
- Source-host egress allowlists.
- KMS-managed keys.
- Separate raw-zone and analytical-zone roles.
- Immutable audit events.
- Export quotas and purpose codes.
- Suppression and correction workflow.
- No personal contact or exact private location in search index.
- Secret scanning and dependency pinning.

### User-location handling

- TLS in transit.
- Short in-memory lifetime.
- Quantization before logging/audit.
- No raw GPS in analytics.
- Explicit permission and revocation behavior.

## 20. Model governance

Every release stores:

```text
model version
feature schema version
source snapshot hashes
graph snapshot ID
normalization cohort definitions
relation weights and half-lives
training/reviewer dataset version
calibration metrics
fairness evaluation
approval record
```

### Model change gates

- Pairwise reviewer quality improves or remains within tolerance.
- Rank churn is explainable.
- No large unexplained source/sector bias.
- False identity/location rates below threshold.
- Score distribution remains calibrated.
- Explanations match supporting evidence.

### Appeals and corrections

A verified professional can request:

- Identity correction.
- Role correction.
- Location correction.
- Profile suppression where program rules permit.
- Re-review of source evidence.

Corrections supersede data; they do not erase audit history.

## 21. Rollout plan

### Phase 1 — Kirkland/98033 pilot

- Load national ZIP/ZCTA lookup but index only Seattle metro profiles.
- Implement SEC, IRS, USPTO, OpenAlex, official organization pages, and official bios.
- Human-review top 1,000 candidates.
- Launch top 100 and top 200.

### Phase 2 — Seattle metro

- Add state registries, public events, press releases, research institutions, and GitHub claimed profiles.
- Add top 300/400, lane filters, and better community diversification.
- Train pairwise calibration model.

### Phase 3 — national

- Distributed graph computation.
- National geospatial index.
- Continuous source freshness and suppression operations.
- Per-market calibration and quality dashboards.

## 22. Acceptance criteria

A production launch is ready when:

- A ZIP or current-location request returns deterministic, paginated results.
- Every result is a verified public/opted-in professional.
- Every location is a reviewed public professional association.
- Every NWS has component evidence, confidence, and model version.
- Social reach cannot materially dominate the score.
- A single organization cannot monopolize the result list when alternatives exist.
- Sparse areas return fewer results or expand radius rather than lowering eligibility.
- Raw user coordinates are absent from durable logs.
- 100% of result cards can be traced to source artifacts and parser versions.
- Suppression and correction requests are enforceable across cache, index, and API.
