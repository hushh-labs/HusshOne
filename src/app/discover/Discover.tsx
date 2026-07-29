"use client";

/* /discover — the real-time, location-aware discovery feed (Phase 1, deliverable #9).

   This REPLACES the DB-table experience for everyday use: instead of one blocking request that returns a
   static snapshot, it POSTs a location to /api/local-discovery/search and then attaches to the returned
   Server-Sent-Events stream, rendering each category's results the moment they resolve. The classic
   directory page (/localfinder) stays reachable as a fallback (linked in the nav).

   Data flow:
     1. POST /api/local-discovery/search  { lat,lng | postalCode,countryCode, radius, categories, sort, filters }
        → 202 { searchId, query (resolved), warnings, links:{ stream }, spend }
     2. new EventSource(links.stream)  — the stream carries the resolved query so it re-attaches on any
        instance. Named SSE events map 1:1 to DiscoveryEvent.type.
     3. Progressive render: while searching, results are grouped per category with independent loading
        indicators; on `search_complete` the UI settles on the server's authoritative merged + ranked list.

   Location honesty: when the origin came from a postal centroid (`approximateOrigin`) or a profile's own
   location is a centroid (`distanceApproximate` / `approximateLocation`), distances render with a "~" and an
   "approximate" marker — never a misleading exact "0 m".

   Monochrome (black/white/grey; no blue), typeset in Lexend (scoped in discover.module.css). */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./discover.module.css";
import {
  DISCOVERY_CATEGORIES,
  SORT_ORDERS,
  type CategoryStatus,
  type DiscoveryCategory,
  type ProfileQuality,
  type ResolvedQuery,
  type SortOrder,
  type SourceKind,
  type UnifiedProfile,
} from "@/lib/local-discovery/types";

// ---------------------------------------------------------------------------
// Static config + small formatters
// ---------------------------------------------------------------------------

const RADII = [
  { label: "2 km", m: 2000 },
  { label: "5 km", m: 5000 },
  { label: "10 km", m: 10000 },
  { label: "25 km", m: 25000 },
];

const MIN_RATINGS = [
  { label: "Any", v: 0 },
  { label: "3.5+", v: 3.5 },
  { label: "4.0+", v: 4 },
  { label: "4.5+", v: 4.5 },
];

const CATEGORY_LABEL: Record<DiscoveryCategory, string> = {
  hotels: "Hotels",
  healthcare: "Healthcare",
};

const SORT_LABEL: Record<SortOrder, string> = {
  recommended: "Recommended",
  nearest: "Nearest",
  rating: "Top rated",
  reviews: "Most reviewed",
};

/** Human label per source kind (falls back to the attribution's own label when present). */
const SOURCE_LABEL: Record<SourceKind, string> = {
  directory: "hushh directory",
  registry: "Official registry",
  google_places: "Google Places",
  grounded_web: "Web",
  osm: "OpenStreetMap",
  user_input: "You",
};

/** Sources that constitute independent VERIFICATION (authoritative registry or our own seeded directory). */
const VERIFYING_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>(["registry", "directory"]);

const QUALITY_LABEL: Record<ProfileQuality, string> = {
  rich: "Rich profile",
  standard: "Standard",
  basic: "Basic",
  insufficient: "Sparse",
};

function fmtDist(m: number | undefined, approx: boolean): string {
  if (m == null || !Number.isFinite(m)) return "—";
  const s = m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  return approx ? `~${s}` : s;
}
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}
function httpHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// ---------------------------------------------------------------------------
// SSE event payloads (mirror DiscoveryEvent — each named frame's data IS the event object)
// ---------------------------------------------------------------------------

type StartedPayload = { searchId: string; query: ResolvedQuery };
type CatStartedPayload = { category: DiscoveryCategory };
type CatResultsPayload = { category: DiscoveryCategory; profiles: UnifiedProfile[]; status: CategoryStatus; warnings: string[] };
type CatErrorPayload = { category: DiscoveryCategory; error: string };
type CompletePayload = { count: number; results: UnifiedProfile[]; warnings: string[] };

type CategoryState = { status: CategoryStatus; profiles: UnifiedProfile[]; warnings: string[]; error?: string };
type SpendSnapshot = { totalUsd: number; budgetUsd: number; remainingUsd: number };
type SearchPhase = "idle" | "searching" | "complete" | "error";

type PostResponse =
  | { ok: true; searchId: string; query: ResolvedQuery; warnings: string[]; links: { self: string; events: string; stream: string }; spend: SpendSnapshot }
  | { ok: false; error: string; code: string };

const STATUS_LABEL: Record<CategoryStatus, string> = {
  pending: "Queued",
  loading: "Searching…",
  done: "Done",
  degraded: "Cached / partial",
  error: "Unavailable",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Discover() {
  // Location input
  const [mode, setMode] = useState<"gps" | "postal">("gps");
  const [postal, setPostal] = useState("");
  const [country, setCountry] = useState("US");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);

  // Query knobs
  const [radiusM, setRadiusM] = useState(5000);
  const [cats, setCats] = useState<Set<DiscoveryCategory>>(() => new Set(DISCOVERY_CATEGORIES));
  const [sort, setSort] = useState<SortOrder>("recommended");
  const [minRating, setMinRating] = useState(0);
  const [openNow, setOpenNow] = useState(false);
  const [queryText, setQueryText] = useState("");

  // Search lifecycle
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedQuery | null>(null);
  const [spend, setSpend] = useState<SpendSnapshot | null>(null);
  const [catState, setCatState] = useState<Partial<Record<DiscoveryCategory, CategoryState>>>({});
  const [finalResults, setFinalResults] = useState<UnifiedProfile[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Monotonic search generation — every run() bumps it; async POST/SSE handlers pin their seq and drop
  // results if a newer search superseded them (same staleness guard as /localfinder's runSeq).
  const runSeq = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  // Close the stream on unmount so a background search never keeps reconnecting.
  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const useMyLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Geolocation is not available in this browser. Enter a postal code instead.");
      setMode("postal");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setMode("gps");
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Enter a postal code instead."
            : "Could not get your location. Enter a postal code instead.",
        );
        setMode("postal");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }, []);

  const toggleCat = useCallback((c: DiscoveryCategory) => {
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) {
        if (next.size > 1) next.delete(c); // never allow zero categories
      } else {
        next.add(c);
      }
      return next;
    });
  }, []);

  const run = useCallback(async () => {
    const seq = (runSeq.current += 1);
    esRef.current?.close();
    esRef.current = null;

    const selected = [...DISCOVERY_CATEGORIES].filter((c) => cats.has(c));
    if (!selected.length) {
      setError("Pick at least one category.");
      return;
    }

    // Build the request body from the active input mode.
    const body: Record<string, unknown> = {
      radius: radiusM,
      categories: selected.join(","),
      sort,
      limit: 30,
    };
    if (minRating > 0) body.minRating = minRating;
    if (openNow) body.openNow = true;
    if (queryText.trim()) body.query = queryText.trim();

    if (mode === "gps") {
      if (!coords) {
        setError("Share your location first, or switch to postal code.");
        return;
      }
      body.lat = coords.lat;
      body.lng = coords.lng;
    } else {
      if (!postal.trim()) {
        setError("Enter a postal code.");
        return;
      }
      body.postalCode = postal.trim();
      body.countryCode = country.trim() || "US";
    }

    setPhase("searching");
    setError(null);
    setFinalResults(null);
    setResolved(null);
    setWarnings([]);
    setCatState(Object.fromEntries(selected.map((c) => [c, { status: "pending" as CategoryStatus, profiles: [], warnings: [] }])));

    let post: PostResponse;
    try {
      const res = await fetch("/api/local-discovery/search", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      post = (await res.json()) as PostResponse;
      if (runSeq.current !== seq) return; // superseded
      if (!res.ok || !post.ok) {
        setPhase("error");
        setError(("error" in post && post.error) || `Search failed (${res.status})`);
        return;
      }
    } catch (e) {
      if (runSeq.current !== seq) return;
      setPhase("error");
      setError(e instanceof Error ? e.message : "Network error");
      return;
    }

    setResolved(post.query);
    setSpend(post.spend);
    if (post.warnings?.length) setWarnings(post.warnings);

    // Attach to the SSE stream. Named events map to DiscoveryEvent.type; the stream URL carries the
    // resolved query so a cross-instance re-attach rebuilds the same session.
    const es = new EventSource(post.links.stream);
    esRef.current = es;

    let completed = false;
    const alive = () => runSeq.current === seq && esRef.current === es;

    es.addEventListener("search_started", (e) => {
      if (!alive()) return;
      const data = JSON.parse((e as MessageEvent).data) as StartedPayload;
      setResolved(data.query);
    });
    es.addEventListener("category_started", (e) => {
      if (!alive()) return;
      const { category } = JSON.parse((e as MessageEvent).data) as CatStartedPayload;
      setCatState((prev) => ({ ...prev, [category]: { ...(prev[category] ?? { profiles: [], warnings: [] }), status: "loading" } }));
    });
    es.addEventListener("category_results", (e) => {
      if (!alive()) return;
      const d = JSON.parse((e as MessageEvent).data) as CatResultsPayload;
      setCatState((prev) => ({ ...prev, [d.category]: { status: d.status, profiles: d.profiles, warnings: d.warnings } }));
    });
    es.addEventListener("category_error", (e) => {
      if (!alive()) return;
      const d = JSON.parse((e as MessageEvent).data) as CatErrorPayload;
      setCatState((prev) => ({ ...prev, [d.category]: { status: "error", profiles: [], warnings: [], error: d.error } }));
    });
    es.addEventListener("search_complete", (e) => {
      if (!alive()) {
        es.close();
        return;
      }
      const d = JSON.parse((e as MessageEvent).data) as CompletePayload;
      completed = true;
      setFinalResults(d.results);
      if (d.warnings?.length) setWarnings(d.warnings);
      setPhase("complete");
      es.close(); // terminal — prevents EventSource's automatic reconnect
      if (esRef.current === es) esRef.current = null;
    });
    es.addEventListener("timeout", () => {
      if (!alive()) return;
      setWarnings((w) => (w.includes("Still working — some results may be incomplete.") ? w : [...w, "Still working — some results may be incomplete."]));
    });
    es.onerror = () => {
      // EventSource auto-reconnects while CONNECTING; only surface a failure once it has truly given up
      // (readyState CLOSED) and the search hadn't already completed.
      if (es.readyState === EventSource.CLOSED && alive() && !completed) {
        setPhase("error");
        setError("Live connection interrupted. Try the search again.");
        if (esRef.current === es) esRef.current = null;
      }
    };
  }, [cats, radiusM, sort, minRating, openNow, queryText, mode, coords, postal, country]);

  const canSearch = (mode === "gps" ? !!coords : postal.trim().length > 0) && cats.size > 0 && phase !== "searching";
  const selectedCats = useMemo(() => [...DISCOVERY_CATEGORIES].filter((c) => cats.has(c)), [cats]);

  // While searching we render per-category groups (progressive, independent). Once complete we settle on
  // the server's authoritative merged + ranked list.
  const usesGoogle = useMemo(() => {
    const pool = finalResults ?? Object.values(catState).flatMap((s) => s?.profiles ?? []);
    return pool.some((p) => p.sources.some((s) => s.kind === "google_places"));
  }, [finalResults, catState]);

  return (
    <div className={styles.page}>
      {/* nav */}
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <Link className={styles.brand} href="/">
            <b>hushh</b> <span>· discover</span>
          </Link>
          <div className={styles.navLinks}>
            <Link className={styles.navLink} href="/localfinder">Classic directory</Link>
            <Link className={styles.navLink} href="/docs">Docs</Link>
          </div>
        </div>
      </nav>

      <main className={styles.wrap}>
        {/* hero */}
        <header className={styles.hero}>
          <p className={styles.eyebrow}>Real-time · location-aware</p>
          <h1 className={styles.h1}>Discover what&apos;s nearby, live.</h1>
          <p className={styles.lede}>
            Share your location or enter a postal code. Each category streams in as it resolves — seeded from
            hushh&apos;s directory, verified against official registries, and enriched in real time.
          </p>
        </header>

        {/* control panel */}
        <section className={styles.panel} aria-label="Search controls">
          <div className={styles.panelBody}>
            {/* location mode */}
            <div className={styles.modeRow}>
              <button
                type="button"
                className={`${styles.modeBtn} ${mode === "gps" ? styles.modeBtnActive : ""}`}
                onClick={() => setMode("gps")}
                aria-pressed={mode === "gps"}
              >
                Use my location
              </button>
              <button
                type="button"
                className={`${styles.modeBtn} ${mode === "postal" ? styles.modeBtnActive : ""}`}
                onClick={() => setMode("postal")}
                aria-pressed={mode === "postal"}
              >
                Postal code
              </button>
            </div>

            {mode === "gps" ? (
              <div className={styles.gpsRow}>
                <button type="button" className={styles.btn} onClick={useMyLocation} disabled={locating}>
                  {locating ? <span className={styles.spinner} aria-hidden /> : null}
                  {coords ? "Update my location" : "Share my location"}
                </button>
                {coords ? (
                  <span className={styles.coordChip}>
                    {coords.lat.toFixed(4)}, {coords.lng.toFixed(4)}
                  </span>
                ) : (
                  <span className={styles.hint}>Your browser will ask for permission.</span>
                )}
              </div>
            ) : (
              <div className={styles.form}>
                <div className={styles.field} style={{ flex: "2 1 220px" }}>
                  <label className={styles.fieldLabel} htmlFor="d-postal">Postal code</label>
                  <input
                    id="d-postal"
                    className={styles.input}
                    value={postal}
                    onChange={(e) => setPostal(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && canSearch && run()}
                    placeholder="98033"
                    inputMode="text"
                    autoComplete="postal-code"
                  />
                </div>
                <div className={styles.field} style={{ flex: "1 1 120px" }}>
                  <label className={styles.fieldLabel} htmlFor="d-country">Country</label>
                  <input
                    id="d-country"
                    className={styles.input}
                    value={country}
                    onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
                    placeholder="US"
                    maxLength={2}
                    autoComplete="country"
                  />
                </div>
              </div>
            )}

            {/* radius */}
            <div className={styles.radioRow}>
              <span className={styles.radioLabel}>Radius</span>
              {RADII.map((r) => (
                <button
                  key={r.m}
                  type="button"
                  className={`${styles.chip} ${radiusM === r.m ? styles.chipActive : ""}`}
                  onClick={() => setRadiusM(r.m)}
                  aria-pressed={radiusM === r.m}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {/* categories */}
            <div className={styles.radioRow}>
              <span className={styles.radioLabel}>Categories</span>
              {[...DISCOVERY_CATEGORIES].map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`${styles.chip} ${cats.has(c) ? styles.chipActive : ""}`}
                  onClick={() => toggleCat(c)}
                  aria-pressed={cats.has(c)}
                >
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>

            {/* filters */}
            <div className={styles.radioRow}>
              <span className={styles.radioLabel}>Min rating</span>
              {MIN_RATINGS.map((r) => (
                <button
                  key={r.v}
                  type="button"
                  className={`${styles.chip} ${minRating === r.v ? styles.chipActive : ""}`}
                  onClick={() => setMinRating(r.v)}
                  aria-pressed={minRating === r.v}
                >
                  {r.label}
                </button>
              ))}
              <button
                type="button"
                className={`${styles.chip} ${openNow ? styles.chipActive : ""}`}
                onClick={() => setOpenNow((v) => !v)}
                aria-pressed={openNow}
              >
                Open now
              </button>
            </div>

            <div className={styles.form} style={{ marginTop: 16 }}>
              <div className={styles.field} style={{ flex: "2 1 240px" }}>
                <label className={styles.fieldLabel} htmlFor="d-q">Refine (optional)</label>
                <input
                  id="d-q"
                  className={styles.input}
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canSearch && run()}
                  placeholder="boutique, pediatric, spa…"
                />
              </div>
              <div className={styles.field} style={{ flex: "1 1 160px" }}>
                <label className={styles.fieldLabel} htmlFor="d-sort">Sort</label>
                <select id="d-sort" className={styles.input} value={sort} onChange={(e) => setSort(e.target.value as SortOrder)}>
                  {[...SORT_ORDERS].map((s) => (
                    <option key={s} value={s}>{SORT_LABEL[s]}</option>
                  ))}
                </select>
              </div>
              <button type="button" className={styles.btn} style={{ flex: "0 0 auto" }} onClick={run} disabled={!canSearch}>
                {phase === "searching" ? <span className={styles.spinner} aria-hidden /> : null}
                {phase === "searching" ? "Searching…" : "Discover"}
              </button>
            </div>

            {error ? <div className={styles.error} role="alert">{error}</div> : null}
          </div>
        </section>

        {/* results */}
        {phase !== "idle" ? (
          <section className={styles.results} aria-live="polite">
            {/* resolved-location + status header */}
            {resolved ? (
              <div className={styles.resultHead}>
                <div>
                  <div className={styles.resultTotal}>
                    {finalResults ? finalResults.length : selectedCats.reduce((n, c) => n + (catState[c]?.profiles.length ?? 0), 0)}
                    <span className={styles.resultTotalUnit}> nearby</span>
                  </div>
                  <div className={styles.resultMeta}>
                    near {resolved.lat.toFixed(3)}, {resolved.lng.toFixed(3)} · {fmtDist(resolved.radiusMeters, false)} radius
                    {resolved.countryCode ? ` · ${resolved.countryCode}` : ""}
                  </div>
                </div>
                {resolved.approximateOrigin ? (
                  <span className={styles.approxPill} title="Origin derived from a postal-code centroid — distances are approximate.">
                    ~ Approximate location
                  </span>
                ) : null}
              </div>
            ) : null}

            {/* per-category status strip */}
            <div className={styles.statusStrip}>
              {selectedCats.map((c) => {
                const st = catState[c];
                const status = st?.status ?? "pending";
                return (
                  <span key={c} className={`${styles.statusChip} ${styles[`status_${status}`] ?? ""}`}>
                    {(status === "loading" || status === "pending") ? <span className={styles.spinnerSm} aria-hidden /> : null}
                    <b>{CATEGORY_LABEL[c]}</b>
                    <span className={styles.statusText}>{STATUS_LABEL[status]}</span>
                    {st && status !== "loading" && status !== "pending" ? (
                      <span className={styles.statusCount}>{st.profiles.length}</span>
                    ) : null}
                  </span>
                );
              })}
            </div>

            {warnings.length ? (
              <ul className={styles.warnings}>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}

            {/* body: grouped while streaming, flat authoritative list once complete */}
            {finalResults ? (
              finalResults.length ? (
                <div className={styles.grid}>
                  {finalResults.map((p) => (
                    <ProfileCard key={p.id} p={p} />
                  ))}
                </div>
              ) : (
                <p className={styles.empty}>No matching places within {fmtDist(resolved?.radiusMeters, false)}. Try a wider radius or fewer filters.</p>
              )
            ) : (
              <div className={styles.groups}>
                {selectedCats.map((c) => {
                  const st = catState[c];
                  const profiles = st?.profiles ?? [];
                  return (
                    <div key={c} className={styles.group}>
                      <h3 className={styles.groupTitle}>
                        {CATEGORY_LABEL[c]}
                        {st?.status === "loading" || !st ? <span className={styles.spinnerSm} aria-hidden /> : null}
                      </h3>
                      {st?.error ? (
                        <p className={styles.groupNote}>{st.error}</p>
                      ) : profiles.length ? (
                        <div className={styles.grid}>
                          {profiles.map((p) => (
                            <ProfileCard key={p.id} p={p} />
                          ))}
                        </div>
                      ) : st && st.status !== "loading" && st.status !== "pending" ? (
                        <p className={styles.groupNote}>Nothing found in this category.</p>
                      ) : (
                        <div className={styles.grid}>
                          <SkeletonCard />
                          <SkeletonCard />
                          <SkeletonCard />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Google Places attribution — required whenever any rendered profile used Places (ToS). */}
            {usesGoogle ? <p className={styles.attribution}>Place details &amp; photos © Google</p> : null}
            {spend ? (
              <p className={styles.spend}>
                Live-enrichment spend this search: ${spend.totalUsd.toFixed(2)} · daily budget ${spend.budgetUsd.toFixed(0)} (${spend.remainingUsd.toFixed(2)} left)
              </p>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function ProfileCard({ p }: { p: UnifiedProfile }) {
  const approx = p.distanceApproximate || p.approximateLocation;
  const verified = p.sources.filter((s) => VERIFYING_KINDS.has(s.kind));
  // Unique source kinds for chips (label taken from the attribution when it differs from the default).
  const kinds = useMemo(() => {
    const seen = new Map<SourceKind, string>();
    for (const s of p.sources) if (!seen.has(s.kind)) seen.set(s.kind, s.label || SOURCE_LABEL[s.kind]);
    return [...seen.entries()];
  }, [p.sources]);
  const citations = p.sources.filter((s) => s.kind === "grounded_web" && s.url);

  return (
    <article className={`${styles.card} ${p.quality === "insufficient" ? styles.cardSparse : ""}`}>
      {p.imageUrl ? (
        // View-time image (not persisted). eslint-disable to keep next/image out of a purely remote, ToS-bound URL.
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.cardImg} src={p.imageUrl} alt="" loading="lazy" />
      ) : null}
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <h4 className={styles.cardName}>{p.name}</h4>
          <span className={styles.cardDist}>{fmtDist(p.distanceMeters, approx)}</span>
        </div>

        {p.headline ? <p className={styles.cardHeadline}>{p.headline}</p> : null}

        <div className={styles.metaRow}>
          {typeof p.rating === "number" ? (
            <span className={styles.rating}>
              {p.rating.toFixed(1)}★{typeof p.reviewCount === "number" ? <span className={styles.reviews}> · {p.reviewCount.toLocaleString("en-US")}</span> : null}
            </span>
          ) : null}
          {p.openingHours?.openNow != null ? (
            <span className={p.openingHours.openNow ? styles.openNow : styles.closedNow}>
              {p.openingHours.openNow ? "Open now" : "Closed"}
            </span>
          ) : null}
          <span className={`${styles.qualityPill} ${styles[`quality_${p.quality}`] ?? ""}`}>{QUALITY_LABEL[p.quality]}</span>
        </div>

        {p.address ? <p className={styles.cardAddr}>{p.address}</p> : null}
        {p.credentials?.length ? <p className={styles.cardCreds}>{p.credentials.slice(0, 4).join(" · ")}</p> : null}

        {(p.phone || p.website) && (
          <div className={styles.cardLinks}>
            {p.phone ? <a className={styles.cardLink} href={telHref(p.phone)}>{p.phone}</a> : null}
            {p.website ? (
              <a className={styles.cardLink} href={httpHref(p.website)} target="_blank" rel="noopener noreferrer nofollow">
                {hostOf(p.website)} ↗
              </a>
            ) : null}
          </div>
        )}

        <div className={styles.badges}>
          {verified.length ? (
            <span className={styles.verifiedBadge} title={verified.map((v) => v.label).join(", ")}>
              ✓ Verified
            </span>
          ) : null}
          {kinds.map(([kind, label]) => (
            <span key={kind} className={styles.sourceBadge}>{label}</span>
          ))}
        </div>

        {citations.length ? (
          <div className={styles.citations}>
            {citations.slice(0, 3).map((c, i) => (
              <a key={i} className={styles.citation} href={httpHref(c.url!)} target="_blank" rel="noopener noreferrer nofollow">
                {hostOf(c.url!)} ↗
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function SkeletonCard() {
  return (
    <div className={`${styles.card} ${styles.skeleton}`} aria-hidden>
      <div className={styles.cardBody}>
        <div className={styles.skLine} style={{ width: "70%" }} />
        <div className={styles.skLine} style={{ width: "45%" }} />
        <div className={styles.skLine} style={{ width: "90%" }} />
      </div>
    </div>
  );
}
