"use client";

/* Adam — the three-moment experience.
   1 Ask (pick a job, your device is auto-detected) → 2 Adam decides (the plan card
   springs in: on-device, or burst to the matched Google Cloud SKU with cost + time)
   → 3 Do it (one CTA into the real BYOC burst path). No settings, no console. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FamilyDock from "@/components/one/FamilyDock";
import { matchVoiceAsk, speechRecognizer } from "@/lib/adam/voice";
import styles from "./adam.module.css";

interface DeviceOption { id: string; label: string }
interface PresetOption {
  id: string; emoji: string; title: string; subtitle: string;
  acceleratorKind: "gpu" | "tpu";
}
interface Plan {
  device: { id: string; label: string };
  placement: { target: "puppy" | "gcp"; reason: string };
  recommendation: { accel: { label: string; kind: string }; count: number; usdPerHour: number; fits: boolean; rationale: string } | null;
  benchmark: Array<{ role: "undersized" | "matched" | "oversized"; label: string; feasible: boolean; wallMinutes: number | null; costUsd: number | null; note: string }>;
  estimatedCostUsd: number | null;
  estimatedMinutes: number | null;
}

/** Best-effort device guess — a starting point the user can change with one tap. */
function guessDeviceId(): string {
  if (typeof navigator === "undefined") return "iphone-17-pro";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iphone-17-pro";
  if (/iPad/.test(ua)) return "ipad-pro-m4";
  if (/Macintosh/.test(ua)) {
    // iPadOS 13+ masquerades as Mac; touch support is the tell.
    return navigator.maxTouchPoints > 1 ? "ipad-pro-m4" : "macbook-pro-m4-max";
  }
  if (/Windows/.test(ua)) return "windows-laptop";
  return "iphone-17-pro";
}

const money = (n: number) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
const clock = (min: number) => (min < 90 ? `${Math.round(min)} min` : `${(min / 60).toFixed(1)} hr`);

export default function AdamExperience() {
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [presets, setPresets] = useState<PresetOption[]>([]);
  const [deviceId, setDeviceId] = useState("iphone-17-pro");
  const [presetId, setPresetId] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planVisible, setPlanVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showBench, setShowBench] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canListen, setCanListen] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const recognizerRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    setDeviceId(guessDeviceId());
    setCanListen(speechRecognizer() != null);
    fetch("/api/adam/plan")
      .then((r) => r.json())
      .then((d) => { setDevices(d.devices); setPresets(d.presets); })
      .catch(() => setError("Adam couldn't load right now — pull to refresh."));
    return () => recognizerRef.current?.stop();
  }, []);

  const ask = useCallback(async (pid: string, did: string) => {
    setPresetId(pid);
    setLoading(true);
    setError(null);
    setShowBench(false);
    setPlanVisible(false);
    try {
      const res = await fetch("/api/adam/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ presetId: pid, deviceId: did }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setPlan(await res.json());
      // Let the card mount hidden, then spring in on the next frame.
      requestAnimationFrame(() => requestAnimationFrame(() => setPlanVisible(true)));
    } catch {
      setPlan(null);
      setError("Adam couldn't plan that one — try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  const listen = useCallback(() => {
    const Ctor = speechRecognizer();
    if (!Ctor || listening) return;
    const rec = new Ctor();
    recognizerRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    setListening(true);
    setHeard(null);
    rec.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      setHeard(transcript);
      const match = matchVoiceAsk(transcript);
      if (match) void ask(match, deviceId);
      else setError("Adam heard you, but didn't recognize that ask — tap one below.");
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
  }, [ask, deviceId, listening]);

  const onDevice = plan?.placement.target === "puppy";
  const deviceLabel = useMemo(
    () => devices.find((d) => d.id === deviceId)?.label ?? "your device",
    [devices, deviceId],
  );

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.glow} aria-hidden />
        <p className={styles.kicker}>Adam · by 🤫 One</p>
        <h1 className={styles.h1}>Your phone is a supercomputer.</h1>
        <p className={styles.lede}>
          Ask for something your device could never do. Adam runs it where it finishes best — on the device in your
          hand, or burst to Google Cloud&apos;s biggest machines — and brings the answer home.
        </p>

        <p className={styles.sectionLabel}>Your device</p>
        <div className={styles.chips} role="radiogroup" aria-label="Your device">
          {devices.map((d) => (
            <button
              key={d.id}
              role="radio"
              aria-checked={deviceId === d.id}
              className={`${styles.chip} ${deviceId === d.id ? styles.chipActive : ""}`}
              onClick={() => { setDeviceId(d.id); if (presetId) void ask(presetId, d.id); }}
            >
              {d.label}
            </button>
          ))}
        </div>

        <p className={styles.sectionLabel}>Ask Adam</p>
        {canListen && (
          <p style={{ margin: "0 0 12px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button className={`${styles.mic} ${listening ? styles.micLive : ""}`} onClick={listen} aria-pressed={listening}>
              <span aria-hidden>🎙️</span> {listening ? "Listening…" : "Say it"}
            </button>
            {heard && <span className={styles.heard}>“{heard}”</span>}
          </p>
        )}
        <div className={styles.asks}>
          {presets.map((p) => (
            <button
              key={p.id}
              className={`${styles.ask} ${presetId === p.id ? styles.askActive : ""}`}
              onClick={() => void ask(p.id, deviceId)}
            >
              <span className={styles.askEmoji} aria-hidden>{p.emoji}</span>
              <div className={styles.askTitle}>{p.title}</div>
              <div className={styles.askSub}>{p.subtitle}</div>
            </button>
          ))}
        </div>

        {error && <p className={styles.foot} role="alert">{error}</p>}
        {loading && <p className={styles.foot}><span className={styles.spin} aria-hidden /> Adam is deciding…</p>}

        {plan && !loading && (
          <section
            className={`${styles.plan} ${onDevice ? styles.planLocal : ""} ${planVisible ? styles.planIn : ""}`}
            aria-live="polite"
          >
            <p className={styles.planWhere}>{onDevice ? `Runs on your ${plan.device.label}` : "Bursting to your Google Cloud"}</p>
            <h2 className={styles.planHeadline}>
              {onDevice
                ? "This one's free. It fits right here."
                : plan.recommendation
                  ? `${plan.recommendation.count}× ${plan.recommendation.accel.label}`
                  : "The cloud takes this one."}
            </h2>
            <p className={styles.planReason}>{plan.placement.reason}</p>

            <div className={styles.planStats}>
              <div className={styles.planStat}>
                <div className={styles.planStatV}>{plan.estimatedCostUsd === 0 ? "$0" : plan.estimatedCostUsd != null ? money(plan.estimatedCostUsd) : "—"}</div>
                <div className={styles.planStatK}>estimated cost</div>
              </div>
              <div className={styles.planStat}>
                <div className={styles.planStatV}>{plan.estimatedMinutes != null ? clock(plan.estimatedMinutes) : "—"}</div>
                <div className={styles.planStatK}>time to result</div>
              </div>
              {!onDevice && plan.recommendation && (
                <div className={styles.planStat}>
                  <div className={styles.planStatV}>{money(plan.recommendation.usdPerHour)}/hr</div>
                  <div className={styles.planStatK}>only while it runs</div>
                </div>
              )}
            </div>

            {onDevice ? (
              <p className={styles.foot} style={{ marginTop: 16 }}>
                Adam keeps work on-device whenever it fits — private, instant, free.
              </p>
            ) : (
              <>
                <Link className={styles.cta} href="/burst/setup">Burst it — set up your cloud once</Link>
                <button className={`${styles.cta} ${styles.ctaQuiet}`} onClick={() => setShowBench((s) => !s)}>
                  {showBench ? "Hide" : "Why this hardware?"}
                </button>
                {showBench && (
                  <div className={styles.bench}>
                    {plan.benchmark.map((b) => (
                      <div key={b.role} className={`${styles.benchRow} ${b.role === "matched" ? styles.benchMatched : ""}`}>
                        <span className={styles.benchLabel}>{b.feasible ? b.label : `${b.label} — won't fit`}</span>
                        <span>{b.feasible && b.wallMinutes != null ? clock(b.wallMinutes) : "—"}</span>
                        <span>{b.feasible && b.costUsd != null ? money(b.costUsd) : "—"}</span>
                      </div>
                    ))}
                    <p className={styles.foot} style={{ marginTop: 8 }}>
                      Adam picks the performance-per-dollar that fits — not the biggest box, not one too small.
                    </p>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        <p className={styles.foot}>
          Planning on {deviceLabel} is free and instant. Real bursts run in <em>your own</em> Google Cloud — pay per
          second, keys never persisted, the machine is torn down the moment your answer lands. Part of the{" "}
          <Link href="/network">🤫 One network of agents</Link> · <Link href="/customers">customer stories</Link>.
        </p>
        <p className={styles.letterhead}>
          Built and published by the 🤫 Research &amp; Advisory Team · Signed <strong>🤫 Confidential</strong><br />
          <span className={styles.letterheadSig}>Simplicity is the signature of excellence.</span>
        </p>
      </div>
      <FamilyDock active="/adam" />
    </div>
  );
}
