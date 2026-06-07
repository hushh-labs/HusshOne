-- A) Upstream Shadow API (RIA) duration + status over last 7 days, from the
--    RIA service's existing "Request completed ... duration_ms=" logs.
SELECT
  CAST(REGEXP_EXTRACT(text_payload, r'status_code=([0-9]+)') AS INT64)        AS status_code,
  COUNT(*)                                                                    AS calls,
  ROUND(APPROX_QUANTILES(CAST(REGEXP_EXTRACT(text_payload, r'duration_ms=([0-9.]+)') AS FLOAT64), 100)[OFFSET(50)]/1000, 1) AS p50_s,
  ROUND(APPROX_QUANTILES(CAST(REGEXP_EXTRACT(text_payload, r'duration_ms=([0-9.]+)') AS FLOAT64), 100)[OFFSET(95)]/1000, 1) AS p95_s
FROM `hushone-app.global._Default._AllLogs`
WHERE resource.labels.service_name = 'hushh-ria-intelligence-api'
  AND text_payload LIKE '%Request completed%'
  AND text_payload LIKE '%path=/v1/hushh-shadow/report%'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY status_code
ORDER BY calls DESC;

-- B) One app error breakdown (last 7 days) by structured event.
SELECT
  JSON_VALUE(json_payload, '$.event') AS event,
  COUNT(*)                            AS errors,
  ANY_VALUE(JSON_VALUE(json_payload, '$.message')) AS sample_message
FROM `hushone-app.global._Default._AllLogs`
WHERE resource.labels.service_name = 'one'
  AND severity = 'ERROR'
  AND JSON_VALUE(json_payload, '$.event') IS NOT NULL
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY event
ORDER BY errors DESC;
