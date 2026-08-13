-- NWS-owned, least-privilege read model over the shared CMS NPPES directory.
-- Apply as the healthcare database owner. The NWS runtime role must not receive
-- SELECT on healthcare.providers because that table also stores street/phone/raw fields.
\set ON_ERROR_STOP on

CREATE OR REPLACE VIEW public.nws_public_professionals
WITH (security_barrier = true) AS
SELECT
  npi,
  first_name,
  middle_name,
  last_name,
  credential,
  primary_taxonomy_code,
  primary_taxonomy_desc,
  city,
  state,
  zip,
  lat,
  lng,
  geog,
  sources,
  enumeration_date,
  last_seen
FROM public.providers
WHERE entity_type = 'individual'
  AND status = 'active'
  AND geog IS NOT NULL;

-- These are the two indexes used by the fixed nearby function: KNN/radius lookup
-- on postal geography, followed by indexed provider retrieval by postal code.
-- CONCURRENTLY avoids blocking writes during an operational re-apply. Run this file
-- with psql autocommit enabled; CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS zips_geog_gix
  ON public.zips USING GIST (geog);
CREATE INDEX CONCURRENTLY IF NOT EXISTS providers_zip_idx
  ON public.providers (zip);

-- Keep function creation and all privilege changes atomic. In particular, a new
-- SECURITY DEFINER function must never become visible with default PUBLIC EXECUTE.
BEGIN;

REVOKE SELECT ON TABLE public.providers, public.zips FROM nws_nearby_ro;

-- Fixed SECURITY DEFINER functions keep callers on a parameterized, allowlisted
-- query surface while allowing PostGIS predicates to reach the underlying GIST
-- index. Querying through the security-barrier view directly prevents that
-- predicate pushdown and can turn a radius lookup into a multi-million-row scan.
CREATE OR REPLACE FUNCTION public.nws_public_professionals_nearby(
  p_latitude double precision,
  p_longitude double precision,
  p_radius_meters double precision,
  p_limit integer
)
RETURNS TABLE (
  npi character(10),
  first_name text,
  middle_name text,
  last_name text,
  credential text,
  primary_taxonomy_code text,
  primary_taxonomy_desc text,
  city text,
  state character(2),
  zip character(5),
  lat double precision,
  lng double precision,
  last_seen timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_query_geog public.geography;
  v_radius_meters double precision;
  v_remaining integer;
  v_added integer;
  v_postal record;
BEGIN
  IF p_latitude IS NULL
    OR p_longitude IS NULL
    OR p_radius_meters IS NULL
    OR p_limit IS NULL
    OR p_latitude NOT BETWEEN -90 AND 90
    OR p_longitude NOT BETWEEN -180 AND 180
    OR p_radius_meters <= 0
    OR p_limit <= 0
  THEN
    RETURN;
  END IF;

  v_radius_meters := LEAST(p_radius_meters, 500000.0);
  v_remaining := LEAST(p_limit, 2000);
  v_query_geog := public.ST_SetSRID(
    public.ST_MakePoint(p_longitude, p_latitude),
    4326
  )::public.geography;

  -- Iterate nearest provider-bearing postal areas and stop as soon as the
  -- bounded candidate window is full. This preserves sparse-area recall without
  -- sorting every provider in a dense metro.
  FOR v_postal IN
    SELECT z.zip
    FROM public.zips AS z
    WHERE z.geog IS NOT NULL
      AND public.ST_DWithin(z.geog, v_query_geog, v_radius_meters)
      AND EXISTS (
        SELECT 1
        FROM public.providers AS eligible
        WHERE eligible.zip = z.zip
          AND eligible.entity_type = 'individual'
          AND eligible.status = 'active'
          AND eligible.geog IS NOT NULL
          AND NULLIF(BTRIM(eligible.first_name), '') IS NOT NULL
          AND NULLIF(BTRIM(eligible.last_name), '') IS NOT NULL
          AND eligible.last_seen IS NOT NULL
      )
    ORDER BY z.geog OPERATOR(public.<->) v_query_geog
    LIMIT 2000
  LOOP
    RETURN QUERY
      SELECT
        candidate.npi,
        candidate.first_name,
        candidate.middle_name,
        candidate.last_name,
        candidate.credential,
        candidate.primary_taxonomy_code,
        candidate.primary_taxonomy_desc,
        candidate.city,
        candidate.state,
        candidate.zip,
        candidate.lat,
        candidate.lng,
        candidate.last_seen
      FROM public.providers AS candidate
      WHERE candidate.zip = v_postal.zip
        AND candidate.entity_type = 'individual'
        AND candidate.status = 'active'
        AND candidate.geog IS NOT NULL
        AND NULLIF(BTRIM(candidate.first_name), '') IS NOT NULL
        AND NULLIF(BTRIM(candidate.last_name), '') IS NOT NULL
        AND candidate.last_seen IS NOT NULL
      ORDER BY candidate.last_seen DESC, candidate.npi
      LIMIT v_remaining;
    GET DIAGNOSTICS v_added = ROW_COUNT;
    v_remaining := v_remaining - v_added;
    EXIT WHEN v_remaining <= 0;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.nws_public_professionals_by_postal(
  p_postal_code text,
  p_limit integer
)
RETURNS TABLE (
  npi character(10),
  first_name text,
  middle_name text,
  last_name text,
  credential text,
  primary_taxonomy_code text,
  primary_taxonomy_desc text,
  city text,
  state character(2),
  zip character(5),
  lat double precision,
  lng double precision,
  last_seen timestamp with time zone
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    p.npi,
    p.first_name,
    p.middle_name,
    p.last_name,
    p.credential,
    p.primary_taxonomy_code,
    p.primary_taxonomy_desc,
    p.city,
    p.state,
    p.zip,
    p.lat,
    p.lng,
    p.last_seen
  FROM public.providers AS p
  WHERE p.entity_type = 'individual'
    AND p.status = 'active'
    AND p.geog IS NOT NULL
    AND NULLIF(BTRIM(p.first_name), '') IS NOT NULL
    AND NULLIF(BTRIM(p.last_name), '') IS NOT NULL
    AND p.last_seen IS NOT NULL
    AND p_postal_code ~ '^[0-9]{5}$'
    AND p.zip = p_postal_code::character(5)
  ORDER BY p.last_seen DESC, p.npi
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 2000);
$function$;

REVOKE ALL ON FUNCTION public.nws_public_professionals_nearby(
  double precision, double precision, double precision, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nws_public_professionals_by_postal(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nws_public_professionals_nearby(
  double precision, double precision, double precision, integer
) TO nws_nearby_ro;
GRANT EXECUTE ON FUNCTION public.nws_public_professionals_by_postal(text, integer) TO nws_nearby_ro;

COMMIT;

-- Expand phase ends here. An existing service may still be calling the legacy
-- view, so its SELECT grant is intentionally left unchanged. After a function-
-- based revision is promoted, apply nppes_read_model_contract.sql.
