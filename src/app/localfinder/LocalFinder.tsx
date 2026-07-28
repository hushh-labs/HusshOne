"use client";

/* /localfinder — public developer page for the coordinate-driven directory API.
   Monochrome (black/white/grey; no blue). Two things in one page:
     1. an interactive panel — enter a ZIP or share GPS, and see how many hotels / healthcare providers /
        RIA firms / insurance producers hushh has near that point, with nearest samples + a healthcare
        specialty histogram. It calls the PUBLIC, key-free GET /api/localfinder (summary shape).
     2. documentation for the real, Bearer-gated GET /api/v1/directory (full per-row firehose).
   The panel and the documented API share the same query engine server-side; the key never reaches the
   browser. */
import { useCallback, useMemo, useState } from "react";
import styles from "./localfinder.module.css";

type GeoPrecision = "rooftop" | "zip_centroid";
type SampleRow = {
  id: string;
  name: string;
  subtitle: string | null;
  location: string | null;
  distanceM: number;
  geoPrecision: GeoPrecision;
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
type ApiError = { ok: false; error: string; code: string };

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

export default function LocalFinder() {
  const [zip, setZip] = useState("");
  const [radiusM, setRadiusM] = useState(5000);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Summary | null>(null);

  const run = useCallback(async (qs: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/localfinder?${qs}`, { headers: { accept: "application/json" } });
      const json = (await res.json()) as Summary | ApiError;
      if (!res.ok || !json.ok) {
        setData(null);
        setError((json as ApiError).error || `Request failed (${res.status})`);
        return;
      }
      setData(json);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
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
            <a className={styles.navLink} href="#try">try it</a>
            <a className={styles.navLink} href="#api">api</a>
            <a className={styles.navLink} href="#params">parameters</a>
            <a className={styles.navLink} href="#errors">errors</a>
            <a className={styles.navCta} href="/docs">Docs →</a>
          </div>
        </div>
      </nav>

      {/* ---- hero ---- */}
      <header className={styles.hero}>
        <div className={styles.wrap}>
          <p className={styles.eyebrow}>One · Directory API</p>
          <h1 className={styles.h1}>The local directory, by coordinates.</h1>
          <p className={styles.lede}>
            One request, four verticals — hotels, healthcare providers, RIA firms and insurance producers —
            returned by true geographic distance from any point. Give it a latitude and longitude (or a ZIP),
            get everything hushh has nearby, nearest first.
          </p>
          <div className={styles.heroRow}>
            <span className={styles.endpointChip}>
              <span className={styles.method}>GET</span> /api/v1/directory
            </span>
            <a className={styles.navCta} href="#try">Try it below ↓</a>
          </div>
        </div>
      </header>

      {/* ---- interactive panel ---- */}
      <section className={styles.section} id="try">
        <div className={styles.wrap}>
          <p className={styles.kicker}>Interactive</p>
          <h2 className={styles.h2}>See what&apos;s near you</h2>
          <p className={styles.sub}>
            Enter a ZIP code or share your location. This panel calls the public{" "}
            <code className={styles.inlineCode}>/api/localfinder</code> endpoint — no key required — and
            returns per-vertical counts, the nearest sample rows and a healthcare specialty breakdown within
            your chosen radius.
          </p>

          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span style={{ marginLeft: 6 }}>hushh directory · live lookup</span>
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

              {error ? <div className={styles.error}>⚠ {error}</div> : null}
              {!error && !data ? (
                <p className={styles.hint}>
                  Try <b>98033</b> (Kirkland, WA) or <b>10001</b> (Manhattan). Coordinates work too via the
                  API: <code className={styles.inlineCode}>?lat=47.68&amp;lng=-122.21</code>.
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
                    {data.verticals.map((v) => (
                      <div className={styles.card} key={v.vertical}>
                        <div className={styles.cardTop}>
                          <span className={styles.cardLabel}>{v.label}</span>
                          <span className={styles.cardCount}>{fmtInt(v.count)}</span>
                        </div>
                        {v.sample.length ? (
                          <ul className={styles.sampleList}>
                            {v.sample.map((s) => (
                              <li className={styles.sampleItem} key={s.id}>
                                <div className={styles.sampleName}>{s.name || "—"}</div>
                                <div className={styles.sampleMeta}>
                                  <span className={styles.dist}>{fmtDist(s.distanceM)}</span>
                                  {s.location ? ` · ${s.location}` : ""}
                                </div>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className={styles.emptyCard}>No rows in this radius.</div>
                        )}
                      </div>
                    ))}
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
            The documented endpoint returns the full per-row result set, merged across verticals and sorted
            by distance. It is authenticated with a Bearer key and CORS-open, so you can call it from a server
            or a browser. Base URL <code className={styles.inlineCode}>https://one.hushh.ai</code>.
          </p>

          <div className={styles.grid2}>
            <div>
              <p className={styles.codeLabel}>Request — curl</p>
              <pre className={styles.code}>{`curl -s https://one.hushh.ai/api/v1/directory \\
  -H "Authorization: Bearer $ONE_API_KEY" \\
  --get \\
  --data-urlencode "lat=47.68" \\
  --data-urlencode "lng=-122.21" \\
  --data-urlencode "radius=5000" \\
  --data-urlencode "limit=20" \\
  --data-urlencode "verticals=hotels,healthcare,ria,insurance"`}</pre>
            </div>
            <div>
              <p className={styles.codeLabel}>Response — 200</p>
              <pre className={styles.code}>{`{
  "ok": true,
  "query": {
    "lat": 47.68, "lng": -122.21,
    "radiusM": 5000, "limit": 20,
    "verticals": ["hotels","healthcare","ria","insurance"],
    "resolvedFrom": "coordinates"
  },
  "count": 20,
  "results": [
    {
      "vertical": "hotels",
      "id": "…",
      "name": "The Heathman Hotel",
      "subtitle": "220 Kirkland Ave · 4.5★",
      "distanceM": 214.7,
      "geoPrecision": "rooftop",
      "lat": 47.676, "lng": -122.208,
      "fields": { "rating": 4.5, "phone": "…", "website": "…" }
    }
  ],
  "warnings": []
}`}</pre>
            </div>
          </div>

          <p className={styles.sub} style={{ marginTop: 24 }}>
            No coordinates? Pass <code className={styles.inlineCode}>zip=98033</code> and the endpoint resolves
            it to a centroid (<code className={styles.inlineCode}>resolvedFrom:&quot;zip&quot;</code>). Every
            row carries a <code className={styles.inlineCode}>geoPrecision</code> flag —{" "}
            <code className={styles.inlineCode}>rooftop</code> for hotels,{" "}
            <code className={styles.inlineCode}>zip_centroid</code> for the other three until per-address
            geocoding upgrades them in place. <code className={styles.inlineCode}>social</code> has no
            coordinates and is excluded (it&apos;s echoed in <code className={styles.inlineCode}>warnings</code>).
          </p>
        </div>
      </section>

      {/* ---- parameters ---- */}
      <section className={styles.section} id="params">
        <div className={styles.wrap}>
          <p className={styles.kicker}>Reference</p>
          <h2 className={styles.h2}>Query parameters</h2>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr><th>Parameter</th><th>Type</th><th>Default</th><th>Notes</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>lat</code>, <code>lng</code></td><td>number</td><td>—</td>
                  <td className={styles.tdDesc}>Search point. <code className={styles.inlineCode}>lat∈[-90,90]</code>, <code className={styles.inlineCode}>lng∈[-180,180]</code>. Aliases: <code className={styles.inlineCode}>latitude</code>, <code className={styles.inlineCode}>longitude</code>, <code className={styles.inlineCode}>lon</code>.</td>
                </tr>
                <tr>
                  <td><code>zip</code></td><td>string</td><td>—</td>
                  <td className={styles.tdDesc}>Fallback when no coordinates are given — resolved to a centroid. Aliases: <code className={styles.inlineCode}>zipCode</code>, <code className={styles.inlineCode}>zipcode</code>.</td>
                </tr>
                <tr>
                  <td><code>radius</code></td><td>number (m)</td><td><code>5000</code></td>
                  <td className={styles.tdDesc}>Search radius in metres. Clamped to <code className={styles.inlineCode}>[100, 50000]</code>. Aliases: <code className={styles.inlineCode}>radiusM</code>, <code className={styles.inlineCode}>radius_m</code>.</td>
                </tr>
                <tr>
                  <td><code>limit</code></td><td>integer</td><td><code>50</code></td>
                  <td className={styles.tdDesc}>Global cap across all merged verticals. Clamped to <code className={styles.inlineCode}>[1, 200]</code>.</td>
                </tr>
                <tr>
                  <td><code>verticals</code></td><td>CSV</td><td><code>all four</code></td>
                  <td className={styles.tdDesc}>Any of <code className={styles.inlineCode}>hotels</code>, <code className={styles.inlineCode}>healthcare</code>, <code className={styles.inlineCode}>ria</code>, <code className={styles.inlineCode}>insurance</code>. Alias: <code className={styles.inlineCode}>vertical</code>.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- errors ---- */}
      <section className={styles.section} id="errors">
        <div className={styles.wrap}>
          <p className={styles.kicker}>Reference</p>
          <h2 className={styles.h2}>Errors</h2>
          <p className={styles.sub}>
            Failures use a flat envelope: <code className={styles.inlineCode}>{`{ "ok": false, "error": "…", "code": "…" }`}</code>.
            Branch on <code className={styles.inlineCode}>code</code>, not the message. A per-vertical query
            failure is <em>not</em> fatal — the other verticals still return 200 and the failure is reported in{" "}
            <code className={styles.inlineCode}>warnings</code>.
          </p>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr><th>HTTP</th><th>code</th><th>Meaning</th><th>Retry</th></tr>
              </thead>
              <tbody>
                <tr><td><span className={styles.statusPill}>401</span></td><td><code>unauthorized</code></td><td className={styles.tdDesc}>Missing or invalid Bearer key.</td><td className={styles.tdDesc}>No</td></tr>
                <tr><td><span className={styles.statusPill}>400</span></td><td><code>bad_coordinates</code></td><td className={styles.tdDesc}><code>lat</code>/<code>lng</code> singly, non-numeric, or out of range.</td><td className={styles.tdDesc}>No</td></tr>
                <tr><td><span className={styles.statusPill}>400</span></td><td><code>missing_coordinates</code></td><td className={styles.tdDesc}>Neither coordinates nor a <code>zip</code> were provided.</td><td className={styles.tdDesc}>No</td></tr>
                <tr><td><span className={styles.statusPill}>400</span></td><td><code>unknown_zip</code></td><td className={styles.tdDesc}>The <code>zip</code> could not be resolved to coordinates.</td><td className={styles.tdDesc}>No</td></tr>
                <tr><td><span className={styles.statusPill}>502</span></td><td><code>directory_query_failed</code></td><td className={styles.tdDesc}>Unexpected error running the proximity query.</td><td className={styles.tdDesc}>Yes — backoff</td></tr>
                <tr><td><span className={styles.statusPill}>503</span></td><td><code>directory_unavailable</code></td><td className={styles.tdDesc}>The directory database is not configured.</td><td className={styles.tdDesc}>No</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- footer ---- */}
      <footer className={styles.wrap}>
        <div className={styles.footer}>
          <span className={styles.footNote}>One by hushh · directory API · monochrome by design</span>
          <div className={styles.footLinks}>
            <a className={styles.footLink} href="/docs">Documentation</a>
            <a className={styles.footLink} href="/docs/directory">Directory guide</a>
            <a className={styles.footLink} href="/api/v1/openapi.json">OpenAPI</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
