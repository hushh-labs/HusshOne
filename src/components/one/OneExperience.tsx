"use client";

/* ============================================================
   OneExperience — One personal intelligence flow.
   Ports the design (app.jsx + screens.jsx) screen-for-screen
   and wires it to the real auth + geolocation + Hushh Shadow
   ensemble backend (streamed POST /api/one/dashboard).
   ============================================================ */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { User } from "firebase/auth";
import {
  isValidEmail,
  normalizeEmail,
  normalizeName,
  initialsForName,
  normalizeLinkedInUrl,
  linkedinHandleFromUrl,
  normalizeInstagramUrl,
  instagramHandleFromUrl,
  normalizeThreadsUrl,
  threadsHandleFromUrl,
  normalizeXUrl,
  xHandleFromUrl,
} from "@/lib/auth/identity";
import {
  completeGoogleRedirect,
  getFirebaseBearer,
  isFirebaseClientConfigured,
  makeDevUser,
  observeAuth,
  signInWithGoogle,
  signInWithOneCustomToken,
  signOutOfGoogle,
} from "@/lib/firebase/client";
import { hasUrlEnrichedLinkedInProfile, type LinkedInProfileFull } from "@/lib/linkedin/profile";
import { hasInstagramProfile, type InstagramAccessInfo, type InstagramProfileFull } from "@/lib/instagram/profile";
import { hasThreadsProfile, type ThreadsAccessInfo, type ThreadsProfileFull } from "@/lib/threads/profile";
import { hasXProfile, type XAccessInfo, type XProfileFull } from "@/lib/x/profile";
import type {
  ConfirmedProfile,
  DashboardCategoryMap,
  DiscoverCandidate,
  OneDashboardResult,
  OneSafeFinding,
  OneSourceCard,
  SocialProfileFull,
  PersonAuditStatus,
} from "@/lib/ria/types";
import type { ScanEmailDeliverySummary } from "@/lib/notifications/types";
import { SHADOW_ESTIMATED_MS, SHADOW_PHASES, isStaleRunning, oneVoiceScanningAt, shadowPhaseIndex } from "@/lib/ria/progress";
import { INTELLIGENCE_VERSION } from "@/lib/research/version";
import { track, getSessionId } from "@/lib/analytics/track";
import { Icons } from "./Icons";
import { CanvasField } from "./CanvasField";
import { ParticleMorph } from "./ParticleMorph";
import LandingPage from "./landing/LandingPage";
import DossierReport from "./DossierReport";
import ErrorBoundary, { reportClientError } from "./ErrorBoundary";

type Stage = "hydrating" | "landing" | "manual" | "connect" | "precollect" | "disambiguate" | "collect" | "dashboard" | "empty" | "error" | "location" | "settings" | "pending";
type LayerStatus = "idle" | "running" | "completed" | "failed" | "pending" | "skipped";
type AuthProvider = "google" | "guest" | "dev" | "unknown";
type ClientUser = Pick<User, "uid" | "email" | "displayName" | "photoURL" | "getIdToken"> & Partial<Pick<User, "getIdTokenResult">>;
type RecoveryOutcome = { outcome: "revealed" | "failed" | "gaveup"; error?: string | null };
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

type ConnectorPlatform = "linkedin" | "instagram" | "threads" | "x";

function ConnectorIcon({ platform }: { platform: ConnectorPlatform }) {
  if (platform === "linkedin") return <span className="connector-logo connector-logo-linkedin">{Icons.linkedin()}</span>;
  if (platform === "instagram") {
    return (
      <span className="connector-logo connector-logo-instagram" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="5" width="14" height="14" rx="4" />
          <circle cx="12" cy="12" r="3.2" />
          <circle cx="16.5" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      </span>
    );
  }
  if (platform === "threads") {
    return (
      <span className="connector-logo connector-logo-threads" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15.8 8.4c-.7-1.2-1.9-2-3.7-2-3 0-5 2.2-5 5.6s2.1 5.7 5.4 5.7c2.8 0 4.6-1.5 4.6-3.6 0-2.2-1.8-3.4-4.2-3.4h-1.2" />
          <path d="M10 13.4c.3 1.1 1.2 1.7 2.4 1.7 1.5 0 2.4-.7 2.4-1.8 0-1.2-1.1-1.9-2.8-1.9" />
        </svg>
      </span>
    );
  }
  return (
    <span className="connector-logo connector-logo-x" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M6 5l12 14M18 5L6 19" />
      </svg>
    </span>
  );
}

function ConnectorDisclosure({
  platform,
  title,
  subtitle,
  state,
  required,
  defaultOpen = false,
  children,
}: {
  platform: ConnectorPlatform;
  title: string;
  subtitle: string;
  state: "connected" | "required" | "optional" | "recommended" | "pending";
  required?: boolean;
  defaultOpen?: boolean;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const statusLabel =
    state === "connected"
      ? "Connected"
      : state === "pending"
        ? "Pending"
        : state === "recommended"
          ? "Recommended"
          : required
            ? "Required"
            : "Optional";
  return (
    <section className={`connector-row connector-row-${platform} ${open ? "open" : ""} ${state}`}>
      <button
        className="connector-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={`connector-panel-${platform}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ConnectorIcon platform={platform} />
        <span className="connector-copy">
          <span className="connector-title">{title}</span>
          <span className="connector-subtitle">{subtitle}</span>
        </span>
        <span className="connector-status">
          {state === "connected" ? Icons.check(12) : null}
          {statusLabel}
        </span>
        <span className="connector-chevron" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="connector-panel" id={`connector-panel-${platform}`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

const MOTION = 0.7;
const ACCENT = "#111113";
/* When on, the number→scan flow is powered by the Deep Research API (markdown
   dossier) instead of the Shadow structured scan. Server routes mirror the
   /dashboard + /scans recovery protocol, so the rest of the flow is unchanged. */
const RESEARCH_MODE = process.env.NEXT_PUBLIC_ONE_RESEARCH_MODE === "true";
const SOCIAL_REFRESH_TIMEOUT_MS = 2500;
/* Phase-0 candidate discovery (the "is this you?" pivot cards + 4-✓ gate) is now
   DORMANT — Phase-0 identity is anchored by the user's pasted LinkedIn URL instead.
   Flip this on to revive the old discover/disambiguation flow (kept intact behind it). */
const DISCOVER_MODE = process.env.NEXT_PUBLIC_ONE_DISCOVER_MODE === "true";

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

function sanitizeScanErrorMessage(message: string): string {
  if (/body\/question must NOT have more than 40000 characters/i.test(message)) {
    return "One had too much source context to start the scan. Please try again.";
  }
  return message;
}

function recoveryErrorMessage(outcome: RecoveryOutcome, fallback: string): string {
  return sanitizeScanErrorMessage(outcome.error || fallback);
}

function extractIdentity(user: ClientUser): Identity {
  return { name: normalizeName(user.displayName), email: normalizeEmail(user.email) };
}

function detectAuthProvider(
  user: ClientUser,
  claims: Record<string, unknown> = {},
  signInProvider?: string | null,
): AuthProvider {
  if (claims.provider === "guest" || user.uid.startsWith("guest:")) return "guest";
  if (claims.provider === "dev" || user.uid === "dev-one-user") return "dev";
  const firebaseClaims = claims.firebase && typeof claims.firebase === "object" ? claims.firebase as Record<string, unknown> : {};
  if (signInProvider === "google.com" || firebaseClaims.sign_in_provider === "google.com") return "google";
  return user.uid ? "google" : "unknown";
}

async function extractAuthContext(user: ClientUser): Promise<{ identity: Identity; provider: AuthProvider }> {
  const base = extractIdentity(user);
  let claims: Record<string, unknown> = {};
  let signInProvider: string | null = null;
  try {
    const result = await user.getIdTokenResult?.();
    claims = (result?.claims ?? {}) as Record<string, unknown>;
    signInProvider = typeof result?.signInProvider === "string" ? result.signInProvider : null;
    return {
      identity: {
        name: normalizeName(base.name || claims.name),
        email: normalizeEmail(base.email || claims.email),
      },
      provider: detectAuthProvider(user, claims, signInProvider),
    };
  } catch {
    return { identity: base, provider: detectAuthProvider(user, claims, signInProvider) };
  }
}

/* ── persisted state (namespaced like the analytics `one_sid`) ─────────────
   localStorage survives a browser restart; sessionStorage is per-tab. We never
   store the PII result blob — only ids that are re-fetched from the server. */
const LS_LAST_SCAN = "one_last_scan"; // last completed scan id → dashboard restore
const LS_ACTIVE_SCAN = "one_active_scan"; // in-flight scan id → resume after refresh OR app close
const LS_ACTIVE_STARTED_AT = "one_active_started_at"; // epoch ms the active scan began → resume the elapsed/progress correctly across refresh/background/close
const LS_DISCOVERY = "one_discovery"; // in-progress Phase-0 disambiguation (confirmed + shown + location)
const LS_LI_FULL = "one_li_full"; // enriched LinkedIn profile → survives refresh so a returning session's re-scan still carries the ground truth
const LS_LI_CONNECTED = "one_li_connected"; // legacy marker; the profile payload itself now drives the mandatory gate
const LS_IG_FULL = "one_ig_full"; // optional Instagram public profile context → survives refresh like LinkedIn
const LS_THREADS_FULL = "one_threads_full"; // optional Threads visible profile context → survives refresh like Instagram
const LS_X_FULL = "one_x_full"; // optional X visible profile context → survives refresh like Instagram/Threads
const SS_SCAN_RUN = "one_scan_run"; // legacy in-flight key (session-scoped) — cleared only
const SS_DEV_AUTH = "one_dev_auth"; // restore the dev user on refresh (no Firebase session)
const SS_PENDING = "one_pending_scan"; // deep-link (?scan=) awaiting sign-in

/** Confirmed-pivot count required before Phase-1 research fires (Intelius-style gate). */
const DISCOVER_GATE = 4;

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

type ScopedLocalEnvelope = { __oneScoped: true; uid: string; value: string };

function isScopedLocalEnvelope(value: unknown): value is ScopedLocalEnvelope {
  return !!value && typeof value === "object"
    && (value as { __oneScoped?: unknown }).__oneScoped === true
    && typeof (value as { uid?: unknown }).uid === "string"
    && typeof (value as { value?: unknown }).value === "string";
}

function scopedGet(user: ClientUser | null, key: string): string | null {
  if (!user?.uid) return null;
  const raw = safeGet("local", key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isScopedLocalEnvelope(parsed) && parsed.uid === user.uid) return parsed.value;
  } catch {
    /* legacy unscoped value — drop it rather than risk cross-user reuse */
  }
  safeDel("local", key);
  return null;
}

function scopedSet(user: ClientUser | null, key: string, value: string) {
  if (!user?.uid) return;
  safeSet("local", key, JSON.stringify({ __oneScoped: true, uid: user.uid, value } satisfies ScopedLocalEnvelope));
}

function scopedDel(_user: ClientUser | null, key: string) {
  safeDel("local", key);
}

function clearPersisted() {
  safeDel("local", LS_LAST_SCAN);
  safeDel("local", LS_ACTIVE_SCAN);
  safeDel("local", LS_ACTIVE_STARTED_AT);
  safeDel("local", LS_DISCOVERY);
  safeDel("local", LS_LI_FULL);
  safeDel("local", LS_LI_CONNECTED);
  safeDel("local", LS_IG_FULL);
  safeDel("local", LS_THREADS_FULL);
  safeDel("local", LS_X_FULL);
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

/* read the NDJSON result stream; forwards progress/start, returns the final done|error line */
async function readScanStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (msg: { type: string; stage?: number; elapsedMs?: number; scanRunId?: string | null; scanning?: string }) => void,
): Promise<{ type: string; result?: OneDashboardResult; audit?: PersonAuditStatus | null; emailDelivery?: ScanEmailDeliverySummary | null; candidates?: DiscoverCandidate[]; error?: string } | null> {
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
    // "pending" = soft-deadline handoff: the scan is still running server-side. Treat it
    // as terminal for the stream so the caller switches to patient recovery (not an error).
    else if (msg.type === "done" || msg.type === "error" || msg.type === "pending") last = msg;
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
  busy = false,
  error = "",
  onContinue,
}: {
  initialName: string;
  initialEmail: string;
  lockedEmail?: string;
  busy?: boolean;
  error?: string;
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
            <button className="solid-cta" type="submit" disabled={!ok || busy}>
              {busy ? "Creating guest session..." : "Continue"}
            </button>
          </div>
          {error ? <span className="field-hint" role="alert" style={{ color: "#b4453a" }}>{error}</span> : null}
        </div>
      </form>
    </div>
  );
}

function ConnectInstagramInline({
  authUser,
  profiles,
  onConnected,
}: {
  authUser: ClientUser | null;
  profiles: InstagramProfileFull[];
  onConnected: (profile: InstagramProfileFull) => void;
}) {
  type Phase = "idle" | "fetching" | "connected" | "pending" | "error";
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [editingConnected, setEditingConnected] = useState(false);
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState("");
  const [pendingAccess, setPendingAccess] = useState<InstagramAccessInfo | null>(null);
  const normalized = normalizeInstagramUrl(url);
  const invalid = touched && !!url && !normalized;
  const connected = profiles[0] ?? null;
  const connectedUrl = connected ? normalizeInstagramUrl(connected.profileUrl) || connected.profileUrl : "";

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    setErr("");
    if (!authUser) {
      setErr("Sign in again to add Instagram.");
      setPhase("error");
      return;
    }
    if (!normalized) {
      setErr("Paste a valid Instagram profile URL.");
      setPhase("error");
      return;
    }
    setPhase("fetching");
    setPendingAccess(null);
    track("instagram_connect_started");
    try {
      const authorization = await getFirebaseBearer(authUser as User);
      const res = await fetch("/api/instagram/enrich-url", {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean; profile?: InstagramProfileFull | null; error?: string; code?: string; access?: InstagramAccessInfo;
      };
      if (res.status === 202 && payload.code === "instagram_access_pending" && payload.access) {
        setPendingAccess(payload.access);
        setUrl("");
        setPhase("pending");
        track("instagram_connect_pending", { state: payload.access.state });
        return;
      }
      if (!res.ok || !payload.ok || !hasInstagramProfile(payload.profile)) {
        throw new Error(payload.error || "We could not read this Instagram profile.");
      }
      setUrl("");
      setEditingConnected(false);
      setPhase("connected");
      onConnected(payload.profile);
    } catch (e) {
      const message = e instanceof Error ? e.message : "We could not read this Instagram profile.";
      track("instagram_connect_failed", { reason: message.slice(0, 120) });
      setErr(message);
      setPhase("error");
    }
  };

  const busy = phase === "fetching";
  if (connected && connectedUrl && !editingConnected) {
    return (
      <div className="field-group connector-form" style={{ gap: 8 }}>
        <label htmlFor="instagram-connected-url">Instagram profile URL <span style={{ color: "var(--muted)" }}>(connected)</span></label>
        <div className="social-url-row">
          <input
            id="instagram-connected-url"
            className="input"
            value={connectedUrl}
            readOnly
            aria-label="Connected Instagram profile URL"
          />
          <button
            className="ghost-btn"
            type="button"
            onClick={() => {
              setUrl(connectedUrl);
              setTouched(false);
              setErr("");
              setPendingAccess(null);
              setEditingConnected(true);
            }}
          >
            Change
          </button>
        </div>
        <span className="field-hint">
          {Icons.check(12)} @{connected.username} added
        </span>
      </div>
    );
  }
  return (
    <form className="field-group connector-form" onSubmit={submit} style={{ gap: 8 }}>
      <label htmlFor="instagram-url">Instagram profile URL <span style={{ color: "var(--muted)" }}>(optional)</span></label>
      <div className="social-url-row">
        <input
          id="instagram-url"
          className={"input" + (invalid ? " invalid" : "")}
          placeholder="https://www.instagram.com/ankit_ya_i_am/"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (err) setErr("");
            if (pendingAccess) setPendingAccess(null);
          }}
          onBlur={() => setTouched(true)}
          autoComplete="url"
          inputMode="url"
          aria-invalid={invalid}
        />
        <button className="ghost-btn" type="submit" disabled={busy || !normalized}>
          {busy ? "Adding..." : connected ? "Update Instagram" : "Add Instagram"}
        </button>
      </div>
      {connected ? (
        <span className="field-hint">
          {Icons.check(12)} @{connected.username} added
        </span>
      ) : pendingAccess ? (
        <span className="field-hint">
          Follow request sent. Instagram will be added after owner approval.
        </span>
      ) : (
        <span className="field-hint">Direct public profile link only.</span>
      )}
      {err ? <span className="field-hint" role="alert" style={{ color: "#b4453a" }}>{err}</span> : null}
    </form>
  );
}

function ConnectThreadsInline({
  authUser,
  profiles,
  onConnected,
}: {
  authUser: ClientUser | null;
  profiles: ThreadsProfileFull[];
  onConnected: (profile: ThreadsProfileFull) => void;
}) {
  type Phase = "idle" | "fetching" | "connected" | "pending" | "error";
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [editingConnected, setEditingConnected] = useState(false);
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState("");
  const [pendingAccess, setPendingAccess] = useState<ThreadsAccessInfo | null>(null);
  const normalized = normalizeThreadsUrl(url);
  const invalid = touched && !!url && !normalized;
  const connected = profiles[0] ?? null;
  const connectedUrl = connected ? normalizeThreadsUrl(connected.profileUrl) || connected.profileUrl : "";

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    setErr("");
    if (!authUser) {
      setErr("Sign in again to add Threads.");
      setPhase("error");
      return;
    }
    if (!normalized) {
      setErr("Paste a valid Threads profile URL.");
      setPhase("error");
      return;
    }
    setPhase("fetching");
    setPendingAccess(null);
    track("threads_connect_started");
    try {
      const authorization = await getFirebaseBearer(authUser as User);
      const res = await fetch("/api/threads/enrich-url", {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean; profile?: ThreadsProfileFull | null; error?: string; code?: string; access?: ThreadsAccessInfo;
      };
      if (res.status === 202 && payload.code === "threads_access_pending" && payload.access) {
        setPendingAccess(payload.access);
        setUrl("");
        setPhase("pending");
        track("threads_connect_pending", { state: payload.access.state });
        return;
      }
      if (!res.ok || !payload.ok || !hasThreadsProfile(payload.profile)) {
        throw new Error(payload.error || "We could not read this Threads profile.");
      }
      setUrl("");
      setEditingConnected(false);
      setPhase("connected");
      onConnected(payload.profile);
    } catch (e) {
      const message = e instanceof Error ? e.message : "We could not read this Threads profile.";
      track("threads_connect_failed", { reason: message.slice(0, 120) });
      setErr(message);
      setPhase("error");
    }
  };

  const busy = phase === "fetching";
  if (connected && connectedUrl && !editingConnected) {
    return (
      <div className="field-group connector-form" style={{ gap: 8 }}>
        <label htmlFor="threads-connected-url">Threads profile URL <span style={{ color: "var(--muted)" }}>(connected)</span></label>
        <div className="social-url-row">
          <input
            id="threads-connected-url"
            className="input"
            value={connectedUrl}
            readOnly
            aria-label="Connected Threads profile URL"
          />
          <button
            className="ghost-btn"
            type="button"
            onClick={() => {
              setUrl(connectedUrl);
              setTouched(false);
              setErr("");
              setPendingAccess(null);
              setEditingConnected(true);
            }}
          >
            Change
          </button>
        </div>
        <span className="field-hint">
          {Icons.check(12)} @{connected.username} added
        </span>
      </div>
    );
  }
  return (
    <form className="field-group connector-form" onSubmit={submit} style={{ gap: 8 }}>
      <label htmlFor="threads-url">Threads profile URL <span style={{ color: "var(--muted)" }}>(optional)</span></label>
      <div className="social-url-row">
        <input
          id="threads-url"
          className={"input" + (invalid ? " invalid" : "")}
          placeholder="https://www.threads.com/@threads"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (err) setErr("");
            if (pendingAccess) setPendingAccess(null);
          }}
          onBlur={() => setTouched(true)}
          autoComplete="url"
          inputMode="url"
          aria-invalid={invalid}
        />
        <button className="ghost-btn" type="submit" disabled={busy || !normalized}>
          {busy ? "Adding..." : connected ? "Update Threads" : "Add Threads"}
        </button>
      </div>
      {connected ? (
        <span className="field-hint">
          {Icons.check(12)} @{connected.username} added
        </span>
      ) : pendingAccess ? (
        <span className="field-hint">
          Follow request sent. Threads will be added after owner approval.
        </span>
      ) : (
        <span className="field-hint">Direct public profile link only.</span>
      )}
      {err ? <span className="field-hint" role="alert" style={{ color: "#b4453a" }}>{err}</span> : null}
    </form>
  );
}

function ConnectXInline({
  authUser,
  profiles,
  onConnected,
}: {
  authUser: ClientUser | null;
  profiles: XProfileFull[];
  onConnected: (profile: XProfileFull) => void;
}) {
  type Phase = "idle" | "fetching" | "connected" | "pending" | "error";
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [editingConnected, setEditingConnected] = useState(false);
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState("");
  const [pendingAccess, setPendingAccess] = useState<XAccessInfo | null>(null);
  const normalized = normalizeXUrl(url);
  const invalid = touched && !!url && !normalized;
  const connected = profiles[0] ?? null;
  const connectedUrl = connected ? normalizeXUrl(connected.profileUrl) || connected.profileUrl : "";

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    setErr("");
    if (!authUser) {
      setErr("Sign in again to add X.");
      setPhase("error");
      return;
    }
    if (!normalized) {
      setErr("Paste a valid X profile URL.");
      setPhase("error");
      return;
    }
    setPhase("fetching");
    setPendingAccess(null);
    track("x_connect_started");
    try {
      const authorization = await getFirebaseBearer(authUser as User);
      const res = await fetch("/api/x/enrich-url", {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean; profile?: XProfileFull | null; error?: string; code?: string; access?: XAccessInfo;
      };
      if (res.status === 202 && payload.code === "x_access_pending" && payload.access) {
        setPendingAccess(payload.access);
        setUrl("");
        setPhase("pending");
        track("x_connect_pending", { state: payload.access.state });
        return;
      }
      if (!res.ok || !payload.ok || !hasXProfile(payload.profile)) {
        throw new Error(payload.error || "We could not read this X profile.");
      }
      setUrl("");
      setEditingConnected(false);
      setPhase("connected");
      onConnected(payload.profile);
    } catch (e) {
      const message = e instanceof Error ? e.message : "We could not read this X profile.";
      track("x_connect_failed", { reason: message.slice(0, 120) });
      setErr(message);
      setPhase("error");
    }
  };

  const busy = phase === "fetching";
  if (connected && connectedUrl && !editingConnected) {
    return (
      <div className="field-group connector-form" style={{ gap: 8 }}>
        <label htmlFor="x-connected-url">X profile URL <span style={{ color: "var(--muted)" }}>(connected)</span></label>
        <div className="social-url-row">
          <input
            id="x-connected-url"
            className="input"
            value={connectedUrl}
            readOnly
            aria-label="Connected X profile URL"
          />
          <button
            className="ghost-btn"
            type="button"
            onClick={() => {
              setUrl(connectedUrl);
              setTouched(false);
              setErr("");
              setPendingAccess(null);
              setEditingConnected(true);
            }}
          >
            Change
          </button>
        </div>
        <span className="field-hint">
          {Icons.check(12)} @{connected.username} added
        </span>
      </div>
    );
  }
  return (
    <form className="field-group connector-form" onSubmit={submit} style={{ gap: 8 }}>
      <label htmlFor="x-url">X profile URL <span style={{ color: "var(--muted)" }}>(optional)</span></label>
      <div className="social-url-row">
        <input
          id="x-url"
          className={"input" + (invalid ? " invalid" : "")}
          placeholder="https://x.com/sundarpichai"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (err) setErr("");
            if (pendingAccess) setPendingAccess(null);
          }}
          onBlur={() => setTouched(true)}
          autoComplete="url"
          inputMode="url"
          aria-invalid={invalid}
        />
        <button className="ghost-btn" type="submit" disabled={busy || !normalized}>
          {busy ? "Adding..." : connected ? "Update X" : "Add X"}
        </button>
      </div>
      {connected ? (
        <span className="field-hint">
          {Icons.check(12)} @{connected.username} added
        </span>
      ) : pendingAccess ? (
        <span className="field-hint">
          Follow request sent. X will be added after owner approval.
        </span>
      ) : (
        <span className="field-hint">Direct public X/Twitter profile link only.</span>
      )}
      {err ? <span className="field-hint" role="alert" style={{ color: "#b4453a" }}>{err}</span> : null}
    </form>
  );
}

function ConnectLinkedInInline({
  authUser,
  profile,
  required = false,
  inputId = "linkedin-optional-url",
  onChange,
  onConnected,
}: {
  authUser: ClientUser | null;
  profile?: LinkedInProfileFull | null;
  required?: boolean;
  inputId?: string;
  onChange?: () => void;
  onConnected: (profile: LinkedInProfileFull) => void;
}) {
  type Phase = "idle" | "fetching" | "connected" | "error";
  const [phase, setPhase] = useState<Phase>("idle");
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState("");
  const normalized = normalizeLinkedInUrl(url);
  const invalid = touched && !!url && !normalized;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    setErr("");
    if (!authUser) {
      setErr("Sign in again to add LinkedIn.");
      setPhase("error");
      return;
    }
    if (!normalized) {
      setErr("Paste a valid LinkedIn personal profile URL.");
      setPhase("error");
      return;
    }
    setPhase("fetching");
    track("linkedin_optional_connect_started");
    try {
      const authorization = await getFirebaseBearer(authUser as User);
      const res = await fetch("/api/linkedin/enrich-url", {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ url: normalized }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean; profile?: LinkedInProfileFull; error?: string;
      };
      if (!res.ok || !payload.ok || !payload.profile) {
        throw new Error(payload.error || "We could not read this profile. Check that the URL is public/visible and try again.");
      }
      setUrl("");
      setPhase("connected");
      onConnected(payload.profile);
    } catch (e) {
      const message = e instanceof Error ? e.message : "We could not read this profile. Check that the URL is public/visible and try again.";
      track("linkedin_optional_connect_failed", { reason: message.slice(0, 120) });
      setErr(message);
      setPhase("error");
    }
  };

  const busy = phase === "fetching";
  if (hasUrlEnrichedLinkedInProfile(profile)) {
    return (
      <div className="field-group connector-form pc-required-link" style={{ gap: 8 }}>
        <label htmlFor={`${inputId}-connected`}>
          LinkedIn profile URL <span style={{ color: "var(--muted)" }}>{required ? "(required)" : "(connected)"}</span>
        </label>
        <div className="social-url-row">
          <input
            id={`${inputId}-connected`}
            className="input"
            value={profile.profileUrl ?? ""}
            readOnly
            aria-label="Connected LinkedIn profile URL"
          />
          {onChange ? (
            <button className="ghost-btn" type="button" onClick={onChange}>
              Change
            </button>
          ) : null}
        </div>
        <span className="field-hint">
          {Icons.check(12)} {required ? "LinkedIn is required for guest sessions." : "LinkedIn connected — One now reads your real career, not just your name."}
        </span>
      </div>
    );
  }
  return (
    <form className="field-group connector-form pc-required-link" onSubmit={submit} style={{ gap: 8 }}>
      <label htmlFor={inputId}>LinkedIn profile URL <span style={{ color: "var(--muted)" }}>{required ? "(required)" : "(optional)"}</span></label>
      <div className="social-url-row">
        <input
          id={inputId}
          className={"input" + (invalid ? " invalid" : "")}
          placeholder="https://www.linkedin.com/in/your-profile"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (err) setErr("");
          }}
          onBlur={() => setTouched(true)}
          autoComplete="url"
          inputMode="url"
          aria-invalid={invalid}
        />
        <button className="ghost-btn" type="submit" disabled={busy || !normalized}>
          {busy ? "Adding..." : "Add LinkedIn"}
        </button>
      </div>
      <span className="field-hint">
        {required
          ? "Use your personal profile link, not a company, jobs, feed, or search page."
          : "Recommended: paste your /in/ link and One reads your real career, education, and skills — far sharper than your name alone. Still optional — you can send One without it."}
      </span>
      {err ? <span className="field-hint" role="alert" style={{ color: "#b4453a" }}>{err}</span> : null}
    </form>
  );
}

/* ── C. Pre-collection — "The Moment Before Discovery" ──── */
function PreCollect({
  user,
  profile,
  authUser,
  authProvider,
  requiresLinkedIn,
  instagramProfiles,
  threadsProfiles,
  xProfiles,
  socialPreferenceConsent,
  onLinkedInConnected,
  onInstagramConnected,
  onThreadsConnected,
  onXConnected,
  onLinkedInChange,
  onSocialPreferenceConsentChange,
  onCollect,
  busy,
  upgradeNotice,
}: {
  user: Identity;
  profile: LinkedInProfileFull | null;
  authUser: ClientUser | null;
  authProvider: AuthProvider;
  requiresLinkedIn: boolean;
  instagramProfiles: InstagramProfileFull[];
  threadsProfiles: ThreadsProfileFull[];
  xProfiles: XProfileFull[];
  socialPreferenceConsent: boolean;
  onLinkedInConnected: (profile: LinkedInProfileFull) => void;
  onInstagramConnected: (profile: InstagramProfileFull) => void;
  onThreadsConnected: (profile: ThreadsProfileFull) => void;
  onXConnected: (profile: XProfileFull) => void;
  onLinkedInChange: () => void;
  onSocialPreferenceConsentChange: (value: boolean) => void;
  onCollect: () => void;
  busy: boolean;
  upgradeNotice?: string;
}) {
  const initials = initialsForName(user.name);
  const verifications = profile?.verifications ?? [];
  const hasLinkedIn = hasUrlEnrichedLinkedInProfile(profile);
  const anchorLabel = hasLinkedIn
    ? "Verified via LinkedIn"
    : authProvider === "dev"
      ? "Preview identity"
      : "Verified via Google";
  const avatarUrl = profile?.pictureUrl || authUser?.photoURL || null;
  const socialCount = instagramProfiles.length + threadsProfiles.length + xProfiles.length;
  const needsSocialConsent = socialCount > 0;
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
    if (!busy && (!requiresLinkedIn || hasLinkedIn) && (!needsSocialConsent || socialPreferenceConsent)) onCollect();
  };
  return (
    <div className="screen precollect screen-enter">
      <div className="pc">
        <div className="pc-head">
          <p className="eyebrow">Agent ready</p>
          <h1 className="display pc-title">One will connect what matters.</h1>
        </div>

        {upgradeNotice ? (
          <div className="upgrade-banner" role="status">
            <span className="upgrade-spark">{Icons.spark()}</span>
            <span>{upgradeNotice}</span>
          </div>
        ) : null}

        <div className="pc-box">
          <div className="pc-id">
            <div className="pc-avatar">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarUrl}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <span>{initials}</span>
              )}
              <i className="scan" aria-hidden="true"></i>
            </div>
            <div className="pc-meta">
              <div className="anchor">{anchorLabel}</div>
              <div className="nm">{user.name}</div>
              <div className="em">{user.email}</div>
              {profile?.headline ? <div className="em">{profile.headline}</div> : null}
            </div>
            <div className="pc-verified" title={hasLinkedIn && verifications.length ? `LinkedIn-verified: ${verifications.join(", ")}` : "Verified identity"}>
              {Icons.check(13)}
            </div>
          </div>

          <div className="pc-phone">
            <span className="field-hint">
              {hasLinkedIn
                ? `One will research the real you from your verified LinkedIn${verifications.length ? ` (LinkedIn-verified: ${verifications.join(", ")})` : ""}.`
                : requiresLinkedIn
                  ? "Add your LinkedIn connector below to unlock One. Instagram, Threads, and X are optional context."
                  : "You're in with Google. Paste your LinkedIn URL below for a sharper, more personal result — One reads your real career, education, and skills in seconds. It's optional, but it makes One understand you, not just your name."}
            </span>
          </div>

          <div className="connector-deck" aria-label="Profile connectors">
            <div className="pc-section-label">Connectors</div>
            <ConnectorDisclosure
              platform="linkedin"
              title="LinkedIn"
              subtitle={
                hasLinkedIn
                  ? "Career context connected"
                  : requiresLinkedIn
                    ? "Required for guest sessions"
                    : "Recommended — One reads your real career, not just your name"
              }
              state={hasLinkedIn ? "connected" : requiresLinkedIn ? "required" : "recommended"}
              required={requiresLinkedIn}
              // For Google users LinkedIn is optional, but it sharpens everything — so open the
              // field by default to gently invite it without forcing it.
              defaultOpen={!hasLinkedIn}
            >
              <ConnectLinkedInInline
                authUser={authUser}
                profile={profile}
                required={requiresLinkedIn}
                inputId="linkedin-precollect-url"
                onChange={onLinkedInChange}
                onConnected={onLinkedInConnected}
              />
            </ConnectorDisclosure>
            <ConnectorDisclosure
              platform="instagram"
              title="Instagram"
              subtitle={instagramProfiles[0] ? `@${instagramProfiles[0].username} added` : "Photos, captions, lifestyle signals"}
              state={instagramProfiles[0] ? "connected" : "optional"}
            >
              <ConnectInstagramInline
                authUser={authUser}
                profiles={instagramProfiles}
                onConnected={onInstagramConnected}
              />
            </ConnectorDisclosure>
            <ConnectorDisclosure
              platform="threads"
              title="Threads"
              subtitle={threadsProfiles[0] ? `@${threadsProfiles[0].username} added` : "Public posts and conversation context"}
              state={threadsProfiles[0] ? "connected" : "optional"}
            >
              <ConnectThreadsInline
                authUser={authUser}
                profiles={threadsProfiles}
                onConnected={onThreadsConnected}
              />
            </ConnectorDisclosure>
            <ConnectorDisclosure
              platform="x"
              title="X"
              subtitle={xProfiles[0] ? `@${xProfiles[0].username} added` : "Posts, replies, links, and public signals"}
              state={xProfiles[0] ? "connected" : "optional"}
            >
              <ConnectXInline
                authUser={authUser}
                profiles={xProfiles}
                onConnected={onXConnected}
              />
            </ConnectorDisclosure>
          </div>
          {needsSocialConsent ? (
            <label className="pc-consent">
              <input
                type="checkbox"
                checked={socialPreferenceConsent}
                onChange={(e) => onSocialPreferenceConsentChange(e.target.checked)}
              />
              <span>
                Allow One to analyze and periodically refresh visible content from connected social URLs for preference intelligence.
              </span>
            </label>
          ) : null}
        </div>

        <span className="magnet pc-actions" ref={magnetRef} onMouseMove={onMove} onMouseLeave={onLeave}>
          <button className="cta cta-xl" onClick={submit} disabled={busy || (requiresLinkedIn && !hasLinkedIn) || (needsSocialConsent && !socialPreferenceConsent)}>
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
  // Live "what One is doing" feed — the real DR progress (personalized as One) arrives
  // via liveSource; before the first real line we fall back to a One-voiced source cycle.
  const scanning = liveSource || oneVoiceScanningAt(elapsedMs);
  const pct = Math.round(Math.max(0.03, progress) * 100);
  return (
    <div className="seq">
      <div className="scan-console" aria-live="polite">
        <p className="scan-headline">
          <span className="fade" key={headline}>
            {overran ? "One is composing your report — almost there…" : `One is ${headline.charAt(0).toLowerCase()}${headline.slice(1)}…`}
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
            <span className="scan-live-text">{scanning}</span>
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
function RichCards({ rich: rawRich }: { rich: NonNullable<OneDashboardResult["rich"]> }) {
  // Defensive: a recovered / older stored result may lack some rich.* arrays (the type
  // marks them required, but old DB rows predate fields). Normalize so render never throws
  // (this is what blanked the app with "undefined is not an object 'sourceCards.length'").
  const rich = {
    ...rawRich,
    evidence: rawRich.evidence ?? [],
    conflicts: rawRich.conflicts ?? [],
    missingEvidence: rawRich.missingEvidence ?? [],
    sourceCards: rawRich.sourceCards ?? [],
    sourceUrls: rawRich.sourceUrls ?? [],
    verifiedWebCount: rawRich.verifiedWebCount ?? 0,
  };
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

function PreferenceIntelligence({
  profile,
  status,
}: {
  profile?: OneDashboardResult["preferenceProfile"];
  status?: OneDashboardResult["preferenceStatus"];
}) {
  if (!profile) {
    if (!status || status === "idle") return null;
    const copy =
      status === "skipped"
        ? {
            title: "Preference intelligence is not enabled for this scan.",
            body: "Connect a social profile and allow preference intelligence to build this layer.",
          }
        : status === "failed"
          ? {
              title: "Preference intelligence needs another run.",
              body: "The main dossier can continue while this layer is retried later.",
            }
          : status === "pending"
            ? {
                title: "Preference intelligence is queued.",
                body: "One will keep this layer warm while the dossier continues.",
              }
            : {
                title: "One is reading your social patterns.",
                body: "Visible posts, captions, media, links, and counters are being clustered into preference signals.",
              };
    return (
      <section className={`pref-intel pref-intel-loading pref-intel-${status}`}>
        <div>
          <p className="eyebrow">Social preference intelligence</p>
          <h2>{copy.title}</h2>
          <p>{copy.body}</p>
        </div>
        {status === "running" ? <span className="pref-spinner" aria-hidden="true" /> : null}
      </section>
    );
  }

  const questionAnswers = Array.isArray(profile.questionAnswers) ? profile.questionAnswers : [];
  const questionCoverage = profile.questionCoverage;
  const sectionSummaries = Array.isArray(profile.sectionSummaries) ? profile.sectionSummaries : [];
  const metrics = questionAnswers.length
    ? [
        ["answers", `${(questionCoverage?.answered ?? 0) + (questionCoverage?.inferred ?? 0)}/${questionCoverage?.total ?? questionAnswers.length}`],
        ["confirm", questionCoverage?.needsConfirmation ?? 0],
        ["unknown", questionCoverage?.unknown ?? 0],
        ["media", profile.updatedFrom.mediaAssets],
        ["items", profile.updatedFrom.indexedItems],
      ]
    : [
        ["items", profile.updatedFrom.indexedItems],
        ["media", profile.updatedFrom.mediaAssets],
        ["links", profile.updatedFrom.externalLinks],
        ["signals", profile.topSignals.length],
        ["selected", profile.selection?.selectedEvidenceCount ?? 0],
      ];
  const domainLabel = (domain: string) =>
    domain
      .split("_")
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ");
  const selectedPlatforms = profile.selection
    ? Object.entries(profile.selection.selectedByPlatform).filter(([, count]) => count > 0)
    : [];
  const selectedDomains = profile.selection
    ? Object.entries(profile.selection.byDomain)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
    : [];
  const sectionRows = sectionSummaries.length
    ? sectionSummaries.map((summary) => ({
        summary,
        answers: questionAnswers.filter((answer) => answer.sectionId === summary.sectionId),
      }))
    : [...new Set(questionAnswers.map((answer) => answer.sectionId))].map((sectionId) => {
        const answers = questionAnswers.filter((answer) => answer.sectionId === sectionId);
        return {
          summary: {
            sectionId,
            title: answers[0]?.sectionTitle ?? domainLabel(sectionId),
            summary: "",
            answeredCount: answers.filter((answer) => answer.status === "answered" || answer.status === "inferred").length,
            totalCount: answers.length,
            confidence: "low" as const,
          },
          answers,
        };
      });
  const statusLabel = (statusValue: string) => statusValue.replace(/_/g, " ");

  return (
    <section className="pref-intel">
      <div className="pref-top">
        <div>
          <p className="eyebrow">Social preference intelligence</p>
          <h2>{profile.summary}</h2>
          <p>
            Updated {new Date(profile.generatedAt).toLocaleString()} from {profile.updatedFrom.platforms.join(", ") || "connected socials"}.
          </p>
        </div>
        <div className="pref-metrics" aria-label="Preference intelligence metrics">
          {metrics.map(([label, value]) => (
            <span key={label}>
              <b>{value}</b>
              <em>{label}</em>
            </span>
          ))}
        </div>
      </div>

      {(() => {
        // v3 archive depth strip — e.g. "instagram 684/1024 · 512/684 media". Present only on the
        // v3 synthesis profile; the v2 fast pass omits it.
        const depth = (profile as { archiveDepth?: { perPlatform?: Record<string, { items: number; mediaTotal: number; mediaAnalyzed: number }> } }).archiveDepth;
        const v3Status = (profile as { preferenceStatus?: string }).preferenceStatus;
        const rows = depth?.perPlatform ? Object.entries(depth.perPlatform).filter(([, d]) => d.items || d.mediaTotal) : [];
        if (!rows.length) return null;
        return (
          <div className="pref-depth" aria-label="Archive depth">
            {rows.map(([platform, d]) => (
              <span key={platform} className="pref-depth-pill">
                <b>{platform}</b> {d.items}/1024{d.mediaTotal ? ` · ${d.mediaAnalyzed}/${d.mediaTotal} media` : ""}
              </span>
            ))}
            {v3Status === "partial" ? <span className="pref-depth-pill pref-depth-partial">analyzing media…</span> : null}
          </div>
        );
      })()}

      {questionAnswers.length ? (
        <div className="pref-question-sections" aria-label="Preference question answers">
          {sectionRows.map(({ summary, answers }) => (
            <article className="pref-question-section" key={summary.sectionId}>
              <div className="pref-question-head">
                <div>
                  <span>{summary.title}</span>
                  <strong>
                    {summary.answeredCount}/{summary.totalCount} evidence-backed
                  </strong>
                </div>
                <em>{summary.confidence} confidence</em>
              </div>
              {summary.summary ? <p>{summary.summary}</p> : null}
              <div className="pref-question-list">
                {answers.map((answer) => (
                  <div className={`pref-question-row pref-question-${answer.status}`} key={answer.questionId}>
                    <div>
                      <span>{answer.prompt}</span>
                      <strong>{answer.answer || (answer.unknownReason === "unsafe_to_infer" ? "Needs your confirmation." : "Not enough reliable evidence yet.")}</strong>
                    </div>
                    <small>
                      {statusLabel(answer.status)} · {answer.confidence.level} · {Math.round(answer.confidence.score * 100)}%
                      {answer.evidenceIds.length ? ` · ${answer.evidenceIds.length} evidence` : ""}
                    </small>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {profile.selection ? (
        <div className="pref-tracking" aria-label="Preference selection tracking">
          <div>
            <span>Selection tracking</span>
            <strong>
              {profile.selection.selectedEvidenceCount} / {profile.selection.evidencePoolSize} evidence items selected
            </strong>
            <small>
              cap {profile.selection.selectionRules.evidenceCap}
              {profile.selection.droppedEvidenceCount ? ` · ${profile.selection.droppedEvidenceCount} dropped by cap` : " · no evidence dropped"}
            </small>
          </div>
          <div className="pref-tracking-pills">
            {selectedPlatforms.map(([platform, count]) => (
              <span key={platform}>
                {platform}: {count}
              </span>
            ))}
            {selectedDomains.map(([domain, count]) => (
              <span key={domain}>
                {domainLabel(domain)}: {count}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {profile.topSignals.length ? (
        <div className="pref-signals">
          {profile.topSignals.slice(0, 8).map((signal) => (
            <div className="pref-signal" key={signal.id}>
              <span>{domainLabel(signal.domain)}</span>
              <strong>{signal.label}</strong>
              <small>
                {signal.confidence} confidence · {Math.round(signal.strength * 100)} strength
                {signal.needsConfirmation ? " · needs confirmation" : ""}
              </small>
            </div>
          ))}
        </div>
      ) : null}

      {profile.collage.length ? (
        <div className="pref-collage" aria-label="Preference evidence collage">
          {profile.collage.slice(0, 12).map((item) => (
            <a
              key={item.evidenceId}
              href={item.postUrl ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="pref-shot"
              title={item.reason}
            >
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imageUrl} alt="" loading="lazy" />
              ) : (
                <span className="pref-shot-text">{item.caption || item.reason}</span>
              )}
              <span className="pref-shot-meta">
                <b>{item.platform}</b>
                <em>{item.signals.slice(0, 2).join(" · ") || item.reason}</em>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LayerStateLine({
  label,
  status,
  detail,
}: {
  label: string;
  status: LayerStatus;
  detail: string;
}) {
  const text = status === "idle" ? "waiting" : status;
  return (
    <div className={`layer-line layer-line-${status}`}>
      <span>{label}</span>
      <strong>{text}</strong>
      <small>{detail}</small>
    </div>
  );
}

function ProgressiveDashboardShell({
  phase1Status,
  phase1Message,
  preferenceStatus,
  preferenceProfile,
  elapsedMs,
  onReset,
}: {
  phase1Status: LayerStatus;
  phase1Message: string | null;
  preferenceStatus: LayerStatus;
  preferenceProfile?: OneDashboardResult["preferenceProfile"];
  elapsedMs: number;
  onReset: () => void;
}) {
  const phaseDetail =
    phase1Status === "completed"
      ? "Dossier is ready."
      : phase1Status === "pending"
        ? "Still running in the background. Email fallback is active."
        : phase1Status === "failed"
          ? "Dossier hit an error."
          : phase1Message || "One is reading public sources and composing the dossier.";
  const preferenceDetail =
    preferenceStatus === "completed"
      ? "Preference layer is ready."
      : preferenceStatus === "skipped"
        ? "No preference layer for this scan."
        : preferenceStatus === "failed"
          ? "Preference layer hit an error."
          : "Building from connected social context.";

  return (
    <div className="dash progressive-dash" data-screen-label="Dashboard">
      <div className="dash-inner">
        <div className="dash-head screen-enter">
          <p className="eyebrow">Gathered by One</p>
          <h1 className="display">Your intelligence is assembling.</h1>
          <p className="sub">Preference intelligence and the Phase 1 dossier are running as separate layers.</p>
        </div>

        <div className="layer-board" aria-label="One scan layer status">
          <LayerStateLine label="Preference intelligence" status={preferenceStatus} detail={preferenceDetail} />
          <LayerStateLine label="Phase 1 dossier" status={phase1Status} detail={`${phaseDetail} · ${mmss(elapsedMs)}`} />
        </div>

        <PreferenceIntelligence profile={preferenceProfile} status={preferenceStatus} />

        <section className="dossier-shell" aria-busy={phase1Status === "running"}>
          <div>
            <p className="eyebrow">Phase 1 dossier</p>
            <h2>{phase1Status === "pending" ? "The dossier is still running." : "One is preparing your dossier."}</h2>
            <p>{phaseDetail}</p>
          </div>
          <div className="dossier-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </section>

        <div className="dash-foot">
          <div className="privacy-row">
            <span className="p">{Icons.shield(14)} Private by default</span>
            <span className="p">{Icons.check(14)} Layers update independently</span>
            <span className="p">{Icons.check(14)} Email fallback active</span>
          </div>
          <div className="state-actions">
            <button className="ghost-btn" onClick={onReset}>
              Start over
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Dashboard({
  result,
  audit,
  emailDelivery,
  onReset,
  onScanAgain,
}: {
  result: OneDashboardResult;
  audit: PersonAuditStatus | null;
  emailDelivery: ScanEmailDeliverySummary | null;
  onReset: () => void;
  onScanAgain: () => void;
}) {
  // Deep Research path → render the markdown dossier instead of the structured grid.
  if (result.report) {
    return (
      <div className="dash" data-screen-label="Dashboard">
        <div className="dash-inner">
          <div className="dash-head screen-enter">
            <p className="eyebrow">Gathered by One</p>
            <h1 className="display">Your deep research dossier.</h1>
            {emailDelivery ? (
              <div className={"email-status " + (emailDelivery.user.status === "sent" ? "sent" : "failed")}>
                {emailDelivery.user.status === "sent"
                  ? `Full results were emailed to ${result.subject.email}.`
                  : "Your dossier is ready."}
              </div>
            ) : null}
          </div>
          <PreferenceIntelligence profile={result.preferenceProfile} status={result.preferenceStatus} />
          <DossierReport
            report={
              result.report +
              (result.deepReport ? `\n\n${result.deepReport}` : "") +
              (result.imageReport ? `\n\n${result.imageReport}` : "")
            }
            deepening={result.deepStatus === "running" || result.imageStatus === "running" || result.preferenceStatus === "running"}
          />
          <div className="dash-foot">
            <div className="privacy-row">
              <span className="p">{Icons.shield(14)} Private by default</span>
              <span className="p">{Icons.check(14)} You control what One keeps</span>
              <span className="p">{Icons.check(14)} Remove anything, anytime</span>
            </div>
            <div className="state-actions">
              <button className="cta" style={{ height: 48, fontSize: 15 }} onClick={onScanAgain}>
                {Icons.retry(16)}
                <span className="label">Scan again</span>
              </button>
              <button className="ghost-btn" onClick={onReset}>
                Start over
              </button>
            </div>
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
  const displayMessage = sanitizeScanErrorMessage(message);

  return (
    <div className="screen hero screen-enter">
      <div className="content hero-copy">
        <p className="eyebrow">Nothing was lost</p>
        <h1 className="display" style={{ fontSize: "clamp(26px,4vw,44px)" }}>
          One couldn&apos;t
          <br />
          finish the scan.
        </h1>
        <p className="sub">{displayMessage || "Try again, or add a source manually."}</p>
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

/* ── F1b. Pending — a deep scan ran past our soft deadline; it keeps working
   server-side and the result is emailed. Calm, not an error. ── */
function PendingState({ email, onCheck, onReset }: { email?: string; onCheck: () => void; onReset: () => void }) {
  return (
    <div className="screen hero screen-enter">
      <div className="content hero-copy">
        <p className="eyebrow">Still working</p>
        <h1 className="display" style={{ fontSize: "clamp(26px,4vw,44px)" }}>
          One is finishing
          <br />
          your dossier.
        </h1>
        <p className="sub">
          This one&apos;s deeper than most, so it&apos;s taking a little longer. One will keep working and email the full
          dossier{email ? ` to ${email}` : ""} the moment it&apos;s ready — you can safely close this tab.
        </p>
        <div className="state-actions">
          <button className="cta" style={{ height: 56, fontSize: 16 }} onClick={onCheck}>
            {Icons.retry(16)}
            <span className="label">Check again</span>
          </button>
          <button className="ghost-btn" style={{ height: 56 }} onClick={onReset}>
            Start over
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

/* ── C2. Disambiguation — Phase-0 "is this you?" pivots (click-only gate) ──
   Surfaces candidate public profiles; the user taps the ones that are theirs.
   Once DISCOVER_GATE are confirmed, Phase-1 research fires seeded with them. */
function Disambiguate({
  candidates,
  confirmedUrls,
  confirmedCount,
  busy,
  error,
  liveLine,
  onConfirm,
  onDismiss,
  onMore,
  onContinue,
}: {
  candidates: DiscoverCandidate[];
  confirmedUrls: Set<string>;
  confirmedCount: number;
  busy: boolean;
  error: string;
  liveLine: string | null;
  onConfirm: (c: DiscoverCandidate) => void;
  onDismiss: (c: DiscoverCandidate) => void;
  onMore: () => void;
  onContinue: () => void;
}) {
  const remaining = Math.max(0, DISCOVER_GATE - confirmedCount);
  const ready = confirmedCount >= DISCOVER_GATE;
  const firstLoad = busy && candidates.length === 0;

  // group visible candidates by category, preserving first-seen order
  const groups: { category: string; items: DiscoverCandidate[] }[] = [];
  const byCat = new Map<string, DiscoverCandidate[]>();
  for (const c of candidates) {
    let bucket = byCat.get(c.category);
    if (!bucket) {
      bucket = [];
      byCat.set(c.category, bucket);
      groups.push({ category: c.category, items: bucket });
    }
    bucket.push(c);
  }

  return (
    <div
      className="screen disambiguate screen-enter"
      style={{ overflowY: "auto", overflowX: "hidden", WebkitOverflowScrolling: "touch", justifyContent: "flex-start", paddingBottom: 56 }}
    >
      <div className="content" style={{ gap: 18, maxWidth: 940, width: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, textAlign: "center" }}>
          <p className="eyebrow">Confirm it&apos;s you</p>
          <h1 className="display" style={{ fontSize: "clamp(24px,3.6vw,36px)" }}>Which of these are you?</h1>
          <p className="sub" style={{ margin: "0 auto" }}>
            Tap the profiles that are really yours. One needs {DISCOVER_GATE} to lock onto the right person — no typing, just tap.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }} aria-live="polite">
          <div style={{ display: "flex", gap: 6 }}>
            {Array.from({ length: DISCOVER_GATE }).map((_, i) => (
              <span
                key={i}
                style={{ width: 26, height: 6, borderRadius: 3, background: i < confirmedCount ? ACCENT : "#E6E6EA", transition: "background .3s" }}
              />
            ))}
          </div>
          <span className="sub" style={{ fontSize: 13, margin: 0 }}>{confirmedCount} of {DISCOVER_GATE} confirmed</span>
        </div>

        {firstLoad ? (
          <div className="card" style={{ textAlign: "center", padding: 28 }}>
            <span
              aria-hidden="true"
              style={{ width: 22, height: 22, borderRadius: "50%", border: "2px solid rgba(0,0,0,0.12)", borderTopColor: ACCENT, animation: "scanSpin .7s linear infinite", display: "inline-block" }}
            />
            <p className="sub" style={{ marginTop: 12 }}>{liveLine || "One is finding your public profiles…"}</p>
          </div>
        ) : candidates.length === 0 ? (
          <div className="card" style={{ textAlign: "center", padding: 24 }}>
            <p className="sub">{error || "One couldn't surface profiles this time."}</p>
            <div className="cta-block">
              <button className="solid-cta" onClick={onMore} disabled={busy}>Try again</button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 18, width: "100%" }}>
            {groups.map((g) => (
              <div key={g.category} style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
                <div className="eyebrow" style={{ textAlign: "left" }}>{g.category}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 10, width: "100%" }}>
                  {g.items.map((c) => {
                    const selected = confirmedUrls.has(c.url);
                    return (
                      <div
                        key={c.id}
                        style={{ border: `1.5px solid ${selected ? ACCENT : "#E6E6EA"}`, borderRadius: 14, padding: 12, background: selected ? hexA(ACCENT, 0.04) : "#fff", display: "flex", flexDirection: "column", gap: 8, transition: "border-color .2s, background .2s" }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span
                            aria-hidden="true"
                            style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: "#111113", color: "#fff", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 600, overflow: "hidden" }}
                          >
                            {c.avatarUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={c.avatarUrl} alt="" width={34} height={34} referrerPolicy="no-referrer" style={{ objectFit: "cover" }} />
                            ) : (
                              (c.platform[0] || "·").toUpperCase()
                            )}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.platform}</div>
                            <div className="sub" style={{ margin: 0, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.handle}</div>
                          </div>
                        </div>
                        {c.context ? <div className="sub" style={{ margin: 0, fontSize: 12, lineHeight: 1.35 }}>{c.context}</div> : null}
                        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                          <button
                            type="button"
                            onClick={() => onConfirm(c)}
                            aria-pressed={selected}
                            style={{ flex: 1, height: 34, borderRadius: 9, cursor: "pointer", border: `1px solid ${selected ? ACCENT : "#DADADE"}`, background: selected ? ACCENT : "#fff", color: selected ? "#fff" : "#111113", fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                          >
                            {Icons.check(13)} {selected ? "It's me" : "This is me"}
                          </button>
                          <button
                            type="button"
                            onClick={() => onDismiss(c)}
                            aria-label="Not me"
                            title="Not me"
                            style={{ width: 38, height: 34, borderRadius: 9, cursor: "pointer", border: "1px solid #DADADE", background: "#fff", color: "#9A9AA2", fontSize: 16 }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && candidates.length > 0 ? <p className="sub" style={{ color: "#b4453a", margin: 0 }}>{error}</p> : null}

        {candidates.length > 0 ? (
          <div className="state-actions" style={{ marginTop: 4 }}>
            <button className="cta" style={{ height: 52, fontSize: 15 }} onClick={onContinue} disabled={!ready}>
              {Icons.spark()}
              <span className="label">{ready ? "These are mine →" : `Confirm ${remaining} more`}</span>
            </button>
            <button className="ghost-btn" onClick={onMore} disabled={busy}>
              {busy ? "Finding more…" : "Show more options"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── C.5 Social URL intake — required only for guest LinkedIn anchoring ─
   URL-first enrichment: guests must add LinkedIn before Phase 1, while optional
   social profiles can be added on the same surface. No secret or worker URL is exposed
   to the browser. */
function ConnectLinkedIn({
  user,
  authUser,
  instagramProfiles,
  threadsProfiles,
  xProfiles,
  onConnected,
  onInstagramConnected,
  onThreadsConnected,
  onXConnected,
  upgradeNotice,
}: {
  user: Identity;
  authUser: ClientUser;
  instagramProfiles: InstagramProfileFull[];
  threadsProfiles: ThreadsProfileFull[];
  xProfiles: XProfileFull[];
  onConnected: (profile: LinkedInProfileFull) => void;
  onInstagramConnected: (profile: InstagramProfileFull) => void;
  onThreadsConnected: (profile: ThreadsProfileFull) => void;
  onXConnected: (profile: XProfileFull) => void;
  upgradeNotice?: string;
}) {
  return (
    <div className="screen social-connect screen-enter">
      <div className="content social-connect-content">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p className="eyebrow">Connectors</p>
          <h1 className="display" style={{ fontSize: "clamp(28px,4vw,44px)" }}>Choose what One can read.</h1>
          {upgradeNotice ? (
            <div className="upgrade-banner" role="status">
              <span className="upgrade-spark">{Icons.spark()}</span>
              <span>{upgradeNotice}</span>
            </div>
          ) : null}
          <p className="sub" style={{ margin: "0 auto" }}>
            LinkedIn is required for guest sessions. Tap any connector to add or update it.
          </p>
        </div>

        <div className="card social-connect-card connector-intake-card">
          <div className="pc-id">
            <div className="pc-avatar"><span>{initialsForName(user.name)}</span></div>
            <div className="pc-meta">
              <div className="nm">{user.name || "Signed in"}</div>
              <div className="em">{user.email}</div>
            </div>
          </div>

          <div className="pc-phone">
            <span className="field-hint">
              Add the LinkedIn connector first to unlock One. Optional socials can be connected now or later.
            </span>
          </div>

          <div className="connector-deck" aria-label="Profile connectors">
            <div className="pc-section-label">Connectors</div>
            <ConnectorDisclosure
              platform="linkedin"
              title="LinkedIn"
              subtitle="Required identity and career anchor"
              state="required"
              required
            >
              <ConnectLinkedInInline
                authUser={authUser}
                required
                inputId="linkedin-url"
                onConnected={onConnected}
              />
            </ConnectorDisclosure>
            <ConnectorDisclosure
              platform="instagram"
              title="Instagram"
              subtitle={instagramProfiles[0] ? `@${instagramProfiles[0].username} added` : "Optional lifestyle and visual context"}
              state={instagramProfiles[0] ? "connected" : "optional"}
            >
              <ConnectInstagramInline
                authUser={authUser}
                profiles={instagramProfiles}
                onConnected={onInstagramConnected}
              />
            </ConnectorDisclosure>
            <ConnectorDisclosure
              platform="threads"
              title="Threads"
              subtitle={threadsProfiles[0] ? `@${threadsProfiles[0].username} added` : "Optional public conversation context"}
              state={threadsProfiles[0] ? "connected" : "optional"}
            >
              <ConnectThreadsInline
                authUser={authUser}
                profiles={threadsProfiles}
                onConnected={onThreadsConnected}
              />
            </ConnectorDisclosure>
            <ConnectorDisclosure
              platform="x"
              title="X"
              subtitle={xProfiles[0] ? `@${xProfiles[0].username} added` : "Optional posts, replies, and links"}
              state={xProfiles[0] ? "connected" : "optional"}
            >
              <ConnectXInline
                authUser={authUser}
                profiles={xProfiles}
                onConnected={onXConnected}
              />
            </ConnectorDisclosure>
          </div>
        </div>
        <div className="trust-line">
          <span className="lock">{Icons.shield(13)}</span> You decide what stays.
        </div>
      </div>
    </div>
  );
}

/* ── state machine ──────────────────────────────────────── */
export default function OneExperience() {
  const [stage, setStage] = useState<Stage>("hydrating");
  const [authUser, setAuthUser] = useState<ClientUser | null>(null);
  const [authProvider, setAuthProvider] = useState<AuthProvider>("unknown");
  const [identity, setIdentity] = useState<Identity>({ name: "", email: "" });
  // The enriched LinkedIn profile pulled from the user's pasted URL (structured
  // experience/education/skills/certs) — fed into the scan as the authoritative ground truth.
  const [liProfile, setLiProfile] = useState<LinkedInProfileFull | null>(null);
  const [igProfiles, setIgProfiles] = useState<InstagramProfileFull[]>([]);
  const [threadsProfiles, setThreadsProfiles] = useState<ThreadsProfileFull[]>([]);
  const [xProfiles, setXProfiles] = useState<XProfileFull[]>([]);
  const [socialPreferenceConsent, setSocialPreferenceConsent] = useState(false);
  const [progress, setProgress] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [serverStage, setServerStage] = useState(0);
  const [liveSource, setLiveSource] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<OneDashboardResult | null>(null);
  const [phase1Status, setPhase1Status] = useState<LayerStatus>("idle");
  const [preferenceStatus, setPreferenceStatus] = useState<LayerStatus>("idle");
  const [preferenceProfile, setPreferenceProfile] = useState<OneDashboardResult["preferenceProfile"] | undefined>(undefined);
  const [audit, setAudit] = useState<PersonAuditStatus | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<ScanEmailDeliverySummary | null>(null);
  const [error, setError] = useState("");
  const [manualMode, setManualMode] = useState<"auth" | "guest">("auth");
  const [guestBusy, setGuestBusy] = useState(false);
  const [guestError, setGuestError] = useState("");
  const [geoBusy, setGeoBusy] = useState(false); // waiting on the browser location prompt
  const [geoReason, setGeoReason] = useState<GeoReason>("denied"); // drives LocationFallback copy
  const [notice, setNotice] = useState(""); // brief confirmation line on landing (e.g. after delete)
  // Shown on the intake screens when a returning user is routed back because the intelligence layer
  // was upgraded — tells them WHY they're here and entices a re-run on the new deployment.
  const [upgradeNotice, setUpgradeNotice] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  // Phase-0 disambiguation state
  const [candidates, setCandidates] = useState<DiscoverCandidate[]>([]);
  const [confirmed, setConfirmed] = useState<ConfirmedProfile[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [restorePending, setRestorePending] = useState<{ location: Coordinates; shownUrls: string[] } | null>(null);
  const discoverLocRef = useRef<Coordinates | null>(null);
  const discoverAbortRef = useRef<AbortController | null>(null);
  const restoredRef = useRef(false); // ensure the cross-refresh discovery resume fires once
  const collectStart = useRef(0); // performance.now() of THIS mount entering collect — for the reveal min-dwell
  const scanStartedAtRef = useRef(0); // absolute epoch ms the scan began — resumable elapsed across refresh/background
  const scanRunIdRef = useRef<string | null>(null);
  const phase1StatusRef = useRef<LayerStatus>("idle");
  const preferenceStatusRef = useRef<LayerStatus>("idle");
  const preferenceProfileRef = useRef<OneDashboardResult["preferenceProfile"] | undefined>(undefined);
  const progressiveOpenedRef = useRef(false);
  const pollStopRef = useRef(false); // abort in-flight recovery polling on logout/delete/unmount
  const prevStageRef = useRef<Stage>("precollect"); // where to return to when leaving Settings

  const mode: "idle" | "collect" | "dashboard" =
    stage === "collect" ? "collect" : stage === "dashboard" ? "dashboard" : "idle";

  const requiresLinkedIn = authProvider === "guest";
  const phaseIndex = Math.max(serverStage, shadowPhaseIndex(elapsedMs));

  const setPhase1LayerStatus = (status: LayerStatus) => {
    phase1StatusRef.current = status;
    setPhase1Status(status);
  };

  const setPreferenceLayer = (status: LayerStatus, profile?: OneDashboardResult["preferenceProfile"]) => {
    preferenceStatusRef.current = status;
    if (profile !== undefined) {
      preferenceProfileRef.current = profile;
      setPreferenceProfile(profile);
    }
    setPreferenceStatus(status);
  };

  const openProgressiveDashboard = (scanRunId: string) => {
    if (!progressiveOpenedRef.current) {
      progressiveOpenedRef.current = true;
      track("progressive_dashboard_opened", { scanRunId });
    }
    setStage("dashboard");
  };

  const resetProgressiveLayers = () => {
    phase1StatusRef.current = "idle";
    preferenceStatusRef.current = "idle";
    preferenceProfileRef.current = undefined;
    progressiveOpenedRef.current = false;
    setPhase1Status("idle");
    setPreferenceStatus("idle");
    setPreferenceProfile(undefined);
  };

  const isStaleIntelligenceResult = (result: OneDashboardResult | null | undefined) =>
    Boolean(result && result.intelligenceVersion !== INTELLIGENCE_VERSION);

  const routeToFreshStartForCurrentVersion = (user: ClientUser | null, nextStage?: Stage) => {
    if (user) {
      scopedDel(user, LS_LAST_SCAN);
      scopedDel(user, LS_ACTIVE_SCAN);
      scopedDel(user, LS_ACTIVE_STARTED_AT);
    }
    scanRunIdRef.current = null;
    setDashboard(null);
    setAudit(null);
    setEmailDelivery(null);
    setError("");
    resetProgressiveLayers();
    setUpgradeNotice(
      "One just leveled up. Send One again to unlock your upgraded intelligence — deeper preference insights read from your social posts and media.",
    );
    const linkedInConnected = hasUrlEnrichedLinkedInProfile(liProfile);
    setStage(nextStage ?? (requiresLinkedIn && !linkedInConnected ? "connect" : "precollect"));
  };

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

  // Surface uncaught client errors to the server logs (one.ui.client_error) — crashes
  // not caught by the React error boundary are otherwise invisible in Cloud Logging.
  useEffect(() => {
    const onErr = (e: ErrorEvent) => reportClientError(e.message || "window.onerror", e.filename || "window");
    const onRej = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string } | string | undefined;
      reportClientError(typeof r === "string" ? r : r?.message || "unhandledrejection", "unhandledrejection");
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  // landing scrolls like a normal marketing page; app stages stay viewport-locked
  useEffect(() => {
    const b = document.body;
    if (stage === "landing") b.classList.add("scroll-on");
    else b.classList.remove("scroll-on");
    return () => b.classList.remove("scroll-on");
  }, [stage]);

  // cinematic progress while collecting/progressive dashboard: ease toward 0.92 across
  // the estimated multi-minute run, track elapsed; never regress until the result lands.
  useEffect(() => {
    if (stage !== "collect" && !(stage === "dashboard" && (phase1StatusRef.current === "running" || phase1StatusRef.current === "pending"))) return;
    // Resume from the scan's ABSOLUTE start (epoch ms) so refresh / background / reconnect
    // all show the TRUE elapsed. Date.now() is wall-clock — unlike rAF it keeps advancing
    // in a hidden tab, and a setInterval (not rAF) still fires (throttled) in the background.
    let startedAt = scanStartedAtRef.current;
    if (!startedAt) {
      const persisted = Number(scopedGet(authUser, LS_ACTIVE_STARTED_AT) || "");
      startedAt = Number.isFinite(persisted) && persisted > 0 ? persisted : Date.now();
      scanStartedAtRef.current = startedAt;
    }
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const elapsed = Math.max(0, Date.now() - startedAt);
      setElapsedMs(elapsed);
      const eased = Math.min(0.92, elapsed / SHADOW_ESTIMATED_MS);
      setProgress((prev) => (prev >= 1 ? prev : Math.max(prev, eased)));
    };
    tick(); // paint the correct position immediately on (re)entry
    const iv = setInterval(tick, 250);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [stage, authUser]);

  const onManualDone = async (u: Identity) => {
    if (manualMode === "guest" && !authUser) {
      setGuestBusy(true);
      setGuestError("");
      setError("");
      track("guest_session_started");
      try {
        const res = await fetch("/api/one/guest-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(u),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          customToken?: string;
          identity?: Identity;
          error?: string;
        };
        if (!res.ok || !payload.ok || !payload.customToken) {
          throw new Error(payload.error || "Could not create a guest session.");
        }
        const user = await signInWithOneCustomToken(payload.customToken);
        setManualMode("auth");
        await hydrateFromUser(user, payload.identity ?? u);
        track("guest_session_completed");
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not create a guest session.";
        setGuestError(message);
        track("guest_session_failed", { reason: message.slice(0, 120) });
      } finally {
        setGuestBusy(false);
      }
      return;
    }
    setIdentity(u);
    setStage(requiresLinkedIn && !hasUrlEnrichedLinkedInProfile(liProfile) ? "connect" : "precollect");
  };

  const onGuestStart = () => {
    setError("");
    setNotice("");
    setGuestError("");
    setGuestBusy(false);
    setManualMode("guest");
    setAuthProvider("guest");
    setIdentity({ name: "", email: "" });
    setStage("manual");
    track("guest_selected");
  };

  // LinkedIn connected via the MCP step → capture the full profile, persist it so a refresh
  // stays connected, and advance to Send One. This is the only way past the mandatory gate.
  const onLinkedInConnected = (full: LinkedInProfileFull) => {
    setLiProfile(full);
    scopedSet(authUser, LS_LI_FULL, JSON.stringify(full));
    scopedSet(authUser, LS_LI_CONNECTED, "1");
    track("linkedin_connected");
    setStage("precollect");
  };

  const onLinkedInChange = () => {
    scopedDel(authUser, LS_LI_FULL);
    scopedDel(authUser, LS_LI_CONNECTED);
    setLiProfile(null);
    setStage(requiresLinkedIn ? "connect" : "precollect");
  };

  const onInstagramConnected = (profile: InstagramProfileFull) => {
    setIgProfiles((prev) => {
      const next = [profile, ...prev.filter((p) => p.profileUrl !== profile.profileUrl && p.username !== profile.username)].slice(0, 4);
      scopedSet(authUser, LS_IG_FULL, JSON.stringify(next));
      return next;
    });
    track("instagram_connected");
  };

  const onThreadsConnected = (profile: ThreadsProfileFull) => {
    setThreadsProfiles((prev) => {
      const next = [profile, ...prev.filter((p) => p.profileUrl !== profile.profileUrl && p.username !== profile.username)].slice(0, 4);
      scopedSet(authUser, LS_THREADS_FULL, JSON.stringify(next));
      return next;
    });
    track("threads_connected");
  };

  const onXConnected = (profile: XProfileFull) => {
    setXProfiles((prev) => {
      const next = [profile, ...prev.filter((p) => p.profileUrl !== profile.profileUrl && p.username !== profile.username)].slice(0, 4);
      scopedSet(authUser, LS_X_FULL, JSON.stringify(next));
      return next;
    });
    track("x_connected");
  };

  const onSocialPreferenceConsentChanged = (value: boolean) => {
    setSocialPreferenceConsent(value);
    track("social_preference_consent_changed", {
      enabled: value,
      socialProfileCount: igProfiles.length + threadsProfiles.length + xProfiles.length,
      platforms: [
        ...(igProfiles.length ? ["instagram"] : []),
        ...(threadsProfiles.length ? ["threads"] : []),
        ...(xProfiles.length ? ["x"] : []),
      ],
    });
  };

  const refreshConnectedSocialProfilesForScan = async (authorization: string): Promise<SocialProfileFull[]> => {
    let nextIg = igProfiles;
    let nextThreads = threadsProfiles;
    let nextX = xProfiles;
    let changed = false;
    const tasks: Promise<void>[] = [];
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SOCIAL_REFRESH_TIMEOUT_MS));
    const refreshOne = async <TProfile extends SocialProfileFull>(
      platform: "instagram" | "threads" | "x",
      profileUrl: string,
      endpoint: string,
      isProfile: (profile: TProfile | null | undefined) => profile is TProfile,
      apply: (profile: TProfile) => void,
    ) => {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body: JSON.stringify({ url: profileUrl }),
        });
        if (res.status === 202) {
          track(`${platform}_refresh_pending_for_scan`);
          return;
        }
        const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; profile?: unknown; error?: string };
        const profile = payload.profile as TProfile | null | undefined;
        if (!res.ok || !payload.ok || !isProfile(profile)) throw new Error(payload.error || `Could not refresh ${platform}`);
        apply(profile);
        changed = true;
        track(`${platform}_refresh_for_scan_completed`);
      } catch (error) {
        track(`${platform}_refresh_for_scan_failed`, {
          reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
        });
      }
    };

    for (const profile of igProfiles) {
      const url = normalizeInstagramUrl(profile.profileUrl);
      if (!url) continue;
      tasks.push(
        refreshOne("instagram", url, "/api/instagram/enrich-url", hasInstagramProfile, (fresh) => {
          nextIg = [fresh, ...nextIg.filter((p) => p.profileUrl !== fresh.profileUrl && p.username !== fresh.username)].slice(0, 4);
        }),
      );
    }
    for (const profile of threadsProfiles) {
      const url = normalizeThreadsUrl(profile.profileUrl);
      if (!url) continue;
      tasks.push(
        refreshOne("threads", url, "/api/threads/enrich-url", hasThreadsProfile, (fresh) => {
          nextThreads = [fresh, ...nextThreads.filter((p) => p.profileUrl !== fresh.profileUrl && p.username !== fresh.username)].slice(0, 4);
        }),
      );
    }
    for (const profile of xProfiles) {
      const url = normalizeXUrl(profile.profileUrl);
      if (!url) continue;
      tasks.push(
        refreshOne("x", url, "/api/x/enrich-url", hasXProfile, (fresh) => {
          nextX = [fresh, ...nextX.filter((p) => p.profileUrl !== fresh.profileUrl && p.username !== fresh.username)].slice(0, 4);
        }),
      );
    }

    if (tasks.length) await Promise.race([Promise.allSettled(tasks).then(() => undefined), timeout]);
    if (changed) {
      setIgProfiles(nextIg);
      setThreadsProfiles(nextThreads);
      setXProfiles(nextX);
      scopedSet(authUser, LS_IG_FULL, JSON.stringify(nextIg));
      scopedSet(authUser, LS_THREADS_FULL, JSON.stringify(nextThreads));
      scopedSet(authUser, LS_X_FULL, JSON.stringify(nextX));
    }
    return [...nextIg, ...nextThreads, ...nextX];
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
    if (!progressiveOpenedRef.current && elapsed < minDwell) await new Promise((r) => setTimeout(r, minDwell - elapsed));
    const earlyPreferenceProfile = preferenceProfileRef.current;
    const earlyPreferenceStatus = preferenceStatusRef.current;
    const result: OneDashboardResult = {
      ...final.result,
      ...(earlyPreferenceProfile
        ? { preferenceStatus: "completed" as const, preferenceProfile: earlyPreferenceProfile }
        : !final.result.preferenceStatus && earlyPreferenceStatus !== "idle"
          ? { preferenceStatus: earlyPreferenceStatus as OneDashboardResult["preferenceStatus"] }
          : {}),
    };
    setPhase1LayerStatus("completed");
    setDashboard(result);
    setAudit(final.audit || null);
    setEmailDelivery(final.emailDelivery || null);
    setProgress(1);
    // promote the scan id to "last completed" so a later refresh restores the report
    scopedDel(authUser, LS_ACTIVE_SCAN);
    scopedDel(authUser, LS_ACTIVE_STARTED_AT);
    if (scanRunIdRef.current) scopedSet(authUser, LS_LAST_SCAN, scanRunIdRef.current);
    const hasReport = !!(result.report && result.report.trim());
    const hasCategorySignal = Object.values(result.categories || {}).some((list) => (list as string[]).some(POSITIVE));
    const hasRichSignal = !!(
      result.rich &&
      (result.rich.evidence?.length ||
        result.rich.professional ||
        result.rich.digitalFootprint?.profiles?.length)
    );
    setTimeout(() => setStage(hasReport || hasCategorySignal || hasRichSignal ? "dashboard" : "empty"), 380);
  };

  // one status probe for a scan id. 404 → "unknown"; otherwise the saved status.
  const fetchScanStatus = async (
    user: ClientUser,
    id: string,
  ): Promise<{ status: string; result: OneDashboardResult | null; emailDelivery: ScanEmailDeliverySummary | null; error: string | null }> => {
    const authorization = await getFirebaseBearer(user as User);
    const res = await fetch(
      `${RESEARCH_MODE ? "/api/one/research/" : "/api/one/scans/"}${encodeURIComponent(id)}`,
      { headers: { Authorization: authorization } },
    );
    if (res.status === 404) return { status: "unknown", result: null, emailDelivery: null, error: null };
    const payload = (await res.json().catch(() => null)) as {
      status?: string;
      result?: OneDashboardResult | null;
      emailDelivery?: ScanEmailDeliverySummary | null;
      error?: string | null;
    } | null;
    if (!res.ok) return { status: "error", result: null, emailDelivery: null, error: payload?.error ?? null };
    return {
      status: payload?.status || "unknown",
      result: payload?.result ?? null,
      emailDelivery: payload?.emailDelivery ?? null,
      error: payload?.error ?? null,
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

  // In-flight recovery: the server keeps running after a disconnect or a soft-deadline
  // handoff, so poll with backoff until it finishes. The DR job can run up to ~3600s on
  // its own service, so be patient (30 min) — beyond that the email is the guaranteed
  // delivery and we show the calm "pending" screen. Caller owns the "collect" stage.
  const POLL_MAX_MS = 1_800_000;
  const resilientRecover = async (user: ClientUser, id: string): Promise<RecoveryOutcome> => {
    pollStopRef.current = false;
    const startedAt = performance.now();
    let delay = 2000;
    let unknownStreak = 0;
    while (!pollStopRef.current && scanRunIdRef.current === id && performance.now() - startedAt < POLL_MAX_MS) {
      let status = "running";
      let result: OneDashboardResult | null = null;
      let emailDelivery: ScanEmailDeliverySummary | null = null;
      let statusError: string | null = null;
      try {
        ({ status, result, emailDelivery, error: statusError } = await fetchScanStatus(user, id));
      } catch {
        status = "error"; // network blip → treat as still running, keep polling
      }
      if (status === "completed" && result) {
        if (isStaleIntelligenceResult(result)) {
          routeToFreshStartForCurrentVersion(user);
          return { outcome: "gaveup" };
        }
        await revealResult({ result, audit: null, emailDelivery });
        return { outcome: "revealed" };
      }
      if (status === "failed") {
        scopedDel(user, LS_ACTIVE_SCAN);
        scopedDel(user, LS_ACTIVE_STARTED_AT);
        return { outcome: "failed", error: statusError };
      }
      if (status === "unknown") {
        unknownStreak += 1;
        if (unknownStreak >= 3) {
          // the row truly isn't there after a few tries → stop chasing it
          scopedDel(user, LS_ACTIVE_SCAN);
          scopedDel(user, LS_ACTIVE_STARTED_AT);
          return { outcome: "gaveup" };
        }
      } else {
        unknownStreak = 0;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(10_000, Math.round(delay * 1.4));
    }
    return { outcome: "gaveup" };
  };

  // Snappy resume: when the user returns to a backgrounded tab mid-scan, do a one-shot
  // status check so a finished scan reveals at once (the wall-clock timer already self-
  // heals on the next tick). One check — not a new poll loop — so it can't stack.
  useEffect(() => {
    if (stage !== "collect" && stage !== "pending" && !(stage === "dashboard" && !dashboard?.report)) return;
    const onVis = () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      const id = scanRunIdRef.current || scopedGet(authUser, LS_ACTIVE_SCAN);
      if (!id || !authUser) return;
      void fetchScanStatus(authUser, id)
        .then(({ status, result, emailDelivery }) => {
          if (status === "completed" && result) {
            if (isStaleIntelligenceResult(result)) {
              routeToFreshStartForCurrentVersion(authUser);
              return;
            }
            void revealResult({ result, audit: null, emailDelivery });
          }
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, authUser]);

  // Progressive Tier-2: once the deep-research dashboard is showing and the deep tier isn't
  // done, quietly pull the remaining sections in the background and merge them in live. This
  // is the ONLY poller that runs after reveal — it both kicks off the first deep batch and
  // polls /deep until completion, calling setDashboard(merged) so DossierReport re-renders
  // with the new sections + TOC entries. Resumes automatically on refresh (deep state lives
  // in the restored result). Re-runs only when the scan id changes; the inner loop keeps
  // polling across batch appends (deepStatus stays "running") and exits when it's done.
  useEffect(() => {
    if (!RESEARCH_MODE || stage !== "dashboard" || !authUser) return;
    const id = dashboard?.scanRunId || scanRunIdRef.current;
    if (!id || !dashboard?.report) return; // deep-research dossier path only
    if (dashboard.deepStatus === "completed" || dashboard.deepStatus === "failed") return;

    let stopped = false;
    const startedAt = performance.now();
    const DEEP_POLL_CAP_MS = 40 * 60 * 1000;
    const run = async () => {
      while (!stopped && performance.now() - startedAt < DEEP_POLL_CAP_MS) {
        try {
          const authorization = await getFirebaseBearer(authUser as User);
          const res = await fetch(`/api/one/research/${encodeURIComponent(id)}/deep`, {
            headers: { Authorization: authorization },
          });
          if (res.ok) {
            const payload = (await res.json().catch(() => null)) as {
              deepStatus?: string;
              result?: OneDashboardResult | null;
            } | null;
            // Functional merge: the deep + image pollers run in parallel and each returns the
            // full blob — merge into latest client state so neither drops the other's fields.
            if (payload?.result) {
              const next = payload.result;
              setDashboard((prev) => (prev ? { ...prev, ...next } : next));
            }
            if (payload?.deepStatus === "completed" || payload?.deepStatus === "failed") return;
          }
        } catch {
          /* transient — keep polling */
        }
        await new Promise((r) => setTimeout(r, 12_000));
      }
    };
    void run();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, dashboard?.scanRunId, authUser]);

  // Background image-intelligence: in parallel with the deep poller, once the dashboard is
  // showing and the image tier isn't done, poll /image to reverse-image-search the LinkedIn
  // photo and merge the "Image intelligence" section in live. Same polling shape as /deep.
  useEffect(() => {
    if (!RESEARCH_MODE || stage !== "dashboard" || !authUser) return;
    const id = dashboard?.scanRunId || scanRunIdRef.current;
    if (!id || !dashboard?.report) return;
    if (dashboard.imageStatus === "completed" || dashboard.imageStatus === "failed") return;

    let stopped = false;
    const startedAt = performance.now();
    const IMAGE_POLL_CAP_MS = 25 * 60 * 1000;
    const run = async () => {
      while (!stopped && performance.now() - startedAt < IMAGE_POLL_CAP_MS) {
        try {
          const authorization = await getFirebaseBearer(authUser as User);
          const res = await fetch(`/api/one/research/${encodeURIComponent(id)}/image`, {
            headers: { Authorization: authorization },
          });
          if (res.ok) {
            const payload = (await res.json().catch(() => null)) as {
              imageStatus?: string;
              result?: OneDashboardResult | null;
            } | null;
            // Functional merge: the deep + image pollers run in parallel and each returns the
            // full blob — merge into latest client state so neither drops the other's fields.
            if (payload?.result) {
              const next = payload.result;
              setDashboard((prev) => (prev ? { ...prev, ...next } : next));
            }
            if (payload?.imageStatus === "completed" || payload?.imageStatus === "failed") return;
          }
        } catch {
          /* transient — keep polling */
        }
        await new Promise((r) => setTimeout(r, 12_000));
      }
    };
    void run();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, dashboard?.scanRunId, authUser]);

  // Social preference intelligence: runs as an independent layer as soon as the scan id
  // exists. It can finish before the Phase-1 dossier because it reads ScanRun.input.
  useEffect(() => {
    if (!RESEARCH_MODE || stage !== "dashboard" || !authUser) return;
    const id = dashboard?.scanRunId || scanRunIdRef.current;
    if (!id) return;
    const currentStatus = dashboard?.preferenceStatus ?? preferenceStatusRef.current;
    if (currentStatus === "completed" || currentStatus === "failed" || currentStatus === "skipped") return;

    let stopped = false;
    const startedAt = performance.now();
    const PREF_POLL_CAP_MS = 10 * 60 * 1000;
    const run = async () => {
      await Promise.resolve();
      if (stopped) return;
      if (preferenceStatusRef.current === "idle") setPreferenceLayer("running");
      setDashboard((prev) => (prev && !prev.preferenceStatus ? { ...prev, preferenceStatus: "running", preferenceStartedAt: Date.now() } : prev));
      track("preference_started", { scanRunId: id });
      while (!stopped && performance.now() - startedAt < PREF_POLL_CAP_MS) {
        try {
          const authorization = await getFirebaseBearer(authUser as User);
          const res = await fetch(`/api/one/research/${encodeURIComponent(id)}/preferences`, {
            headers: { Authorization: authorization },
          });
          if (res.ok) {
            const payload = (await res.json().catch(() => null)) as {
              preferenceStatus?: string;
              preferenceProfile?: OneDashboardResult["preferenceProfile"] | null;
              result?: OneDashboardResult | null;
            } | null;
            const nextProfile = payload?.result?.preferenceProfile ?? payload?.preferenceProfile ?? undefined;
            if (payload?.result) {
              const next = payload.result;
              setDashboard((prev) => (prev ? { ...prev, ...next } : next));
            }
            if (nextProfile) {
              setPreferenceLayer("completed", nextProfile);
              setDashboard((prev) => (prev ? { ...prev, preferenceStatus: "completed", preferenceProfile: nextProfile } : prev));
            }
            if (payload?.preferenceStatus === "completed") {
              track("preference_completed", {
                scanRunId: id,
                signals: nextProfile?.topSignals.length ?? 0,
                selectedEvidence: nextProfile?.selection?.selectedEvidenceCount ?? 0,
              });
              return;
            }
            if (payload?.preferenceStatus === "skipped") {
              setPreferenceLayer("skipped");
              setDashboard((prev) => (prev ? { ...prev, preferenceStatus: "skipped" } : prev));
              return;
            }
            if (payload?.preferenceStatus === "failed") {
              setPreferenceLayer("failed");
              track("preference_failed", { scanRunId: id });
              return;
            }
          }
        } catch {
          /* transient — keep polling */
        }
        await new Promise((r) => setTimeout(r, 10_000));
      }
      if (!stopped) track("preference_poll_timeout", { scanRunId: id });
    };
    void run();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, dashboard?.scanRunId, authUser]);

  // Map a (restored or freshly signed-in) user → identity → the right screen,
  // honoring a mid-scan recovery, an email deep-link, or a last-scan dashboard.
  const hydrateFromUser = async (user: ClientUser, identityOverride?: Identity) => {
    try {
      setAuthUser(user);
      const context = await extractAuthContext(user);
      const provider = context.provider;
      setAuthProvider(provider);
      const id = identityOverride ?? context.identity;
      setIdentity(id);

      // Rehydrate the connected LinkedIn FULL profile (pulled via the MCP connect step) so a
      // returning session re-scans WITH the LinkedIn ground truth instead of dropping to
      // linkedinProfile:undefined. Prefer the localStorage cache (instant), else rebuild from the
      // server (DB-backed). The presence of a profile IS the mandatory connect gate.
      let profile: LinkedInProfileFull | null = null;
      const savedLi = scopedGet(user, LS_LI_FULL);
      if (savedLi) {
        try {
          profile = JSON.parse(savedLi) as LinkedInProfileFull;
          if (!hasUrlEnrichedLinkedInProfile(profile)) {
            profile = null;
            scopedDel(user, LS_LI_FULL);
            scopedDel(user, LS_LI_CONNECTED);
          }
        } catch {
          /* corrupt cache — rebuild from the network below */
          scopedDel(user, LS_LI_FULL);
          scopedDel(user, LS_LI_CONNECTED);
        }
      }
      if (!profile) {
        try {
          const authorization = await getFirebaseBearer(user as User);
          const res = await fetch("/api/linkedin/profile", { headers: { Authorization: authorization } });
          if (res.ok) {
            const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; profile?: LinkedInProfileFull };
            if (payload.ok && hasUrlEnrichedLinkedInProfile(payload.profile)) {
              profile = payload.profile;
              scopedSet(user, LS_LI_FULL, JSON.stringify(profile));
              scopedSet(user, LS_LI_CONNECTED, "1");
            } else {
              scopedDel(user, LS_LI_FULL);
              scopedDel(user, LS_LI_CONNECTED);
            }
          }
        } catch {
          /* offline / not connected — fall through; the connect gate catches it */
        }
      }
      if (profile) setLiProfile(profile);
      else setLiProfile(null);

      let instagramProfiles: InstagramProfileFull[] = [];
      const savedIg = scopedGet(user, LS_IG_FULL);
      if (savedIg) {
        try {
          const parsed = JSON.parse(savedIg) as unknown;
          instagramProfiles = (Array.isArray(parsed) ? parsed : [parsed]).filter(hasInstagramProfile).slice(0, 4);
          if (instagramProfiles.length) scopedSet(user, LS_IG_FULL, JSON.stringify(instagramProfiles));
          else scopedDel(user, LS_IG_FULL);
        } catch {
          scopedDel(user, LS_IG_FULL);
        }
      }
      if (!instagramProfiles.length) {
        try {
          const authorization = await getFirebaseBearer(user as User);
          const res = await fetch("/api/instagram/profile", { headers: { Authorization: authorization } });
          if (res.ok) {
            const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; profiles?: InstagramProfileFull[] };
            instagramProfiles = (payload.ok && Array.isArray(payload.profiles) ? payload.profiles : [])
              .filter(hasInstagramProfile)
              .slice(0, 4);
            if (instagramProfiles.length) scopedSet(user, LS_IG_FULL, JSON.stringify(instagramProfiles));
          }
        } catch {
          /* optional social context — ignore transient/offline failures */
        }
      }
      setIgProfiles(instagramProfiles);

      let connectedThreadsProfiles: ThreadsProfileFull[] = [];
      const savedThreads = scopedGet(user, LS_THREADS_FULL);
      if (savedThreads) {
        try {
          const parsed = JSON.parse(savedThreads) as unknown;
          connectedThreadsProfiles = (Array.isArray(parsed) ? parsed : [parsed]).filter(hasThreadsProfile).slice(0, 4);
          if (connectedThreadsProfiles.length) scopedSet(user, LS_THREADS_FULL, JSON.stringify(connectedThreadsProfiles));
          else scopedDel(user, LS_THREADS_FULL);
        } catch {
          scopedDel(user, LS_THREADS_FULL);
        }
      }
      if (!connectedThreadsProfiles.length) {
        try {
          const authorization = await getFirebaseBearer(user as User);
          const res = await fetch("/api/threads/profile", { headers: { Authorization: authorization } });
          if (res.ok) {
            const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; profiles?: ThreadsProfileFull[] };
            connectedThreadsProfiles = (payload.ok && Array.isArray(payload.profiles) ? payload.profiles : [])
              .filter(hasThreadsProfile)
              .slice(0, 4);
            if (connectedThreadsProfiles.length) scopedSet(user, LS_THREADS_FULL, JSON.stringify(connectedThreadsProfiles));
          }
        } catch {
          /* optional social context — ignore transient/offline failures */
        }
      }
      setThreadsProfiles(connectedThreadsProfiles);

      let connectedXProfiles: XProfileFull[] = [];
      const savedX = scopedGet(user, LS_X_FULL);
      if (savedX) {
        try {
          const parsed = JSON.parse(savedX) as unknown;
          connectedXProfiles = (Array.isArray(parsed) ? parsed : [parsed]).filter(hasXProfile).slice(0, 4);
          if (connectedXProfiles.length) scopedSet(user, LS_X_FULL, JSON.stringify(connectedXProfiles));
          else scopedDel(user, LS_X_FULL);
        } catch {
          scopedDel(user, LS_X_FULL);
        }
      }
      if (!connectedXProfiles.length) {
        try {
          const authorization = await getFirebaseBearer(user as User);
          const res = await fetch("/api/x/profile", { headers: { Authorization: authorization } });
          if (res.ok) {
            const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; profiles?: XProfileFull[] };
            connectedXProfiles = (payload.ok && Array.isArray(payload.profiles) ? payload.profiles : [])
              .filter(hasXProfile)
              .slice(0, 4);
            if (connectedXProfiles.length) scopedSet(user, LS_X_FULL, JSON.stringify(connectedXProfiles));
          }
        } catch {
          /* optional social context — ignore transient/offline failures */
        }
      }
      setXProfiles(connectedXProfiles);
      const linkedInConnected = hasUrlEnrichedLinkedInProfile(profile);
      const linkedInRequired = provider === "guest";

      // Provider-aware connect gate: guest sessions need rich LinkedIn; Google/dev users
      // can start from their signed-in identity and optionally add LinkedIn on precollect.
      const baseStage: Stage = !id.name || !isValidEmail(id.email)
        ? "manual"
        : linkedInRequired && !linkedInConnected
          ? "connect"
          : "precollect";
      if (baseStage === "manual") setManualMode("auth");

      // Guest sessions cannot resume normal scans until the required LinkedIn URL
      // gate is satisfied. Keep ?scan= email deep-links as explicit report-open requests.
      const pending = safeGet("session", SS_PENDING);
      if (baseStage === "connect") {
        scopedDel(user, LS_ACTIVE_SCAN);
        scopedDel(user, LS_ACTIVE_STARTED_AT);
        if (!pending) scopedDel(user, LS_LAST_SCAN);
        if (!pending) {
          setStage("connect");
          return;
        }
      }

      // (a) a scan was in flight (localStorage → survives refresh AND app close)
      const inFlight = scopedGet(user, LS_ACTIVE_SCAN);
      if (inFlight) {
        scanRunIdRef.current = inFlight;
        // Resume the timer from the scan's TRUE start (persisted) so the bar shows the real
        // elapsed instead of restarting at ~3%. Fall back to now only if we have no record.
        const startedAt = Number(scopedGet(user, LS_ACTIVE_STARTED_AT) || "");
        scanStartedAtRef.current = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now();
        collectStart.current = performance.now();
        setPhase1LayerStatus("running");
        setPreferenceLayer("running");
        openProgressiveDashboard(inFlight);
        const outcome = await resilientRecover(user, inFlight);
        if (outcome.outcome === "revealed") return;
        if (outcome.outcome === "failed") {
          setPhase1LayerStatus("failed");
          setError(recoveryErrorMessage(outcome, "That scan didn't finish. Start a new one when you're ready."));
          setStage("error");
          return;
        }
        // gaveup → fall through to the other recovery paths
      }

      // (b) an email deep-link (?scan=) or last completed scan → completed-only fetch
      const restoreId = pending || scopedGet(user, LS_LAST_SCAN);
      if (restoreId) {
        scanRunIdRef.current = restoreId;
        const recovered = await tryRecoverCompleted(user, restoreId);
        safeDel("session", SS_PENDING);
        if (recovered) {
          // Intelligence layer changed since this scan → don't show the stale report;
          // route back to Send One to re-run on the new intelligence. (An explicit email
          // deep-link ?scan= is a request for that specific report → still open it.)
          if (!pending && isStaleIntelligenceResult(recovered.result)) {
            routeToFreshStartForCurrentVersion(user, baseStage);
            return;
          }
          await revealResult({ result: recovered.result, audit: null, emailDelivery: recovered.emailDelivery });
          return;
        }
        if (!pending) scopedDel(user, LS_LAST_SCAN); // stale/expired id
      }

      if (baseStage === "connect") {
        setStage("connect");
        return;
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
            createdAt?: string | null;
            result?: OneDashboardResult | null;
            emailDelivery?: ScanEmailDeliverySummary | null;
          } | null;
          if (payload?.scanRunId && payload.status === "running") {
            const createdMs = payload.createdAt ? new Date(payload.createdAt).getTime() : Date.now();
            // Defense in depth (the server also auto-fails these): never resume the progress
            // screen for a scan that's been "running" past the staleness ceiling. Without this
            // a cold reopen re-seeds the elapsed timer from a day-old createdAt and shows the
            // eternal "composing your report" screen (observed: 1358:09 / 92%).
            if (isStaleRunning("running", createdMs)) {
              scopedDel(user, LS_ACTIVE_SCAN);
              scopedDel(user, LS_ACTIVE_STARTED_AT);
              scopedDel(user, LS_LAST_SCAN);
              setError("That scan didn't finish. Start a new one when you're ready.");
              setStage("error");
              return;
            }
            scanRunIdRef.current = payload.scanRunId;
            scopedSet(user, LS_ACTIVE_SCAN, payload.scanRunId);
            // Seed the timer from the server's scan createdAt so a cold reopen (no local
            // state) still shows the true elapsed, then persist it for subsequent refreshes.
            scanStartedAtRef.current = Number.isFinite(createdMs) ? createdMs : Date.now();
            scopedSet(user, LS_ACTIVE_STARTED_AT, String(scanStartedAtRef.current));
            collectStart.current = performance.now();
            setPhase1LayerStatus("running");
            setPreferenceLayer("running");
            openProgressiveDashboard(payload.scanRunId);
            const outcome = await resilientRecover(user, payload.scanRunId);
            if (outcome.outcome === "revealed") return;
            if (outcome.outcome === "failed") {
              setPhase1LayerStatus("failed");
              setError(recoveryErrorMessage(outcome, "That scan didn't finish. Start a new one when you're ready."));
              setStage("error");
              return;
            }
          } else if (payload?.scanRunId && payload.status === "completed" && payload.result) {
            // intelligence changed since this scan → re-run on the new layer, not restore
            if (isStaleIntelligenceResult(payload.result)) {
              routeToFreshStartForCurrentVersion(user, baseStage);
              return;
            }
            scanRunIdRef.current = payload.scanRunId;
            scopedSet(user, LS_LAST_SCAN, payload.scanRunId);
            await revealResult({ result: payload.result, audit: null, emailDelivery: payload.emailDelivery ?? null });
            return;
          }
        }
      } catch {
        /* probe failed — never block sign-in on it */
      }

      // (d) default — signed in, nothing to restore. With the dormant discover flow
      // revived (DISCOVER_MODE), resume an in-progress disambiguation if one was saved.
      // When it's off (the LinkedIn-pivot flow), drop any stale saved discovery so it
      // can't resurrect the retired screen for a returning user.
      if (!DISCOVER_MODE) safeDel("local", LS_DISCOVERY);
      if (RESEARCH_MODE && DISCOVER_MODE && baseStage === "precollect") {
        const rawDisc = safeGet("local", LS_DISCOVERY);
        if (rawDisc) {
          try {
            const saved = JSON.parse(rawDisc) as {
              confirmed?: ConfirmedProfile[];
              shownUrls?: string[];
              location?: Coordinates;
            };
            if (saved.location && ((saved.confirmed?.length ?? 0) > 0 || (saved.shownUrls?.length ?? 0) > 0)) {
              setConfirmed(saved.confirmed ?? []);
              discoverLocRef.current = saved.location;
              setRestorePending({ location: saved.location, shownUrls: saved.shownUrls ?? [] });
              setStage("disambiguate");
              return;
            }
          } catch {
            safeDel("local", LS_DISCOVERY);
          }
        }
      }
      // (d) default — signed in, nothing to restore
      setStage(baseStage);
    } catch {
      // token revoked / getIdToken threw → clean sign-out → landing
      await signOutOfGoogle().catch(() => undefined);
      clearPersisted();
      setAuthUser(null);
      setAuthProvider("unknown");
      setIgProfiles([]);
      setThreadsProfiles([]);
      setXProfiles([]);
      setSocialPreferenceConsent(false);
      setStage("landing");
    }
  };

  // ── Rehydrate auth + app state on load so a refresh never re-prompts ──────
  useEffect(() => {
    // capture an email deep-link (?scan=<id>), then clean the URL so a refresh doesn't re-trigger it.
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
        await completeGoogleRedirect();
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

  const onAuth = async () => {
    setError("");
    setNotice("");
    setManualMode("auth");
    setGuestError("");
    // Dev mode (no Firebase) keeps the fake-user path so local UI work doesn't need OAuth.
    if (!isFirebaseClientConfigured()) {
      if (shouldAllowDevAuth()) {
        safeSet("session", SS_DEV_AUTH, "1"); // so a refresh restores the dev user
        await hydrateFromUser(makeDevUser());
      } else {
        setError("Sign-in is not configured for this build.");
      }
      return;
    }
    // Google is the front door. On desktop the popup resolves with the user (route now);
    // on mobile a redirect starts and completeGoogleRedirect() finishes it on the next load.
    try {
      track("signed_in", { provider: "google", step: "popup" });
      const user = await signInWithGoogle();
      if (user) await hydrateFromUser(user);
    } catch (e) {
      setError(mapSignInError(e));
    }
  };

  const runScan = async (location: Coordinates, confirmedProfiles?: ConfirmedProfile[]) => {
    if (!authUser) {
      setError("Sign in again to continue.");
      setStage("error");
      return;
    }
    safeDel("local", LS_DISCOVERY); // past disambiguation — don't resurrect it on refresh
    setProgress(0);
    setElapsedMs(0);
    setServerStage(0);
    setLiveSource(null);
    setDashboard(null);
    resetProgressiveLayers();
    setAudit(null);
    setEmailDelivery(null);
    setError("");
    scanRunIdRef.current = null;
    scanStartedAtRef.current = Date.now(); // absolute start → resumable elapsed across refresh/close
    setStage("collect");
    collectStart.current = performance.now();

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 1_800_000); // match server cap (30min)
    setPhase1LayerStatus("running");

    try {
      const authorization = await getFirebaseBearer(authUser as User);
      const socialProfiles = await refreshConnectedSocialProfilesForScan(authorization);
      setPreferenceLayer(socialProfiles.length && socialPreferenceConsent ? "running" : "skipped");
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
          linkedinProfile: liProfile ?? undefined, // verified LinkedIn anchor → ground truth for Phase 1
          socialProfiles: socialProfiles.length ? socialProfiles : undefined,
          socialPreferenceConsent: socialProfiles.length ? socialPreferenceConsent : false,
          confirmedProfiles, // derived LinkedIn pivot → seeds Phase 1 + 2
          consentAttestation: true,
          purpose: "self_audit",
          sessionId: getSessionId(), // links server scan events to this UI session
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
          // recover this run after a refresh OR app close — persist id + the absolute start
          // so the resumed timer shows the true elapsed (not a reset-to-0% bar).
          scopedSet(authUser, LS_ACTIVE_SCAN, msg.scanRunId);
          scopedSet(authUser, LS_ACTIVE_STARTED_AT, String(scanStartedAtRef.current || Date.now()));
          openProgressiveDashboard(msg.scanRunId);
          track("phase1_stream_started", { scanRunId: msg.scanRunId });
        }
        if (typeof msg.stage === "number") setServerStage((s) => Math.max(s, msg.stage as number));
        if (typeof msg.scanning === "string") {
          setLiveSource(msg.scanning as string);
          setPhase1LayerStatus("running");
        }
      });

      // Soft-deadline handoff: the scan is still running server-side (Phase-1 ran long).
      // Poll patiently, reassure the user, and fall back to the email — never a hard error.
      if (final?.type === "pending") {
        setPhase1LayerStatus("pending");
        track("phase1_stream_pending", { scanRunId: scanRunIdRef.current });
        setLiveSource("One is taking longer than usual — it'll keep working and email you.");
        if (scanRunIdRef.current) {
          const outcome = await resilientRecover(authUser, scanRunIdRef.current).catch((): RecoveryOutcome => ({ outcome: "gaveup" }));
          if (outcome.outcome === "revealed") return;
          if (outcome.outcome === "failed") {
            setPhase1LayerStatus("failed");
            setError(recoveryErrorMessage(outcome, "One could not complete the scan."));
            setStage("error");
            return;
          }
        }
        if (scanRunIdRef.current) openProgressiveDashboard(scanRunIdRef.current);
        return;
      }

      if (!final || final.type === "error" || !final.result) {
        setPhase1LayerStatus("failed");
        throw new Error(final?.error || "One could not complete the scan.");
      }
      setPhase1LayerStatus("completed");
      track("phase1_stream_completed", { scanRunId: scanRunIdRef.current });
      await revealResult({ result: final.result, audit: final.audit, emailDelivery: final.emailDelivery });
    } catch (e) {
      // the stream dropped, but the scan keeps running server-side — keep polling
      if (scanRunIdRef.current) {
        const outcome = await resilientRecover(authUser, scanRunIdRef.current).catch((): RecoveryOutcome => ({ outcome: "gaveup" }));
        if (outcome.outcome === "revealed") return;
        if (outcome.outcome === "failed") {
          setPhase1LayerStatus("failed");
          setError(recoveryErrorMessage(outcome, "One could not complete the scan."));
          setStage("error");
          return;
        }
        // gaveup but the scan is still tracked (recovery just timed out — not a vanished
        // row, which resilientRecover would have cleared) → it's still running. Show the
        // calm pending screen and KEEP it resumable; the email delivers it.
        if (scopedGet(authUser, LS_ACTIVE_SCAN)) {
          setPhase1LayerStatus("pending");
          if (scanRunIdRef.current) openProgressiveDashboard(scanRunIdRef.current);
          return;
        }
      }
      scopedDel(authUser, LS_ACTIVE_SCAN); // nothing to resurrect as "collecting"
      scopedDel(authUser, LS_ACTIVE_STARTED_AT);
      setError(e instanceof Error ? e.message : "One could not complete the scan.");
      setStage("error");
    } finally {
      clearTimeout(abortTimer);
    }
  };

  // Phase 0: discover candidate profiles for the user to confirm. `append` keeps the
  // running batch (Show more / restore); otherwise it starts a fresh session. `exclude`
  // overrides the excluded set (used on cross-refresh restore).
  const runDiscover = async (location: Coordinates, opts?: { append?: boolean; exclude?: string[] }) => {
    if (!authUser) {
      setError("Sign in again to continue.");
      setStage("error");
      return;
    }
    const append = !!opts?.append;
    discoverLocRef.current = location;
    const excludeUrls = opts?.exclude ?? (append ? candidates.map((c) => c.url) : []);
    if (!append) {
      setCandidates([]);
      setConfirmed([]);
      setDismissed([]);
    }
    setDiscoverError("");
    setDiscoverBusy(true);
    setLiveSource(null);
    setStage("disambiguate");
    track("discover_started");

    discoverAbortRef.current?.abort();
    const controller = new AbortController();
    discoverAbortRef.current = controller;
    const abortTimer = setTimeout(() => controller.abort(), 600_000);
    try {
      const authorization = await getFirebaseBearer(authUser as User);
      const response = await fetch("/api/one/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization },
        signal: controller.signal,
        body: JSON.stringify({
          name: identity.name,
          email: identity.email,
          latitude: location.latitude,
          longitude: location.longitude,
          zipCode: location.zipCode,
          excludeUrls,
          sessionId: getSessionId(),
        }),
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !response.body || contentType.includes("application/json")) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "One could not find your profiles.");
      }
      const final = await readScanStream(response.body, (msg) => {
        if (typeof msg.scanning === "string") setLiveSource(msg.scanning);
      });
      if (!final || final.type === "error") throw new Error(final?.error || "One could not find your profiles.");
      const fresh = (final.candidates ?? []) as DiscoverCandidate[];
      setCandidates((prev) => {
        const seen = new Set(prev.map((c) => c.url));
        return [...prev, ...fresh.filter((c) => c && c.url && !seen.has(c.url))];
      });
      track("discover_candidates", { count: fresh.length });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setDiscoverError(e instanceof Error ? e.message : "One could not find your profiles.");
    } finally {
      clearTimeout(abortTimer);
      setDiscoverBusy(false);
    }
  };

  const confirmedUrls = new Set(confirmed.map((p) => p.url));
  // visible = surfaced, not dismissed (dismissed stay hidden but excluded next cycle)
  const visibleCandidates = candidates.filter((c) => !dismissed.includes(c.url));

  const toggleConfirm = (c: DiscoverCandidate) => {
    setConfirmed((prev) => {
      if (prev.some((p) => p.url === c.url)) return prev.filter((p) => p.url !== c.url);
      track("pivot_confirmed", { platform: c.platform });
      return [...prev, { platform: c.platform, handle: c.handle, url: c.url, category: c.category }];
    });
  };
  const dismissCandidate = (c: DiscoverCandidate) => {
    setConfirmed((prev) => prev.filter((p) => p.url !== c.url));
    setDismissed((prev) => (prev.includes(c.url) ? prev : [...prev, c.url]));
    track("pivot_rejected", { platform: c.platform });
  };
  const moreOptions = () => {
    const loc = discoverLocRef.current;
    if (!loc || discoverBusy) return;
    track("discover_cycle");
    void runDiscover(loc, { append: true });
  };
  const proceedFromDisambiguation = () => {
    if (confirmed.length < DISCOVER_GATE) return;
    const loc = discoverLocRef.current ?? {};
    track("disambiguation_complete", { confirmed: confirmed.length });
    safeDel("local", LS_DISCOVERY);
    void runScan(loc, [...confirmed, ...socialPivots()]);
  };

  // persist in-progress disambiguation so a refresh restores the gate progress
  useEffect(() => {
    if (stage !== "disambiguate") return;
    const loc = discoverLocRef.current;
    if (!loc) return;
    safeSet(
      "local",
      LS_DISCOVERY,
      JSON.stringify({ confirmed, shownUrls: [...candidates.map((c) => c.url), ...dismissed], location: loc }),
    );
  }, [stage, confirmed, candidates, dismissed]);

  // cross-refresh restore: re-run discovery (excluding already-shown) to resume picking.
  // Guard with a ref so it fires once even if authUser re-emits (token refresh).
  useEffect(() => {
    if (!restorePending || !authUser || restoredRef.current) return;
    restoredRef.current = true;
    void runDiscover(restorePending.location, { append: true, exclude: restorePending.shownUrls });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restorePending, authUser]);

  // The verified LinkedIn profile URL → the single anchor threaded into Phase 1 + 2.
  // Empty array when there's no profile URL (the server also derives this from linkedinProfile).
  const linkedinPivot = (): ConfirmedProfile[] => {
    const url = normalizeLinkedInUrl(liProfile?.profileUrl ?? "");
    if (!url) return [];
    return [{ platform: "LinkedIn", handle: linkedinHandleFromUrl(url), url, category: "Professional" }];
  };

  const instagramPivots = (): ConfirmedProfile[] =>
    igProfiles.flatMap((profile) => {
      const url = normalizeInstagramUrl(profile.profileUrl);
      return url ? [{ platform: "Instagram", handle: instagramHandleFromUrl(url), url, category: "Social" }] : [];
    });

  const threadsPivots = (): ConfirmedProfile[] =>
    threadsProfiles.flatMap((profile) => {
      const url = normalizeThreadsUrl(profile.profileUrl);
      return url ? [{ platform: "Threads", handle: threadsHandleFromUrl(url), url, category: "Social" }] : [];
    });

  const xPivots = (): ConfirmedProfile[] =>
    xProfiles.flatMap((profile) => {
      const url = normalizeXUrl(profile.profileUrl);
      return url ? [{ platform: "X", handle: xHandleFromUrl(url), url, category: "Social" }] : [];
    });

  const socialPivots = (): ConfirmedProfile[] => [...instagramPivots(), ...threadsPivots(), ...xPivots()];

  const startCollect = () => {
    if (geoBusy || stage === "collect") return; // guard double-submit / overlapping scans
    setUpgradeNotice(""); // they're re-running on the new layer — clear the upgrade prompt
    if (requiresLinkedIn && !hasUrlEnrichedLinkedInProfile(liProfile)) {
      scopedDel(authUser, LS_LI_FULL);
      scopedDel(authUser, LS_LI_CONNECTED);
      setLiProfile(null);
      setError("");
      setStage("connect");
      return;
    }
    // A scan is already running (e.g. user landed back on precollect after a recovery
    // timeout) → RESUME it instead of POSTing a duplicate. "Scan again"/"Start over"
    // clear LS_ACTIVE_SCAN first, so an intentional fresh scan still starts cleanly.
    const active = scopedGet(authUser, LS_ACTIVE_SCAN);
    if (active && authUser) {
      scanRunIdRef.current = active;
      const startedAt = Number(scopedGet(authUser, LS_ACTIVE_STARTED_AT) || "");
      scanStartedAtRef.current = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now();
      collectStart.current = performance.now();
      setError("");
      setPhase1LayerStatus("running");
      openProgressiveDashboard(active);
      void resilientRecover(authUser, active).then((outcome) => {
        if (outcome.outcome === "failed") {
          setPhase1LayerStatus("failed");
          setError(recoveryErrorMessage(outcome, "That scan didn't finish. Start a new one when you're ready."));
          setStage("error");
        } else if (outcome.outcome === "gaveup" && scopedGet(authUser, LS_ACTIVE_SCAN)) {
          setPhase1LayerStatus("pending");
          openProgressiveDashboard(active);
        }
      });
      return;
    }
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
        const loc = {
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
        };
        // Deep Research → anchor on the pasted LinkedIn pivot and scan directly.
        // (DISCOVER_MODE revives the old "confirm candidates" Phase-0 instead.) Shadow → scan directly.
        if (RESEARCH_MODE && DISCOVER_MODE) void runDiscover(loc);
        else if (RESEARCH_MODE) void runScan(loc, [...linkedinPivot(), ...socialPivots()]);
        else void runScan(loc);
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

  // Re-run a fresh scan without signing out — on-demand re-test / pick up new intelligence.
  const scanAgain = () => {
    pollStopRef.current = true;
    scanRunIdRef.current = null;
    scanStartedAtRef.current = 0;
    scopedDel(authUser, LS_LAST_SCAN);
    scopedDel(authUser, LS_ACTIVE_SCAN);
    scopedDel(authUser, LS_ACTIVE_STARTED_AT);
    safeDel("local", LS_DISCOVERY);
    setDashboard(null);
    resetProgressiveLayers();
    setAudit(null);
    setEmailDelivery(null);
    setError("");
    setProgress(0);
    setElapsedMs(0);
    setServerStage(0);
    setLiveSource(null);
    setCandidates([]);
    setConfirmed([]);
    setDismissed([]);
    setDiscoverError("");
    setStage(requiresLinkedIn && !hasUrlEnrichedLinkedInProfile(liProfile) ? "connect" : "precollect");
  };

  // From the calm "pending" (deadline-handoff) screen → re-check whether the scan finished.
  const checkPending = async () => {
    if (!authUser || !scanRunIdRef.current) {
      setStage(identity.name && isValidEmail(identity.email) ? "precollect" : "manual");
      return;
    }
    setLiveSource("One is checking on your dossier…");
    setPhase1LayerStatus("running");
    if (scanRunIdRef.current) openProgressiveDashboard(scanRunIdRef.current);
    const outcome = await resilientRecover(authUser, scanRunIdRef.current).catch((): RecoveryOutcome => ({ outcome: "gaveup" }));
    if (outcome.outcome === "revealed") return;
    if (outcome.outcome === "failed") {
      setError(recoveryErrorMessage(outcome, "One could not complete the scan."));
      setStage("error");
      return;
    }
    setPhase1LayerStatus("pending");
    if (scanRunIdRef.current) openProgressiveDashboard(scanRunIdRef.current);
  };

  const reset = async () => {
    track("started_over");
    pollStopRef.current = true; // halt any in-flight recovery polling
    await signOutOfGoogle().catch(() => undefined);
    clearPersisted();
    scanRunIdRef.current = null;
    setAuthUser(null);
    setAuthProvider("unknown");
    setIdentity({ name: "", email: "" });
    setManualMode("auth");
    setGuestBusy(false);
    setGuestError("");
    setLiProfile(null);
    setIgProfiles([]);
    setThreadsProfiles([]);
    setXProfiles([]);
    setSocialPreferenceConsent(false);
    setDashboard(null);
    resetProgressiveLayers();
    setAudit(null);
    setEmailDelivery(null);
    setError("");
    setProgress(0);
    setElapsedMs(0);
    setServerStage(0);
    setLiveSource(null);
    setGeoBusy(false);
    setCandidates([]);
    setConfirmed([]);
    setDismissed([]);
    setDiscoverError("");
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
      setAuthProvider("unknown");
      setIdentity({ name: "", email: "" });
      setManualMode("auth");
      setGuestBusy(false);
      setGuestError("");
      setLiProfile(null);
      setIgProfiles([]);
      setThreadsProfiles([]);
      setXProfiles([]);
      setSocialPreferenceConsent(false);
      setDashboard(null);
      resetProgressiveLayers();
      setAudit(null);
      setEmailDelivery(null);
      setError("");
      setProgress(0);
      setElapsedMs(0);
      setServerStage(0);
      setLiveSource(null);
      setCandidates([]);
      setConfirmed([]);
      setDismissed([]);
      setDiscoverError("");
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
        <LandingPage onStart={onAuth} onGuest={onGuestStart} error={error} />
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
        busy={guestBusy}
        error={guestError}
        onContinue={onManualDone}
      />
    );
  else if (stage === "connect")
    view = (
      <ConnectLinkedIn
        key="conn"
        user={identity}
        authUser={authUser as ClientUser}
        instagramProfiles={igProfiles}
        threadsProfiles={threadsProfiles}
        xProfiles={xProfiles}
        onConnected={onLinkedInConnected}
        onInstagramConnected={onInstagramConnected}
        onThreadsConnected={onThreadsConnected}
        onXConnected={onXConnected}
        upgradeNotice={upgradeNotice}
      />
    );
  else if (stage === "precollect")
    view = (
      <PreCollect
        key="p"
        user={identity}
        profile={liProfile}
        authUser={authUser}
        authProvider={authProvider}
        requiresLinkedIn={requiresLinkedIn}
        instagramProfiles={igProfiles}
        threadsProfiles={threadsProfiles}
        xProfiles={xProfiles}
        socialPreferenceConsent={socialPreferenceConsent}
        onLinkedInConnected={onLinkedInConnected}
        onInstagramConnected={onInstagramConnected}
        onThreadsConnected={onThreadsConnected}
        onXConnected={onXConnected}
        onLinkedInChange={onLinkedInChange}
        onSocialPreferenceConsentChange={onSocialPreferenceConsentChanged}
        onCollect={startCollect}
        busy={geoBusy}
        upgradeNotice={upgradeNotice}
      />
    );
  else if (stage === "disambiguate")
    view = (
      <Disambiguate
        key="dis"
        candidates={visibleCandidates}
        confirmedUrls={confirmedUrls}
        confirmedCount={confirmed.length}
        busy={discoverBusy}
        error={discoverError}
        liveLine={liveSource}
        onConfirm={toggleConfirm}
        onDismiss={dismissCandidate}
        onMore={moreOptions}
        onContinue={proceedFromDisambiguation}
      />
    );
  else if (stage === "collect")
    view = <CollectionOverlay key="c" progress={progress} phaseIndex={phaseIndex} elapsedMs={elapsedMs} liveSource={liveSource} />;
  else if (stage === "dashboard" && dashboard)
    view = <Dashboard key="d" result={dashboard} audit={audit} emailDelivery={emailDelivery} onReset={reset} onScanAgain={scanAgain} />;
  else if (stage === "dashboard")
    view = (
      <ProgressiveDashboardShell
        key="pd"
        phase1Status={phase1Status}
        phase1Message={liveSource}
        preferenceStatus={preferenceStatus}
        preferenceProfile={preferenceProfile}
        elapsedMs={elapsedMs}
        onReset={reset}
      />
    );
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
  else if (stage === "pending")
    view = <PendingState key="pend" email={identity.email} onCheck={() => void checkPending()} onReset={reset} />;
  else if (stage === "location")
    view = (
      <LocationFallback
        key="loc"
        reason={geoReason}
        busy={geoBusy}
        onRetry={startCollect}
        onZip={(zip) =>
          RESEARCH_MODE && DISCOVER_MODE
            ? void runDiscover({ zipCode: zip })
            : RESEARCH_MODE
              ? void runScan({ zipCode: zip }, [...linkedinPivot(), ...socialPivots()])
              : void runScan({ zipCode: zip })
        }
      />
    );

  return (
    <main className="stage">
      {stage === "manual" || stage === "connect" || stage === "empty" || stage === "error" || stage === "location" || stage === "settings" || stage === "pending" ? (
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

      <div className="ui">
        <ErrorBoundary>{view}</ErrorBoundary>
      </div>

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
