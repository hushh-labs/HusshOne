"use client";

/* ============================================================
   OneExperience — One personal intelligence flow.
   Ports the design (app.jsx + screens.jsx) screen-for-screen
   and wires it to the real auth + geolocation + Hushh Shadow
   ensemble backend (streamed POST /api/one/dashboard).
   ============================================================ */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { User } from "firebase/auth";
import { isValidEmail, normalizeEmail, normalizeName, initialsForName } from "@/lib/auth/identity";
import {
  completeGoogleRedirect,
  getFirebaseBearer,
  isFirebaseClientConfigured,
  makeDevUser,
  observeAuth,
  signInWithGoogle,
  signOutOfGoogle,
} from "@/lib/firebase/client";
import type {
  DashboardCategoryMap,
  OneDashboardResult,
  OneSafeFinding,
  OneSourceCard,
  PersonAuditStatus,
} from "@/lib/ria/types";
import type { ScanEmailDeliverySummary } from "@/lib/notifications/types";
import { SHADOW_ESTIMATED_MS, SHADOW_PHASES, scanningSourceAt, shadowPhaseIndex } from "@/lib/ria/progress";
import { track } from "@/lib/analytics/track";
import { Icons } from "./Icons";
import { CanvasField } from "./CanvasField";
import { ParticleMorph } from "./ParticleMorph";
import LandingPage from "./landing/LandingPage";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Stage = "hydrating" | "landing" | "manual" | "precollect" | "collect" | "dashboard" | "empty" | "error" | "location" | "settings";
type ClientUser = Pick<User, "uid" | "email" | "displayName" | "photoURL" | "getIdToken">;
/* why geolocation failed → drives the LocationFallback copy (and the ZIP extreme fallback) */
type GeoReason = "denied" | "unavailable" | "timeout" | "unsupported";

interface Identity {
  name: string;
  email: string;
}
interface Coordinates {
  latitude?: number;
  longitude?: number;
  zipCode?: string;
}
interface ScanFinal {
  result: OneDashboardResult;
  audit?: PersonAuditStatus | null;
  emailDelivery?: ScanEmailDeliverySummary | null;
}

const MOTION = 0.7;
const ACCENT = "#111113";
/* When on, the number→scan flow is powered by the Deep Research API (markdown
   dossier) instead of the Shadow structured scan. Server routes mirror the
   /dashboard + /scans recovery protocol, so the rest of the flow is unchanged. */
const RESEARCH_MODE = process.env.NEXT_PUBLIC_ONE_RESEARCH_MODE === "true";

function hexA(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function shouldAllowDevAuth() {
  return process.env.NEXT_PUBLIC_ONE_ENABLE_DEV_AUTH === "true";
}

/* Map a Firebase sign-in error to a user-facing message. Returns "" for user-initiated
   cancellations (popup closed / dismissed) so we stay quiet rather than show an error. */
function mapSignInError(e: unknown): string {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code?: string }).code) : "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request" || code === "auth/user-cancelled") {
    return "";
  }
  if (code === "auth/popup-blocked") return "Your browser blocked the sign-in popup. Allow popups for this site and try again.";
  if (code === "auth/network-request-failed") return "Network issue — check your connection and try again.";
  if (code === "auth/missing-or-invalid-nonce") return "Sign-in didn't complete. Please tap Continue with Google again.";
  return e instanceof Error ? e.message : "Sign-in failed.";
}

function extractIdentity(user: ClientUser): Identity {
  return { name: normalizeName(user.displayName), email: normalizeEmail(user.email) };
}

/* ── persisted state (namespaced like the analytics `one_sid`) ─────────────
   localStorage survives a browser restart; sessionStorage is per-tab. We never
   store the PII result blob — only ids that are re-fetched from the server. */
const LS_PHONE = "one_phone"; // typed phone, restored across refresh
const LS_LAST_SCAN = "one_last_scan"; // last completed scan id → dashboard restore
const LS_ACTIVE_SCAN = "one_active_scan"; // in-flight scan id → resume after refresh OR app close
const SS_SCAN_RUN = "one_scan_run"; // legacy in-flight key (session-scoped) — cleared only
const SS_DEV_AUTH = "one_dev_auth"; // restore the dev user on refresh (no Firebase session)
const SS_PENDING = "one_pending_scan"; // deep-link (?scan=) awaiting sign-in

function safeGet(store: "local" | "session", key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return (store === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}
function safeSet(store: "local" | "session", key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    (store === "local" ? window.localStorage : window.sessionStorage).setItem(key, value);
  } catch {
    /* private mode / quota — non-fatal */
  }
}
function safeDel(store: "local" | "session", key: string) {
  if (typeof window === "undefined") return;
  try {
    (store === "local" ? window.localStorage : window.sessionStorage).removeItem(key);
  } catch {
    /* non-fatal */
  }
}
function clearPersisted() {
  safeDel("local", LS_PHONE);
  safeDel("local", LS_LAST_SCAN);
  safeDel("local", LS_ACTIVE_SCAN);
  safeDel("session", SS_SCAN_RUN); // legacy
  safeDel("session", SS_DEV_AUTH);
  safeDel("session", SS_PENDING);
}

function mmss(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function phoneDigits(value: string) {
  return value.replace(/\D/g, "");
}
function isValidPhone(value: string) {
  const digits = phoneDigits(value);
  return digits.length >= 7 && digits.length <= 15;
}

/* read the NDJSON result stream; forwards progress/start, returns the final done|error line */
async function readScanStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (msg: { type: string; stage?: number; elapsedMs?: number; scanRunId?: string | null; scanning?: string }) => void,
): Promise<{ type: string; result?: OneDashboardResult; audit?: PersonAuditStatus | null; emailDelivery?: ScanEmailDeliverySummary | null; error?: string } | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last: { type: string; [k: string]: unknown } | null = null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.type === "progress" || msg.type === "start") onProgress(msg as never);
    else if (msg.type === "done" || msg.type === "error") last = msg;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) handleLine(buffer);
  return last as never;
}

/* ── A. Landing / sign-in lives in ./landing/LandingPage (hellow-style
      minimal home); its CTA calls onAuth below. ─────────────── */

/* ── B. Manual name / email fallback ────────────────────── */
function Manual({
  initialName,
  initialEmail,
  lockedEmail,
  onContinue,
}: {
  initialName: string;
  initialEmail: string;
  lockedEmail?: string;
  onContinue: (u: Identity) => void;
}) {
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  // The server only scans the signed-in Google email, so when we have a valid one we
  // lock the field to it — editing it would surface as a confusing 403 later at scan time.
  const locked = !!lockedEmail && EMAIL_RE.test(lockedEmail);
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [touched, setTouched] = useState(false);
  const effectiveEmail = locked ? (lockedEmail as string) : email;
  const validEmail = EMAIL_RE.test(effectiveEmail);
  const ok = name.trim().length > 1 && validEmail;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    onContinue({ name: name.trim(), email: effectiveEmail.trim() });
  };
  return (
    <div className="screen screen-enter">
      <form className="content" style={{ gap: 26 }} onSubmit={submit}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h1 className="display" style={{ fontSize: "clamp(26px,4vw,38px)" }}>Almost there.</h1>
          <p className="sub" style={{ margin: "0 auto" }}>Just your name and email to anchor the search.</p>
        </div>
        <div className="card">
          <div className="field-group">
            <label htmlFor="nm">Name</label>
            <input
              id="nm"
              className="input"
              placeholder="Aryan Mehta"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </div>
          {locked ? (
            <div className="field-group">
              <label htmlFor="em">Email</label>
              <input id="em" className="input" value={lockedEmail} readOnly aria-readonly="true" style={{ opacity: 0.7 }} />
              <span className="field-hint">Signed in as {lockedEmail}. One can only search the account you signed in with.</span>
            </div>
          ) : (
            <div className="field-group">
              <label htmlFor="em">Email</label>
              <input
                id="em"
                className={"input" + (touched && email && !validEmail ? " invalid" : "")}
                placeholder="you@example.com"
                value={email}
                type="email"
                inputMode="email"
                onBlur={() => setTouched(true)}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
          )}
          <div className="cta-block">
            <button className="solid-cta" type="submit" disabled={!ok}>
              Continue
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

/* ── C. Pre-collection — "The Moment Before Discovery" ──── */
const COUNTRY_CODES: { flag: string; dial: string; iso: string }[] = [
  { flag: "🇮🇳", dial: "+91", iso: "IN" },
  { flag: "🇺🇸", dial: "+1", iso: "US" },
  { flag: "🇬🇧", dial: "+44", iso: "GB" },
  { flag: "🇦🇪", dial: "+971", iso: "AE" },
  { flag: "🇦🇺", dial: "+61", iso: "AU" },
  { flag: "🇸🇬", dial: "+65", iso: "SG" },
  { flag: "🇩🇪", dial: "+49", iso: "DE" },
  { flag: "🇫🇷", dial: "+33", iso: "FR" },
  { flag: "🇳🇱", dial: "+31", iso: "NL" },
  { flag: "🇪🇸", dial: "+34", iso: "ES" },
  { flag: "🇮🇹", dial: "+39", iso: "IT" },
  { flag: "🇨🇭", dial: "+41", iso: "CH" },
  { flag: "🇸🇪", dial: "+46", iso: "SE" },
  { flag: "🇮🇪", dial: "+353", iso: "IE" },
  { flag: "🇯🇵", dial: "+81", iso: "JP" },
  { flag: "🇰🇷", dial: "+82", iso: "KR" },
  { flag: "🇨🇳", dial: "+86", iso: "CN" },
  { flag: "🇭🇰", dial: "+852", iso: "HK" },
  { flag: "🇧🇷", dial: "+55", iso: "BR" },
  { flag: "🇲🇽", dial: "+52", iso: "MX" },
  { flag: "🇿🇦", dial: "+27", iso: "ZA" },
  { flag: "🇳🇬", dial: "+234", iso: "NG" },
  { flag: "🇸🇦", dial: "+966", iso: "SA" },
  { flag: "🇮🇩", dial: "+62", iso: "ID" },
  { flag: "🇵🇰", dial: "+92", iso: "PK" },
  { flag: "🇧🇩", dial: "+880", iso: "BD" },
  { flag: "🇨🇦", dial: "+1", iso: "CA" },
  { flag: "🇳🇿", dial: "+64", iso: "NZ" },
];

function PreCollect({
  user,
  phone,
  setPhone,
  onCollect,
  busy,
}: {
  user: Identity;
  phone: string;
  setPhone: (v: string) => void;
  onCollect: () => void;
  busy: boolean;
}) {
  const initials = initialsForName(user.name);
  const [code, setCode] = useState(() => {
    const m = phone.match(/^(\+\d{1,4})\s/);
    return m ? m[1] : "+91";
  });
  const [national, setNational] = useState(() => phone.replace(/^\+\d{1,4}\s/, ""));
  const combine = (c: string, n: string) => (n.trim() ? `${c} ${n.trim()}` : "");
  const valid = isValidPhone(combine(code, national));
  const magnetRef = useRef<HTMLSpanElement | null>(null);
  const onMove = (e: React.MouseEvent) => {
    const el = magnetRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    el.style.transform = `translate(${x * 0.16}px, ${Math.max(-9, Math.min(9, y * 0.3))}px)`;
  };
  const onLeave = () => {
    if (magnetRef.current) magnetRef.current.style.transform = "";
  };
  const submit = () => {
    if (valid && !busy) onCollect();
  };
  return (
    <div className="screen precollect screen-enter">
      <div className="pc">
        <div className="pc-head">
          <p className="eyebrow">Agent ready</p>
          <h1 className="display pc-title">One will connect what matters.</h1>
        </div>

        <div className="pc-box">
          <div className="pc-id">
            <div className="pc-avatar">
              <span>{initials}</span>
              <i className="scan" aria-hidden="true"></i>
            </div>
            <div className="pc-meta">
              <div className="anchor">Identity locked</div>
              <div className="nm">{user.name}</div>
              <div className="em">{user.email}</div>
            </div>
            <div className="pc-verified" title="Verified identity">
              {Icons.check(13)}
            </div>
          </div>

          <div className="pc-phone">
            <label htmlFor="ph">Your phone number</label>
            <div className="phone-row">
              <select
                className="cc-select"
                aria-label="Country code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setPhone(combine(e.target.value, national));
                }}
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={c.iso} value={c.dial}>
                    {c.flag} {c.dial}
                  </option>
                ))}
              </select>
              <input
                id="ph"
                className="input phone-input"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="98765 43210"
                value={national}
                onChange={(e) => {
                  setNational(e.target.value);
                  setPhone(combine(code, e.target.value));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </div>
            <span className="field-hint">Required — used only to tell you apart from people with the same name. Your number isn&apos;t stored raw.</span>
          </div>
        </div>

        <span className="magnet" ref={magnetRef} onMouseMove={onMove} onMouseLeave={onLeave}>
          <button className="cta cta-xl" onClick={submit} disabled={!valid || busy}>
            {busy ? (
              <>
                <span
                  aria-hidden="true"
                  style={{
                    width: 17,
                    height: 17,
                    borderRadius: "50%",
                    border: "2px solid rgba(255,255,255,0.35)",
                    borderTopColor: "#fff",
                    animation: "scanSpin 0.7s linear infinite",
                    display: "inline-block",
                  }}
                />
                <span className="label">Locating…</span>
              </>
            ) : (
              <>
                {Icons.spark()}
                <span className="label">Send One</span>
                <span className="arrow" aria-hidden="true">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h13M13 6l6 6-6 6" />
                  </svg>
                </span>
              </>
            )}
          </button>
        </span>

        <div className="trust-line">
          <span className="lock">{Icons.shield(13)}</span> You decide what stays.
        </div>
      </div>
    </div>
  );
}

/* ── D. Collection sequence overlay — live, honest status ── */
function CollectionOverlay({
  progress,
  phaseIndex,
  elapsedMs,
  liveSource,
}: {
  progress: number;
  phaseIndex: number;
  elapsedMs: number;
  liveSource: string | null;
}) {
  const active = Math.min(phaseIndex, SHADOW_PHASES.length - 1);
  const headline = SHADOW_PHASES[active];
  const overran = elapsedMs > SHADOW_ESTIMATED_MS && active >= SHADOW_PHASES.length - 1;
  // Live "what's being checked" feed — real per-source when the upstream streams,
  // otherwise a curated cycle through the source categories Shadow checks.
  const scanning = liveSource || scanningSourceAt(elapsedMs);
  const pct = Math.round(Math.max(0.03, progress) * 100);
  return (
    <div className="seq">
      <div className="scan-console" aria-live="polite">
        <p className="scan-headline">
          <span className="fade" key={headline}>
            {overran ? "Composing your report — almost there…" : `One is ${headline.charAt(0).toLowerCase()}${headline.slice(1)}…`}
          </span>
        </p>

        <ol className="steps">
          {SHADOW_PHASES.map((label, i) => {
            const state = i < active ? "done" : i === active ? "active" : "pending";
            return (
              <li className={`step ${state}`} key={label} style={{ ["--i" as string]: i }}>
                <span className="step-dot" aria-hidden="true">
                  {state === "done" ? Icons.check(11) : null}
                </span>
                <span className="step-label">{label}</span>
              </li>
            );
          })}
        </ol>

        <div className="scan-progress">
          <div className="seq-progress">
            <div className="bar" style={{ transform: `scaleX(${Math.max(0.03, progress)})` }} />
          </div>
          <span className="scan-pct">{pct}%</span>
        </div>

        <div className="scan-foot">
          <span className="scan-live">
            <i className="scan-live-dot" aria-hidden="true" />
            <span className="scan-live-text">scanning {scanning}…</span>
          </span>
          <span className="seq-elapsed">{mmss(elapsedMs)}</span>
        </div>

        <p className="scan-note">Working through public sources — this deep scan takes a minute or two.</p>
      </div>
    </div>
  );
}

/* ── E. Results dashboard ───────────────────────────────── */
function ConfidenceRing({ value }: { value: number }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const off = c * (1 - value / 100);
  return (
    <div className="ring">
      <svg width="116" height="116" viewBox="0 0 116 116">
        <circle cx="58" cy="58" r={r} fill="none" stroke="#EEEEF0" strokeWidth="7" />
        <circle
          cx="58"
          cy="58"
          r={r}
          fill="none"
          stroke="url(#cg)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={off}
          style={{ transition: "stroke-dashoffset 1.4s cubic-bezier(0.22,0.61,0.18,1)" }}
        />
        <defs>
          <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8FB6FF" />
            <stop offset="1" stopColor="#E2AEF2" />
          </linearGradient>
        </defs>
      </svg>
      <div className="rnum">
        <b>{value}</b>
        <span>CONFIDENCE</span>
      </div>
    </div>
  );
}

function GCard({
  label,
  icon,
  span,
  delay,
  children,
}: {
  label: string;
  icon: ReactElement;
  span: number;
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <div className={"gcard col-" + span} style={{ animationDelay: delay + "ms" }}>
      <div className="ghead">
        <span className="glabel">{label}</span>
        <span className="gicon">{icon}</span>
      </div>
      {children}
    </div>
  );
}

const PLATFORMS: { key: string; name: string; a: string; c: string }[] = [
  { key: "linkedin", name: "LinkedIn", a: "in", c: "#0a66c2" },
  { key: "github", name: "GitHub", a: "gh", c: "#1d1d1f" },
  { key: "twitter", name: "X", a: "X", c: "#1d1d1f" },
  { key: "instagram", name: "Instagram", a: "ig", c: "#b14fb0" },
  { key: "dribbble", name: "Dribbble", a: "Dr", c: "#ea4c89" },
  { key: "facebook", name: "Facebook", a: "fb", c: "#1877f2" },
  { key: "youtube", name: "YouTube", a: "yt", c: "#ff0000" },
  { key: "medium", name: "Medium", a: "M", c: "#1d1d1f" },
  { key: "reddit", name: "Reddit", a: "re", c: "#ff4500" },
  { key: "behance", name: "Behance", a: "Be", c: "#1769ff" },
  { key: "stack overflow", name: "Stack Overflow", a: "SO", c: "#f48024" },
];

function detectPlatform(text: string) {
  const l = text.toLowerCase();
  return PLATFORMS.find((p) => l.includes(p.key)) || null;
}

const URL_RE = /((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s,)]*)?)/i;
function extractUrl(text: string) {
  const m = text.match(URL_RE);
  return m ? m[1].replace(/^https?:\/\//, "") : null;
}

const GROUNDING_RE = /vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i;
/** Display-safe source label — never renders a raw Gemini grounding-redirect token. */
function displaySource(text: string) {
  if (GROUNDING_RE.test(text)) return "public web source";
  return extractUrl(text) || text;
}

const POSITIVE = (s: string) => !!s && !/^\s*(no |none|not )/i.test(s.trim());

function coverageScore(result: OneDashboardResult) {
  const cats = result.categories;
  const populated = (Object.keys(cats) as (keyof DashboardCategoryMap)[]).filter((k) =>
    (cats[k] || []).some(POSITIVE),
  ).length;
  const sourceBacked = result.privateDataEstimation.filter((f) => f.confidence === "source-backed").length;
  return Math.max(8, Math.min(96, Math.round(46 + populated * 8 + sourceBacked * 4)));
}

function Frags({ items, src }: { items: string[]; src: string }) {
  const positive = items.filter(POSITIVE);
  if (!positive.length) {
    return <p className="sub" style={{ fontSize: 13.5, maxWidth: "none" }}>No source-backed signal yet.</p>;
  }
  return (
    <div className="frags">
      {positive.slice(0, 4).map((t, i) => (
        <div className="frag" key={i}>
          <div className="fsrc">{src}</div>
          <div className="ftitle">{t}</div>
        </div>
      ))}
    </div>
  );
}

/* curated rich lists (claims, conflicts, missing evidence) are rendered as-is —
   no POSITIVE filter, which would wrongly hide legitimate items starting with "No…" */
function TextList({ items }: { items: string[] }) {
  const clean = items.filter((s) => !!s && s.trim().length > 0);
  if (!clean.length) {
    return <p className="sub" style={{ fontSize: 13.5, maxWidth: "none" }}>Nothing surfaced.</p>;
  }
  return (
    <ul className="plist">
      {clean.slice(0, 8).map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

function ConfChip({ level }: { level: string | null }) {
  if (!level) return null;
  return <span className={`conf-chip conf-${level}`}>{level}</span>;
}

/* rich Shadow-only cards, appended after the core grid when result.rich exists */
function RichCards({ rich }: { rich: NonNullable<OneDashboardResult["rich"]> }) {
  const cards: ReactElement[] = [];
  const next = () => 720 + cards.length * 80;

  if (rich.professional && (rich.professional.currentRole || rich.professional.validatedClaims.length)) {
    cards.push(
      <GCard key="prof" label="Professional" icon={Icons.work()} span={7} delay={next()}>
        {rich.professional.currentRole ? (
          <div className="rrow">
            <span className="rrole">{rich.professional.currentRole}</span>
            <ConfChip level={rich.professional.confidence} />
          </div>
        ) : null}
        <TextList items={rich.professional.validatedClaims} />
        {rich.professional.unverifiedClaims.length ? (
          <div className="rsub">Unverified: {rich.professional.unverifiedClaims.join("; ")}</div>
        ) : null}
      </GCard>,
    );
  }

  if (rich.network && rich.network.associates.length) {
    cards.push(
      <GCard key="net" label="Network" icon={Icons.social()} span={5} delay={next()}>
        <ul className="plist">
          {rich.network.associates.slice(0, 8).map((a, i) => (
            <li key={i}>
              {a.name}
              {a.relation ? ` — ${a.relation}` : ""} <ConfChip level={a.confidence} />
            </li>
          ))}
        </ul>
      </GCard>,
    );
  }

  if (rich.preferenceSignals) {
    const ps = rich.preferenceSignals;
    if (ps.supported.length || ps.inferred.length || ps.unknown.length) {
      cards.push(
        <GCard key="pref" label="Preference signals" icon={Icons.identity()} span={6} delay={next()}>
          {ps.supported.length ? <div className="rsub-h">Supported</div> : null}
          {ps.supported.length ? <TextList items={ps.supported} /> : null}
          {ps.inferred.length ? <div className="rsub-h">Inferred</div> : null}
          {ps.inferred.length ? <TextList items={ps.inferred} /> : null}
          {ps.unknown.length ? <div className="rsub">Unknown: {ps.unknown.join("; ")}</div> : null}
        </GCard>,
      );
    }
  }

  if (rich.discovery && (rich.discovery.summary || rich.discovery.sources.length || rich.discovery.queryExpansion.length)) {
    cards.push(
      <GCard key="disc" label="Discovery" icon={Icons.gauge()} span={6} delay={next()}>
        {rich.discovery.summary ? <p className="sub" style={{ fontSize: 13.5, maxWidth: "none" }}>{rich.discovery.summary}</p> : null}
        {rich.discovery.sources.length ? (
          <div className="links" style={{ marginTop: 10 }}>
            {rich.discovery.sources.slice(0, 5).map((s, i) => (
              <div className="lrow" key={i}>
                <span className="lico">{Icons.link(15)}</span>
                <span className="lurl" title={s.url || s.platform}>{s.url && !GROUNDING_RE.test(s.url) ? displaySource(s.url) : s.platform}</span>
              </div>
            ))}
          </div>
        ) : null}
      </GCard>,
    );
  }

  if (rich.evidence.length) {
    cards.push(
      <GCard key="evid" label="Evidence ledger" icon={Icons.shield()} span={12} delay={next()}>
        <div className="frags">
          {rich.evidence.slice(0, 8).map((e, i) => (
            <div className="frag" key={i}>
              <div className="fsrc">
                {e.category || "evidence"}
                {e.confidence ? ` · ${e.confidence}` : ""}
              </div>
              <div className="ftitle">{e.claim}</div>
              {e.support ? <div className="fmeta" style={{ fontFamily: "var(--font-body)" }}>{e.support}</div> : null}
              {e.sources.length ? <div className="fmeta">{[...new Set(e.sources.map(displaySource))].join(" · ")}</div> : null}
            </div>
          ))}
        </div>
      </GCard>,
    );
  }

  if (rich.conflicts.length) {
    cards.push(
      <GCard key="conf" label="Conflicts" icon={Icons.retry(16)} span={6} delay={next()}>
        <TextList items={rich.conflicts} />
      </GCard>,
    );
  }

  if (rich.missingEvidence.length) {
    cards.push(
      <GCard key="miss" label="Missing evidence" icon={Icons.lock(16)} span={6} delay={next()}>
        <TextList items={rich.missingEvidence} />
      </GCard>,
    );
  }

  if (rich.sourceCards.length || rich.verifiedWebCount || rich.sourceUrls.length) {
    const list: OneSourceCard[] = rich.sourceCards.length
      ? rich.sourceCards
      : rich.sourceUrls.slice(0, 12).map((u) => ({
          url: u,
          domain: extractUrl(u) || u,
          label: extractUrl(u) || u,
          category: "Public web",
          favicon: null,
        }));
    cards.push(
      <GCard key="src" label="Sources" icon={Icons.link()} span={12} delay={next()}>
        <div className="links">
          {list.map((s, i) => (
            <div className="lrow" key={i}>
              <span className="lico">
                {s.favicon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.favicon} alt="" width={15} height={15} loading="lazy" style={{ borderRadius: 3 }} />
                ) : (
                  Icons.link(15)
                )}
              </span>
              <span className="lurl" title={s.url} style={{ fontFamily: "inherit" }}>
                <strong style={{ fontWeight: 600 }}>{s.label}</strong>
                {s.domain && s.domain !== s.label ? <span style={{ opacity: 0.45 }}> · {s.domain}</span> : null}
              </span>
              <span className="lcheck" style={{ opacity: 0.55, fontSize: "0.78em", letterSpacing: "0.02em" }}>{s.category}</span>
            </div>
          ))}
        </div>
        {rich.verifiedWebCount > 0 ? (
          <p style={{ opacity: 0.6, fontSize: "0.86em", marginTop: 10 }}>
            ✓ Verified across {rich.verifiedWebCount} more public web source{rich.verifiedWebCount === 1 ? "" : "s"}.
          </p>
        ) : null}
      </GCard>,
    );
  }

  return <>{cards}</>;
}

function Dashboard({
  result,
  audit,
  emailDelivery,
  onReset,
}: {
  result: OneDashboardResult;
  audit: PersonAuditStatus | null;
  emailDelivery: ScanEmailDeliverySummary | null;
  onReset: () => void;
}) {
  // Deep Research path → render the markdown dossier instead of the structured grid.
  if (result.report) {
    return (
      <div className="dash" data-screen-label="Dashboard">
        <div className="dash-inner">
          <div className="dash-head screen-enter">
            <p className="eyebrow">Gathered by One</p>
            <h1 className="display">Your deep research dossier.</h1>
            <p className="sub">{result.summary || "One compiled this from public sources for you."}</p>
            {emailDelivery ? (
              <div className={"email-status " + (emailDelivery.user.status === "sent" ? "sent" : "failed")}>
                {emailDelivery.user.status === "sent"
                  ? `Full results were emailed to ${result.subject.email}.`
                  : "Your dossier is ready."}
              </div>
            ) : null}
          </div>
          <article className="research-report screen-enter">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {result.report}
            </ReactMarkdown>
          </article>
          <div className="dash-foot">
            <div className="privacy-row">
              <span className="p">{Icons.shield(14)} Private by default</span>
              <span className="p">{Icons.check(14)} You control what One keeps</span>
              <span className="p">{Icons.check(14)} Remove anything, anytime</span>
            </div>
            <button className="ghost-btn" onClick={onReset}>
              Start over
            </button>
          </div>
        </div>
      </div>
    );
  }

  const first = result.subject.name.split(" ")[0] || "you";
  const initials = initialsForName(result.subject.name);
  const cats = result.categories;

  const catLabel: Record<keyof DashboardCategoryMap, string> = {
    newsAndMedia: "News & media",
    socials: "Social",
    education: "Education",
    government: "Public records",
    otherFootprints: "Public web",
    connectedIdentities: "Connected identities",
  };
  const tags = [result.mode === "precise" ? "Coordinate-backed" : "Limited mode"];
  (Object.keys(catLabel) as (keyof DashboardCategoryMap)[]).forEach((k) => {
    if ((cats[k] || []).some(POSITIVE)) tags.push(catLabel[k]);
  });

  const socials = (cats.socials || []).filter(POSITIVE);
  const links = [...(cats.connectedIdentities || []), ...(cats.otherFootprints || [])].filter(POSITIVE).slice(0, 5);
  const ringValue = result.rich?.confidenceScore ?? coverageScore(result);

  return (
    <div className="dash" data-screen-label="Dashboard">
      <div className="dash-inner">
        <div className="dash-head screen-enter">
          <p className="eyebrow">Gathered by One</p>
          <h1 className="display">Your footprint, organized.</h1>
          <p className="sub">{result.summary || `One organized this from public sources for you, ${first}.`}</p>
          {emailDelivery ? (
            <div className={"email-status " + (emailDelivery.user.status === "sent" ? "sent" : "failed")}>
              {emailDelivery.user.status === "sent"
                ? `Full scan results were emailed to ${result.subject.email}.`
                : emailDelivery.user.status === "skipped"
                  ? "Your scan is ready. The email copy was already sent for this scan."
                  : "Your scan is ready, but the email copy could not be sent."}
            </div>
          ) : null}
        </div>

        <div className="dash-grid">
          {/* Identity */}
          <GCard label="Identity" icon={Icons.identity()} span={7} delay={0}>
            <div className="idcard">
              <div className="photo">{initials}</div>
              <div>
                <div className="iname">{result.subject.name}</div>
                <div className="iemail">{result.subject.email}</div>
                <div className="itags">
                  {tags.slice(0, 5).map((t, i) => (
                    <span className="tag" key={i}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </GCard>

          {/* Confidence */}
          <GCard label="Confidence" icon={Icons.gauge()} span={5} delay={80}>
            <div className="ring-wrap">
              <ConfidenceRing value={ringValue} />
              {result.rich?.overallConfidence ? (
                <div className="src-lbl" style={{ marginTop: 4 }}>
                  {result.rich.overallConfidence} confidence
                  {typeof result.rich.sourceCount === "number" ? ` · ${result.rich.sourceCount} sources` : ""}
                </div>
              ) : audit ? (
                <div className="src-lbl" style={{ marginTop: 4 }}>
                  Audit {audit.status} · {audit.completedShards}/{audit.totalShards}
                </div>
              ) : null}
            </div>
          </GCard>

          {/* Social */}
          <GCard label="Social" icon={Icons.social()} span={6} delay={160}>
            {socials.length ? (
              <div className="social">
                {socials.slice(0, 6).map((s, i) => {
                  const p = detectPlatform(s);
                  const name = p?.name || "Profile";
                  const a = p?.a || (s.trim()[0] || "·").toUpperCase();
                  const color = "#111113";
                  return (
                    <div className="snode" key={i} title={s}>
                      <span className="sdot" style={{ background: color }}>
                        {a}
                      </span>
                      {name}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="sub" style={{ fontSize: 13.5, maxWidth: "none" }}>No source-backed social signal yet.</p>
            )}
          </GCard>

          {/* News & media */}
          <GCard label="News & media" icon={Icons.mention()} span={6} delay={240}>
            <Frags items={cats.newsAndMedia || []} src="Public web" />
          </GCard>

          {/* Links / connected identities */}
          <GCard label="Links" icon={Icons.link()} span={5} delay={320}>
            {links.length ? (
              <div className="links">
                {links.map((l, i) => (
                  <div className="lrow" key={i}>
                    <span className="lico">{Icons.link(15)}</span>
                    <span className="lurl" title={l}>
                      {displaySource(l)}
                    </span>
                    <span className="lcheck">{Icons.check(15)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sub" style={{ fontSize: 13.5, maxWidth: "none" }}>No connected identities yet.</p>
            )}
          </GCard>

          {/* Education */}
          <GCard label="Education" icon={Icons.work()} span={7} delay={400}>
            <Frags items={cats.education || []} src="Education" />
          </GCard>

          {/* Public records */}
          <GCard label="Public records" icon={Icons.shield()} span={6} delay={480}>
            <Frags items={cats.government || []} src="Records" />
          </GCard>

          {/* Location intelligence */}
          <GCard label="Location" icon={Icons.identity()} span={6} delay={560}>
            <p className="sub" style={{ fontSize: 13.5, maxWidth: "none" }}>
              {result.locationIntelligence || "No location context available."}
            </p>
          </GCard>

          {/* Private data estimation */}
          <GCard label="Private data estimation" icon={Icons.lock(16)} span={12} delay={640}>
            <div className="frags">
              {result.privateDataEstimation.length ? (
                result.privateDataEstimation.map((f: OneSafeFinding) => (
                  <div className="frag" key={f.id}>
                    <div className="fsrc">{f.confidence}</div>
                    <div className="ftitle">{f.label}</div>
                    <div className="fmeta">{f.detail}</div>
                  </div>
                ))
              ) : (
                <p className="sub" style={{ fontSize: 13.5, maxWidth: "none" }}>No private-data estimates surfaced.</p>
              )}
            </div>
            {result.warnings.length ? (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                {result.warnings.map((w, i) => (
                  <div className="fmeta" key={i} style={{ fontFamily: "var(--font-body)" }}>
                    {w}
                  </div>
                ))}
              </div>
            ) : null}
          </GCard>

          {result.rich ? <RichCards rich={result.rich} /> : null}
        </div>

        <div className="dash-foot">
          <div className="privacy-row">
            <span className="p">{Icons.shield(14)} Private by default</span>
            <span className="p">{Icons.check(14)} You control what One keeps</span>
            <span className="p">{Icons.check(14)} Remove anything, anytime</span>
          </div>
          <div className="trust-line">
            {result.redactions.length
              ? `Redacted from public view: ${result.redactions.join(", ")}`
              : "No private contact data rendered"}
          </div>
          <button className="ghost-btn" onClick={onReset}>
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── F. Empty + Error states ────────────────────────────── */
function EmptyState({ onManual, onRetry }: { onManual: () => void; onRetry: () => void }) {
  return (
    <div className="screen hero screen-enter">
      <div className="content hero-copy">
        <p className="eyebrow">A quiet result</p>
        <h1 className="display" style={{ fontSize: "clamp(26px,4vw,44px)" }}>
          One found only
          <br />a <span className="em">whisper</span>.
        </h1>
        <p className="sub">Just a few public signals. That can be a good thing.</p>
        <div className="state-actions">
          <button className="cta" style={{ height: 56, fontSize: 16 }} onClick={onManual}>
            <span className="label">Add sources manually</span>
          </button>
          <button className="ghost-btn" style={{ height: 56 }} onClick={onRetry}>
            Scan again
          </button>
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry, onManual }: { message: string; onRetry: () => void; onManual: () => void }) {
  return (
    <div className="screen hero screen-enter">
      <div className="content hero-copy">
        <p className="eyebrow">Nothing was lost</p>
        <h1 className="display" style={{ fontSize: "clamp(26px,4vw,44px)" }}>
          One couldn&apos;t
          <br />
          finish the scan.
        </h1>
        <p className="sub">{message || "Try again, or add a source manually."}</p>
        <div className="state-actions">
          <button className="cta" style={{ height: 56, fontSize: 16 }} onClick={onRetry}>
            {Icons.retry(16)}
            <span className="label">Try again</span>
          </button>
          <button className="ghost-btn" style={{ height: 56 }} onClick={onManual}>
            Add a source
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── F2. Location fallback — geolocation failed; retry or ZIP (extreme case) ── */
function LocationFallback({
  reason,
  busy,
  onRetry,
  onZip,
}: {
  reason: GeoReason;
  busy: boolean;
  onRetry: () => void;
  onZip: (zip: string) => void;
}) {
  const [zip, setZip] = useState("");
  const zipOk = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/.test(zip.trim());
  const headline =
    reason === "denied"
      ? "Location is turned off."
      : reason === "timeout"
        ? "Couldn't lock your location."
        : reason === "unsupported"
          ? "Location isn't available here."
          : "Couldn't find your location.";
  const detail =
    reason === "denied"
      ? "One uses your location to anchor the search. Re-enable location for this site in your browser settings and retry — or continue with your ZIP / postal code."
      : reason === "timeout"
        ? "That took too long. Make sure location is on, then try again — or continue with your ZIP / postal code."
        : "Your device couldn't determine your location. Try again — or continue with your ZIP / postal code.";
  const submitZip = (e: FormEvent) => {
    e.preventDefault();
    if (zipOk && !busy) onZip(zip.trim());
  };
  return (
    <div className="screen hero screen-enter">
      <div className="content hero-copy">
        <p className="eyebrow">One needs a location</p>
        <h1 className="display" style={{ fontSize: "clamp(26px,4vw,44px)" }}>
          {headline}
        </h1>
        <p className="sub">{detail}</p>
        <div className="state-actions">
          <button className="cta" style={{ height: 56, fontSize: 16 }} onClick={onRetry} disabled={busy}>
            {Icons.retry(16)}
            <span className="label">{busy ? "Locating…" : "Enable location & retry"}</span>
          </button>
        </div>
        <form className="card" style={{ marginTop: 18 }} onSubmit={submitZip}>
          <div className="field-group">
            <label htmlFor="zip">Or continue with your ZIP / postal code</label>
            <input
              id="zip"
              className="input"
              placeholder="400001"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              autoComplete="postal-code"
              disabled={busy}
            />
            <span className="field-hint">Less precise than live location, but enough to anchor the search.</span>
          </div>
          <div className="cta-block">
            <button className="solid-cta" type="submit" disabled={!zipOk || busy}>
              Continue with ZIP
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── G. Profile menu (header avatar dropdown) ───────────── */
function ProfileMenu({
  name,
  email,
  photoURL,
  onSettings,
  onLogout,
  onDelete,
}: {
  name: string;
  email: string;
  photoURL: string | null;
  onSettings: () => void;
  onLogout: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("touchstart", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("touchstart", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="pm" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="pm-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pm-avatar">
          {photoURL ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoURL} alt="" referrerPolicy="no-referrer" />
          ) : (
            initialsForName(name)
          )}
        </span>
      </button>
      {open ? (
        <div className="pm-panel" role="menu">
          <div className="pm-head">
            <div className="pm-nm">{name || "One user"}</div>
            <div className="pm-em">{email}</div>
          </div>
          <button type="button" className="pm-item" role="menuitem" onClick={run(onSettings)}>
            Settings
          </button>
          <button type="button" className="pm-item" role="menuitem" onClick={run(onLogout)}>
            Log out
          </button>
          <button type="button" className="pm-item danger" role="menuitem" onClick={run(onDelete)}>
            Delete account
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ── H. Settings screen ─────────────────────────────────── */
function Settings({
  name,
  email,
  photoURL,
  onBack,
  onLogout,
  onDelete,
}: {
  name: string;
  email: string;
  photoURL: string | null;
  onBack: () => void;
  onLogout: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="screen settings screen-enter">
      <div className="content">
        <p className="eyebrow">Your account</p>
        <h1 className="display" style={{ fontSize: "clamp(26px,4vw,44px)" }}>
          Settings
        </h1>

        <div className="set-box">
          <div className="idcap">
            <span className="avatar">
              {photoURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoURL} alt="" referrerPolicy="no-referrer" />
              ) : (
                initialsForName(name)
              )}
            </span>
            <span className="meta">
              <span className="nm">{name || "One user"}</span>
              <span className="em">{email}</span>
            </span>
          </div>
          <p className="sub set-note">
            {Icons.shield(14)} One is private by default. Your report stays tied to your account, and you can remove
            everything at any time.
          </p>
        </div>

        <div className="set-actions">
          <button className="ghost-btn" onClick={onLogout}>
            Log out
          </button>
          <button className="ghost-btn danger" onClick={onDelete}>
            Delete account
          </button>
        </div>

        <button className="set-back" onClick={onBack}>
          ← Done
        </button>
      </div>
    </div>
  );
}

/* ── I. Delete-account confirmation (type-to-confirm) ───── */
function ConfirmDelete({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // mounted fresh each open (parent renders conditionally) → autofocus the field
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const armed = value.trim().toUpperCase() === "DELETE" && !busy;

  return (
    <div className="modal-scrim" role="presentation" onClick={() => !busy && onCancel()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="del-title"
        aria-describedby="del-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="del-title" className="modal-title">
          Delete your account?
        </h2>
        <p id="del-desc" className="sub" style={{ maxWidth: "none" }}>
          This permanently removes your account, every scan and report, and your sign-in. This can&apos;t be undone.
        </p>
        <label className="modal-label" htmlFor="del-input">
          Type <strong>DELETE</strong> to confirm
        </label>
        <input
          id="del-input"
          ref={inputRef}
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="Type DELETE to confirm"
        />
        {error ? <p className="modal-error">{error}</p> : null}
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="danger-btn" onClick={onConfirm} disabled={!armed}>
            {busy ? "Deleting…" : "Delete account"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── state machine ──────────────────────────────────────── */
export default function OneExperience() {
  const [stage, setStage] = useState<Stage>("hydrating");
  const [authUser, setAuthUser] = useState<ClientUser | null>(null);
  const [identity, setIdentity] = useState<Identity>({ name: "", email: "" });
  // lazy-read the saved phone so a refresh keeps it without a setState-in-effect
  // (SSR-safe: safeGet returns null on the server, and phone isn't rendered while hydrating)
  const [phone, setPhone] = useState(() => safeGet("local", LS_PHONE) ?? "");
  const [progress, setProgress] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [serverStage, setServerStage] = useState(0);
  const [liveSource, setLiveSource] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<OneDashboardResult | null>(null);
  const [audit, setAudit] = useState<PersonAuditStatus | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<ScanEmailDeliverySummary | null>(null);
  const [error, setError] = useState("");
  const [geoBusy, setGeoBusy] = useState(false); // waiting on the browser location prompt
  const [geoReason, setGeoReason] = useState<GeoReason>("denied"); // drives LocationFallback copy
  const [notice, setNotice] = useState(""); // brief confirmation line on landing (e.g. after delete)
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const collectStart = useRef(0);
  const scanRunIdRef = useRef<string | null>(null);
  const pollStopRef = useRef(false); // abort in-flight recovery polling on logout/delete/unmount
  const prevStageRef = useRef<Stage>("precollect"); // where to return to when leaving Settings

  const mode: "idle" | "collect" | "dashboard" =
    stage === "collect" ? "collect" : stage === "dashboard" ? "dashboard" : "idle";

  const phaseIndex = Math.max(serverStage, shadowPhaseIndex(elapsedMs));

  // reflect baked accent/motion defaults into CSS chrome (replaces the Tweaks panel)
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--blue-soft", ACCENT);
    root.style.setProperty("--motion", String(MOTION));
    root.style.setProperty("--blue-glow", hexA(ACCENT, 0.16));
  }, []);

  // client behaviour funnel — one event per stage transition so drop-off
  // (landing → sign-in → precollect → collect → dashboard) is reconstructable.
  useEffect(() => {
    track(`stage_${stage}`);
  }, [stage]);

  // landing scrolls like a normal marketing page; app stages stay viewport-locked
  useEffect(() => {
    const b = document.body;
    if (stage === "landing") b.classList.add("scroll-on");
    else b.classList.remove("scroll-on");
    return () => b.classList.remove("scroll-on");
  }, [stage]);

  // cinematic progress while collecting: ease toward 0.92 across the estimated
  // multi-minute run, track elapsed; never regress, never complete until the result lands
  useEffect(() => {
    if (stage !== "collect") return;
    let raf = 0;
    let stopped = false;
    const start = performance.now();
    const tick = (now: number) => {
      if (stopped) return;
      const elapsed = now - start;
      setElapsedMs(elapsed);
      const eased = Math.min(0.92, elapsed / SHADOW_ESTIMATED_MS);
      setProgress((prev) => (prev >= 1 ? prev : Math.max(prev, eased)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [stage]);

  const onManualDone = (u: Identity) => {
    setIdentity(u);
    setStage("precollect");
  };

  // Settings is a signed-in overlay stage; remember where we came from for "Done".
  const goToSettings = () => {
    if (stage === "settings") return;
    prevStageRef.current = stage;
    setStage("settings");
  };
  const leaveSettings = () => setStage(prevStageRef.current ?? "precollect");

  const revealResult = async (final: ScanFinal) => {
    const minDwell = 4500;
    const elapsed = performance.now() - collectStart.current;
    if (elapsed < minDwell) await new Promise((r) => setTimeout(r, minDwell - elapsed));
    const result = final.result;
    setDashboard(result);
    setAudit(final.audit || null);
    setEmailDelivery(final.emailDelivery || null);
    setProgress(1);
    // promote the scan id to "last completed" so a later refresh restores the report
    safeDel("local", LS_ACTIVE_SCAN);
    if (scanRunIdRef.current) safeSet("local", LS_LAST_SCAN, scanRunIdRef.current);
    const hasReport = !!(result.report && result.report.trim());
    const hasCategorySignal = Object.values(result.categories || {}).some((list) => (list as string[]).some(POSITIVE));
    const hasRichSignal = !!(
      result.rich &&
      (result.rich.evidence.length ||
        result.rich.professional ||
        (result.rich.digitalFootprint && result.rich.digitalFootprint.profiles.length))
    );
    setTimeout(() => setStage(hasReport || hasCategorySignal || hasRichSignal ? "dashboard" : "empty"), 380);
  };

  // one status probe for a scan id. 404 → "unknown"; otherwise the saved status.
  const fetchScanStatus = async (
    user: ClientUser,
    id: string,
  ): Promise<{ status: string; result: OneDashboardResult | null; emailDelivery: ScanEmailDeliverySummary | null }> => {
    const authorization = await getFirebaseBearer(user as User);
    const res = await fetch(
      `${RESEARCH_MODE ? "/api/one/research/" : "/api/one/scans/"}${encodeURIComponent(id)}`,
      { headers: { Authorization: authorization } },
    );
    if (res.status === 404) return { status: "unknown", result: null, emailDelivery: null };
    if (!res.ok) return { status: "error", result: null, emailDelivery: null };
    const payload = (await res.json().catch(() => null)) as {
      status?: string;
      result?: OneDashboardResult | null;
      emailDelivery?: ScanEmailDeliverySummary | null;
    } | null;
    return {
      status: payload?.status || "unknown",
      result: payload?.result ?? null,
      emailDelivery: payload?.emailDelivery ?? null,
    };
  };

  // Fast path for an ALREADY-completed scan (deep-link / last-scan). A few quick
  // tries; bail immediately once it's clearly not a finished result to wait on.
  const tryRecoverCompleted = async (
    user: ClientUser,
    id: string,
  ): Promise<{ result: OneDashboardResult; emailDelivery: ScanEmailDeliverySummary | null } | null> => {
    for (let i = 0; i < 3; i += 1) {
      try {
        const { status, result, emailDelivery } = await fetchScanStatus(user, id);
        if (status === "completed" && result) return { result, emailDelivery };
        if (status === "failed" || status === "unknown") return null;
      } catch {
        /* transient — retry */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  };

  // In-flight recovery: the server keeps running after a disconnect, so poll with
  // backoff (capped near the route's 900s maxDuration) until it finishes. The
  // caller owns showing the "collect" stage; this reveals on success.
  const POLL_MAX_MS = 900_000;
  const resilientRecover = async (user: ClientUser, id: string): Promise<"revealed" | "failed" | "gaveup"> => {
    pollStopRef.current = false;
    const startedAt = performance.now();
    let delay = 2000;
    let unknownStreak = 0;
    while (!pollStopRef.current && scanRunIdRef.current === id && performance.now() - startedAt < POLL_MAX_MS) {
      let status = "running";
      let result: OneDashboardResult | null = null;
      let emailDelivery: ScanEmailDeliverySummary | null = null;
      try {
        ({ status, result, emailDelivery } = await fetchScanStatus(user, id));
      } catch {
        status = "error"; // network blip → treat as still running, keep polling
      }
      if (status === "completed" && result) {
        await revealResult({ result, audit: null, emailDelivery });
        return "revealed";
      }
      if (status === "failed") {
        safeDel("local", LS_ACTIVE_SCAN);
        return "failed";
      }
      if (status === "unknown") {
        unknownStreak += 1;
        if (unknownStreak >= 3) {
          // the row truly isn't there after a few tries → stop chasing it
          safeDel("local", LS_ACTIVE_SCAN);
          return "gaveup";
        }
      } else {
        unknownStreak = 0;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(10_000, Math.round(delay * 1.4));
    }
    return "gaveup";
  };

  // Map a (restored or freshly signed-in) user → identity → the right screen,
  // honoring a mid-scan recovery, an email deep-link, or a last-scan dashboard.
  const hydrateFromUser = async (user: ClientUser) => {
    try {
      setAuthUser(user);
      const id = extractIdentity(user);
      setIdentity(id);
      const baseStage: Stage = !id.name || !isValidEmail(id.email) ? "manual" : "precollect";

      // (a) a scan was in flight (localStorage → survives refresh AND app close)
      const inFlight = safeGet("local", LS_ACTIVE_SCAN);
      if (inFlight) {
        scanRunIdRef.current = inFlight;
        collectStart.current = performance.now();
        setStage("collect");
        const outcome = await resilientRecover(user, inFlight);
        if (outcome === "revealed") return;
        if (outcome === "failed") {
          setError("That scan didn't finish. Start a new one when you're ready.");
          setStage("error");
          return;
        }
        // gaveup → fall through to the other recovery paths
      }

      // (b) an email deep-link (?scan=) or last completed scan → completed-only fetch
      const pending = safeGet("session", SS_PENDING);
      const restoreId = pending || safeGet("local", LS_LAST_SCAN);
      if (restoreId) {
        scanRunIdRef.current = restoreId;
        const recovered = await tryRecoverCompleted(user, restoreId);
        safeDel("session", SS_PENDING);
        if (recovered) {
          await revealResult({ result: recovered.result, audit: null, emailDelivery: recovered.emailDelivery });
          return;
        }
        if (!pending) safeDel("local", LS_LAST_SCAN); // stale/expired id
      }

      // (c) nothing local — ask the server for this user's most recent scan, so a
      // full app close mid-scan (no local id) still reconnects.
      try {
        const authorization = await getFirebaseBearer(user as User);
        const res = await fetch("/api/one/scans/latest", { headers: { Authorization: authorization } });
        if (res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            status?: string;
            scanRunId?: string | null;
            result?: OneDashboardResult | null;
            emailDelivery?: ScanEmailDeliverySummary | null;
          } | null;
          if (payload?.scanRunId && payload.status === "running") {
            scanRunIdRef.current = payload.scanRunId;
            safeSet("local", LS_ACTIVE_SCAN, payload.scanRunId);
            collectStart.current = performance.now();
            setStage("collect");
            const outcome = await resilientRecover(user, payload.scanRunId);
            if (outcome === "revealed") return;
            if (outcome === "failed") {
              setError("That scan didn't finish. Start a new one when you're ready.");
              setStage("error");
              return;
            }
          } else if (payload?.scanRunId && payload.status === "completed" && payload.result) {
            scanRunIdRef.current = payload.scanRunId;
            safeSet("local", LS_LAST_SCAN, payload.scanRunId);
            await revealResult({ result: payload.result, audit: null, emailDelivery: payload.emailDelivery ?? null });
            return;
          }
        }
      } catch {
        /* probe failed — never block sign-in on it */
      }

      // (d) default — signed in, nothing to restore
      setStage(baseStage);
    } catch {
      // token revoked / getIdToken threw → clean sign-out → landing
      await signOutOfGoogle().catch(() => undefined);
      clearPersisted();
      setAuthUser(null);
      setStage("landing");
    }
  };

  // ── Rehydrate auth + app state on load so a refresh never re-prompts ──────
  useEffect(() => {
    // capture an email deep-link (?scan=<id>) for after sign-in, then clean the URL
    try {
      const params = new URLSearchParams(window.location.search);
      const scanId = params.get("scan");
      if (scanId) {
        safeSet("session", SS_PENDING, scanId);
        params.delete("scan");
        const qs = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
      }
    } catch {
      /* ignore malformed URL */
    }

    let cancelled = false;
    let unsub: (() => void) | null = null;
    // run async so we never call setState synchronously during the effect pass
    const boot = async () => {
      // dev mode has no Firebase session → restore the fake user from a flag
      if (!isFirebaseClientConfigured()) {
        if (shouldAllowDevAuth() && safeGet("session", SS_DEV_AUTH) === "1") await hydrateFromUser(makeDevUser());
        else setStage("landing");
        return;
      }
      // Complete a pending mobile redirect sign-in first (and surface its errors). The
      // resulting signed-in user is routed by the observeAuth first emission below.
      try {
        const redirectUser = await completeGoogleRedirect();
        if (redirectUser) track("signed_in", { provider: "google" });
      } catch (e) {
        if (!cancelled) setError(mapSignInError(e));
      }
      let initialResolved = false;
      unsub = observeAuth((user) => {
        if (cancelled) return;
        if (!initialResolved) {
          initialResolved = true; // first emission = the persisted session (or null)
          if (user) void hydrateFromUser(user);
          else setStage("landing");
          return;
        }
        // later emissions (token refresh, interactive sign-in, sign-out): keep the
        // user reference fresh — routing is owned by onAuth/reset, not the listener.
        setAuthUser(user);
      });
    };
    void boot();
    return () => {
      cancelled = true;
      pollStopRef.current = true; // stop recovery polling if the component unmounts
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist the typed phone so a precollect refresh keeps it (skip the splash)
  useEffect(() => {
    if (stage === "hydrating") return;
    if (phone.trim()) safeSet("local", LS_PHONE, phone);
    else safeDel("local", LS_PHONE);
  }, [phone, stage]);

  const onAuth = async () => {
    setError("");
    setNotice("");
    try {
      let user: ClientUser | null;
      if (isFirebaseClientConfigured()) user = await signInWithGoogle();
      else if (shouldAllowDevAuth()) {
        user = makeDevUser();
        safeSet("session", SS_DEV_AUTH, "1"); // so a refresh restores the dev user
      } else throw new Error("Google sign-in is not configured for this build.");

      // Mobile (or a popup fallback) started a full-page redirect → no user on this page;
      // boot()'s completeGoogleRedirect finishes the sign-in when the browser returns.
      if (!user) return;

      track("signed_in", { provider: isFirebaseClientConfigured() ? "google" : "dev" });
      await hydrateFromUser(user); // single routing path (also honors a ?scan deep-link)
    } catch (e) {
      // LandingPage renders this error inline — no bounce to the error screen.
      // mapSignInError returns "" for user cancellations (stay quiet).
      setError(mapSignInError(e));
    }
  };

  const runScan = async (location: Coordinates) => {
    if (!authUser) {
      setError("Sign in again to continue.");
      setStage("error");
      return;
    }
    setProgress(0);
    setElapsedMs(0);
    setServerStage(0);
    setLiveSource(null);
    setDashboard(null);
    setAudit(null);
    setEmailDelivery(null);
    setError("");
    scanRunIdRef.current = null;
    setStage("collect");
    collectStart.current = performance.now();

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 900_000);

    try {
      const authorization = await getFirebaseBearer(authUser as User);
      const response = await fetch(RESEARCH_MODE ? "/api/one/research" : "/api/one/dashboard", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        signal: controller.signal,
        body: JSON.stringify({
          name: identity.name,
          email: identity.email,
          latitude: location.latitude,
          longitude: location.longitude,
          zipCode: location.zipCode,
          phone: phone.trim() || undefined,
          consentAttestation: true,
          purpose: "self_audit",
        }),
      });

      // Pre-stream failures (auth/validation) come back as a JSON error body.
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !response.body || contentType.includes("application/json")) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "One could not complete the scan.");
      }

      const final = await readScanStream(response.body, (msg) => {
        if (typeof msg.scanRunId === "string") {
          scanRunIdRef.current = msg.scanRunId;
          safeSet("local", LS_ACTIVE_SCAN, msg.scanRunId); // recover this run after a refresh OR app close
        }
        if (typeof msg.stage === "number") setServerStage((s) => Math.max(s, msg.stage as number));
        if (typeof msg.scanning === "string") setLiveSource(msg.scanning as string);
      });

      if (!final || final.type === "error" || !final.result) {
        throw new Error(final?.error || "One could not complete the scan.");
      }
      await revealResult({ result: final.result, audit: final.audit, emailDelivery: final.emailDelivery });
    } catch (e) {
      // the stream dropped, but the scan keeps running server-side — keep polling
      if (scanRunIdRef.current) {
        const outcome = await resilientRecover(authUser, scanRunIdRef.current).catch(() => "gaveup" as const);
        if (outcome === "revealed") return;
        if (outcome === "failed") {
          setError("One could not complete the scan.");
          setStage("error");
          return;
        }
      }
      safeDel("local", LS_ACTIVE_SCAN); // nothing to resurrect as "collecting"
      setError(e instanceof Error ? e.message : "One could not complete the scan.");
      setStage("error");
    } finally {
      clearTimeout(abortTimer);
    }
  };

  const startCollect = () => {
    if (geoBusy || stage === "collect") return; // guard double-submit / overlapping scans
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoReason("unsupported");
      setStage("location");
      return;
    }
    setError("");
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoBusy(false);
        void runScan({
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
        });
      },
      (err) => {
        setGeoBusy(false);
        const reason: GeoReason =
          err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable";
        if (reason === "denied") track("geo_denied");
        setGeoReason(reason);
        setStage("location"); // retry + ZIP extreme fallback
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  const reset = async () => {
    track("started_over");
    pollStopRef.current = true; // halt any in-flight recovery polling
    await signOutOfGoogle().catch(() => undefined);
    clearPersisted();
    scanRunIdRef.current = null;
    setAuthUser(null);
    setIdentity({ name: "", email: "" });
    setPhone("");
    setDashboard(null);
    setAudit(null);
    setEmailDelivery(null);
    setError("");
    setProgress(0);
    setElapsedMs(0);
    setServerStage(0);
    setLiveSource(null);
    setGeoBusy(false);
    setStage("landing");
  };

  // Irreversible: wipe the account + all data server-side, then tear down locally.
  const deleteAccount = async () => {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      if (isFirebaseClientConfigured() && authUser) {
        const authorization = await getFirebaseBearer(authUser as User);
        const res = await fetch("/api/one/account", { method: "DELETE", headers: { Authorization: authorization } });
        // 401 = token already revoked → treat as already deleted; other !ok = real failure
        if (!res.ok && res.status !== 401) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || "Could not delete your account.");
        }
      } else if (shouldAllowDevAuth() && authUser) {
        await fetch("/api/one/account", {
          method: "DELETE",
          headers: { Authorization: "Bearer DEV_TOKEN" },
        }).catch(() => undefined);
      }

      // teardown — mirrors reset() (minus the "started_over" event)
      pollStopRef.current = true;
      await signOutOfGoogle().catch(() => undefined);
      clearPersisted();
      scanRunIdRef.current = null;
      setAuthUser(null);
      setIdentity({ name: "", email: "" });
      setPhone("");
      setDashboard(null);
      setAudit(null);
      setEmailDelivery(null);
      setError("");
      setProgress(0);
      setElapsedMs(0);
      setServerStage(0);
      setLiveSource(null);
      setDeleteOpen(false);
      setNotice("Your account and all data were deleted.");
      track("account_deleted");
      setStage("landing");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete your account.");
    } finally {
      setDeleteBusy(false);
    }
  };

  // While Firebase reports the persisted session, show a minimal splash (no CTA,
  // no popup) so a signed-in refresh never flashes the landing or re-prompts.
  if (stage === "hydrating") {
    return (
      <main className="stage landing-mode">
        <div className="brandbar">
          <div className="wordmark">
            <span className="logo">{Icons.husshMark()}</span>
            <span className="mark">One</span>
            <span className="byline">by hussh</span>
          </div>
        </div>
        <div className="hydrate-splash" aria-busy="true" aria-label="Restoring your session" />
      </main>
    );
  }

  // Landing is the hellow-style minimal home with its own shell.
  if (stage === "landing") {
    return (
      <main className="stage landing-mode">
        <div className="brandbar">
          <div className="wordmark">
            <span className="logo">{Icons.husshMark()}</span>
            <span className="mark">One</span>
            <span className="byline">by hussh</span>
          </div>
        </div>
        {notice ? (
          <div className="toast" role="status">
            {Icons.check(14)} {notice}
          </div>
        ) : null}
        <LandingPage onStart={onAuth} error={error} />
      </main>
    );
  }

  let view: ReactElement | null = null;
  if (stage === "settings")
    view = (
      <Settings
        key="s"
        name={identity.name}
        email={identity.email}
        photoURL={authUser?.photoURL ?? null}
        onBack={leaveSettings}
        onLogout={reset}
        onDelete={() => setDeleteOpen(true)}
      />
    );
  else if (stage === "manual")
    view = (
      <Manual
        key="m"
        initialName={identity.name}
        initialEmail={identity.email}
        lockedEmail={authUser?.email ?? undefined}
        onContinue={onManualDone}
      />
    );
  else if (stage === "precollect")
    view = <PreCollect key="p" user={identity} phone={phone} setPhone={setPhone} onCollect={startCollect} busy={geoBusy} />;
  else if (stage === "collect")
    view = <CollectionOverlay key="c" progress={progress} phaseIndex={phaseIndex} elapsedMs={elapsedMs} liveSource={liveSource} />;
  else if (stage === "dashboard" && dashboard)
    view = <Dashboard key="d" result={dashboard} audit={audit} emailDelivery={emailDelivery} onReset={reset} />;
  else if (stage === "empty")
    view = (
      <EmptyState
        key="e"
        onManual={() => setStage("manual")}
        onRetry={() => (authUser ? startCollect() : setStage("landing"))}
      />
    );
  else if (stage === "error")
    view = (
      <ErrorState
        key="x"
        message={error}
        onRetry={() => (authUser ? startCollect() : setStage("landing"))}
        onManual={() => setStage("manual")}
      />
    );
  else if (stage === "location")
    view = (
      <LocationFallback
        key="loc"
        reason={geoReason}
        busy={geoBusy}
        onRetry={startCollect}
        onZip={(zip) => void runScan({ zipCode: zip })}
      />
    );

  return (
    <main className="stage">
      {stage === "manual" || stage === "empty" || stage === "error" || stage === "location" || stage === "settings" ? (
        <ParticleMorph motion={MOTION} />
      ) : (
        <CanvasField mode={mode} progress={progress} motion={MOTION} preMoment={stage === "precollect"} />
      )}

      <div className="brandbar">
        <div className="wordmark">
          <span className="logo">{Icons.husshMark()}</span>
          <span className="mark">One</span>
          <span className="byline">by hussh</span>
        </div>
        {authUser && stage !== "collect" ? (
          <ProfileMenu
            name={identity.name}
            email={identity.email}
            photoURL={authUser.photoURL ?? null}
            onSettings={goToSettings}
            onLogout={reset}
            onDelete={() => setDeleteOpen(true)}
          />
        ) : (
          <div className="trust">{Icons.shield(14)} Private by default</div>
        )}
      </div>

      <div className="ui">{view}</div>

      {deleteOpen ? (
        <ConfirmDelete
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => {
            if (!deleteBusy) {
              setDeleteOpen(false);
              setDeleteError("");
            }
          }}
          onConfirm={deleteAccount}
        />
      ) : null}
    </main>
  );
}
