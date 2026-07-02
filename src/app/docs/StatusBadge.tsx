"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import styles from "./docs.module.css";

type Status = "operational" | "degraded" | "down" | "loading";

/* Small live status pill in the sidebar — polls the public GET /api/v1/health every 60s and links to the
   full /docs/status dashboard. Fully defensive: any fetch error shows "down" rather than throwing. */
export default function StatusBadge() {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/v1/health", { cache: "no-store" });
        const body = (await res.json()) as { status?: Status };
        if (alive) setStatus(body.status ?? "down");
      } catch {
        if (alive) setStatus("down");
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const label =
    status === "loading"
      ? "Checking status…"
      : status === "operational"
        ? "All systems operational"
        : status === "degraded"
          ? "Partial degradation"
          : "Service disruption";

  return (
    <Link href="/docs/status" className={styles.statusBadge}>
      <span className={`${styles.statusDot} ${styles[`dot_${status}`]}`} aria-hidden />
      <span className={styles.statusBadgeLabel}>{label}</span>
    </Link>
  );
}
