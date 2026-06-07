-- Full end-to-end request journey on one.hushh.ai (page -> sign-in -> scan ->
-- response) for a time window, chronological with per-request latency.
-- Tweak the timestamp window to a session you care about.
SELECT
  timestamp,
  http_request.request_method                         AS method,
  http_request.status                                 AS status,
  ROUND(CAST(REGEXP_EXTRACT(http_request.latency, r'([0-9.]+)s') AS FLOAT64), 3) AS latency_s,
  REGEXP_REPLACE(http_request.request_url, r'\?.*$', '') AS path,
  trace
FROM `hushone-app.global._Default._AllLogs`
WHERE resource.type = 'cloud_run_revision'
  AND resource.labels.service_name = 'one'
  AND http_request.request_method IS NOT NULL
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 HOUR)
ORDER BY timestamp ASC
LIMIT 200;
