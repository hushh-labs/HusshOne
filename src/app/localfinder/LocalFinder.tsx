"use client";

/* /localfinder — public developer page for the coordinate-driven directory API.
   Monochrome (black/white/grey; no blue), typeset in Lexend (scoped in localfinder.module.css).
   Two things in one page:
     1. an interactive panel — enter a ZIP or share GPS, and see how many hotels / healthcare providers /
        RIA firms / insurance producers hushh has near that point. It calls the PUBLIC, key-free
        GET /api/localfinder (summary shape).
     2. documentation for the real, Bearer-gated GET /api/v1/directory (full per-row firehose).
   Copy is deliberately terse — the panel and the tables carry the page, not prose. */
import { useCallback, useMemo, useRef, useState } from "react";
import styles from "./localfinder.module.css";

type GeoPrecision = "rooftop" | "zip_centroid";
type RowDetail = {
  phone: string | null;
  website: string | null;
  address: string | null;
  url: string | null;
  urlLabel: string | null;
};
type SampleRow = {
  id: string;
  name: string;
  subtitle: string | null;
  location: string | null;
  distanceM: number;
  geoPrecision: GeoPrecision;
  detail: RowDetail;
};
type VerticalSummary = { vertical: string; label: string; count: number; sample: SampleRow[]; error?: string };
type SpecialtyBucket = { specialty: string; count: number };
type Summary = {
  ok: true;
  query: { lat: number; lng: number; radiusM: number; resolvedFrom: "coordinates" | "zip"; zip?: string };
  totals: { records: number; verticals: number };
  verticals: VerticalSummary[];
  healthcareSpecialties: SpecialtyBucket[];
  warnings: string[];
};
type RowsResponse = { ok: true; vertical: string; page: number; pageSize: number; rows: SampleRow[]; warnings: string[] };
type ApiError = { ok: false; error: string; code: string };

/** Per-vertical paging state. `cache[page]` holds already-fetched pages (page 0 is seeded from the
 *  summary's sample), so Prev/Next between visited pages is instant. */
type PageState = { page: number; cache: Record<number, SampleRow[]>; loading: boolean; error: string | null };
type PagingByVertical = Record<string, PageState>;

const PAGE_SIZE = 10;

const RADII = [
  { label: "2 km", m: 2000 },
  { label: "5 km", m: 5000 },
  { label: "10 km", m: 10000 },
  { label: "25 km", m: 25000 },
];

function fmtDist(m: number): string {
  if (!Number.isFinite(m)) return "—";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
/** Bare host for a display link (backend already normalized to an absolute http/https URL). */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
/** Strip a phone down to a dialable tel: target while keeping a leading +. */
function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

export default function LocalFinder() {
  const [zip, setZip] = useState("");
  const [radiusM, setRadiusM] = useState(5000);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Summary | null>(null);
  const [paging, setPaging] = useState<PagingByVertical>({});
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  /* Monotonic search generation. Bumped at the start of every run(); each in-flight summary AND rows fetch
     pins the value it started under and drops its result if a newer search has begun. Without this, a slow
     rows fetch from a PREVIOUS location could resolve after a fresh search reseeded state and write stale,
     wrong-location rows into the new card (under the new count/label). A ref (not state) so the guard reads
     the live latest value inside async callbacks without re-creating them. */
  const runSeq = useRef(0);

  const run = useCallback(async (qs: string) => {
    const seq = (runSeq.current += 1); // this search supersedes any earlier in-flight summary/rows fetches
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/localfinder?${qs}`, { headers: { accept: "application/json" } });
      const json = (await res.json()) as Summary | ApiError;
      if (runSeq.current !== seq) return; // a newer search started while this one was in flight — discard
      if (!res.ok || !json.ok) {
        setData(null);
        setError((json as ApiError).error || `Request failed (${res.status})`);
        return;
      }
      setData(json);
      // Seed page 0 of every vertical from the summary sample; reset any open drawers.
      const seed: PagingByVertical = {};
      for (const v of json.verticals) {
        seed[v.vertical] = { page: 0, cache: { 0: v.sample }, loading: false, error: null };
      }
      setPaging(seed);
      setOpenRows(new Set());
    } catch (e) {
      if (runSeq.current !== seq) return;
      setData(null);
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      if (runSeq.current === seq) setLoading(false);
    }
  }, []);

  /** Move a single card to `page`, fetching from /api/localfinder/rows on a cache miss. Paging always
   *  uses the resolved coordinates (stable — no ZIP re-resolution), and never throws to the caller. */
  const goToPage = useCallback(
    async (vertical: string, page: number) => {
      if (!data || page < 0) return;
      // Upper-bound no-op: the pager buttons stay focusable (aria-disabled, not native disabled) so a click
      // past the last page still fires onClick — bail here instead of issuing an out-of-range fetch.
      const count = data.verticals.find((x) => x.vertical === vertical)?.count ?? 0;
      const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
      if (page >= totalPages) return;
      const st = paging[vertical];
      if (!st || st.loading) return;
      if (st.cache[page]) {
        setPaging((prev) => (prev[vertical] ? { ...prev, [vertical]: { ...prev[vertical]!, page } } : prev));
        return;
      }
      const seq = runSeq.current; // pin this rows fetch to the current search generation
      setPaging((prev) =>
        prev[vertical] ? { ...prev, [vertical]: { ...prev[vertical]!, loading: true, error: null } } : prev,
      );
      try {
        const { lat, lng, radiusM } = data.query;
        const qs =
          `vertical=${encodeURIComponent(vertical)}&lat=${lat}&lng=${lng}` +
          `&radius=${radiusM}&page=${page}&pageSize=${PAGE_SIZE}`;
        const res = await fetch(`/api/localfinder/rows?${qs}`, { headers: { accept: "application/json" } });
        const json = (await res.json()) as RowsResponse | ApiError;
        // Drop the result if a newer search superseded this one — otherwise stale, wrong-location rows would
        // be written into the freshly-reseeded card. The `prev[vertical]` guards also protect against the
        // (post-reseed) case where the vertical key no longer exists in state.
        if (runSeq.current !== seq) return;
        if (!res.ok || !json.ok) {
          const msg = (json as ApiError).error || `Failed (${res.status})`;
          setPaging((prev) =>
            prev[vertical] ? { ...prev, [vertical]: { ...prev[vertical]!, loading: false, error: msg } } : prev,
          );
          return;
        }
        setPaging((prev) =>
          prev[vertical]
            ? {
                ...prev,
                [vertical]: {
                  ...prev[vertical]!,
                  page,
                  loading: false,
                  error: null,
                  cache: { ...prev[vertical]!.cache, [page]: json.rows },
                },
              }
            : prev,
        );
      } catch (e) {
        if (runSeq.current !== seq) return;
        const msg = e instanceof Error ? e.message : "Network error";
        setPaging((prev) =>
          prev[vertical] ? { ...prev, [vertical]: { ...prev[vertical]!, loading: false, error: msg } } : prev,
        );
      }
    },
    [data, paging],
  );

  /** Toggle a row's expand-in-place detail drawer. Keyed by vertical+id (ids are unique per vertical). */
  const toggleRow = useCallback((vertical: string, id: string) => {
    const key = `${vertical}:${id}`;
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const searchZip = useCallback(() => {
    const z = zip.trim();
    if (!z) {
      setError("Enter a ZIP code, or use your location.");
      return;
    }
    void run(`zip=${encodeURIComponent(z)}&radius=${radiusM}`);
  }, [zip, radiusM, run]);

  const useLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Geolocation is not available in this browser.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude, longitude } = pos.coords;
        void run(`lat=${latitude}&lng=${longitude}&radius=${radiusM}`);
      },
      (err) => {
        setLocating(false);
        setError(err.code === err.PERMISSION_DENIED ? "Location permission denied." : "Could not get your location.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }, [radiusM, run]);

  const specMax = useMemo(
    () => Math.max(1, ...(data?.healthcareSpecialties ?? []).map((s) => s.count)),
    [data],
  );

  const whereLabel = data
    ? data.query.resolvedFrom === "zip"
      ? `ZIP ${data.query.zip}`
      : `${data.query.lat.toFixed(4)}, ${data.query.lng.toFixed(4)}`
    : "";

  return (
    <div className={styles.page}>
      {/* ---- nav ---- */}
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <a className={styles.brand} href="/localfinder">
            <b>hushh</b> <span>/ localfinder</span>
          </a>
          <div className={styles.navLinks}>
            <a className={styles.navLink} href="#try">Try</a>
            <a className={styles.navLink} href="#api">API</a>
            <a className={styles.navLink} href="#params">Reference</a>
            <a className={styles.navCta} href="/docs">Docs →</a>
          </div>
        </div>
      </nav>

      {/* ---- hero ---- */}
      <header className={styles.hero}>
        <div className={styles.wrap}>
          <p className={styles.eyebrow}>Directory API</p>
          <h1 className={styles.h1}>The local directory, by coordinates.</h1>
          <p className={styles.lede}>
            Hotels, healthcare, RIA firms and insurance producers near any point — one request, nearest first.
          </p>
          <span className={styles.endpointChip}>
            <span className={styles.method}>GET</span> /api/v1/directory
          </span>
        </div>
      </header>

      {/* ---- interactive panel ---- */}
      <section className={styles.section} id="try">
        <div className={styles.wrap}>
          <h2 className={styles.h2}>See what&apos;s near you</h2>
          <p className={styles.sub}>Enter a ZIP or share your location — public endpoint, no key.</p>

          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span style={{ marginLeft: 6 }}>live lookup</span>
            </div>
            <div className={styles.panelBody}>
              <div className={styles.form}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>ZIP / postal code</span>
                  <input
                    className={styles.input}
                    inputMode="numeric"
                    placeholder="98033"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && searchZip()}
                    aria-label="ZIP code"
                  />
                </div>
                <button className={styles.btn} onClick={searchZip} disabled={loading}>
                  {loading ? <span className={styles.spinner} /> : null}
                  Search
                </button>
                <button className={`${styles.btn} ${styles.btnGhost}`} onClick={useLocation} disabled={locating || loading}>
                  {locating ? <span className={styles.spinner} /> : "◎ "}
                  Use my location
                </button>
              </div>

              <div className={styles.radioRow}>
                <span className={styles.radioLabel}>RADIUS</span>
                {RADII.map((r) => (
                  <button
                    key={r.m}
                    className={`${styles.chip} ${radiusM === r.m ? styles.chipActive : ""}`}
                    onClick={() => setRadiusM(r.m)}
                  >
                    {r.label}
                  </button>
                ))}
              </div>

              {error ? <div className={styles.error} role="alert">⚠ {error}</div> : null}
              {!error && !data ? (
                <p className={styles.hint}>
                  Try <b>98033</b> or <b>10001</b>.
                </p>
              ) : null}

              {/* ---- results ---- */}
              {data ? (
                <div className={styles.results}>
                  <div className={styles.resultHead}>
                    <div>
                      <div className={styles.resultTotal}>{fmtInt(data.totals.records)} records</div>
                      <div className={styles.resultMeta}>
                        within {fmtDist(data.query.radiusM)} of {whereLabel}
                      </div>
                    </div>
                    <div className={styles.resultMeta}>{data.totals.verticals} verticals</div>
                  </div>

                  <div className={styles.grid}>
                    {data.verticals.map((v) => {
                      const st = paging[v.vertical];
                      const page = st?.page ?? 0;
                      const rows = st?.cache[page] ?? v.sample;
                      const cardLoading = st?.loading ?? false;
                      const cardError = st?.error ?? null;
                      const totalPages = Math.max(1, Math.ceil(v.count / PAGE_SIZE));
                      const from = v.count ? page * PAGE_SIZE + 1 : 0;
                      const to = page * PAGE_SIZE + rows.length;
                      const prevDisabled = page === 0 || cardLoading;
                      const nextDisabled = page + 1 >= totalPages || cardLoading;
                      return (
                        <div className={styles.card} key={v.vertical}>
                          <div className={styles.cardTop}>
                            <span className={styles.cardLabel}>{v.label}</span>
                            <span className={styles.cardCount}>{fmtInt(v.count)}</span>
                          </div>
                          {v.error ? (
                            <div className={styles.emptyCard}>Lookup failed.</div>
                          ) : v.count === 0 ? (
                            <div className={styles.emptyCard}>No rows in this radius.</div>
                          ) : (
                            <>
                              <ul className={styles.sampleList}>
                                {rows.map((s) => {
                                  const key = `${v.vertical}:${s.id}`;
                                  const open = openRows.has(key);
                                  const d = s.detail;
                                  const hasDetail = d.address || d.phone || d.website || d.url;
                                  return (
                                    <li className={styles.sampleItem} key={key}>
                                      <button
                                        type="button"
                                        className={`${styles.rowBtn} ${open ? styles.rowBtnOpen : ""}`}
                                        onClick={() => toggleRow(v.vertical, s.id)}
                                        aria-expanded={open}
                                      >
                                        <span className={styles.rowMain}>
                                          <span className={styles.sampleName}>{s.name || "—"}</span>
                                          <span className={styles.sampleMeta}>
                                            <span className={styles.dist}>{fmtDist(s.distanceM)}</span>
                                            {s.location ? ` · ${s.location}` : ""}
                                          </span>
                                        </span>
                                        <span className={styles.chevron} aria-hidden>{open ? "–" : "+"}</span>
                                      </button>
                                      {open ? (
                                        <div className={styles.detail}>
                                          {d.address ? <div className={styles.detailRow}>{d.address}</div> : null}
                                          {d.phone ? (
                                            <div className={styles.detailRow}>
                                              <a className={styles.detailLink} href={telHref(d.phone)}>{d.phone}</a>
                                            </div>
                                          ) : null}
                                          {d.website ? (
                                            <div className={styles.detailRow}>
                                              <a
                                                className={styles.detailLink}
                                                href={d.website}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                              >
                                                {hostOf(d.website)} ↗
                                              </a>
                                            </div>
                                          ) : null}
                                          {d.url ? (
                                            <div className={styles.detailRow}>
                                              <a
                                                className={styles.detailLink}
                                                href={d.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                              >
                                                {d.urlLabel || "View"} ↗
                                              </a>
                                            </div>
                                          ) : null}
                                          {!hasDetail ? (
                                            <div className={styles.detailEmpty}>No extra details.</div>
                                          ) : null}
                                        </div>
                                      ) : null}
                                    </li>
                                  );
                                })}
                              </ul>
                              {rows.length ? null : (
                                <div className={styles.emptyCard}>No rows on this page.</div>
                              )}
                              {cardError ? (
                                <div className={styles.pagerError} role="alert">⚠ {cardError}</div>
                              ) : null}
                              {v.count > PAGE_SIZE ? (
                                <div className={styles.pager}>
                                  <button
                                    type="button"
                                    className={`${styles.pagerBtn} ${prevDisabled ? styles.pagerBtnOff : ""}`}
                                    onClick={() => goToPage(v.vertical, page - 1)}
                                    aria-disabled={prevDisabled}
                                  >
                                    ‹ Prev
                                  </button>
                                  <span className={styles.pagerLabel} role="status" aria-live="polite">
                                    {cardLoading ? (
                                      <>
                                        <span className={styles.spinner} aria-hidden="true" />
                                        <span className={styles.srOnly}>Loading results…</span>
                                      </>
                                    ) : rows.length ? (
                                      `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(v.count)}`
                                    ) : (
                                      // Empty deep page (count says there's a page here but it came back empty —
                                      // a rare count/rows race). Avoid a reversed "11–10 of 15" range.
                                      `${fmtInt(v.count)} total`
                                    )}
                                  </span>
                                  <button
                                    type="button"
                                    className={`${styles.pagerBtn} ${nextDisabled ? styles.pagerBtnOff : ""}`}
                                    onClick={() => goToPage(v.vertical, page + 1)}
                                    aria-disabled={nextDisabled}
                                  >
                                    Next ›
                                  </button>
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {data.healthcareSpecialties.length ? (
                    <div className={styles.specWrap}>
                      <div className={styles.specTitle}>Healthcare — top specialties nearby</div>
                      {data.healthcareSpecialties.map((s) => (
                        <div className={styles.specRow} key={s.specialty}>
                          <span className={styles.specName} title={s.specialty}>{s.specialty}</span>
                          <span className={styles.specTrack}>
                            <span className={styles.specBar} style={{ width: `${(s.count / specMax) * 100}%` }} />
                          </span>
                          <span className={styles.specVal}>{fmtInt(s.count)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {data.warnings.length ? (
                    <p className={styles.hint} style={{ marginTop: 18 }}>
                      note: {data.warnings.join("; ")}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* ---- API: auth + request ---- */}
      <section className={styles.section} id="api">
        <div className={styles.wrap}>
          <p className={styles.kicker}>Developer API</p>
          <h2 className={styles.h2}>GET /api/v1/directory</h2>
          <p className={styles.sub}>
            Full per-row results, Bearer-authed and CORS-open. Base{" "}
            <code className={styles.inlineCode}>https://intelligence.hushh.ai</code>.
          </p>

          <div className={styles.grid2}>
            <div>
              <p className={styles.codeLabel}>Request</p>
              <pre className={styles.code}>{`curl -s https://intelligence.hushh.ai/api/v1/directory \\
  -H "Authorization: Bearer $ONE_API_KEY" \\
  --get \\
  --data-urlencode "lat=47.68" \\
  --data-urlencode "lng=-122.21" \\
  --data-urlencode "radius=5000" \\
  --data-urlencode "limit=20"`}</pre>
            </div>
            <div>
              <p className={styles.codeLabel}>Response · 200</p>
              <pre className={styles.code}>{`{
  "ok": true,
  "query": { "lat": 47.68, "lng": -122.21,
    "radiusM": 5000, "resolvedFrom": "coordinates" },
  "count": 20,
  "results": [
    { "vertical": "hotels",
      "name": "The Heathman Hotel",
      "distanceM": 214.7,
      "geoPrecision": "rooftop",
      "lat": 47.676, "lng": -122.208 }
  ],
  "warnings": []
}`}</pre>
            </div>
          </div>

          <p className={styles.hint} style={{ marginTop: 18 }}>
            No coordinates? Pass <code className={styles.inlineCode}>zip=98033</code>. Every row carries a{" "}
            <code className={styles.inlineCode}>geoPrecision</code> flag —{" "}
            <code className={styles.inlineCode}>rooftop</code> for hotels,{" "}
            <code className={styles.inlineCode}>zip_centroid</code> otherwise.{" "}
            <code className={styles.inlineCode}>social</code> has no coordinates and is echoed in{" "}
            <code className={styles.inlineCode}>warnings</code>.
          </p>
        </div>
      </section>

      {/* ---- parameters ---- */}
      <section className={styles.section} id="params">
        <div className={styles.wrap}>
          <p className={styles.kicker}>Parameters</p>
          <h2 className={styles.h2}>Query</h2>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr><th>Parameter</th><th>Type</th><th>Default</th><th>Notes</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>lat</code>, <code>lng</code></td><td>number</td><td>—</td>
                  <td className={styles.tdDesc}>Search point. <code className={styles.inlineCode}>lat∈[-90,90]</code>, <code className={styles.inlineCode}>lng∈[-180,180]</code>.</td>
                </tr>
                <tr>
                  <td><code>zip</code></td><td>string</td><td>—</td>
                  <td className={styles.tdDesc}>Fallback when no coordinates — resolved to a centroid.</td>
                </tr>
                <tr>
                  <td><code>radius</code></td><td>number (m)</td><td><code>5000</code></td>
                  <td className={styles.tdDesc}>Clamped to <code className={styles.inlineCode}>[100, 50000]</code>.</td>
                </tr>
                <tr>
                  <td><code>limit</code></td><td>integer</td><td><code>50</code></td>
                  <td className={styles.tdDesc}>Global cap across verticals. Clamped to <code className={styles.inlineCode}>[1, 200]</code>.</td>
                </tr>
                <tr>
                  <td><code>verticals</code></td><td>CSV</td><td><code>all four</code></td>
                  <td className={styles.tdDesc}><code className={styles.inlineCode}>hotels</code>, <code className={styles.inlineCode}>healthcare</code>, <code className={styles.inlineCode}>ria</code>, <code className={styles.inlineCode}>insurance</code>.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- errors ---- */}
      <section className={styles.section} id="errors">
        <div className={styles.wrap}>
          <p className={styles.kicker}>Errors</p>
          <h2 className={styles.h2}>Errors</h2>
          <p className={styles.sub}>
            Flat envelope <code className={styles.inlineCode}>{`{ "ok": false, "error", "code" }`}</code> — branch on{" "}
            <code className={styles.inlineCode}>code</code>. Per-vertical failures are non-fatal.
          </p>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr><th>HTTP</th><th>code</th><th>Meaning</th><th>Retry</th></tr>
              </thead>
              <tbody>
                <tr><td><span className={styles.statusPill}>401</span></td><td><code>unauthorized</code></td><td className={styles.tdDesc}>Missing or invalid Bearer key.</td><td className={styles.tdDesc}>No</td></tr>
                <tr><td><span className={styles.statusPill}>400</span></td><td><code>bad_coordinates</code></td><td className={styles.tdDesc}><code>lat</code>/<code>lng</code> singly, non-numeric, or out of range.</td><td className={styles.tdDesc}>No</td></tr>
                <tr><td><span className={styles.statusPill}>400</span></td><td><code>missing_coordinates</code></td><td className={styles.tdDesc}>Neither coordinates nor a <code>zip</code>.</td><td className={styles.tdDesc}>No</td></tr>
                <tr><td><span className={styles.statusPill}>400</span></td><td><code>unknown_zip</code></td><td className={styles.tdDesc}>The <code>zip</code> could not be resolved.</td><td className={styles.tdDesc}>No</td></tr>
                <tr><td><span className={styles.statusPill}>502</span></td><td><code>directory_query_failed</code></td><td className={styles.tdDesc}>Proximity query failed unexpectedly.</td><td className={styles.tdDesc}>Yes — backoff</td></tr>
                <tr><td><span className={styles.statusPill}>503</span></td><td><code>directory_unavailable</code></td><td className={styles.tdDesc}>Directory database not configured.</td><td className={styles.tdDesc}>No</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- footer ---- */}
      <footer className={styles.wrap}>
        <div className={styles.footer}>
          <span className={styles.footNote}>One by hushh · directory API</span>
          <div className={styles.footLinks}>
            <a className={styles.footLink} href="/docs">Documentation</a>
            <a className={styles.footLink} href="/api/v1/openapi.json">OpenAPI</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
