-- One scan latency p50/p95/p99 (ms) over the last 7 days, by intelligence source.
-- Run in: Logging > Log Analytics (project hushone-app), or BigQuery on the
-- linked dataset. Source = the one.scan.completed structured log.
SELECT
  JSON_VALUE(json_payload, '$.source')                                  AS source,
  COUNT(*)                                                              AS scans,
  ROUND(APPROX_QUANTILES(CAST(JSON_VALUE(json_payload, '$.totalMs') AS FLOAT64), 100)[OFFSET(50)]/1000, 1) AS p50_s,
  ROUND(APPROX_QUANTILES(CAST(JSON_VALUE(json_payload, '$.totalMs') AS FLOAT64), 100)[OFFSET(95)]/1000, 1) AS p95_s,
  ROUND(APPROX_QUANTILES(CAST(JSON_VALUE(json_payload, '$.totalMs') AS FLOAT64), 100)[OFFSET(99)]/1000, 1) AS p99_s,
  ROUND(MAX(CAST(JSON_VALUE(json_payload, '$.totalMs') AS FLOAT64))/1000, 1)                               AS max_s
FROM `hushone-app.global._Default._AllLogs`
WHERE resource.type = 'cloud_run_revision'
  AND JSON_VALUE(json_payload, '$.event') = 'one.scan.completed'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY source
ORDER BY scans DESC;
