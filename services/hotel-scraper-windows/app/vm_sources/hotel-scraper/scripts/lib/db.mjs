// Postgres access layer (Cloud SQL + PostGIS via the local Auth Proxy).
// One shared pool. All hotel writes go through upsertHotel() so OSM + Places
// merge onto a single row by dedup_key; the queue is drained by claimNextZip().

import pg from "pg";
import { config } from "./config.mjs";

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      max: config.db.max,
      // Cloud SQL Auth Proxy terminates TLS itself, so the pg connection to
      // 127.0.0.1 is plaintext loopback — no ssl config needed.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    // Don't let a transient backend error crash the 24/7 worker.
    pool.on("error", (err) => {
      console.log(JSON.stringify({ event: "pg.pool_error", message: err.message }));
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export async function query(text, params) {
  return getPool().query(text, params);
}

// Ping used by /health and the init step to confirm the DB is reachable.
export async function ping() {
  const { rows } = await query("SELECT 1 AS ok");
  return rows[0]?.ok === 1;
}

// -- ZIP queue ---------------------------------------------------------------

// Bulk-load ZIPs (from GeoNames) idempotently. Existing rows keep their crawl
// status/counters; only the static geo fields are refreshed. Returns inserted count.
export async function insertZipsBatch(rows) {
  if (!rows.length) return 0;
  const cols = ["zip", "city", "state", "county", "lat", "lng", "dist_km_from_kirkland"];
  const values = [];
  const tuples = rows.map((r, i) => {
    const base = i * cols.length;
    values.push(r.zip, r.city, r.state, r.county, r.lat, r.lng, r.distKm);
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
  });
  const sql = `
    INSERT INTO zips (${cols.join(", ")})
    VALUES ${tuples.join(", ")}
    ON CONFLICT (zip) DO UPDATE SET
      city = EXCLUDED.city,
      state = EXCLUDED.state,
      county = EXCLUDED.county,
      lat = EXCLUDED.lat,
      lng = EXCLUDED.lng,
      dist_km_from_kirkland = EXCLUDED.dist_km_from_kirkland,
      updated_at = now()
    RETURNING (xmax = 0) AS inserted`;
  const { rows: out } = await query(sql, values);
  return out.filter((o) => o.inserted).length;
}

// Atomically claim the next ZIP to enrich with Places. Prefers pending ZIPs
// nearest Kirkland; once the first sweep is done it falls back to refreshing the
// oldest-scraped ZIP past the refresh window. FOR UPDATE SKIP LOCKED makes this
// safe if we ever run more than one worker. Returns the claimed zip row or null.
export async function claimNextZip({ refreshAfterDays = config.worker.refreshAfterDays } = {}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Phase 1: nearest still-pending ZIP.
    let picked = await client.query(
      `SELECT zip FROM zips
        WHERE places_status = 'pending'
        ORDER BY dist_km_from_kirkland ASC NULLS LAST
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    let mode = "initial";
    // Phase 2 (steady state): nothing pending -> refresh the stalest done ZIP.
    if (picked.rowCount === 0) {
      picked = await client.query(
        `SELECT zip FROM zips
          WHERE places_status = 'done'
            AND (last_scraped_at IS NULL OR last_scraped_at < now() - ($1 || ' days')::interval)
          ORDER BY last_scraped_at ASC NULLS FIRST
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [String(refreshAfterDays)],
      );
      mode = "refresh";
    }
    if (picked.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }
    const zip = picked.rows[0].zip;
    const { rows } = await client.query(
      `UPDATE zips
          SET places_status = 'in_progress', updated_at = now()
        WHERE zip = $1
        RETURNING *`,
      [zip],
    );
    await client.query("COMMIT");
    return { ...rows[0], _mode: mode };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function markZipDone(zip, { placesCalls = 0, hotelsFound = 0 } = {}) {
  await query(
    `UPDATE zips
        SET places_status = 'done',
            places_calls = places_calls + $2,
            hotels_found = $3,
            last_scraped_at = now(),
            last_error = NULL,
            updated_at = now()
      WHERE zip = $1`,
    [zip, placesCalls, hotelsFound],
  );
}

export async function markZipError(zip, message) {
  await query(
    `UPDATE zips
        SET places_status = 'error',
            last_error = $2,
            updated_at = now()
      WHERE zip = $1`,
    [zip, String(message || "").slice(0, 2000)],
  );
}

// Reset ZIPs stuck 'in_progress' (e.g. worker killed mid-ZIP) back to pending so
// the crawl fully resumes on restart. Returns how many were requeued.
export async function requeueStaleInProgress({ olderThanMinutes = 30 } = {}) {
  const { rowCount } = await query(
    `UPDATE zips
        SET places_status = 'pending', updated_at = now()
      WHERE places_status = 'in_progress'
        AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return rowCount;
}

export async function markOsmStatus(zip, status) {
  await query(`UPDATE zips SET osm_status = $2, updated_at = now() WHERE zip = $1`, [zip, status]);
}

// -- Hotels ------------------------------------------------------------------

// Insert or merge a hotel. Conflict on dedup_key (same name+geocell) merges OSM
// and Places into one row; conflict on place_id catches the same Google place
// arriving under a slightly different dedup_key. COALESCE keeps existing values
// when the incoming source lacks a field (OSM has no rating; Places has no osm_id),
// and sources is unioned so a row can read {osm,places}. first_seen is never moved.
export async function upsertHotel(rec) {
  if (!rec || !rec.dedupKey || !rec.name) return null;
  const sql = `
    INSERT INTO hotels (
      dedup_key, place_id, osm_id, sources, name, formatted_address,
      zip, query_zip, state, lat, lng, rating, user_ratings_total, price_level,
      phone, website, google_maps_uri, primary_type, types, business_status, raw,
      photo_refs
    ) VALUES (
      $1, $2, $3, ARRAY[$4]::text[], $5, $6,
      $7, $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21,
      COALESCE($22::text[], '{}')
    )
    ON CONFLICT (dedup_key) DO UPDATE SET
      place_id          = COALESCE(hotels.place_id, EXCLUDED.place_id),
      osm_id            = COALESCE(hotels.osm_id, EXCLUDED.osm_id),
      sources           = (SELECT ARRAY(SELECT DISTINCT unnest(hotels.sources || EXCLUDED.sources))),
      name              = COALESCE(EXCLUDED.name, hotels.name),
      formatted_address = COALESCE(EXCLUDED.formatted_address, hotels.formatted_address),
      zip               = COALESCE(EXCLUDED.zip, hotels.zip),
      query_zip         = COALESCE(hotels.query_zip, EXCLUDED.query_zip),
      state             = COALESCE(EXCLUDED.state, hotels.state),
      lat               = COALESCE(EXCLUDED.lat, hotels.lat),
      lng               = COALESCE(EXCLUDED.lng, hotels.lng),
      rating            = COALESCE(EXCLUDED.rating, hotels.rating),
      user_ratings_total= COALESCE(EXCLUDED.user_ratings_total, hotels.user_ratings_total),
      price_level       = COALESCE(EXCLUDED.price_level, hotels.price_level),
      phone             = COALESCE(EXCLUDED.phone, hotels.phone),
      website           = COALESCE(EXCLUDED.website, hotels.website),
      google_maps_uri   = COALESCE(EXCLUDED.google_maps_uri, hotels.google_maps_uri),
      primary_type      = COALESCE(EXCLUDED.primary_type, hotels.primary_type),
      types             = COALESCE(EXCLUDED.types, hotels.types),
      business_status   = COALESCE(EXCLUDED.business_status, hotels.business_status),
      raw               = COALESCE(EXCLUDED.raw, hotels.raw),
      -- Keep the freshest photo refs from Places; leave old refs if this update
      -- carries none (e.g. an OSM re-touch). Never disturb a 'done'/'pending' row's
      -- resolver state — only re-queue rows we'd previously given up on.
      photo_refs        = CASE WHEN COALESCE(array_length(EXCLUDED.photo_refs, 1), 0) > 0
                               THEN EXCLUDED.photo_refs ELSE hotels.photo_refs END,
      photos_status     = CASE WHEN COALESCE(array_length(EXCLUDED.photo_refs, 1), 0) > 0
                                     AND hotels.photos_status IN ('none', 'error')
                               THEN 'pending' ELSE hotels.photos_status END,
      last_seen         = now()
    RETURNING id, (xmax = 0) AS inserted`;
  const params = [
    rec.dedupKey,
    rec.placeId || null,
    rec.osmId || null,
    rec.source,
    rec.name,
    rec.formattedAddress || null,
    rec.zip || null,
    rec.queryZip || null,
    rec.state || null,
    rec.lat ?? null,
    rec.lng ?? null,
    rec.rating ?? null,
    rec.userRatingsTotal ?? null,
    rec.priceLevel || null,
    rec.phone || null,
    rec.website || null,
    rec.googleMapsUri || null,
    rec.primaryType || null,
    rec.types || null,
    rec.businessStatus || null,
    rec.raw ? JSON.stringify(rec.raw) : null,
    Array.isArray(rec.photoRefs) && rec.photoRefs.length ? rec.photoRefs : null,
  ];
  try {
    const { rows } = await query(sql, params);
    return { id: rows[0].id, inserted: rows[0].inserted };
  } catch (err) {
    // A distinct dedup_key can still collide on the UNIQUE place_id (same Google
    // place, name/geo drift). Fall back to merging by place_id in that case.
    if (err.code === "23505" && rec.placeId) {
      const { rows } = await query(
        `UPDATE hotels SET
            sources = (SELECT ARRAY(SELECT DISTINCT unnest(sources || ARRAY[$2]::text[]))),
            rating = COALESCE($3, rating),
            user_ratings_total = COALESCE($4, user_ratings_total),
            price_level = COALESCE($5, price_level),
            phone = COALESCE($6, phone),
            website = COALESCE($7, website),
            google_maps_uri = COALESCE($8, google_maps_uri),
            formatted_address = COALESCE($9, formatted_address),
            raw = COALESCE($10, raw),
            -- Same photo re-queue as the dedup_key path: adopt fresh refs and
            -- re-open a settled ('none'/'error') resolver state when they arrive.
            photo_refs = CASE WHEN COALESCE(array_length($11::text[], 1), 0) > 0
                              THEN $11::text[] ELSE photo_refs END,
            photos_status = CASE WHEN COALESCE(array_length($11::text[], 1), 0) > 0
                                      AND photos_status IN ('none', 'error')
                                 THEN 'pending' ELSE photos_status END,
            last_seen = now()
          WHERE place_id = $1
          RETURNING id`,
        [
          rec.placeId,
          rec.source,
          rec.rating ?? null,
          rec.userRatingsTotal ?? null,
          rec.priceLevel || null,
          rec.phone || null,
          rec.website || null,
          rec.googleMapsUri || null,
          rec.formattedAddress || null,
          rec.raw ? JSON.stringify(rec.raw) : null,
          Array.isArray(rec.photoRefs) && rec.photoRefs.length ? rec.photoRefs : null,
        ],
      );
      return rows[0] ? { id: rows[0].id, inserted: false } : null;
    }
    throw err;
  }
}

// Count hotels found for a given query_zip (used to stamp zips.hotels_found).
export async function countHotelsForQueryZip(zip) {
  const { rows } = await query(`SELECT count(*)::int AS n FROM hotels WHERE query_zip = $1`, [zip]);
  return rows[0]?.n || 0;
}

// -- Photo queue -------------------------------------------------------------
// The photo resolver drains rows that have a place_id (only those can have Google
// photos). Mirrors the ZIP queue: two-phase claim (backfill 'pending' first, then
// refresh stale 'done' rows whose photoUri links have aged out), FOR UPDATE SKIP
// LOCKED so multiple workers are safe. photos_fetched_at doubles as the "last
// resolver touch" stamp so requeueStalePhotos can recover crashed claims.

export async function claimPhotoBatch({
  batchSize = config.photos.batchSize,
  refreshAfterDays = config.photos.refreshAfterDays,
} = {}) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Phase 1: never-resolved rows (backfill + freshly crawled). Best hotels
    // first, so the most-reviewed places get their photos soonest.
    let picked = await client.query(
      `SELECT id FROM hotels
        WHERE place_id IS NOT NULL AND photos_status = 'pending'
        ORDER BY user_ratings_total DESC NULLS LAST
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    let mode = "initial";
    // Phase 2 (steady state): nothing pending -> refresh the stalest resolved
    // rows, since Place Photo URIs are not permanent.
    if (picked.rowCount === 0) {
      picked = await client.query(
        `SELECT id FROM hotels
          WHERE place_id IS NOT NULL AND photos_status = 'done'
            AND (photos_fetched_at IS NULL
                 OR photos_fetched_at < now() - ($2 || ' days')::interval)
          ORDER BY photos_fetched_at ASC NULLS FIRST
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [batchSize, String(refreshAfterDays)],
      );
      mode = "refresh";
    }
    if (picked.rowCount === 0) {
      await client.query("COMMIT");
      return { mode, rows: [] };
    }
    const ids = picked.rows.map((r) => r.id);
    // Stamp photos_fetched_at now so a crashed claim looks stale to the requeuer.
    const { rows } = await client.query(
      `UPDATE hotels
          SET photos_status = 'in_progress', photos_fetched_at = now()
        WHERE id = ANY($1::bigint[])
        RETURNING id, place_id, name, photo_refs`,
      [ids],
    );
    await client.query("COMMIT");
    return {
      mode,
      rows: rows.map((r) => ({
        id: r.id,
        placeId: r.place_id,
        name: r.name,
        photoRefs: Array.isArray(r.photo_refs) ? r.photo_refs : [],
      })),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Resolved photos for a hotel. `refs` (optional) persists a fuller ref list we may
// have just fetched via Place Details so future refreshes skip that call.
export async function savePhotos(id, { refs, photos } = {}) {
  const arr = Array.isArray(photos) ? photos : [];
  await query(
    `UPDATE hotels
        SET photos = $2::jsonb,
            photos_count = $3,
            photo_refs = CASE WHEN COALESCE(array_length($4::text[], 1), 0) > 0
                              THEN $4::text[] ELSE photo_refs END,
            photos_status = 'done',
            photos_fetched_at = now(),
            photos_error = NULL
      WHERE id = $1`,
    [id, JSON.stringify(arr), arr.length, Array.isArray(refs) && refs.length ? refs : null],
  );
}

// Place genuinely has no photos — terminal until a future crawl brings new refs.
export async function markPhotosNone(id) {
  await query(
    `UPDATE hotels
        SET photos = '[]'::jsonb, photos_count = 0,
            photos_status = 'none', photos_fetched_at = now(), photos_error = NULL
      WHERE id = $1`,
    [id],
  );
}

export async function markPhotosError(id, message) {
  await query(
    `UPDATE hotels
        SET photos_status = 'error',
            photos_error = $2,
            photos_fetched_at = now()
      WHERE id = $1`,
    [id, String(message || "").slice(0, 2000)],
  );
}

// Recover crashed claims (stuck 'in_progress') and retry old 'error' rows.
export async function requeueStalePhotos({ inProgressMinutes = 30, errorMinutes = 180 } = {}) {
  const { rowCount } = await query(
    `UPDATE hotels
        SET photos_status = 'pending'
      WHERE place_id IS NOT NULL
        AND (
          (photos_status = 'in_progress'
             AND (photos_fetched_at IS NULL
                  OR photos_fetched_at < now() - ($1 || ' minutes')::interval))
          OR
          (photos_status = 'error'
             AND (photos_fetched_at IS NULL
                  OR photos_fetched_at < now() - ($2 || ' minutes')::interval))
        )`,
    [String(inProgressMinutes), String(errorMinutes)],
  );
  return rowCount;
}

// -- Photo spend ledger ------------------------------------------------------
// Paid Place Photo media fetches are metered per UTC day so the worker can pause
// once dailyBudgetUsd is hit and the report can show real dollars spent. One row
// per day; media_fetches is the count of billed (HTTP 200) media calls.

export async function recordPhotoSpend(mediaFetches) {
  const n = Math.max(0, Math.round(Number(mediaFetches) || 0));
  if (!n) return;
  await query(
    `INSERT INTO photo_spend (day, media_fetches)
     VALUES (current_date, $1)
     ON CONFLICT (day) DO UPDATE
        SET media_fetches = photo_spend.media_fetches + EXCLUDED.media_fetches`,
    [n],
  );
}

// Today's and all-time media fetches + their dollar cost at the configured rate.
export async function getPhotoSpend() {
  const { rows } = await query(
    `SELECT
        COALESCE((SELECT media_fetches FROM photo_spend WHERE day = current_date), 0)::bigint AS today_fetches,
        COALESCE((SELECT sum(media_fetches) FROM photo_spend), 0)::bigint AS total_fetches`,
  );
  const per = config.photos.mediaCostPer1k / 1000;
  const todayFetches = Number(rows[0].today_fetches);
  const totalFetches = Number(rows[0].total_fetches);
  return {
    todayFetches,
    totalFetches,
    todayUsd: Math.round(todayFetches * per * 100) / 100,
    totalUsd: Math.round(totalFetches * per * 100) / 100,
  };
}

// -- Progress / reporting ----------------------------------------------------

// Single round-trip snapshot for /status and the daily email.
export async function getProgress() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM zips)::int AS zips_total,
      (SELECT count(*) FROM zips WHERE places_status = 'done')::int AS zips_done,
      (SELECT count(*) FROM zips WHERE places_status = 'pending')::int AS zips_pending,
      (SELECT count(*) FROM zips WHERE places_status = 'in_progress')::int AS zips_in_progress,
      (SELECT count(*) FROM zips WHERE places_status = 'error')::int AS zips_error,
      (SELECT COALESCE(sum(places_calls), 0) FROM zips)::bigint AS places_calls_total,
      (SELECT count(DISTINCT state) FROM zips WHERE places_status = 'done')::int AS states_touched,
      (SELECT count(*) FROM hotels)::int AS hotels_total,
      (SELECT count(*) FROM hotels WHERE 'places' = ANY(sources))::int AS hotels_places,
      (SELECT count(*) FROM hotels WHERE 'osm' = ANY(sources))::int AS hotels_osm,
      (SELECT max(dist_km_from_kirkland) FROM zips WHERE places_status = 'done') AS frontier_km,
      (SELECT count(*) FROM hotels WHERE place_id IS NOT NULL)::int AS photos_eligible,
      (SELECT count(*) FROM hotels WHERE place_id IS NOT NULL AND photos_status = 'pending')::int AS photos_pending,
      (SELECT count(*) FROM hotels WHERE place_id IS NOT NULL AND photos_status = 'in_progress')::int AS photos_in_progress,
      (SELECT count(*) FROM hotels WHERE photos_status = 'done')::int AS photos_done,
      (SELECT count(*) FROM hotels WHERE photos_status = 'none')::int AS photos_none,
      (SELECT count(*) FROM hotels WHERE photos_status = 'error')::int AS photos_error,
      (SELECT count(*) FROM hotels WHERE photos_count > 0)::int AS photos_with_urls,
      (SELECT COALESCE(sum(photos_count), 0) FROM hotels)::bigint AS photos_urls_total,
      (SELECT COALESCE(sum(media_fetches), 0) FROM photo_spend)::bigint AS media_fetches_total,
      (SELECT COALESCE(sum(media_fetches), 0) FROM photo_spend WHERE day = current_date)::bigint AS media_fetches_today
  `);
  const p = rows[0];
  const zipsLeft = p.zips_total - p.zips_done;
  const pctDone = p.zips_total ? Math.round((p.zips_done / p.zips_total) * 1000) / 10 : 0;
  const estCostUsd = Math.round(Number(p.places_calls_total) * config.places.costPerCallUsd * 100) / 100;
  const photosResolved = p.photos_done + p.photos_none; // eligible rows the resolver has settled
  const photosPctDone = p.photos_eligible
    ? Math.round((photosResolved / p.photos_eligible) * 1000) / 10
    : 0;
  // Real dollars spent on paid Place Photo media (from the spend ledger).
  const perMedia = config.photos.mediaCostPer1k / 1000;
  const mediaFetchesTotal = Number(p.media_fetches_total);
  const mediaFetchesToday = Number(p.media_fetches_today);
  const mediaSpendUsd = Math.round(mediaFetchesTotal * perMedia * 100) / 100;
  const mediaSpendTodayUsd = Math.round(mediaFetchesToday * perMedia * 100) / 100;
  return {
    zipsTotal: p.zips_total,
    zipsDone: p.zips_done,
    zipsPending: p.zips_pending,
    zipsInProgress: p.zips_in_progress,
    zipsError: p.zips_error,
    zipsLeft,
    pctDone,
    placesCallsTotal: Number(p.places_calls_total),
    statesTouched: p.states_touched,
    hotelsTotal: p.hotels_total,
    hotelsPlaces: p.hotels_places,
    hotelsOsm: p.hotels_osm,
    frontierKm: p.frontier_km == null ? null : Math.round(Number(p.frontier_km) * 10) / 10,
    estCostUsd,
    photos: {
      eligible: p.photos_eligible,
      pending: p.photos_pending,
      inProgress: p.photos_in_progress,
      done: p.photos_done,
      none: p.photos_none,
      error: p.photos_error,
      withUrls: p.photos_with_urls,
      urlsTotal: Number(p.photos_urls_total),
      pctDone: photosPctDone,
      mediaFetchesTotal,
      mediaFetchesToday,
      mediaSpendUsd,
      mediaSpendTodayUsd,
    },
  };
}

export async function logEmailReport({ recipients, progress, ok, error }) {
  await query(
    `INSERT INTO email_reports
        (recipients, zips_done, zips_left, hotels_total, places_calls_total, est_cost_usd, ok, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      recipients || null,
      progress?.zipsDone ?? null,
      progress?.zipsLeft ?? null,
      progress?.hotelsTotal ?? null,
      progress?.placesCallsTotal ?? null,
      progress?.estCostUsd ?? null,
      !!ok,
      error ? String(error).slice(0, 2000) : null,
    ],
  );
}
