-- User-behaviour FUNNEL / drop-off for one.hushh.ai (last 7 days).
-- Distinct sessions reaching each stage → where users drop off.
-- Source: one.ui.* client beacon events (per-tab sessionId).
SELECT
  REGEXP_EXTRACT(JSON_VALUE(json_payload, '$.event'), r'one\.ui\.(.+)') AS ui_event,
  COUNT(DISTINCT JSON_VALUE(json_payload, '$.sessionId'))               AS sessions,
  COUNT(*)                                                              AS events
FROM `hushone-app.global._Default._AllLogs`
WHERE resource.labels.service_name = 'one'
  AND JSON_VALUE(json_payload, '$.event') LIKE 'one.ui.%'
  AND timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY ui_event
ORDER BY sessions DESC;

-- Per-session journey (replay one user's path through the app):
-- SELECT timestamp, REGEXP_EXTRACT(JSON_VALUE(json_payload,'$.event'), r'one\.ui\.(.+)') AS step
-- FROM `hushone-app.global._Default._AllLogs`
-- WHERE JSON_VALUE(json_payload,'$.sessionId') = 'PASTE_SESSION_ID'
-- ORDER BY timestamp ASC;
