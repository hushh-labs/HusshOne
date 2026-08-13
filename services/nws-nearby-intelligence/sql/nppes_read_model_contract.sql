-- NWS NPPES read-model contract phase.
-- Apply only after the function-based application revision is serving 100% of
-- traffic and both postal and coordinate probes pass. This removes the legacy
-- arbitrary-query surface without touching the fixed functions.
\set ON_ERROR_STOP on

BEGIN;

REVOKE SELECT ON TABLE public.nws_public_professionals FROM nws_nearby_ro;
REVOKE SELECT ON TABLE public.providers, public.zips FROM nws_nearby_ro;

COMMIT;
