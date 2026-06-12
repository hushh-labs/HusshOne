"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ALL_LINKEDIN_SCOPES, DEFAULT_SCOPES } from "@/lib/linkedin/oauth";

/**
 * LinkedIn OAuth 2.0 experiment UI (local-only lab).
 * "Sign in with LinkedIn" → real OAuth consent → this page reads the token cookie
 * via /api/linkedin/me and shows what every scope returned: OIDC profile, the
 * decoded id_token, and a per-scope data battery.
 */

type RawApiResult = { ok: boolean; status: number; data: unknown };

type Probe = {
  key: string;
  label: string;
  description: string;
  kind: "read" | "write-only";
  requiredAnyScope: string[];
  method: string;
  url: string;
  granted: boolean;
  attempted: boolean;
  result?: RawApiResult;
  note?: string;
};

type MeResponse = {
  ok: boolean;
  connected: boolean;
  granted_scopes?: string[];
  token_meta?: {
    token_type: string;
    masked_token: string;
    token_length: number;
    expires_at: number | null;
    expires_in_seconds: number | null;
    has_id_token: boolean;
    has_refresh_token: boolean;
  };
  id_token?: { present: boolean; header?: unknown; payload?: unknown; error?: string | null; iss_ok?: boolean | null; aud_ok?: boolean | null };
  userinfo?: RawApiResult;
  probes?: Probe[];
  error?: string;
};

const C = {
  bg: "#0a0c10",
  panel: "#12161d",
  panelAlt: "#0e1218",
  border: "#222a35",
  text: "#e7edf3",
  dim: "#8a97a6",
  blue: "#0A66C2",
  blueText: "#7cc0ff",
  green: "#37d39b",
  red: "#ff6b6b",
  amber: "#f5b942",
  mono: "var(--font-fragment, ui-monospace, SFMono-Regular, Menlo, monospace)",
};

// Official "Sign in with LinkedIn" button — #0A66C2, white [in] mark as inline SVG
// (no external assets), label verbatim. Brand spec per brand.linkedin.com/in-logo.
function SignInWithLinkedInButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Sign in with LinkedIn"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        height: 48,
        padding: "0 22px",
        backgroundColor: C.blue,
        color: "#fff",
        border: "none",
        borderRadius: 24,
        fontFamily: '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        fontSize: 16,
        fontWeight: 600,
        lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        userSelect: "none",
      }}
    >
      <svg width={22} height={22} viewBox="0 0 24 24" fill="#FFFFFF" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
      </svg>
      <span>Sign in with LinkedIn</span>
    </button>
  );
}

export default function LinkedInLab() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(DEFAULT_SCOPES));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<{ kind: "error" | "info"; title: string; detail?: string } | null>(null);
  const [pageOrigin, setPageOrigin] = useState("http://localhost:3000");

  const loadMe = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/linkedin/me", { cache: "no-store" });
      const json = (await res.json()) as MeResponse;
      if (res.ok && json.connected) {
        setMe(json);
      } else if (res.status !== 401) {
        // 401 = simply not signed in (or token expired) → stay on the hero, no scary banner.
        setBanner({ kind: "error", title: "Couldn't load LinkedIn data", detail: json.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      setBanner({ kind: "error", title: "Failed to load LinkedIn data", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  // On mount: surface any redirect error, clean the URL, then ALWAYS try to restore
  // an existing session so a plain reload keeps showing the connected view. The work
  // lives in a nested function so the one-time read doesn't trip react-hooks/set-state-in-effect.
  useEffect(() => {
    const init = () => {
      setPageOrigin(window.location.origin);
      const params = new URLSearchParams(window.location.search);
      const error = params.get("error");
      const errorDescription = params.get("error_description");
      if (window.location.search) {
        window.history.replaceState(null, "", "/labs/linkedin");
      }
      if (error) {
        setBanner({ kind: "error", title: humanError(error), detail: errorDescription || undefined });
      }
      void loadMe();
    };
    init();
  }, [loadMe]);

  const toggle = useCallback((scope: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }, []);

  const connect = useCallback(() => {
    const scopes = ALL_LINKEDIN_SCOPES.map((s) => s.scope).filter((s) => selected.has(s));
    if (!scopes.length) return;
    window.location.href = `/api/linkedin/authorize?scopes=${encodeURIComponent(scopes.join(","))}`;
  }, [selected]);

  const disconnect = useCallback(async () => {
    await fetch("/api/linkedin/logout", { method: "POST" }).catch(() => undefined);
    setMe(null);
    setBanner(null);
  }, []);

  const grouped = useMemo(() => {
    const open = ALL_LINKEDIN_SCOPES.filter((s) => s.selfServe);
    const gated = ALL_LINKEDIN_SCOPES.filter((s) => !s.selfServe);
    return { open, gated };
  }, []);

  const selectAll = useCallback(() => setSelected(new Set(ALL_LINKEDIN_SCOPES.map((s) => s.scope))), []);
  const resetDefault = useCallback(() => setSelected(new Set(DEFAULT_SCOPES)), []);

  const selectedList = ALL_LINKEDIN_SCOPES.map((s) => s.scope).filter((s) => selected.has(s));
  const displayedRedirectUri = `${pageOrigin.replace(/\/+$/, "")}/api/linkedin/callback`;

  return (
    <main style={page}>
      <div style={container}>
        <header style={{ marginBottom: 24 }}>
          <div style={{ fontFamily: C.mono, fontSize: 12, color: C.blueText, letterSpacing: 1 }}>EXPERIMENT · LOCAL ONLY</div>
          <h1 style={{ fontSize: 30, margin: "8px 0 6px", fontWeight: 700 }}>LinkedIn OAuth 2.0 Lab</h1>
          <p style={{ color: C.dim, margin: 0, maxWidth: 720, lineHeight: 1.5 }}>
            Sign in with your real LinkedIn, then see exactly what each scope returns after OAuth — your OIDC profile, the
            decoded <code style={code}>id_token</code>, and a per-scope data battery. Scopes your app isn&apos;t approved
            for are dropped automatically so sign-in still completes.
          </p>
        </header>

        {banner && (
          <div style={bannerStyle(banner.kind)}>
            <strong>{banner.title}</strong>
            {banner.detail ? (
              <div style={{ marginTop: 6, color: C.dim, fontFamily: C.mono, fontSize: 12, wordBreak: "break-word" }}>{banner.detail}</div>
            ) : null}
          </div>
        )}

        {me ? (
          <ConnectedView me={me} onDisconnect={disconnect} loading={loading} />
        ) : (
          <section style={panel}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 14 }}>
              <SignInWithLinkedInButton onClick={connect} disabled={loading || selectedList.length === 0} />
              <div style={{ color: C.dim, fontSize: 13 }}>
                Requesting <strong style={{ color: C.text }}>{selectedList.length}</strong> scope{selectedList.length === 1 ? "" : "s"}:{" "}
                <span style={{ fontFamily: C.mono, fontSize: 12 }}>{selectedList.join(" · ") || "none selected"}</span>
              </div>
              <button style={linkBtn} onClick={() => setAdvancedOpen((v) => !v)} aria-expanded={advancedOpen}>
                {advancedOpen ? "▾ Hide scopes" : "▸ Advanced — choose / request all scopes"}
              </button>
            </div>

            {advancedOpen && (
              <div style={{ marginTop: 18, borderTop: `1px solid ${C.border}`, paddingTop: 18 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
                  <span style={{ fontSize: 13, color: C.dim }}>
                    Toggle scopes to request. Gated ones get auto-dropped if your app isn&apos;t a LinkedIn partner.
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={ghostBtn} onClick={selectAll}>Select all</button>
                    <button style={ghostBtn} onClick={resetDefault}>Reset to default</button>
                  </div>
                </div>
                <ScopeGroup label="Self-serve — no LinkedIn approval needed" tone="ok" scopes={grouped.open} selected={selected} onToggle={toggle} />
                <ScopeGroup label="Needs a LinkedIn partner program — likely dropped" tone="warn" scopes={grouped.gated} selected={selected} onToggle={toggle} />
              </div>
            )}
          </section>
        )}

        <footer style={{ marginTop: 36, paddingTop: 16, borderTop: `1px solid ${C.border}`, color: C.dim, fontSize: 12, lineHeight: 1.6 }}>
          <div>
            Redirect URI: <code style={code}>{displayedRedirectUri}</code> — must be registered in your LinkedIn app (Auth tab).
          </div>
          <div style={{ marginTop: 4 }}>
            This app&apos;s enabled scopes: <code style={code}>openid · profile · email · w_member_social · r_profile_basicinfo · r_verify</code>.
          </div>
          <div style={{ marginTop: 4 }}>
            Maximum data (full profile, connections, ~70 data domains) requires the <strong>Member Data Portability API</strong> — needs LinkedIn
            partner approval and an EEA-based member.
          </div>
        </footer>
      </div>
    </main>
  );
}

function ScopeGroup(props: {
  label: string;
  tone: "ok" | "warn";
  scopes: typeof ALL_LINKEDIN_SCOPES;
  selected: Set<string>;
  onToggle: (scope: string) => void;
}) {
  const { label, tone, scopes, selected, onToggle } = props;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontFamily: C.mono, color: tone === "ok" ? C.green : C.amber, marginBottom: 8, letterSpacing: 0.5 }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 6 }}>
        {scopes.map((s) => {
          const on = selected.has(s.scope);
          return (
            <label key={s.scope} style={{ ...scopeRow, borderColor: on ? C.blue : C.border, background: on ? "#0d1a2b" : C.panelAlt }}>
              <input type="checkbox" checked={on} onChange={() => onToggle(s.scope)} style={{ marginTop: 3, accentColor: C.blue }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <code style={{ ...code, color: on ? C.blueText : C.text }}>{s.scope}</code>
                  <span style={{ fontSize: 11, color: C.dim }}>{s.product}</span>
                </div>
                <div style={{ fontSize: 12, color: C.dim, marginTop: 2 }}>{s.description}</div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ConnectedView({ me, onDisconnect, loading }: { me: MeResponse; onDisconnect: () => void; loading: boolean }) {
  const profile = asRecord(me.userinfo?.data);
  const name = str(profile.name) || [str(profile.given_name), str(profile.family_name)].filter(Boolean).join(" ");
  const email = str(profile.email);
  const picture = str(profile.picture);
  const idClaims = me.id_token?.present ? asRecord(me.id_token.payload) : null;

  return (
    <section style={{ display: "grid", gap: 16 }}>
      <div style={{ ...panel, borderColor: C.green }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <strong style={{ color: C.green }}>● Signed in with LinkedIn{loading ? " — refreshing…" : ""}</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <CopyButton value={JSON.stringify(me, null, 2)} label="Copy all JSON" style={ghostBtn} />
            <button style={ghostBtn} onClick={onDisconnect}>Disconnect &amp; sign in again</button>
          </div>
        </div>
        {(name || email || picture) && (
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 14 }}>
            {picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={picture} alt="" width={56} height={56} style={{ borderRadius: "50%", border: `1px solid ${C.border}` }} />
            ) : null}
            <div>
              {name ? <div style={{ fontSize: 18, fontWeight: 600 }}>{name}</div> : null}
              {email ? <div style={{ color: C.dim, fontSize: 13 }}>{email}</div> : null}
              {str(profile.sub) ? <div style={{ color: C.dim, fontSize: 11, fontFamily: C.mono, marginTop: 2 }}>sub: {str(profile.sub)}</div> : null}
            </div>
          </div>
        )}
      </div>

      <div style={rowGrid}>
        <div style={panel}>
          <h2 style={h2}>Granted scopes</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {me.granted_scopes?.length ? (
              me.granted_scopes.map((s) => <span key={s} style={chip}>{s}</span>)
            ) : (
              <span style={{ color: C.dim }}>None reported by LinkedIn.</span>
            )}
          </div>
        </div>

        {me.token_meta && (
          <div style={panel}>
            <h2 style={h2}>Access token</h2>
            <dl style={dl}>
              <Row k="Type" v={me.token_meta.token_type} />
              <Row k="Access token" v={`${me.token_meta.masked_token} (${me.token_meta.token_length} chars)`} mono />
              <Row k="Expires in" v={me.token_meta.expires_in_seconds != null ? `${me.token_meta.expires_in_seconds}s` : "—"} />
              <Row k="id_token returned" v={me.token_meta.has_id_token ? "yes" : "no"} />
              <Row k="refresh_token returned" v={me.token_meta.has_refresh_token ? "yes" : "no"} />
            </dl>
          </div>
        )}
      </div>

      {idClaims && (
        <div style={panel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ ...h2, margin: 0 }}>Identity token (id_token)</h2>
            <CopyButton value={JSON.stringify(idClaims, null, 2)} label="Copy claims" />
          </div>
          <div style={{ color: C.dim, fontSize: 12, margin: "12px 0" }}>
            Decoded OIDC claims (signature not verified — display only). <code style={code}>iss</code> proves it came from LinkedIn;{" "}
            <code style={code}>aud</code> is your client id; <code style={code}>sub</code> is a per-app opaque id.
          </div>
          {(me.id_token?.iss_ok != null || me.id_token?.aud_ok != null) && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {me.id_token?.iss_ok != null && (
                <span style={{ ...miniChip, color: me.id_token.iss_ok ? C.green : C.red }}>
                  iss {me.id_token.iss_ok ? "✓ linkedin.com" : "✕ unexpected"}
                </span>
              )}
              {me.id_token?.aud_ok != null && (
                <span style={{ ...miniChip, color: me.id_token.aud_ok ? C.green : C.red }}>
                  aud {me.id_token.aud_ok ? "✓ matches client id" : "✕ mismatch"}
                </span>
              )}
            </div>
          )}
          <ClaimsTable record={idClaims} />
        </div>
      )}
      {me.id_token && !me.id_token.present && (
        <div style={panel}>
          <h2 style={h2}>Identity token (id_token)</h2>
          <div style={{ color: C.dim, fontSize: 13 }}>No id_token returned — add the <code style={code}>openid</code> scope to receive one.</div>
        </div>
      )}

      <div style={panel}>
        <h2 style={h2}>Data by scope</h2>
        <div style={{ color: C.dim, fontSize: 12, marginBottom: 12 }}>
          What each readable scope returns with this token. Granted scopes are called live; ungranted ones are listed so you can see
          what they&apos;d unlock.
        </div>
        <div style={probeGrid}>
          <ProbeCard title="OIDC userinfo" scopes={["openid", "profile", "email"]} result={me.userinfo} granted attempted />
          {me.probes?.map((p) => <ProbeCard key={p.key} probe={p} />)}
        </div>
      </div>
    </section>
  );
}

function ProbeCard(props: { probe?: Probe; title?: string; scopes?: string[]; result?: RawApiResult; granted?: boolean; attempted?: boolean }) {
  const p = props.probe;
  const label = p?.label ?? props.title ?? "";
  const scopes = p?.requiredAnyScope ?? props.scopes ?? [];
  const result = p?.result ?? props.result;
  const granted = p?.granted ?? props.granted ?? false;
  const attempted = p?.attempted ?? props.attempted ?? false;
  const writeOnly = p?.kind === "write-only";

  let status: { text: string; color: string };
  if (writeOnly) status = { text: granted ? "write-only · granted" : "write-only", color: C.amber };
  else if (result) status = result.ok ? { text: `HTTP ${result.status} ✓`, color: C.green } : { text: `HTTP ${result.status} ✕${granted ? "" : " · scope not granted"}`, color: result.status === 0 ? C.dim : C.red };
  else if (!granted) status = { text: "not granted", color: C.dim };
  else status = { text: attempted ? "—" : "skipped", color: C.dim };

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", background: C.panelAlt }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>{label}</strong>
          {scopes.map((s) => <span key={s} style={miniChip}>{s}</span>)}
        </div>
        <span style={{ fontFamily: C.mono, fontSize: 12, color: status.color, whiteSpace: "nowrap" }}>{status.text}</span>
      </div>
      {p?.description ? <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>{p.description}</div> : null}
      {p?.note ? <div style={{ fontSize: 12, color: C.dim, marginTop: 6, fontStyle: "italic" }}>{p.note}</div> : null}
      {result ? <JsonBlock data={result.data} /> : null}
    </div>
  );
}

// Copy-to-clipboard button with a transient "✓ Copied" confirmation.
// Uses the async Clipboard API (works on localhost — a secure context) with a
// legacy execCommand fallback for any non-secure context.
function CopyButton({ value, label = "Copy", style: extra }: { value: string; label?: string; style?: CSSProperties }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* clipboard unavailable — nothing else we can do */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied to clipboard" : label}
      style={{ ...copyBtn, ...(extra || {}), ...(copied ? { color: C.green, borderColor: C.green } : null) }}
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

// Pretty-printed JSON with a floating Copy button at the top-right.
function JsonBlock({ data }: { data: unknown }) {
  const text = JSON.stringify(data, null, 2);
  return (
    <div style={{ position: "relative", marginTop: 10 }}>
      <CopyButton value={text} label="Copy JSON" style={{ position: "absolute", top: 8, right: 8, zIndex: 1 }} />
      <pre style={{ ...pre, margin: 0 }}>{text}</pre>
    </div>
  );
}

function ClaimsTable({ record }: { record: Record<string, unknown> }) {
  const entries = Object.entries(record);
  if (!entries.length) return <div style={{ color: C.dim, fontSize: 13 }}>No claims.</div>;
  return (
    <dl style={dl}>
      {entries.map(([k, v]) => (
        <Row key={k} k={k} v={formatClaim(k, v)} mono />
      ))}
    </dl>
  );
}

function formatClaim(key: string, value: unknown): string {
  if ((key === "iat" || key === "exp" || key === "auth_time") && typeof value === "number") {
    return `${value} (${new Date(value * 1000).toISOString()})`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt style={{ color: C.dim }}>{k}</dt>
      <dd style={{ margin: 0, fontFamily: mono ? C.mono : undefined, wordBreak: "break-word" }}>{v}</dd>
    </>
  );
}

function humanError(code: string): string {
  switch (code) {
    case "unauthorized_scope_error":
      return "LinkedIn rejected the requested scopes";
    case "state_mismatch":
      return "Security check failed (state mismatch)";
    case "token_exchange_failed":
      return "Token exchange failed";
    case "config_error":
      return "LinkedIn OAuth is not configured";
    case "user_cancelled_login":
    case "user_cancelled_authorize":
      return "You cancelled the LinkedIn sign-in";
    case "missing_code":
      return "LinkedIn returned no authorization code";
    default:
      return `LinkedIn error: ${code}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// --- styles ---
// globals.css locks `html, body { overflow: hidden }` for the immersive landing,
// so this page must be its own scroll container or its content gets clipped.
const page: CSSProperties = {
  height: "100dvh",
  overflowY: "auto",
  WebkitOverflowScrolling: "touch",
  background: C.bg,
  color: C.text,
  fontFamily: "var(--font-inter, system-ui, sans-serif)",
};
const container: CSSProperties = { maxWidth: 960, margin: "0 auto", padding: "48px 20px 80px" };
// Two-up summary row + the per-scope card grid. auto-fit/minmax gives a real
// responsive grid from inline styles (no media queries): one column when narrow,
// two when there's room. alignItems:start keeps a tall JSON card from stretching
// its short neighbour to match height.
const rowGrid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, alignItems: "start" };
const probeGrid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 10, alignItems: "start" };
const panel: CSSProperties = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 };
const h2: CSSProperties = { fontSize: 15, margin: "0 0 12px" };
const scopeRow: CSSProperties = { display: "flex", gap: 10, alignItems: "flex-start", border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer" };
const ghostBtn: CSSProperties = { background: "transparent", color: C.text, border: `1px solid ${C.border}`, borderRadius: 7, padding: "7px 12px", fontSize: 13, cursor: "pointer" };
const copyBtn: CSSProperties = { background: C.panelAlt, color: C.blueText, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 11.5, fontFamily: C.mono, lineHeight: 1, cursor: "pointer", whiteSpace: "nowrap" };
const linkBtn: CSSProperties = { background: "transparent", color: C.blueText, border: "none", padding: 0, fontSize: 13, cursor: "pointer" };
const chip: CSSProperties = { fontFamily: C.mono, fontSize: 12, background: C.panelAlt, border: `1px solid ${C.border}`, color: C.blueText, borderRadius: 999, padding: "4px 10px" };
const miniChip: CSSProperties = { fontFamily: C.mono, fontSize: 11, background: C.bg, border: `1px solid ${C.border}`, color: C.dim, borderRadius: 999, padding: "2px 8px" };
const code: CSSProperties = { fontFamily: C.mono, fontSize: 13 };
const pre: CSSProperties = { margin: "10px 0 0", padding: 14, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, overflowX: "auto", fontFamily: C.mono, fontSize: 12.5, lineHeight: 1.55, color: C.text, maxHeight: 360 };
const dl: CSSProperties = { display: "grid", gridTemplateColumns: "180px 1fr", gap: "8px 16px", margin: 0, fontSize: 13 };

function bannerStyle(kind: "error" | "info"): CSSProperties {
  const accent = kind === "error" ? C.red : C.blueText;
  return { background: C.panel, border: `1px solid ${accent}`, borderLeft: `3px solid ${accent}`, borderRadius: 10, padding: "12px 16px", marginBottom: 20, color: C.text };
}
