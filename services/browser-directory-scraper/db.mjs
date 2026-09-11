import fs from "node:fs/promises";
import pg from "pg";
import { normalizeObservation } from "./app.mjs";

const pool = new pg.Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "hotel_scraper",
  user: process.env.PGUSER || "directories",
  password: process.env.PGPASSWORD || "",
  max: Number(process.env.PGPOOL_MAX || 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on("error", (error) => console.log(JSON.stringify({ event: "pg.pool_error", message: error.message })));

export async function query(text, params) {
  return pool.query(text, params);
}

export async function close() {
  await pool.end();
}

export async function applySchema() {
  const schema = await fs.readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await query(schema);
}

export async function seedTasks(tasks) {
  for (const task of tasks) {
    await query(
      `INSERT INTO browser_scrape_tasks (task_id, vertical, query_zip, city, state, query, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (task_id) DO UPDATE SET city = EXCLUDED.city, state = EXCLUDED.state, query = EXCLUDED.query, updated_at = now()`,
      [task.taskId, task.vertical, task.zip, task.city || null, task.state || null, task.query, task.source || "google_search"],
    );
  }
  return tasks.length;
}

export async function requeueExpired() {
  const result = await query(
    `UPDATE browser_scrape_tasks
        SET status = 'pending', worker_id = NULL, lease_until = NULL, heartbeat_at = NULL, updated_at = now(),
            last_error = COALESCE(last_error, 'lease expired')
      WHERE status = 'running' AND lease_until < now()
      RETURNING task_id`,
  );
  return result.rowCount;
}

export async function claimTask({ workerId, vertical, leaseMinutes = 10 }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const params = vertical === "all" ? [] : [vertical];
    const verticalClause = vertical === "all" ? "" : "AND vertical = $1";
    const picked = await client.query(
      `SELECT * FROM browser_scrape_tasks
        WHERE status = 'pending' AND next_attempt_at <= now() ${verticalClause}
        ORDER BY query_zip, vertical, task_id
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      params,
    );
    if (!picked.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const task = picked.rows[0];
    const out = await client.query(
      `UPDATE browser_scrape_tasks
          SET status = 'running', worker_id = $1, attempts = attempts + 1,
              lease_until = now() + ($2 || ' minutes')::interval,
              heartbeat_at = now(), updated_at = now()
        WHERE task_id = $3 RETURNING *`,
      [workerId, String(leaseMinutes), task.task_id],
    );
    await client.query("COMMIT");
    return out.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeat(workerId, data = {}) {
  await query(
    `INSERT INTO browser_worker_heartbeats (worker_id, vertical, cdp_port, profile_dir, status, current_task_id, last_error, heartbeat_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
     ON CONFLICT (worker_id) DO UPDATE SET vertical = EXCLUDED.vertical, cdp_port = EXCLUDED.cdp_port,
       profile_dir = EXCLUDED.profile_dir, status = EXCLUDED.status, current_task_id = EXCLUDED.current_task_id,
       last_error = EXCLUDED.last_error, heartbeat_at = now(), updated_at = now()`,
    [workerId, data.vertical || "unknown", data.cdpPort || 0, data.profileDir || null, data.status || "running", data.taskId || null, data.error || null],
  );
  if (data.taskId) {
    await query(
      `UPDATE browser_scrape_tasks SET heartbeat_at = now(), lease_until = now() + ($2 || ' minutes')::interval, updated_at = now()
       WHERE task_id = $1 AND worker_id = $3 AND status = 'running'`,
      [data.taskId, String(data.leaseMinutes || 10), workerId],
    );
  }
}

export async function completeTask(taskId, resultCount, recordsSaved) {
  await query(
    `UPDATE browser_scrape_tasks SET status = 'done', result_count = $2, records_saved = $3,
      worker_id = NULL, lease_until = NULL, heartbeat_at = NULL, last_error = NULL, updated_at = now()
     WHERE task_id = $1`,
    [taskId, resultCount, recordsSaved],
  );
}

export async function failTask(task, error) {
  const retryMinutes = Math.min(60, Math.max(1, 2 ** Math.min(task.attempts || 1, 5)));
  await query(
    `UPDATE browser_scrape_tasks SET status = CASE WHEN attempts >= $2 THEN 'error' ELSE 'pending' END,
      worker_id = NULL, lease_until = NULL, heartbeat_at = NULL, last_error = $3,
      next_attempt_at = now() + ($4 || ' minutes')::interval, updated_at = now()
     WHERE task_id = $1`,
    [task.task_id, Number(process.env.MAX_TASK_ATTEMPTS || 8), String(error).slice(0, 2000), String(retryMinutes)],
  );
}

export async function upsertObservation(raw) {
  const row = normalizeObservation(raw);
  if (!row) return false;
  await query(
    `INSERT INTO browser_observations
      (stable_key, vertical, query_zip, name, normalized_name, address, city, state, postal_code, phone, website,
       source, source_domain, source_url, source_rank, categories, rating, raw, canonical_database, canonical_table)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (stable_key) DO UPDATE SET
       name = EXCLUDED.name, address = COALESCE(EXCLUDED.address, browser_observations.address),
       city = COALESCE(EXCLUDED.city, browser_observations.city), state = COALESCE(EXCLUDED.state, browser_observations.state),
       postal_code = COALESCE(EXCLUDED.postal_code, browser_observations.postal_code), phone = COALESCE(EXCLUDED.phone, browser_observations.phone),
       website = COALESCE(EXCLUDED.website, browser_observations.website), source_url = EXCLUDED.source_url,
       source_rank = EXCLUDED.source_rank, categories = EXCLUDED.categories, rating = COALESCE(EXCLUDED.rating, browser_observations.rating),
       raw = EXCLUDED.raw, last_seen = now(), crawl_count = browser_observations.crawl_count + 1`,
    [row.stableKey, row.vertical, row.queryZip, row.name, row.normalizedName, row.address, row.city, row.state, row.postalCode,
      row.phone, row.website, row.source, row.sourceDomain, row.sourceUrl, row.sourceRank, row.categories, row.rating, row.raw,
      row.canonicalDatabase, row.canonicalTable],
  );
  return true;
}
