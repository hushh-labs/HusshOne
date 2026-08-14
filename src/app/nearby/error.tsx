"use client";

import styles from "./nearby.module.css";

export default function NearbyError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className={styles.page}>
      <section className={styles.centerState} role="alert">
        <h1>Couldn’t open nearby</h1>
        <p>Try again in a moment.</p>
        <button className={styles.primaryButton} type="button" onClick={reset}>
          Retry
        </button>
      </section>
    </main>
  );
}
