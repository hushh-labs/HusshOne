import { close, query } from "./db.mjs";

try {
  const [tasks, observations, workers] = await Promise.all([
    query(`SELECT status, count(*)::int AS count FROM browser_scrape_tasks GROUP BY status ORDER BY status`),
    query(`SELECT vertical, count(*)::int AS count FROM browser_observations GROUP BY vertical ORDER BY vertical`),
    query(`SELECT worker_id, vertical, cdp_port, status, current_task_id, heartbeat_at,
                   EXTRACT(EPOCH FROM (now() - heartbeat_at))::int AS heartbeat_age_seconds
              FROM browser_worker_heartbeats ORDER BY worker_id`),
  ]);
  console.log(JSON.stringify({
    event: "scraper.status",
    tasks: tasks.rows,
    observations: observations.rows,
    workers: workers.rows,
  }, null, 2));
} finally {
  await close();
}
