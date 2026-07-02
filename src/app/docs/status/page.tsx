import type { Metadata } from "next";
import StatusDashboard from "../StatusDashboard";
import styles from "../docs.module.css";

export const metadata: Metadata = {
  title: "API status — One Developer API",
  description: "Live status of the One Developer API and its dependencies (research engine, database, profile scrapers).",
};

export default function StatusRoute() {
  return (
    <article>
      <h1 className={styles.statusTitle}>API status</h1>
      <StatusDashboard />
    </article>
  );
}
