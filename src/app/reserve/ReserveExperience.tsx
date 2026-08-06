"use client";

/* Reserve — seamless communication becomes seamless commerce.
   Three moments: 1 Pick who you need → 2 One decides the fair fee (the broker's band —
   you tap low / suggested / high, never a blank price box) and you pick the slot →
   3 Reserve & pay in the same tap: the booking lands with an AP2-style payment mandate
   attached, so the provider knows you're real. Payments become a non-thought. */
import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "../adam/adam.module.css";

type Seniority = "rising" | "established" | "top";
interface Band { sessionUsd: number; feeLowUsd: number; feeSuggestedUsd: number; feeHighUsd: number }
interface Slot { startsAt: string; minutes: number; label: string }
interface CatalogEntry {
  id: string; emoji: string; title: string; subtitle: string;
  sessionMinutes: number[];
  bands: Record<Seniority, Band>;
  slots: Slot[];
}
interface Reservation {
  id: string; categoryTitle: string; seniority: Seniority; slot: Slot;
  feeUsd: number; sessionUsd: number; status: string;
  mandate: { mode: string; amountUsd: number; capture: string; refund: string };
}

const SENIORITY_LABEL: Record<Seniority, string> = { rising: "Rising", established: "Established", top: "Top of field" };
const money = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;

export default function ReserveExperience() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [seniority, setSeniority] = useState<Seniority>("established");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [fee, setFee] = useState<number | null>(null);
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/reserve")
      .then((r) => r.json())
      .then((d) => setCatalog(d.catalog))
      .catch(() => setError("Reserve couldn't load right now — pull to refresh."));
  }, []);

  const service = catalog.find((c) => c.id === serviceId) ?? null;
  const band = service?.bands[seniority] ?? null;

  function pickService(id: string) {
    setServiceId(id);
    setReservation(null);
    setVisible(false);
    setSlot(null);
    setFee(null);
    setError(null);
  }

  async function reserve() {
    if (!service || !slot || fee == null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categoryId: service.id, seniority, startsAt: slot.startsAt, minutes: slot.minutes, feeUsd: fee }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setReservation(data.reservation);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } catch {
      setError("That didn't book — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.glow} aria-hidden />
        <p className={styles.kicker}>Reserve · by 🤫 One</p>
        <h1 className={styles.h1}>Book the person. Pay in the same tap.</h1>
        <p className={styles.lede}>
          Pick who you need. One already knows the fair fee — you choose within the band, reserve the slot, and the
          payment rides along. Booked means booked: they know you&apos;re real, you know they&apos;ll show.
        </p>

        <p className={styles.sectionLabel}>Who do you need?</p>
        <div className={styles.asks}>
          {catalog.map((c) => (
            <button key={c.id} className={`${styles.ask} ${serviceId === c.id ? styles.askActive : ""}`} onClick={() => pickService(c.id)}>
              <span className={styles.askEmoji} aria-hidden>{c.emoji}</span>
              <div className={styles.askTitle}>{c.title}</div>
              <div className={styles.askSub}>{c.subtitle}</div>
            </button>
          ))}
        </div>

        {service && !reservation && (
          <>
            <p className={styles.sectionLabel}>Their level</p>
            <div className={styles.chips} role="radiogroup" aria-label="Provider level">
              {(Object.keys(SENIORITY_LABEL) as Seniority[]).map((s) => (
                <button key={s} role="radio" aria-checked={seniority === s}
                  className={`${styles.chip} ${seniority === s ? styles.chipActive : ""}`}
                  onClick={() => { setSeniority(s); setFee(null); }}>
                  {SENIORITY_LABEL[s]}
                </button>
              ))}
            </div>

            <p className={styles.sectionLabel}>When</p>
            <div className={styles.chips} role="radiogroup" aria-label="Time slot">
              {service.slots.map((s) => (
                <button key={s.startsAt} role="radio" aria-checked={slot?.startsAt === s.startsAt}
                  className={`${styles.chip} ${slot?.startsAt === s.startsAt ? styles.chipActive : ""}`}
                  onClick={() => setSlot(s)}>
                  {s.label}
                </button>
              ))}
            </div>

            {band && (
              <>
                <p className={styles.sectionLabel}>Reservation fee — One&apos;s read on what this is worth</p>
                <div className={styles.chips} role="radiogroup" aria-label="Reservation fee">
                  {[band.feeLowUsd, band.feeSuggestedUsd, band.feeHighUsd].map((f, i) => (
                    <button key={f} role="radio" aria-checked={fee === f}
                      className={`${styles.chip} ${fee === f ? styles.chipActive : ""}`}
                      onClick={() => setFee(f)}>
                      {money(f)}{i === 1 ? " · most book this" : ""}
                    </button>
                  ))}
                </div>
                <p className={styles.foot} style={{ marginTop: 8 }}>
                  Full session ~{money(band.sessionUsd)} · the fee holds the slot and counts toward it.
                </p>
              </>
            )}

            <button className={styles.cta} disabled={!slot || fee == null || busy} style={!slot || fee == null ? { opacity: 0.45 } : undefined} onClick={() => void reserve()}>
              {busy ? "Reserving…" : fee != null ? `Reserve & pay ${money(fee)}` : "Reserve & pay"}
            </button>
          </>
        )}

        {error && <p className={styles.foot} role="alert">{error}</p>}

        {reservation && (
          <section className={`${styles.plan} ${styles.planLocal} ${visible ? styles.planIn : ""}`} aria-live="polite">
            <p className={styles.planWhere}>Reserved — payment attached</p>
            <h2 className={styles.planHeadline}>{reservation.categoryTitle} · {reservation.slot.label}</h2>
            <p className={styles.planReason}>
              {money(reservation.feeUsd)} rides with the booking ({reservation.mandate.mode} mandate). It captures when
              they confirm, refunds in full if they can&apos;t make it — and counts toward the ~{money(reservation.sessionUsd)} session.
            </p>
            <div className={styles.planStats}>
              <div className={styles.planStat}><div className={styles.planStatV}>{money(reservation.feeUsd)}</div><div className={styles.planStatK}>reserved with</div></div>
              <div className={styles.planStat}><div className={styles.planStatV}>{reservation.slot.minutes} min</div><div className={styles.planStatK}>held for you</div></div>
              <div className={styles.planStat}><div className={styles.planStatV}>{SENIORITY_LABEL[reservation.seniority]}</div><div className={styles.planStatK}>level</div></div>
            </div>
            <button className={`${styles.cta} ${styles.ctaQuiet}`} onClick={() => { setReservation(null); setVisible(false); }}>
              Book another
            </button>
          </section>
        )}

        <p className={styles.foot}>
          Fees come from One&apos;s modeled booking analytics — a fair band, never a blank price box. Payment mandates are
          AP2-style and preview-mode until live rails are wired. Part of the <Link href="/network">🤫 One network</Link>{" "}
          · <Link href="/adam">Adam, the supercomputing agent</Link>.
        </p>
      </div>
    </div>
  );
}
