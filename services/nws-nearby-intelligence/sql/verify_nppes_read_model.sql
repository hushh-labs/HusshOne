-- Run as nws_nearby_ro after the contract migration. Any privilege regression or
-- query exceeding the production statement budget exits psql nonzero.
\set ON_ERROR_STOP on
\timing on

SET statement_timeout = '4s';

DO $verification$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_state
    WHERE index_state.indexrelid = pg_catalog.to_regclass('public.zips_geog_gix')
      AND index_state.indisvalid
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_state
    WHERE index_state.indexrelid = pg_catalog.to_regclass('public.providers_zip_idx')
      AND index_state.indisvalid
  )
  THEN
    RAISE EXCEPTION 'NWS read model is missing a valid required index';
  END IF;

  IF has_table_privilege(current_user, 'public.providers', 'SELECT')
    OR has_table_privilege(current_user, 'public.zips', 'SELECT')
    OR has_table_privilege(current_user, 'public.nws_public_professionals', 'SELECT')
  THEN
    RAISE EXCEPTION 'NWS role has an unexpected table/view SELECT privilege';
  END IF;

  IF NOT has_function_privilege(
    current_user,
    'public.nws_public_professionals_nearby(double precision,double precision,double precision,integer)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    current_user,
    'public.nws_public_professionals_by_postal(text,integer)',
    'EXECUTE'
  )
  THEN
    RAISE EXCEPTION 'NWS role is missing a fixed-function EXECUTE privilege';
  END IF;
END;
$verification$;

SELECT count(*) AS chicago_coordinate_candidate_count
FROM public.nws_public_professionals_nearby(41.7825, -87.6027, 25000, 300);

SELECT count(*) AS chicago_postal_candidate_count
FROM public.nws_public_professionals_by_postal('60637', 300);
