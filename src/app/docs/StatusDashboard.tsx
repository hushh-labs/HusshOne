"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./docs.module.css";

type Status = "operational" | "degraded" | "down";

interface Component {
  id: string;
  name: string;
  status: Status;
  description: string;
  latencyMs: number;
}
interface Health {
  ok: boolean;
  status: Status;
  checkedAt: string;
  components: Component[];
}

const OVERALL_COPY: Record<Status, { title: string; blurb: string }> = {
  operational: { title: "All systems operational", blurb: "The One Developer API and its dependencies are healthy." },
  degraded: { title: "Partial degradation", blurb: "The API is up, but one or more components are degraded — some requests may be slower or shallower." },
  down: { title: "Service disruption", blurb: "A critical component is down. Scans may fail until this recovers." },
};

/* Live status dashboard for /docs/status — polls the public GET /api/v1/health (overall + per-component),
   auto-refreshes every 30s, and offers a manual refresh. No auth; safe to render for anyone. */
export default function StatusDashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/health", { cache: "no-store" });
      const body = (await res.json()) as Health;
      setHealth(body);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const overall: Status = error ? "down" : (health?.status ?? "operational");
  const copy = OVERALL_COPY[overall];

  return (
    <div className={styles.statusPage}>
      <div className={styles.docMeta}>Live status of the One Developer API — polled from GET /api/v1/health.</div>

      <div className={`${styles.statusBanner} ${styles[`banner_${overall}`]}`}>
        <span className={`${styles.statusDotLg} ${styles[`dot_${overall}`]}`} aria-hidden />
        <div>
          <div className={styles.statusBannerTitle}>{error ? "Status unavailable" : copy.title}</div>
          <div className={styles.statusBannerBlurb}>{error ? "Couldn’t reach the health endpoint. Retrying…" : copy.blurb}</div>
        </div>
        <button className={styles.refreshBtn} onClick={load} disabled={loading} type="button">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className={styles.statusList}>
        {(health?.components ?? []).map((c) => (
          <div key={c.id} className={styles.statusRow}>
            <span className={`${styles.statusDot} ${styles[`dot_${c.status}`]}`} aria-hidden />
            <div className={styles.statusRowMain}>
              <div className={styles.statusRowName}>{c.name}</div>
              <div className={styles.statusRowDesc}>{c.description}</div>
            </div>
            <div className={styles.statusRowMeta}>
              <span className={`${styles.statusTag} ${styles[`tag_${c.status}`]}`}>{c.status}</span>
              {c.latencyMs > 0 ? <span className={styles.statusLatency}>{c.latencyMs} ms</span> : null}
            </div>
          </div>
        ))}
      </div>

      {health?.checkedAt ? (
        <p className={styles.statusFoot}>
          Last checked {new Date(health.checkedAt).toLocaleTimeString()} · auto-refreshes every 30s · cached ~30s server-side
        </p>
      ) : null}
    </div>
  );
}
