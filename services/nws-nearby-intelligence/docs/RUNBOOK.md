# NWS Nearby Operations Runbook

> The public query service uses the national snapshot plus reviewed Kirkland path described in
> `US_NATIONAL_COVERAGE_HANDOFF.md`. Sections below that discuss a completed graph, collector fleet,
> or generalized PostGIS data plane remain roadmap material unless explicitly identified as the
> active NPPES restricted read model.

## 1. Local verification

```bash
python -m pip install -e ".[dev]"
pytest -q
python scripts/nws_demo.py
uvicorn app.main:app --reload --port 8080
```

Expected:

```text
O1 test suite passes (count varies as contracts expand)
health endpoint returns service version 3.0.0
60637 routes nationally, the corrected Kirkland coordinate uses its reviewed release, and an
explicit India coordinate returns an empty NOT_COVERED state
```

## 2. Local infrastructure

```bash
docker compose up -d
```

Components:

```text
PostgreSQL/PostGIS  canonical state and geospatial index
Redpanda            work/change events
MinIO               development immutable raw zone
FastAPI             logic and query API
```

The local compose uses development credentials and single-node services. Do not promote it unchanged.

## 3. Production bootstrap order

```text
1. Provision KMS keys and workload identities.
2. Provision object storage with versioning/object lock.
3. Provision PostgreSQL/PostGIS and apply schema.
4. Provision Redpanda/Kafka.
5. Load source registry.
6. Load Census postal centroids and boundaries.
7. Deploy collectors and parsers disabled.
8. Enable one source at a time.
9. Backfill canonical entities/edges.
10. Run identity and location review.
11. Build first graph snapshot.
12. Build NWS feature and score snapshots.
13. Warm geospatial/query caches.
14. Enable query API.
```

## 4. Source onboarding checklist

Before enabling a source:

- Source owner and authority documented.
- Public/bulk acquisition path documented.
- User-agent and rate policy configured.
- Allowed and forbidden facts declared.
- Parser fixtures added.
- Schema-drift behavior tested.
- Artifact-size and decompression limits set.
- Identity matching features documented.
- Source reliability baseline approved.
- Retention and refresh cadence configured.
- Kill switch tested.

## 5. Collector operation

### Healthy flow

```text
job leased
→ fetch begins
→ manifest written
→ artifact hashed and stored
→ source_artifact row committed
→ SOURCE_ARTIFACT_VERIFIED emitted
→ parser consumes
```

### Retry policy

```text
HTTP 408/429/5xx    exponential backoff with jitter
DNS/network         bounded retry
HTTP 404/410        mark missing; do not retry aggressively
robots denied       permanent skip until contract review
unexpected type     quarantine
hash mismatch       fail and alert
oversize artifact   fail and alert
```

Do not respond to blocks by adding stealth proxies or bypass logic. Pause the source and use an approved bulk or alternate official route.

## 6. Parser operation

### Parse lifecycle

```text
PENDING
RUNNING
PARSED
QUARANTINED
FAILED
SUPERSEDED
```

### Schema drift

Trigger alert when:

- Required fields disappear.
- Record count changes beyond source-specific bounds.
- Null rates spike.
- Unknown enum/relationship values appear.
- XML/JSON namespace changes.
- Main-text extraction falls sharply.

Quarantine artifacts rather than emitting low-confidence mass observations.

## 7. Entity-resolution queue

Review priority:

```text
P0  conflicting stable identifiers on published profile
P1  ambiguous merge affecting top 400 in active market
P2  new public profile with high preliminary score
P3  low-score or inactive profile
```

Reviewer sees:

- Original names/aliases.
- Stable identifiers.
- Organization/role overlap.
- Timeline.
- Coauthor/coinventor overlap.
- Source artifacts.
- Match explanation.

Reviewer actions:

```text
MATCH
NO_MATCH
MERGE_WITH_DIFFERENT_SUBJECT
CREATE_NEW_SUBJECT
REQUEST_MORE_EVIDENCE
```

## 8. Public-location review

Approve only when:

- Identity is verified.
- Association is professional/public/opt-in.
- Source is current enough.
- Confidence is at least 0.65.
- A non-opt-in association normally has two sources.
- It is not based only on an event.
- Output label is city/postal/metro appropriate.

Changes create a superseding location row and invalidate geographic caches.

## 9. Graph snapshot run

### Inputs

- Approved canonical identities.
- Approved active professional edges.
- Approved organizations.
- Edge relation weights and half-lives.
- Source and identity confidence.
- Snapshot date.

### Job

```text
freeze input snapshot hash
→ export active edges to Parquet
→ compute weighted PageRank
→ compute k-core
→ compute communities
→ compute bridging/cross-sector
→ validate metrics
→ load graph_person_metric
→ mark graph snapshot complete
```

### Validation

- PageRank sum approximately 1.
- Node/edge counts within expected range.
- No source family causes unexplained large centrality jump.
- Top-rank churn reviewed.
- Community count and size distribution plausible.
- Published subjects have complete graph metrics or explicit missingness.

## 10. NWS recomputation

Run after a graph snapshot or material feature changes.

```text
build lane cohorts
→ transform/winsorize raw features
→ compute peer percentiles
→ build NwsFeatureVector
→ calculate components
→ apply coverage and anti-gaming
→ calculate confidence and reasons
→ write nws_score_snapshot as OPEN
→ automated validation
→ review/approve publication
```

### Automated validation

- Score in 0–100.
- Components in 0–1.
- Social-only ablation cannot create high score.
- Evidence count and source diversity present.
- No suppressed profile marked publishable.
- Identity and location remain verified.
- Explanation reasons map to stored features/evidence.

## 11. Query service SLOs

Suggested initial SLO:

```text
Availability                         99.9%
P50 ZIP query                        < 150 ms cached, < 400 ms uncached
P95 ZIP/current-location query       < 800 ms
P99                                  < 1.5 s
Error rate                           < 0.5%
Stale score snapshot                 < 24 h target
Suppression propagation              < 15 min
```

A 400-result response should use pagination or compressed response fields rather than an oversized single payload on mobile.

## 12. Query-cache invalidation

Invalidate by:

```text
coarse location cell
postal code
model version
score snapshot date
profile subject ID
location association ID
suppression event
```

A suppression event must evict the person from all cached result sets immediately.

## 13. Incident: wrong person merge

1. Suppress affected profile from publication.
2. Freeze related score/location snapshots.
3. Split canonical entity.
4. Reassign observations and edges.
5. Recompute affected graph/feature scores.
6. Invalidate caches.
7. Record root cause and parser/matcher change.
8. Sample similar matches for regression.

## 14. Incident: wrong local association

1. Suppress location association.
2. Invalidate geographic caches.
3. Review evidence and office-role inference.
4. Restore previous valid association or remove.
5. Re-run nearby query regression for affected ZIP/cell.

Global NWS does not need recomputation unless role evidence also changed.

## 15. Incident: source poisoning or promotional ring

1. Disable source or domain partition.
2. Mark observations under investigation.
3. Rebuild features excluding source.
4. Compare rank deltas.
5. Add duplicate-content/ring rule.
6. Re-review materially affected top profiles.
7. Publish new model/source snapshot.

## 16. Incident: leaked precise user location in logs

1. Restrict log access and stop affected pipeline.
2. Delete/expire records according to incident process.
3. Rotate logging configuration and deploy quantization fix.
4. Audit downstream copies and analytics exports.
5. Verify raw coordinates are absent from request tracing.
6. Add regression test and detection alert.

## 17. Backup and recovery

### PostgreSQL

- Continuous WAL archive.
- Daily full backup.
- Point-in-time recovery test monthly.
- Separate backup encryption key.

### Object storage

- Versioning and object lock.
- Cross-region replication.
- Hash verification sampling.

### Event broker

- Replication factor 3.
- Topic retention based on replay window.
- Canonical state remains PostgreSQL/object store, so broker loss does not destroy lineage.

## 18. Observability

Metrics:

```text
collector requests/status/bytes/latency
source rate-limit waits
artifact duplicates
parser success/quarantine/schema drift
observation volume by fact type
entity-match distribution and review SLA
location approval/rejection rate
edge count by relation/source
PageRank and community distribution
NWS distribution by lane/market
rank churn
query latency/cache hit/expansion rate
results per organization/community
suppression propagation time
```

Logs contain IDs and hashes, not private contact data or precise user coordinates.

## 19. Deployment

- Pin container images by digest.
- Run database migrations separately.
- Deploy read-compatible code before writing new schema fields.
- Canary query workers by market/ZIP cohort.
- Compare old/new result overlap and score deltas.
- Promote model version independently from application code.
- Keep rollback snapshot and cache namespace.

## 20. Daily operator checklist

```text
[ ] Source jobs within freshness SLA
[ ] No parser schema-drift alert
[ ] Entity/location review queue within SLA
[ ] Latest graph and NWS snapshots complete
[ ] Query latency and error SLO healthy
[ ] Rank-churn dashboard reviewed
[ ] Source concentration alerts reviewed
[ ] Suppression queue empty or within SLA
[ ] Object-store and DB backups healthy
```
