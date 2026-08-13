-- NWS-owned, least-privilege read model over the shared CMS NPPES directory.
-- Apply as the healthcare database owner. The NWS runtime role must not receive
-- SELECT on healthcare.providers because that table also stores street/phone/raw fields.

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

-- Critical for bounded nationwide radius queries. Keep the predicate aligned with
-- the public-professional view so PostGIS does not scan organization/deactivated rows.
-- CONCURRENTLY avoids blocking writes during an operational re-apply. Run this file
-- with psql autocommit enabled; CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS providers_nws_active_individual_geog_gix
  ON public.providers USING GIST (geog)
  WHERE entity_type = 'individual'
    AND status = 'active'
    AND geog IS NOT NULL;

REVOKE SELECT ON TABLE public.providers, public.zips FROM nws_nearby_ro;
GRANT SELECT ON TABLE public.nws_public_professionals TO nws_nearby_ro;
