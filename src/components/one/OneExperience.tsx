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
  getFirebaseBearer,
  isFirebaseClientConfigured,
  makeDevUser,
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

type Stage = "landing" | "manual" | "precollect" | "collect" | "dashboard" | "empty" | "error";
type ClientUser = Pick<User, "uid" | "email" | "displayName" | "photoURL" | "getIdToken">;

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

const HEADLINE = 'Meet <span class="em">One</span>.';
const MOTION = 0.7;
const ACCENT = "#4C9DFF";

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

function extractIdentity(user: ClientUser): Identity {
  return { name: normalizeName(user.displayName), email: normalizeEmail(user.email) };
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

/* ── auth button ────────────────────────────────────────── */
function AuthButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn" onClick={onClick}>
      {Icons.google()}
      <span>Continue with Google</span>
    </button>
  );
}

/* ── A. Landing / sign-in ───────────────────────────────── */
function Landing({ onAuth, error }: { onAuth: () => void; error: string }) {
  return (
    <div className="screen hero screen-enter">
      <div className="content hero-copy">
        <h1 className="display" dangerouslySetInnerHTML={{ __html: HEADLINE }} />
        <p className="sub">Your personal intelligence agent.</p>
        <div className="auth-stack">
          <AuthButton onClick={onAuth} />
        </div>
        {error ? <p className="trust-line" style={{ color: "#c2554d" }}>{error}</p> : null}
      </div>
    </div>
  );
}

/* ── B. Manual name / email fallback ────────────────────── */
function Manual({
  initialName,
  initialEmail,
  onContinue,
}: {
  initialName: string;
  initialEmail: string;
  onContinue: (u: Identity) => void;
}) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [touched, setTouched] = useState(false);
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const ok = name.trim().length > 1 && validEmail;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    onContinue({ name: name.trim(), email: email.trim() });
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
function PreCollect({
  user,
  phone,
  setPhone,
  onCollect,
}: {
  user: Identity;
  phone: string;
  setPhone: (v: string) => void;
  onCollect: () => void;
}) {
  const initials = initialsForName(user.name);
  const valid = isValidPhone(phone);
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
    if (valid) onCollect();
  };
  return (
    <div className="screen precollect screen-enter">
      <div className="pc">
        <div className="pc-head">
          <p className="eyebrow">Agent ready</p>
          <h1 className="display pc-title">One will connect what matters.</h1>
        </div>

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
          <input
            id="ph"
            className="input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+1 555 000 1234"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <span className="field-hint">Used only to tell you apart from people with the same name — your number isn&apos;t stored raw.</span>
        </div>

        <div className="pc-thread" aria-hidden="true">
          <i></i>
          <i></i>
          <i></i>
        </div>

        <span className="magnet" ref={magnetRef} onMouseMove={onMove} onMouseLeave={onLeave}>
          <button className="cta cta-xl" onClick={submit} disabled={!valid}>
            {Icons.spark()}
            <span className="label">Send One</span>
            <span className="arrow" aria-hidden="true">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
            </span>
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
  return (
    <div className="seq">
      <div className="seq-copy" aria-live="polite">
        <ol className="steps">
          {SHADOW_PHASES.map((label, i) => {
            const state = i < active ? "done" : i === active ? "active" : "pending";
            return (
              <li className={`step ${state}`} key={label}>
                <span className="step-dot" aria-hidden="true">
                  {state === "done" ? Icons.check(11) : null}
                </span>
                <span className="step-label">{label}</span>
              </li>
            );
          })}
        </ol>
        <p className="seq-line">
          <span className="fade" key={headline}>
            {overran ? "Composing your report — almost there…" : `One is ${headline.charAt(0).toLowerCase()}${headline.slice(1)}…`}
          </span>
        </p>
        <p className="seq-line" style={{ marginTop: -6, opacity: 0.66, fontSize: "0.9em" }}>
          <span className="fade" key={`scan-${scanning}`}>↳ scanning {scanning}…</span>
        </p>
        <div className="seq-progress">
          <div className="bar" style={{ transform: `scaleX(${Math.max(0.03, progress)})` }} />
        </div>
        <div className="seq-meta">
          <span>Working through public sources — this deep scan takes a minute or two.</span>
          <span className="seq-elapsed">{mmss(elapsedMs)}</span>
        </div>
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
        <circle cx="58" cy="58" r={r} fill="none" stroke="#E8E8E8" strokeWidth="7" />
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
            <stop offset="0" stopColor="#4C9DFF" />
            <stop offset="1" stopColor="#8FE3F2" />
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
                  const color = p?.c || "#8E8E93";
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

/* ── state machine ──────────────────────────────────────── */
export default function OneExperience() {
  const [stage, setStage] = useState<Stage>("landing");
  const [authUser, setAuthUser] = useState<ClientUser | null>(null);
  const [identity, setIdentity] = useState<Identity>({ name: "", email: "" });
  const [phone, setPhone] = useState("");
  const [progress, setProgress] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [serverStage, setServerStage] = useState(0);
  const [liveSource, setLiveSource] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<OneDashboardResult | null>(null);
  const [audit, setAudit] = useState<PersonAuditStatus | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<ScanEmailDeliverySummary | null>(null);
  const [error, setError] = useState("");
  const collectStart = useRef(0);
  const scanRunIdRef = useRef<string | null>(null);

  const mode: "idle" | "collect" | "dashboard" =
    stage === "collect" ? "collect" : stage === "dashboard" ? "dashboard" : "idle";

  const phaseIndex = Math.max(serverStage, shadowPhaseIndex(elapsedMs));

  // reflect baked accent/motion defaults into CSS chrome (replaces the Tweaks panel)
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--blue-soft", ACCENT);
    root.style.setProperty("--motion", String(MOTION));
    root.style.setProperty("--blue-glow", hexA(ACCENT, 0.55));
  }, []);

  // client behaviour funnel — one event per stage transition so drop-off
  // (landing → sign-in → precollect → collect → dashboard) is reconstructable.
  useEffect(() => {
    track(`stage_${stage}`);
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

  const onAuth = async () => {
    setError("");
    try {
      let user: ClientUser;
      if (isFirebaseClientConfigured()) user = await signInWithGoogle();
      else if (shouldAllowDevAuth()) user = makeDevUser();
      else throw new Error("Google sign-in is not configured for this build.");

      const id = extractIdentity(user);
      setAuthUser(user);
      setIdentity(id);
      track("signed_in", { provider: isFirebaseClientConfigured() ? "google" : "dev" });
      setStage(!id.name || !isValidEmail(id.email) ? "manual" : "precollect");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      setStage("error");
    }
  };

  const onManualDone = (u: Identity) => {
    setIdentity(u);
    setStage("precollect");
  };

  const revealResult = async (final: ScanFinal) => {
    const minDwell = 4500;
    const elapsed = performance.now() - collectStart.current;
    if (elapsed < minDwell) await new Promise((r) => setTimeout(r, minDwell - elapsed));
    const result = final.result;
    setDashboard(result);
    setAudit(final.audit || null);
    setEmailDelivery(final.emailDelivery || null);
    setProgress(1);
    const hasCategorySignal = Object.values(result.categories || {}).some((list) => (list as string[]).some(POSITIVE));
    const hasRichSignal = !!(
      result.rich &&
      (result.rich.evidence.length ||
        result.rich.professional ||
        (result.rich.digitalFootprint && result.rich.digitalFootprint.profiles.length))
    );
    setTimeout(() => setStage(hasCategorySignal || hasRichSignal ? "dashboard" : "empty"), 380);
  };

  // recovery net: if the stream dropped, the server may have saved the result
  const tryRecoverResult = async (user: ClientUser): Promise<ScanFinal | null> => {
    const id = scanRunIdRef.current;
    if (!id) return null;
    const authorization = await getFirebaseBearer(user as User);
    for (let i = 0; i < 3; i += 1) {
      try {
        const res = await fetch(`/api/one/scans/${encodeURIComponent(id)}`, {
          headers: { Authorization: authorization },
        });
        if (res.ok) {
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; result?: OneDashboardResult } | null;
          if (payload?.ok && payload.result) return { result: payload.result, audit: null, emailDelivery: null };
        }
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    return null;
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
      const response = await fetch("/api/one/dashboard", {
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
        if (typeof msg.scanRunId === "string") scanRunIdRef.current = msg.scanRunId;
        if (typeof msg.stage === "number") setServerStage((s) => Math.max(s, msg.stage as number));
        if (typeof msg.scanning === "string") setLiveSource(msg.scanning as string);
      });

      if (!final || final.type === "error" || !final.result) {
        throw new Error(final?.error || "One could not complete the scan.");
      }
      await revealResult({ result: final.result, audit: final.audit, emailDelivery: final.emailDelivery });
    } catch (e) {
      const recovered = await tryRecoverResult(authUser).catch(() => null);
      if (recovered) {
        await revealResult(recovered);
      } else {
        setError(e instanceof Error ? e.message : "One could not complete the scan.");
        setStage("error");
      }
    } finally {
      clearTimeout(abortTimer);
    }
  };

  const startCollect = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Browser location is unavailable on this device.");
      setStage("error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        void runScan({
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
        }),
      () => {
        track("geo_denied");
        setError("Location wasn't shared, so One couldn't anchor the search.");
        setStage("error");
      },
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 60_000 },
    );
  };

  const reset = async () => {
    track("started_over");
    await signOutOfGoogle().catch(() => undefined);
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
    setStage("landing");
  };

  let view: ReactElement | null = null;
  if (stage === "landing") view = <Landing key="l" onAuth={onAuth} error={error} />;
  else if (stage === "manual")
    view = (
      <Manual
        key="m"
        initialName={identity.name}
        initialEmail={identity.email}
        onContinue={onManualDone}
      />
    );
  else if (stage === "precollect")
    view = <PreCollect key="p" user={identity} phone={phone} setPhone={setPhone} onCollect={startCollect} />;
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

  return (
    <main className="stage">
      <CanvasField mode={mode} progress={progress} motion={MOTION} preMoment={stage === "precollect"} />

      <div className="brandbar">
        <div className="wordmark">
          <span className="logo">{Icons.husshMark()}</span>
          <span className="mark">One</span>
          <span className="byline">by Hussh</span>
        </div>
        <div className="trust">{Icons.shield(14)} Private by default</div>
      </div>

      <div className="ui">{view}</div>
    </main>
  );
}
