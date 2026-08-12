CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE subject_type AS ENUM ('PUBLIC_FIGURE', 'ANONYMOUS_ASSET_CLUSTER');
CREATE TYPE verification_status AS ENUM ('VERIFIED', 'PENDING_REVIEW', 'REJECTED');
CREATE TYPE review_status AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'SUPERSEDED');

CREATE TABLE source_registry (
    source_id              text PRIMARY KEY,
    authority              text NOT NULL,
    acquisition_mode       text NOT NULL,
    allowed_uses           text[] NOT NULL,
    forbidden_uses         text[] NOT NULL DEFAULT '{}',
    cadence                text NOT NULL,
    enabled                boolean NOT NULL DEFAULT true,
    config                 jsonb NOT NULL DEFAULT '{}',
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_artifact (
    artifact_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id              text NOT NULL REFERENCES source_registry(source_id),
    source_uri             text NOT NULL,
    source_version         text,
    source_date            date,
    retrieved_at           timestamptz NOT NULL,
    sha256                 char(64) NOT NULL,
    byte_size              bigint NOT NULL CHECK (byte_size >= 0),
    object_store_key       text NOT NULL,
    content_type           text,
    parser_version         text,
    parse_status           text NOT NULL DEFAULT 'PENDING',
    UNIQUE (source_id, sha256)
);

CREATE TABLE subject (
    subject_id             text PRIMARY KEY,
    type                   subject_type NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    retired_at             timestamptz
);

CREATE TABLE public_person (
    subject_id             text PRIMARY KEY REFERENCES subject(subject_id),
    display_name           text NOT NULL,
    verification           verification_status NOT NULL DEFAULT 'PENDING_REVIEW',
    public_figure_reason   text NOT NULL,
    city_affiliation       text,
    state_affiliation      text,
    affiliation_confidence numeric(5,4) CHECK (affiliation_confidence BETWEEN 0 AND 1),
    publication_allowed    boolean NOT NULL DEFAULT false,
    CHECK (city_affiliation IS NULL OR city_affiliation <> ''),
    CHECK (state_affiliation IS NULL OR length(state_affiliation) = 2)
);

CREATE TABLE anonymous_asset_cluster (
    subject_id             text PRIMARY KEY REFERENCES subject(subject_id),
    anonymous_id           text NOT NULL UNIQUE CHECK (anonymous_id LIKE 'KIR-98033-%'),
    parcel_token_set       text[] NOT NULL,
    centroid               geometry(Point, 4326),
    internal_geo_precision text NOT NULL DEFAULT 'PARCEL',
    publish_geo_precision  text NOT NULL DEFAULT 'CLUSTER',
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE person_alias (
    alias_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id             text NOT NULL REFERENCES public_person(subject_id),
    alias_normalized       text NOT NULL,
    source_artifact_id     uuid REFERENCES source_artifact(artifact_id),
    UNIQUE (subject_id, alias_normalized)
);

CREATE TABLE organization (
    organization_id        text PRIMARY KEY,
    legal_name             text NOT NULL,
    cik                    text,
    ein_token              text,
    organization_type      text,
    UNIQUE NULLS NOT DISTINCT (cik)
);

CREATE TABLE public_role (
    role_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id             text NOT NULL REFERENCES public_person(subject_id),
    organization_id        text NOT NULL REFERENCES organization(organization_id),
    title                  text NOT NULL,
    start_date             date,
    end_date               date,
    evidence_artifact_id   uuid NOT NULL REFERENCES source_artifact(artifact_id)
);

CREATE TABLE evidence (
    evidence_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id             text NOT NULL REFERENCES subject(subject_id),
    artifact_id            uuid NOT NULL REFERENCES source_artifact(artifact_id),
    evidence_kind          text NOT NULL,
    allowed_uses           text[] NOT NULL,
    source_authority       text NOT NULL,
    source_date            date NOT NULL,
    reliability            numeric(5,4) NOT NULL CHECK (reliability BETWEEN 0 AND 1),
    facts                  jsonb NOT NULL,
    normalized_fact_hash   char(64) NOT NULL,
    supersedes_evidence_id uuid REFERENCES evidence(evidence_id),
    review                 review_status NOT NULL DEFAULT 'OPEN',
    created_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (subject_id, normalized_fact_hash)
);

CREATE TABLE estimate_component (
    component_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id             text NOT NULL REFERENCES public_person(subject_id),
    category               text NOT NULL,
    low_usd                numeric NOT NULL CHECK (low_usd >= 0),
    mode_usd               numeric NOT NULL CHECK (mode_usd >= low_usd),
    high_usd               numeric NOT NULL CHECK (high_usd >= mode_usd),
    quality_score          numeric(5,4) NOT NULL CHECK (quality_score BETWEEN 0 AND 1),
    as_of_date             date NOT NULL,
    double_count_group     text,
    model_version          text NOT NULL,
    status                 review_status NOT NULL DEFAULT 'OPEN',
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE component_evidence (
    component_id           uuid NOT NULL REFERENCES estimate_component(component_id),
    evidence_id            uuid NOT NULL REFERENCES evidence(evidence_id),
    PRIMARY KEY (component_id, evidence_id)
);

CREATE TABLE anonymous_feature_snapshot (
    snapshot_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id             text NOT NULL REFERENCES anonymous_asset_cluster(subject_id),
    as_of_date             date NOT NULL,
    assessed_value         numeric,
    indexed_sale_value     numeric,
    improvement_value      numeric,
    lot_area_sqft          numeric,
    building_area_sqft     numeric,
    quality_index          numeric,
    waterfront_flag        boolean,
    acs_income_context     numeric,
    acs_home_value_context numeric,
    evidence_recency       numeric,
    missing_feature_count  integer NOT NULL,
    model_input_hash       char(64) NOT NULL,
    UNIQUE (subject_id, as_of_date, model_input_hash)
);

CREATE TABLE valuation_run (
    valuation_run_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_version          text NOT NULL,
    as_of_date             date NOT NULL,
    simulation_count       integer NOT NULL CHECK (simulation_count >= 1000),
    random_seed            bigint NOT NULL,
    input_snapshot_hash    char(64) NOT NULL,
    started_at             timestamptz NOT NULL DEFAULT now(),
    completed_at           timestamptz,
    status                 text NOT NULL DEFAULT 'RUNNING'
);

CREATE TABLE valuation_result (
    valuation_run_id       uuid NOT NULL REFERENCES valuation_run(valuation_run_id),
    subject_id             text NOT NULL REFERENCES public_person(subject_id),
    p05_usd                numeric NOT NULL,
    median_usd             numeric NOT NULL,
    p95_usd                numeric NOT NULL,
    mean_usd               numeric NOT NULL,
    probability_negative   numeric(7,6) NOT NULL,
    confidence_grade       text NOT NULL,
    review                 review_status NOT NULL DEFAULT 'OPEN',
    PRIMARY KEY (valuation_run_id, subject_id)
);

CREATE TABLE rank_run (
    rank_run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    valuation_run_id       uuid REFERENCES valuation_run(valuation_run_id),
    cohort_type            text NOT NULL,
    target_n               integer NOT NULL,
    model_version          text NOT NULL,
    as_of_date             date NOT NULL,
    input_snapshot_hash    char(64) NOT NULL,
    started_at             timestamptz NOT NULL DEFAULT now(),
    completed_at           timestamptz,
    status                 text NOT NULL DEFAULT 'RUNNING'
);

CREATE TABLE rank_result (
    rank_run_id            uuid NOT NULL REFERENCES rank_run(rank_run_id),
    subject_id             text NOT NULL REFERENCES subject(subject_id),
    deterministic_rank     integer,
    median_rank            integer,
    rank_p05               integer,
    rank_p95               integer,
    probability_top_n      numeric(7,6),
    affluence_score        numeric(8,4),
    confidence_grade       text NOT NULL,
    publication_allowed    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (rank_run_id, subject_id)
);

CREATE TABLE entity_match_candidate (
    match_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    left_external_id       text NOT NULL,
    right_subject_id       text NOT NULL REFERENCES public_person(subject_id),
    match_score            numeric(5,4) NOT NULL CHECK (match_score BETWEEN 0 AND 1),
    reasons                jsonb NOT NULL,
    disposition            text NOT NULL,
    reviewer               text,
    reviewed_at            timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE review_task (
    review_task_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type              text NOT NULL,
    subject_id             text REFERENCES subject(subject_id),
    severity               text NOT NULL,
    reason_codes           text[] NOT NULL,
    payload                jsonb NOT NULL,
    status                 review_status NOT NULL DEFAULT 'OPEN',
    assigned_to            text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    resolved_at            timestamptz
);

CREATE TABLE policy_audit (
    policy_audit_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id               text NOT NULL,
    action                 text NOT NULL,
    subject_id             text,
    purpose_code           text NOT NULL,
    case_or_project_id     text NOT NULL,
    rule_id                text NOT NULL,
    allowed                boolean NOT NULL,
    reason                 text NOT NULL,
    request_fingerprint    char(64) NOT NULL,
    created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_event (
    outbox_id              bigserial PRIMARY KEY,
    event_id               text NOT NULL UNIQUE,
    topic                  text NOT NULL,
    partition_key          text NOT NULL,
    payload                jsonb NOT NULL,
    idempotency_key        char(64) NOT NULL UNIQUE,
    created_at             timestamptz NOT NULL DEFAULT now(),
    published_at           timestamptz,
    publish_attempts       integer NOT NULL DEFAULT 0
);

CREATE INDEX evidence_subject_date_idx ON evidence(subject_id, source_date DESC);
CREATE INDEX component_subject_date_idx ON estimate_component(subject_id, as_of_date DESC);
CREATE INDEX anon_centroid_gix ON anonymous_asset_cluster USING gist(centroid);
CREATE INDEX review_open_idx ON review_task(status, severity, created_at) WHERE status = 'OPEN';
CREATE INDEX outbox_unpublished_idx ON outbox_event(created_at) WHERE published_at IS NULL;

-- The normalized analytical schema intentionally contains no private owner name,
-- personal email, phone number, family relationship, or exact publishable address.

-- -----------------------------------------------------------------------------
-- NWS v2: nearby public-professional network intelligence
-- -----------------------------------------------------------------------------

ALTER TYPE subject_type ADD VALUE IF NOT EXISTS 'PUBLIC_PROFESSIONAL';
ALTER TYPE subject_type ADD VALUE IF NOT EXISTS 'OPTED_IN_PROFESSIONAL';

ALTER TABLE public_person
    ADD COLUMN IF NOT EXISTS profile_class text NOT NULL DEFAULT 'PUBLIC_FIGURE',
    ADD COLUMN IF NOT EXISTS primary_lane text NOT NULL DEFAULT 'GENERAL',
    ADD COLUMN IF NOT EXISTS headline text,
    ADD COLUMN IF NOT EXISTS public_profile_url text,
    ADD COLUMN IF NOT EXISTS suppression_status text NOT NULL DEFAULT 'ACTIVE';

CREATE TABLE IF NOT EXISTS person_external_identifier (
    identifier_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id             text NOT NULL REFERENCES public_person(subject_id),
    namespace              text NOT NULL,
    external_identifier    text NOT NULL,
    source_artifact_id     uuid REFERENCES source_artifact(artifact_id),
    identity_confidence    numeric(5,4) NOT NULL CHECK (identity_confidence BETWEEN 0 AND 1),
    review                 review_status NOT NULL DEFAULT 'OPEN',
    UNIQUE (namespace, external_identifier)
);

CREATE TABLE IF NOT EXISTS postal_area (
    country_code           char(2) NOT NULL DEFAULT 'US',
    postal_code            text NOT NULL,
    label                  text NOT NULL,
    centroid               geometry(Point, 4326) NOT NULL,
    boundary               geometry(MultiPolygon, 4326),
    source_year            integer NOT NULL,
    source_artifact_id     uuid REFERENCES source_artifact(artifact_id),
    PRIMARY KEY (country_code, postal_code)
);

CREATE TABLE IF NOT EXISTS public_location_association (
    location_association_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id              text NOT NULL REFERENCES public_person(subject_id),
    label                   text NOT NULL,
    association_kind        text NOT NULL,
    granularity             text NOT NULL,
    public_point            geometry(Point, 4326) NOT NULL,
    public_area             geometry(MultiPolygon, 4326),
    confidence              numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    source_count            integer NOT NULL CHECK (source_count >= 1),
    valid_from              date,
    valid_to                date,
    as_of_date              date NOT NULL,
    publication_allowed     boolean NOT NULL DEFAULT false,
    review                  review_status NOT NULL DEFAULT 'OPEN',
    created_at              timestamptz NOT NULL DEFAULT now(),
    CHECK (association_kind <> 'PRIVATE_RESIDENCE')
);

CREATE TABLE IF NOT EXISTS location_evidence (
    location_association_id uuid NOT NULL REFERENCES public_location_association(location_association_id),
    evidence_id             uuid NOT NULL REFERENCES evidence(evidence_id),
    PRIMARY KEY (location_association_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS organization_location (
    organization_location_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          text NOT NULL REFERENCES organization(organization_id),
    label                    text NOT NULL,
    location_kind            text NOT NULL,
    point                    geometry(Point, 4326) NOT NULL,
    postal_code              text,
    confidence               numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    as_of_date               date NOT NULL,
    evidence_id              uuid REFERENCES evidence(evidence_id)
);

CREATE TABLE IF NOT EXISTS organization_metric_snapshot (
    organization_id          text NOT NULL REFERENCES organization(organization_id),
    as_of_date               date NOT NULL,
    influence_score          numeric(6,5) NOT NULL CHECK (influence_score BETWEEN 0 AND 1),
    employee_scale_percentile numeric(6,5) CHECK (employee_scale_percentile BETWEEN 0 AND 1),
    funding_or_market_percentile numeric(6,5) CHECK (funding_or_market_percentile BETWEEN 0 AND 1),
    knowledge_output_percentile numeric(6,5) CHECK (knowledge_output_percentile BETWEEN 0 AND 1),
    public_impact_percentile numeric(6,5) CHECK (public_impact_percentile BETWEEN 0 AND 1),
    sector                  text,
    model_version           text NOT NULL,
    input_snapshot_hash     char(64) NOT NULL,
    PRIMARY KEY (organization_id, as_of_date, model_version)
);

CREATE TABLE IF NOT EXISTS professional_edge (
    edge_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_node_id          text NOT NULL,
    target_node_id          text NOT NULL,
    source_node_type        text NOT NULL,
    target_node_type        text NOT NULL,
    relation_type           text NOT NULL,
    base_weight             numeric(7,6) NOT NULL CHECK (base_weight BETWEEN 0 AND 1),
    source_confidence       numeric(7,6) NOT NULL CHECK (source_confidence BETWEEN 0 AND 1),
    valid_from              date,
    valid_to                date,
    observed_on             date,
    half_life_days          integer NOT NULL CHECK (half_life_days > 0),
    evidence_id             uuid NOT NULL REFERENCES evidence(evidence_id),
    normalized_edge_hash    char(64) NOT NULL,
    supersedes_edge_id      uuid REFERENCES professional_edge(edge_id),
    review                  review_status NOT NULL DEFAULT 'OPEN',
    created_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (normalized_edge_hash)
);

CREATE TABLE IF NOT EXISTS verified_achievement (
    achievement_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id              text NOT NULL REFERENCES public_person(subject_id),
    achievement_type        text NOT NULL,
    title                   text NOT NULL,
    occurred_on             date,
    organization_id         text REFERENCES organization(organization_id),
    magnitude               numeric,
    quality_score           numeric(5,4) NOT NULL CHECK (quality_score BETWEEN 0 AND 1),
    evidence_id             uuid NOT NULL REFERENCES evidence(evidence_id),
    review                  review_status NOT NULL DEFAULT 'OPEN'
);

CREATE TABLE IF NOT EXISTS graph_snapshot (
    graph_snapshot_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    as_of_date              date NOT NULL,
    model_version           text NOT NULL,
    edge_count              bigint NOT NULL,
    node_count              bigint NOT NULL,
    input_snapshot_hash     char(64) NOT NULL,
    parameters              jsonb NOT NULL,
    started_at              timestamptz NOT NULL DEFAULT now(),
    completed_at            timestamptz,
    status                  text NOT NULL DEFAULT 'RUNNING',
    UNIQUE (as_of_date, model_version, input_snapshot_hash)
);

CREATE TABLE IF NOT EXISTS graph_person_metric (
    graph_snapshot_id       uuid NOT NULL REFERENCES graph_snapshot(graph_snapshot_id),
    subject_id              text NOT NULL REFERENCES public_person(subject_id),
    weighted_pagerank       double precision NOT NULL,
    pagerank_percentile     numeric(6,5) NOT NULL CHECK (pagerank_percentile BETWEEN 0 AND 1),
    kcore_number            integer NOT NULL,
    kcore_percentile        numeric(6,5) NOT NULL CHECK (kcore_percentile BETWEEN 0 AND 1),
    bridging_score          numeric(6,5) NOT NULL CHECK (bridging_score BETWEEN 0 AND 1),
    bridging_percentile     numeric(6,5) NOT NULL CHECK (bridging_percentile BETWEEN 0 AND 1),
    cross_sector_score      numeric(6,5) NOT NULL CHECK (cross_sector_score BETWEEN 0 AND 1),
    cross_sector_percentile numeric(6,5) NOT NULL CHECK (cross_sector_percentile BETWEEN 0 AND 1),
    community_id            text,
    PRIMARY KEY (graph_snapshot_id, subject_id)
);

CREATE TABLE IF NOT EXISTS nws_feature_snapshot (
    feature_snapshot_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id               text NOT NULL REFERENCES public_person(subject_id),
    graph_snapshot_id        uuid NOT NULL REFERENCES graph_snapshot(graph_snapshot_id),
    as_of_date               date NOT NULL,
    primary_lane             text NOT NULL,
    features                 jsonb NOT NULL,
    evidence_count           integer NOT NULL CHECK (evidence_count >= 0),
    source_quality           numeric(6,5) NOT NULL CHECK (source_quality BETWEEN 0 AND 1),
    source_diversity         numeric(6,5) NOT NULL CHECK (source_diversity BETWEEN 0 AND 1),
    identity_confidence      numeric(6,5) NOT NULL CHECK (identity_confidence BETWEEN 0 AND 1),
    suspicious_pattern_ratio numeric(6,5) NOT NULL CHECK (suspicious_pattern_ratio BETWEEN 0 AND 1),
    input_snapshot_hash      char(64) NOT NULL,
    UNIQUE (subject_id, as_of_date, input_snapshot_hash)
);

CREATE TABLE IF NOT EXISTS nws_score_snapshot (
    score_snapshot_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_snapshot_id      uuid NOT NULL REFERENCES nws_feature_snapshot(feature_snapshot_id),
    subject_id               text NOT NULL REFERENCES public_person(subject_id),
    global_nws               numeric(7,4) NOT NULL CHECK (global_nws BETWEEN 0 AND 100),
    confidence               numeric(6,5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    confidence_grade         char(1) NOT NULL,
    component_scores         jsonb NOT NULL,
    reasons                  jsonb NOT NULL,
    warnings                 jsonb NOT NULL,
    model_version            text NOT NULL,
    as_of_date               date NOT NULL,
    publication_allowed      boolean NOT NULL DEFAULT false,
    review                   review_status NOT NULL DEFAULT 'OPEN',
    UNIQUE (subject_id, model_version, as_of_date)
);

CREATE TABLE IF NOT EXISTS nearby_query_audit (
    nearby_query_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id                 text NOT NULL,
    purpose_code             text NOT NULL,
    query_mode               text NOT NULL,
    query_postal_code        text,
    query_coarse_cell        text,
    requested_top_n          integer NOT NULL CHECK (requested_top_n BETWEEN 1 AND 400),
    initial_radius_km        numeric NOT NULL,
    effective_radius_km      numeric NOT NULL,
    candidate_pool_size      integer NOT NULL,
    eligible_count           integer NOT NULL,
    returned_count           integer NOT NULL,
    model_version            text NOT NULL,
    request_fingerprint      char(64) NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    CHECK (query_postal_code IS NOT NULL OR query_coarse_cell IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS nearby_result_audit (
    nearby_query_id          uuid NOT NULL REFERENCES nearby_query_audit(nearby_query_id),
    subject_id               text NOT NULL REFERENCES public_person(subject_id),
    result_rank              integer NOT NULL,
    nearby_rank_score        numeric(7,4) NOT NULL CHECK (nearby_rank_score BETWEEN 0 AND 100),
    global_nws               numeric(7,4) NOT NULL CHECK (global_nws BETWEEN 0 AND 100),
    local_relevance          numeric(6,5) NOT NULL CHECK (local_relevance BETWEEN 0 AND 1),
    distance_band            text NOT NULL,
    explanation_hash         char(64) NOT NULL,
    PRIMARY KEY (nearby_query_id, subject_id)
);

CREATE TABLE IF NOT EXISTS profile_suppression (
    suppression_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id               text NOT NULL REFERENCES public_person(subject_id),
    reason_code              text NOT NULL,
    scope                    text NOT NULL,
    requested_by             text NOT NULL,
    approved_by              text,
    starts_at                timestamptz NOT NULL DEFAULT now(),
    ends_at                  timestamptz,
    status                   text NOT NULL DEFAULT 'ACTIVE'
);

CREATE INDEX IF NOT EXISTS public_location_point_gix
    ON public_location_association USING gist(public_point)
    WHERE publication_allowed = true AND review = 'APPROVED';
CREATE INDEX IF NOT EXISTS organization_location_point_gix
    ON organization_location USING gist(point);
CREATE INDEX IF NOT EXISTS professional_edge_source_idx
    ON professional_edge(source_node_id, relation_type, valid_to);
CREATE INDEX IF NOT EXISTS professional_edge_target_idx
    ON professional_edge(target_node_id, relation_type, valid_to);
CREATE INDEX IF NOT EXISTS nws_score_publish_idx
    ON nws_score_snapshot(global_nws DESC, confidence DESC)
    WHERE publication_allowed = true AND review = 'APPROVED';
CREATE INDEX IF NOT EXISTS nearby_query_created_idx
    ON nearby_query_audit(created_at DESC);

-- Production geospatial candidate retrieval. The query point must already be coarsened.
-- SELECT p.subject_id, p.display_name, l.label,
--        ST_DistanceSphere(l.public_point, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)) / 1000 AS distance_km
-- FROM public_person p
-- JOIN public_location_association l ON l.subject_id = p.subject_id
-- JOIN nws_score_snapshot n ON n.subject_id = p.subject_id
-- WHERE p.verification = 'VERIFIED'
--   AND p.profile_class IN ('PUBLIC_FIGURE', 'PUBLIC_PROFESSIONAL', 'OPTED_IN')
--   AND p.suppression_status = 'ACTIVE'
--   AND l.publication_allowed = true AND l.review = 'APPROVED'
--   AND n.publication_allowed = true AND n.review = 'APPROVED'
--   AND ST_DWithin(
--       l.public_point::geography,
--       ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
--       :radius_meters
--   )
-- ORDER BY n.global_nws DESC
-- LIMIT :candidate_pool_limit;

ALTER TABLE public_person
    ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS public_person_tags_gin ON public_person USING gin(tags);
