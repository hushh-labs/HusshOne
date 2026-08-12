# NWS Logic Specification

## 1. Definition

**NWS = Network Worth Score**, a 0–100 estimate of a verified public professional's capacity to create, access, or route opportunities through a public professional network.

It is deliberately different from financial net worth. The score answers:

- How structurally central is this person in a verified professional graph?
- What authority and responsibility do their current public roles carry?
- What verified outcomes have they produced?
- How much access do they have to company-building, investment, knowledge, or civic networks?
- How current, diverse, and trustworthy is the evidence?
- How relevant is their public professional location to this particular query?

The platform stores two scores:

```text
Global NWS          independent of the searching user
Nearby Rank Score   Global NWS blended with query-local relevance
```

This prevents proximity from changing a person's underlying professional-network score.

## 2. Eligible subjects

A named result must be one of:

```text
PUBLIC_FIGURE
PUBLIC_PROFESSIONAL
OPTED_IN
```

and must have `VERIFIED` identity status.

A non-opt-in location association must normally have two public sources and confidence of at least 0.65. One-time event attendance cannot establish a stable local association.

Eligible public association examples:

- A current official company biography naming the city or office.
- A current organization office plus a verified role whose location is supported separately.
- A government official's public service jurisdiction.
- An opt-in professional profile location.

Ineligible location logic:

- Private home address.
- Property title or assessor record.
- Relative's address.
- Social-media check-in.
- Photo background or EXIF inference.
- One conference visit.

## 3. Professional graph

### 3.1 Nodes

```text
Person
Organization
Public office or agency
Patent
Research work
Open-source project
Event
Award or verified achievement
Place association
```

### 3.2 Edges

```text
FOUNDED
CURRENT_CEO
CURRENT_CXO
BOARD_MEMBER
GENERAL_PARTNER
INVESTOR
PUBLIC_OFFICIAL
NONPROFIT_CHAIR
RESEARCH_LAB_LEAD
INVENTED
COINVENTED_WITH
AUTHORED
COAUTHORED_WITH
MAINTAINS_OPEN_SOURCE
SPOKE_AT
TRUSTED_MEDIA_MENTION
PUBLICLY_ASSOCIATED_WITH_PLACE
```

Each edge has:

```text
base relation weight
source confidence
identity confidence
valid-from / valid-to
observation date
relation-specific half-life
supporting evidence IDs
review state
```

Effective edge weight:

```text
freshness = exp(-ln(2) × age_days / half_life_days)

effective_weight =
    base_relation_weight
  × source_confidence
  × identity_confidence
  × freshness
```

Multiple observations of the same economic or professional relationship are corroboration, not separate edges. A normalized edge hash and supersession chain prevent double counting.


## 3.3 Raw evidence to normalized feature vector

The executable pipeline in `app/feature_engineering.py` applies:

```text
semantic evidence-key deduplication
→ source-quality and relation half-life weighting
→ log1p magnitude transform
→ cohort winsorization
→ global and lane percentiles
→ hierarchical shrinkage for small lanes
→ source-diversity entropy and dominant-source ratio
→ freshness, self-published, and suspicious-pattern ratios
```

`app/observation_projection.py` maps approved observations to bounded professional graph edges and feature signals. Financial amounts, property values, compensation, and follower counts are not converted into personal wealth. Beneficial-ownership filings contribute only a bounded, verified capital-network relationship signal.

## 4. Graph component

The graph job computes:

### Weighted PageRank

Measures authority flowing through verified, weighted relationships. Outbound weights are normalized, so a person or organization cannot create unlimited influence merely by publishing many links.

### K-core percentile

Measures whether the person belongs to a deeply connected, mutually reinforced professional core rather than having only isolated high-profile links.

### Bridging percentile

Measures whether the person connects otherwise separate communities. The implementation uses normalized entropy of neighboring community labels multiplied by a bounded degree factor.

### Cross-sector percentile

Measures verified connections across distinct sectors. It is log-scaled and capped so six sectors are not automatically twice as valuable as three.

```text
graph_authority =
    0.42 × pagerank_percentile
  + 0.23 × kcore_percentile
  + 0.25 × bridging_percentile
  + 0.10 × cross_sector_percentile
```

## 5. Institutional influence

Raw role authority is produced from a versioned role taxonomy. Example starting weights:

```text
Founder / current CEO         1.00 / 0.95
General partner               0.90
Board member                  0.85
Current C-level executive     0.82
Public-agency leader          0.85
Research-lab lead             0.74
Nonprofit chair               0.72
Senior executive              0.68
Advisor                       0.35
One-time speaker              0.18
```

Organization strength is a separate model using public organizational facts such as operating scale, public impact, funding/market scale, research output, patents, and institutional durability. It must not simply inherit the person's score, which would create a circular model.

```text
institutional_influence =
    0.45 × role_authority_percentile
  + 0.35 × institution_strength_percentile
  + 0.20 × founder_board_percentile
```

## 6. Verified track record

Track record is lane-aware. The same evidence should not systematically favor founders over researchers or civic leaders.

Inputs:

```text
outcome_track_record_percentile
knowledge_creation_percentile
civic_leadership_percentile
```

Lane weights:

| Lane | Outcomes | Knowledge | Civic |
|---|---:|---:|---:|
| Builder | 0.60 | 0.25 | 0.15 |
| Capital | 0.65 | 0.15 | 0.20 |
| Knowledge | 0.25 | 0.65 | 0.10 |
| Civic | 0.25 | 0.10 | 0.65 |
| Connector | 0.40 | 0.25 | 0.35 |
| General | 0.45 | 0.30 | 0.25 |

Outcome examples:

- Founded and sustained an organization.
- Publicly documented acquisition, funding, product, or operating milestone.
- Board responsibility.
- Public program delivery.
- Repeated high-quality investment or institution-building record.

Knowledge examples:

- Patents, normalized for field and age.
- Research works and citations, normalized by field and year.
- Open-source maintainership and verified collaboration.
- Public technical standards or recognized expert contribution.

Civic examples:

- Public office or agency leadership.
- Nonprofit chair/trustee responsibility.
- Documented public-interest programs.
- Cross-institution civic collaboration.

Every raw count is log-scaled, winsorized, age-adjusted, source-quality adjusted, and converted to a peer-cohort percentile before scoring.

## 7. Capital access

Capital access is not personal wealth. It measures publicly verified access to company-building or investment networks:

- Founder relationship with funded or operating organizations.
- Current partner or investor role.
- Board and portfolio relationships.
- SEC reporting-owner or director relationship.
- Public financing or capital-allocation responsibility.

A home value, estimated cash balance, luxury purchase, or social-media lifestyle does not contribute.

## 8. Trusted reach

```text
trusted_reach =
    0.85 × trusted_public_reach_percentile
  + 0.15 × verified_social_reach_percentile
```

Trusted reach can include official events, reputable coverage, institutional audiences, and public professional publishing. Verified social reach is capped to 15% of the reach component, which is only 7% of the full NWS. Therefore, social reach can contribute at most 1.05% of the unpenalized total score.

Follower counts are log-scaled, platform-normalized, bot-adjusted, and accepted only from a verified or officially linked public profile.

## 9. Evidence confidence

```text
evidence_confidence =
    0.40 × source_quality
  + 0.25 × source_diversity
  + 0.25 × identity_confidence
  + 0.10 × location_confidence
```

Source diversity is computed using normalized Shannon entropy, not just source count. Ten observations from one press-release mirror do not equal ten independent sources.

Identity confidence uses stable identifiers first:

```text
SEC CIK
IRS EIN-linked officer record
OpenAlex author ID plus institution/work overlap
USPTO inventor disambiguation ID
official profile URL
claimed public account link
```

Name-only joins cannot automatically create a person.

## 10. Global NWS formula

```text
weighted =
    0.30 × graph_authority
  + 0.20 × institutional_influence
  + 0.20 × verified_track_record
  + 0.10 × capital_access
  + 0.07 × trusted_reach
  + 0.05 × freshness
  + 0.08 × evidence_confidence
```

A balance term prevents a one-dimensional profile from winning exclusively through one component:

```text
balance = sqrt(
    max(0.02, graph_authority)
  × max(0.02, max(institutional_influence, verified_track_record))
)

base = 0.88 × weighted + 0.12 × balance
```

Evidence coverage:

```text
coverage = min(1, sqrt(evidence_count / 12))
coverage_multiplier = 0.78 + 0.22 × coverage
```

Anti-gaming penalty:

```text
anti_gaming_penalty = min(
    0.30,
    0.18 × suspicious_pattern_ratio
  + 0.07 × self_published_source_ratio
  + 0.08 × dominant_source_ratio
)
```

Final score:

```text
Global NWS =
    100 × clamp(
      base
      × coverage_multiplier
      × (1 - anti_gaming_penalty),
      0,
      1
    )
```

## 11. Local relevance and Nearby Rank Score

Distance uses the searching point and a **public professional location point or area centroid**, never a private home.

```text
scale_km = max(5, effective_radius_km / 2)

local_relevance =
    location_confidence × exp(-distance_km / scale_km)

Nearby Rank Score =
    0.90 × Global NWS
  + 0.10 × (100 × local_relevance)
```

The UI should display distance as a band where appropriate, for example `within 5 km`, rather than exposing a precise person coordinate.

## 12. Candidate radius expansion

Default search behavior:

```text
initial radius = 20 km
candidate-pool target = max(top_n, ceil(1.6 × top_n))
expand multiplier = 1.75
maximum radius = 100 km
```

Stop when the pool target is reached or maximum radius is reached. If fewer eligible people exist, return fewer. Do not fill the list with unverified profiles.

## 13. Diversification

A pure score sort can return dozens of people from the same company or graph community. The service applies Maximal Marginal Relevance:

```text
MMR =
    0.88 × relevance
  - 0.12 × maximum_similarity_to_selected
```

Similarity:

```text
same organization       0.60
same graph community    0.25
same professional lane  0.15
```

Default caps:

```text
per organization = max(5, ceil(0.08 × top_n))
per community    = max(10, ceil(0.20 × top_n))
```

Caps relax only when they would otherwise shorten the requested list.

## 14. Confidence grade

```text
A   confidence >= 0.85
B   confidence >= 0.70
C   confidence >= 0.55
D   otherwise
```

Confidence is a separate field from NWS. A high preliminary score with weak evidence should never look as certain as a deeply corroborated profile.

## 15. Explainability

Every card returns:

- Global NWS.
- Nearby Rank Score.
- Component scores.
- Evidence confidence grade.
- Public location label and distance/band.
- Top three or four reasons.
- Warnings such as source concentration or limited evidence.
- Model version and as-of date.

Example:

```text
NWS 86 · Confidence A

Why:
- Strong position in the verified professional graph.
- High-authority founder and board roles.
- Strong verified execution record.
- Strong public professional association with Kirkland.

Caution:
- Capital-access evidence is older than the latest role evidence.
```

## 16. Calibration and evaluation

Before production ranking, fit and validate the model on reviewer-created pairwise judgments:

```text
“Which of these two people has stronger public professional opportunity access?”
```

Use stratified pairs across lanes, metros, gender, institution type, and career stage. Do not expose protected attributes to the score. They may be used only in controlled fairness evaluation.

Track:

- Pairwise agreement with expert reviewers.
- NDCG@100 and NDCG@400.
- Rank stability after source refresh.
- Score calibration by confidence grade.
- Organization and community concentration.
- Newcomer coverage.
- Source-family ablation.
- False merge and false location rates.
- Appeal/suppression resolution rate.

A new model version should not replace the existing version unless it passes predetermined stability, quality, and fairness gates.
