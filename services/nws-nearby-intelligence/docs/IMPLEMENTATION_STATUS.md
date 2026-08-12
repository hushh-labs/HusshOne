# Implementation Status

> **Deployed release boundary:** the public Cloud Run service exposes only `GET /health`,
> `GET /ready`, and authenticated `POST /v2/nearby-network/discover`. It uses the 11-record
> `VERIFIED_PUBLIC_BOOTSTRAP` market, explicit coverage states, coarse coordinate handling, and
> server-held API-key protection. The reference modules listed below are source and roadmap
> material; no legacy `/v1/*`, `/internal/*`, synthetic-demo, or PostGIS route is internet-exposed.

## Executable in this repository

### Query and ranking

- Public location-only endpoint: `/v2/nearby-network/discover`.
- Country-qualified postal and coordinate request validation.
- Coordinate coarsening and coverage-first market selection.
- `COVERED`, `NOT_COVERED`, and `LOCATION_UNRESOLVED` response states with no fallback people.
- In-memory demo and PostGIS repository implementations.
- Public-profile and public-location policy gates.
- Confidence-aware radius expansion.
- Global NWS, local relevance, and Nearby Rank Score.
- Lane-aware track-record scoring.
- MMR diversification.
- Public-safe result serialization.

### Graph and score logic

- Weighted PageRank.
- K-core.
- Community-neighbor entropy bridge score.
- Cross-sector signal.
- Role/institution/track/capital/reach/evidence components.
- Evidence deduplication, age decay, log scaling, winsorization, lane/global percentile shrinkage, and source-diversity metrics.
- Observation-to-graph/feature projection with a versioned role taxonomy.
- Evidence coverage multiplier.
- Source-concentration and suspicious-pattern penalties.
- Confidence grades, reasons, and warnings.

### Acquisition primitives

- Source contract data model.
- YAML source-registry loader.
- Robots-aware and rate-limited public fetcher.
- SHA-256 content-addressed artifact store.
- Deterministic observation IDs.
- Parser registry.
- Observation policy gate.
- Official JSON-LD reference parser.
- SEC Form 4 XML reference parser.

### Persistence and operations

- PostgreSQL/PostGIS schema.
- Professional graph, location, feature, score, query-audit, and suppression tables.
- Redpanda/Kafka event taxonomy and transactional-outbox schema.
- Docker Compose development environment.
- Source onboarding, graph rebuild, scoring, and incident runbook.
- Synthetic 520-person demo dataset.
- Automated tests.

## Defined by contract but requiring production adapters or infrastructure

- National Census Gazetteer/TIGER ingestion job.
- Full SEC daily-index/archive downloader and amendment reconciliation.
- IRS 990 XML parser family.
- USPTO PatentsView bulk-table parser.
- OpenAlex snapshot/Parquet parser and author disambiguation pipeline.
- Wikidata/Common Crawl discovery workers.
- State-by-state corporation-registry adapters.
- Organization-domain crawler discovery and sitemap scheduling.
- GitHub public-profile/repository adapter.
- Optional bounded verified-social adapter.
- Large-scale Leiden/Louvain graph computation.
- Redis/query cache and signed cursor service.
- Analyst review UI, appeals, suppression UI, and model-promotion workflow.
- National postal geography, country-specific coverage geometry, and approved market datasets.
- Full PostGIS retrieval, production collectors/workers, caches, cursor pagination, WAF quotas,
  monitoring, and analyst review UI.

Those adapters share the same immutable-artifact, parser, observation-policy, identity-resolution, evidence, and graph contracts. A new scraper cannot directly change NWS.
