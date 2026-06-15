import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { verifyOneRequest } from "@/lib/auth/verify";
import {
  isValidEmail,
  normalizeEmail,
  normalizeName,
  normalizeLinkedInUrl,
  linkedinHandleFromUrl,
  normalizeInstagramUrl,
  instagramHandleFromUrl,
} from "@/lib/auth/identity";
import { createConsentAndScan, completeScanRun, failScanRun, recordScanDeadline, upsertOneUser } from "@/lib/db/scan-store";
import { startResearch, pollResearch, type ResearchDepth } from "@/lib/research/client";
import { buildPersonDossierQuestion } from "@/lib/research/dossier";
import { finalizeResearch } from "@/lib/research/finalize";
import { shadowPhaseIndex, SHADOW_PHASES, oneVoiceProgress } from "@/lib/ria/progress";
import { hasUrlEnrichedLinkedInProfile, type LinkedInProfileFull, type LinkedInExperience, type LinkedInEducation, type LinkedInCertification } from "@/lib/linkedin/profile";
import type { InstagramHighlight, InstagramProfileFull, InstagramPublicPost } from "@/lib/instagram/profile";
import type { ConfirmedProfile, LocationMode, OneSubjectInput } from "@/lib/ria/types";
import { sendScanResultEmails } from "@/lib/notifications/scan-email";
import type { ScanEmailDeliverySummary } from "@/lib/notifications/types";

export const runtime = "nodejs";
// Deep Research is a multi-minute job; allow the route to run long where honored.
export const maxDuration = 1800;

const NAME_MAX = 80;
const SUBJECT_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const POLL_INTERVAL_MS = 8000;
// Soft deadline: close + hand off before Cloud Run's hard 1800s kill (maxDuration=1800 +
// service --timeout=1800), so a long scan is never silently lost — the DR job keeps running
// on its own 3600s service and the recovery route (fresh budget) finalizes + emails it.
// Raised from 840s: Phase-1 (fast) realistically runs ~14–20min, so handing off at 14min
// meant EVERY scan handed off; a 27.5min inline budget lets most complete on-screen.
const DEADLINE_MS = 1_650_000;
// Don't START Phase-2 inline if less than this remains before the deadline; recovery
// (a fresh request) runs synthesis instead so it isn't cut off mid-way.
const PHASE2_RESERVE_MS = 200_000;

function clientIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

function requestOrigin(request: Request): string | null {
  const explicit = request.headers.get("origin");
  if (explicit?.startsWith("http")) return explicit.replace(/\/+$/, "");
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  if (!host) return null;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) return null;
  return `${proto}://${host}`;
}

async function parseBody(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

function numberOrUndefined(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/** Sanitize the Phase-0 confirmed pivots from the request body into ConfirmedProfile[]. */
function parseConfirmedProfiles(value: unknown): ConfirmedProfile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ConfirmedProfile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const rawUrl = typeof p.url === "string" ? p.url.trim().slice(0, 400) : "";
    if (!rawUrl) continue;
    // Canonicalize the LinkedIn pivot so the anchor is clean ground truth for both phases
    // (client already gates on a valid URL; fall back to the raw value if it doesn't normalize).
    const url = /linkedin\.com/i.test(rawUrl) ? normalizeLinkedInUrl(rawUrl) || rawUrl : rawUrl;
    out.push({
      url,
      platform: typeof p.platform === "string" ? p.platform.trim().slice(0, 60) : "",
      handle: typeof p.handle === "string" ? p.handle.trim().slice(0, 120) : "",
      category: typeof p.category === "string" ? p.category.trim().slice(0, 60) : "",
    });
    if (out.length >= 12) break;
  }
  return out.length ? out : undefined;
}

/** Sanitize the verified LinkedIn profile sent by the client (full MCP profile or legacy
    OAuth profile) into a LinkedInProfileFull. The structured arrays must be sanitized here
    too so they ride inside ScanRun.input — the recovery / image / deep routes read them
    back from there. Everything is bounded so a hostile/huge body can't bloat the row. */
function parseLinkedInProfile(value: unknown): LinkedInProfileFull | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const s = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const sub = s(p.sub, 120);
  if (!sub) return undefined;
  const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const list = (v: unknown, max: number) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 80)).slice(0, max) : [];

  const experience: LinkedInExperience[] = (Array.isArray(p.experience) ? p.experience : [])
    .slice(0, 25)
    .map((it) => {
      const e = rec(it);
      return {
        title: s(e.title, 160),
        company: s(e.company, 160),
        employmentType: s(e.employmentType, 80) || undefined,
        location: s(e.location, 120) || undefined,
        startDate: s(e.startDate, 40) || undefined,
        endDate: s(e.endDate, 40) || undefined,
        current: e.current === true || undefined,
        description: s(e.description, 1000) || undefined,
      };
    })
    .filter((e) => e.title || e.company);
  const education: LinkedInEducation[] = (Array.isArray(p.education) ? p.education : [])
    .slice(0, 15)
    .map((it) => {
      const e = rec(it);
      return {
        school: s(e.school, 160),
        degree: s(e.degree, 120) || undefined,
        field: s(e.field, 120) || undefined,
        startDate: s(e.startDate, 40) || undefined,
        endDate: s(e.endDate, 40) || undefined,
        grade: s(e.grade, 80) || undefined,
        description: s(e.description, 1000) || undefined,
      };
    })
    .filter((e) => e.school);
  const certifications: LinkedInCertification[] = (Array.isArray(p.certifications) ? p.certifications : [])
    .slice(0, 25)
    .map((it) => {
      const e = rec(it);
      return { name: s(e.name, 160), authority: s(e.authority, 120) || undefined, date: s(e.date, 40) || undefined };
    })
    .filter((c) => c.name);
  const skills = list(p.skills, 50);
  const rawStats = rec(p.profileStats);
  const profileStats = {
    followers: s(rawStats.followers, 80) || undefined,
    connections: s(rawStats.connections, 80) || undefined,
    isConnection: rawStats.isConnection === true || undefined,
    premium: rawStats.premium === true || undefined,
    creator: rawStats.creator === true || undefined,
  };
  const hasProfileStats = Object.values(profileStats).some((v) => v !== undefined);

  return {
    sub,
    name: s(p.name, 120),
    givenName: s(p.givenName, 80),
    familyName: s(p.familyName, 80),
    email: s(p.email, 200) || null,
    emailVerified: p.emailVerified === true,
    locale: s(p.locale, 20) || null,
    pictureUrl: s(p.pictureUrl, 1000) || null,
    profileUrl: s(p.profileUrl, 400) || null,
    headline: s(p.headline, 300) || null,
    verifications: list(p.verifications, 10),
    grantedScopes: list(p.grantedScopes, 20),
    source: p.source === "mcp" ? "mcp" : p.source === "oauth" ? "oauth" : p.source === "scraper" ? "scraper" : undefined,
    location: s(p.location, 160) || null,
    about: s(p.about, 2000) || null,
    ...(experience.length ? { experience } : {}),
    ...(education.length ? { education } : {}),
    ...(skills.length ? { skills } : {}),
    ...(certifications.length ? { certifications } : {}),
    ...(hasProfileStats ? { profileStats } : {}),
  };
}

function parseSocialProfiles(value: unknown): InstagramProfileFull[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: InstagramProfileFull[] = [];
  const s = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const rec = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const strOrNull = (v: unknown, max = 300) => s(v, max) || null;
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  for (const item of value) {
    const p = rec(item);
    if (p.platform !== "Instagram" || p.source !== "scraper") continue;
    const profileUrl = normalizeInstagramUrl(p.profileUrl);
    const username = s(p.username, 60) || (profileUrl ? instagramHandleFromUrl(profileUrl) : "");
    const url = profileUrl || normalizeInstagramUrl(`https://www.instagram.com/${username}/`);
    if (!username || !url) continue;
    const stats = rec(p.stats);
    const profile: InstagramProfileFull = {
      platform: "Instagram",
      username: username.toLowerCase(),
      displayName: strOrNull(p.displayName, 120),
      bio: strOrNull(p.bio, 1000),
      avatarUrl: strOrNull(p.avatarUrl, 1000),
      externalUrl: strOrNull(p.externalUrl, 500),
      profileUrl: url,
      source: "scraper",
      connectedAt: strOrNull(p.connectedAt, 80) || new Date().toISOString(),
    };
    const isVerified = bool(p.isVerified);
    const isPrivate = bool(p.isPrivate);
    if (typeof isVerified === "boolean") profile.isVerified = isVerified;
    if (typeof isPrivate === "boolean") profile.isPrivate = isPrivate;
    const cleanStats = {
      posts: strOrNull(stats.posts, 40),
      followers: strOrNull(stats.followers, 40),
      following: strOrNull(stats.following, 40),
    };
    if (Object.values(cleanStats).some(Boolean)) profile.stats = cleanStats;
    const highlights: InstagramHighlight[] = [];
    for (const highlight of Array.isArray(p.highlights) ? p.highlights : []) {
      const h = rec(highlight);
      const title = s(h.title, 120);
      if (!title) continue;
      highlights.push({
        title,
        url: strOrNull(h.url, 500),
        thumbnailUrl: strOrNull(h.thumbnailUrl, 1000),
      });
      if (highlights.length >= 24) break;
    }
    if (highlights.length) profile.highlights = highlights;
    const posts: InstagramPublicPost[] = [];
    for (const post of Array.isArray(p.recentPublicPosts) ? p.recentPublicPosts : []) {
      const r = rec(post);
      const postUrl = s(r.url, 500);
      if (!/^https:\/\/www\.instagram\.com\/(?:p|reel)\//i.test(postUrl)) continue;
      const position = Number(r.position);
      posts.push({
        url: postUrl,
        kind: /\/reel\//i.test(postUrl) ? "reel" : "post",
        ...(Number.isFinite(position) && position > 0 ? { position: Math.round(position) } : {}),
        caption: strOrNull(r.caption, 500),
        thumbnailUrl: strOrNull(r.thumbnailUrl, 1000),
        cdnUrls: Array.isArray(r.cdnUrls)
          ? r.cdnUrls.map((item) => s(item, 1000)).filter((item) => /^https?:\/\//i.test(item)).slice(0, 12)
          : undefined,
        alt: strOrNull(r.alt, 500),
        ariaLabel: strOrNull(r.ariaLabel, 300),
        isCarousel: r.isCarousel === true || undefined,
        isVideo: r.isVideo === true || undefined,
        timestamp: strOrNull(r.timestamp, 80),
        likes: strOrNull(r.likes, 40),
        comments: strOrNull(r.comments, 40),
        visibleText: strOrNull(r.visibleText, 300),
      });
      if (posts.length >= 120) break;
    }
    if (posts.length) profile.recentPublicPosts = posts;
    const visibleProfileText = (Array.isArray(p.visibleProfileText) ? p.visibleProfileText : [])
      .filter((item): item is string => typeof item === "string")
      .map((item) => s(item, 300))
      .filter(Boolean)
      .slice(0, 80);
    if (visibleProfileText.length) profile.visibleProfileText = visibleProfileText;
    out.push(profile);
    if (out.length >= 4) break;
  }
  return out.length ? out : undefined;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function statusCodeOf(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInput(body: Record<string, unknown>, verifiedEmail: string): OneSubjectInput {
  const name = normalizeName(body.name).slice(0, NAME_MAX);
  const email = normalizeEmail(body.email || verifiedEmail);
  const latitude = numberOrUndefined(body.latitude);
  const longitude = numberOrUndefined(body.longitude);
  const zipCode = typeof body.zipCode === "string" ? body.zipCode.trim() : undefined;
  const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : undefined;

  if (!name) throw Object.assign(new Error("Name is required"), { statusCode: 400 });
  if (!isValidEmail(email)) throw Object.assign(new Error("Valid email is required"), { statusCode: 400 });
  if (email !== verifiedEmail) {
    throw Object.assign(new Error("Signed-in account email does not match the requested subject"), { statusCode: 403 });
  }
  if (body.consentAttestation !== true) {
    throw Object.assign(new Error("Consent attestation is required"), { statusCode: 400 });
  }
  if (body.purpose !== "self_audit") {
    throw Object.assign(new Error("Only self_audit purpose is supported"), { statusCode: 400 });
  }
  if ((latitude === undefined || longitude === undefined) && !zipCode) {
    throw Object.assign(new Error("Browser coordinates or zip code are required"), { statusCode: 400 });
  }

  // LinkedIn URL-first flow: the scraper-enriched profile is the identity/career anchor.
  // Fold its profile URL into confirmedProfiles so the existing LinkedIn-anchor logic +
  // Phase-2 passthrough keep working.
  const linkedinProfile = parseLinkedInProfile(body.linkedinProfile);
  if (!hasUrlEnrichedLinkedInProfile(linkedinProfile)) {
    throw Object.assign(
      new Error("Paste your LinkedIn profile URL before Send One so One can use your full LinkedIn profile."),
      { statusCode: 400 },
    );
  }
  const socialProfiles = parseSocialProfiles(body.socialProfiles);
  let confirmedProfiles = parseConfirmedProfiles(body.confirmedProfiles);
  if (linkedinProfile?.profileUrl) {
    const url = normalizeLinkedInUrl(linkedinProfile.profileUrl) || linkedinProfile.profileUrl;
    const hasLinkedIn = (confirmedProfiles ?? []).some(
      (p) => /linkedin/i.test(p.platform || "") || /linkedin\.com\/in\//i.test(p.url),
    );
    if (!hasLinkedIn) {
      const anchor: ConfirmedProfile = {
        platform: "LinkedIn",
        handle: linkedinHandleFromUrl(url) || "",
        url,
        category: "Professional",
      };
      confirmedProfiles = [anchor, ...(confirmedProfiles ?? [])];
    }
  }
  for (const profile of socialProfiles ?? []) {
    const url = normalizeInstagramUrl(profile.profileUrl);
    if (!url) continue;
    const exists = (confirmedProfiles ?? []).some((p) => /instagram/i.test(p.platform || "") && p.url === url);
    if (!exists) {
      confirmedProfiles = [
        ...(confirmedProfiles ?? []),
        { platform: "Instagram", handle: instagramHandleFromUrl(url), url, category: "Social" },
      ];
    }
  }

  return {
    name,
    email,
    latitude,
    longitude,
    zipCode,
    phone: phone || undefined,
    confirmedProfiles,
    linkedinProfile,
    socialProfiles,
    consentAttestation: true,
    purpose: "self_audit",
  };
}

export async function POST(request: Request) {
  // Phase 1 (synchronous): auth + validate + start the Deep Research job + create the scan.
  let input: OneSubjectInput;
  let mode: LocationMode;
  let userId: string | null;
  let scanRunId: string | null;
  let jobId: string;
  let sessionId: string | null = null;
  let depth: ResearchDepth = "fast";
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = await parseBody(request);
    input = normalizeInput(body, verified.email);
    // Client analytics session id (one_sid) — links this scan's server events to the
    // user's UI funnel events for end-to-end tracing.
    sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : null;
    mode = typeof input.latitude === "number" && typeof input.longitude === "number" ? "precise" : "limited";
    // Default = fast (deep-research-preview): pointed, LinkedIn-anchored, stays under the
    // 900s wall. `max` only when explicitly forced via env. (Phase-1 max routinely ran 14–19min.)
    depth = process.env.DEEP_RESEARCH_DEPTH === "max" ? "max" : "fast";

    ({ jobId } = await startResearch(buildPersonDossierQuestion(input), depth));

    const user = await upsertOneUser({
      firebaseUid: verified.uid,
      email: input.email,
      name: input.name || verified.name,
      photoUrl: input.linkedinProfile?.pictureUrl ?? verified.picture,
    });
    userId = user?.id ?? null;
    const scan = await createConsentAndScan({
      userId: user?.id || SUBJECT_PLACEHOLDER,
      mode,
      purpose: input.purpose,
      input: toJsonValue({ ...input, deepResearchJobId: jobId }),
      latitude: input.latitude,
      longitude: input.longitude,
      zipCode: input.zipCode,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    scanRunId = scan.scanRunId;
  } catch (error) {
    const status = statusCodeOf(error) ?? 500;
    const message = error instanceof Error ? error.message : "One could not start the research";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({ event: "one.research.precheck_failed", status, message }),
    );
    return NextResponse.json({ ok: false, error: message }, { status: status >= 400 ? status : 500 });
  }

  // Phase 2 (streamed): poll the Deep Research job with NDJSON heartbeats so the
  // connection never idles and the UI shows live progress (same protocol as /dashboard).
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };
      const finish = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      // Live progress, personalized as One acting. Phase 1 → driven by the real DR
      // progress (dr.progress); Phase 2 (synthesis) → a fixed "composing" line.
      let latestRawProgress: string | null = null;
      let phase2 = false;
      let phase1Ms = 0; // set when Phase-1 finishes; readable in catch for time-to-failure
      const stageNow = () => (phase2 ? SHADOW_PHASES.length - 1 : shadowPhaseIndex(Date.now() - startedAt));
      const scanningNow = () =>
        phase2 ? "One is composing your report…" : oneVoiceProgress(latestRawProgress, stageNow());

      // Soft-deadline handoff: close cleanly BEFORE the 900s hard kill so the scan is
      // never lost without a trace. The DR job keeps running on its own 3600s service;
      // the recovery route (a fresh request) finalizes + emails. `at` records where we bailed.
      const handoffDeadline = async (elapsedMs: number, at: "phase1" | "phase2_reserve") => {
        console.warn(
          JSON.stringify({
            event: "one.research.deadline",
            severity: "WARNING",
            scanRunId,
            sessionId,
            email: input.email,
            jobId,
            depth,
            at,
            phase1Ms: elapsedMs,
            elapsedMs,
          }),
        );
        await recordScanDeadline(scanRunId, { phase1Ms: elapsedMs, sessionId, deepResearchJobId: jobId }).catch(() => undefined);
        send({
          type: "pending",
          reason: "deadline",
          scanRunId,
          message: "One is taking longer than usual — it'll keep working and email you the moment it's done.",
        });
      };

      send({ type: "start", scanRunId, stage: 0, elapsedMs: 0, scanning: oneVoiceProgress(null, 0) });
      heartbeat = setInterval(() => {
        send({ type: "progress", stage: stageNow(), elapsedMs: Date.now() - startedAt, scanning: scanningNow() });
      }, 7000);

      try {
        let report: string | null = null;
        let citations: unknown[] = [];
        for (;;) {
          if (closed) return; // client disconnected; recovery route will resume
          // Soft deadline reached during Phase-1 → hand off (don't wait for the hard kill).
          if (Date.now() - startedAt > DEADLINE_MS) {
            await handoffDeadline(Date.now() - startedAt, "phase1");
            return;
          }
          const dr = await pollResearch(jobId);
          if (dr.progress) latestRawProgress = dr.progress; // keep the latest real signal
          if (dr.status === "completed" && dr.report) {
            report = dr.report;
            citations = dr.citations;
            break;
          }
          if (dr.status === "failed") {
            throw Object.assign(new Error(dr.error || "Deep Research could not complete"), { statusCode: 502 });
          }
          // push a fresh One-voiced line right after each poll (don't wait for the heartbeat)
          send({ type: "progress", stage: stageNow(), elapsedMs: Date.now() - startedAt, scanning: scanningNow() });
          await sleep(POLL_INTERVAL_MS);
        }

        // Phase 1 done — record how long Gemini took.
        phase1Ms = Date.now() - startedAt;
        console.info(
          JSON.stringify({ event: "one.research.phase1_done", severity: "INFO", scanRunId, sessionId, email: input.email, jobId, phase1Ms }),
        );

        // Too little budget left to also run Phase-2 inline before the wall → hand off;
        // recovery (a fresh request) will synthesize + email rather than be cut off.
        if (Date.now() - startedAt > DEADLINE_MS - PHASE2_RESERVE_MS) {
          await handoffDeadline(phase1Ms, "phase2_reserve");
          return;
        }

        // Phase 2: refine into the focused, disambiguated final dossier (fail-safe to raw).
        phase2 = true; // heartbeats now show "One is composing your report…"
        send({ type: "progress", stage: SHADOW_PHASES.length - 1, elapsedMs: Date.now() - startedAt, scanning: "One is composing your report…" });
        const { result, phase2Ms } = await finalizeResearch(report, citations, input, mode, scanRunId);
        const totalMs = Date.now() - startedAt;
        await completeScanRun(scanRunId, toJsonValue(result), result.summary, {
          phase1Ms,
          phase2Ms,
          totalMs,
          outcome: "completed",
          sessionId,
          deepResearchJobId: jobId,
        });

        let emailDelivery: ScanEmailDeliverySummary | null = null;
        try {
          emailDelivery = await sendScanResultEmails({
            userId,
            scanRunId,
            result,
            audit: null,
            siteUrl: requestOrigin(request),
          });
        } catch (notificationError) {
          console.error(
            JSON.stringify({
              event: "one.research_email.failed",
              severity: "ERROR",
              scanRunId,
              message: notificationError instanceof Error ? notificationError.message : "unknown",
            }),
          );
        }

        send({ type: "done", ok: true, result, source: result.source, audit: null, emailDelivery });
        console.info(
          JSON.stringify({
            event: "one.research.completed",
            severity: "INFO",
            scanRunId,
            sessionId,
            email: input.email,
            jobId,
            phase1Ms,
            phase2Ms,
            totalMs,
            outcome: "completed",
            source: result.source,
          }),
        );
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const failMs = phase1Ms || elapsedMs; // time-to-failure when Phase-1 itself errored
        const message = error instanceof Error ? error.message : "One could not complete the research";
        console.error(
          JSON.stringify({
            event: "one.research.failed",
            severity: "ERROR",
            scanRunId,
            sessionId,
            email: input.email,
            jobId,
            phase1Ms: failMs,
            elapsedMs,
            message,
          }),
        );
        await failScanRun(scanRunId, message, { phase1Ms: failMs, sessionId, deepResearchJobId: jobId }).catch(() => undefined);
        send({ type: "error", ok: false, error: message });
      } finally {
        finish();
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
