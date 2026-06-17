import crypto from "node:crypto";
import type { InstagramProfileFull, InstagramPublicPost } from "@/lib/instagram/profile";
import type { ThreadsPost, ThreadsProfileFull } from "@/lib/threads/profile";
import type { XProfileFull, XTimelineItem } from "@/lib/x/profile";
import type { LinkedInProfileFull } from "@/lib/linkedin/profile";

export type PreferenceConfidence = "low" | "medium" | "high";
export type PreferenceSource = "observed" | "inferred" | "observed_plus_inferred" | "self_declared";

export type PreferenceDomain =
  | "travel_stay"
  | "food_drinks"
  | "colors_style"
  | "brands_devices"
  | "work_interests"
  | "language"
  | "communication_style"
  | "social_behavior"
  | "digital_wellbeing"
  | "relationship_preferences"
  | "unknowns";

export interface PreferenceEvidence {
  id: string;
  platform: "instagram" | "threads" | "x" | "linkedin";
  type: "profile" | "post" | "reply" | "media" | "link";
  url: string | null;
  text: string | null;
  mediaUrl: string | null;
  timestamp: string | null;
  reason: string;
  signals: string[];
}

export interface PreferenceSignal {
  id: string;
  domain: PreferenceDomain;
  label: string;
  confidence: PreferenceConfidence;
  strength: number;
  source: PreferenceSource;
  reason: string;
  evidenceIds: string[];
  needsConfirmation?: boolean;
}

export interface PreferenceCollageItem {
  evidenceId: string;
  platform: PreferenceEvidence["platform"];
  imageUrl: string | null;
  postUrl: string | null;
  caption: string | null;
  timestamp: string | null;
  signals: string[];
  reason: string;
}

export interface PreferenceSelectionTracking {
  selectedAt: string;
  evidencePoolSize: number;
  selectedEvidenceCount: number;
  selectedEvidenceIds: string[];
  selectedSignalCount: number;
  selectedSignalIds: string[];
  collageEvidenceIds: string[];
  droppedEvidenceCount: number;
  byPlatform: Record<PreferenceEvidence["platform"], number>;
  selectedByPlatform: Record<PreferenceEvidence["platform"], number>;
  byDomain: Record<PreferenceDomain, number>;
  selectionRules: {
    evidenceCap: number;
    topSignalCap: number;
    signalEvidenceCap: number;
    collageCap: number;
    promptPostLimit: number | null;
  };
}

export interface UserPreferenceProfile {
  version: "2026-06-17.social-preference-v1";
  status: "completed";
  generatedAt: string;
  updatedFrom: {
    platforms: string[];
    indexedItems: number;
    mediaAssets: number;
    ocrSignals: number;
    externalLinks: number;
    recentWindowDays: number;
  };
  summary: string;
  topSignals: PreferenceSignal[];
  domains: Record<PreferenceDomain, PreferenceSignal[]>;
  evidence: PreferenceEvidence[];
  collage: PreferenceCollageItem[];
  selection: PreferenceSelectionTracking;
  refresh: {
    lastIndexedAt: string;
    staleAfter: string;
    mode: "initial_build" | "refresh_ready";
  };
  guardrails: {
    linkedinUntouched: true;
    noPrivateContent: true;
    sensitiveInferencePolicy: "self_declared_or_needs_confirmation";
  };
}

type SocialProfile = InstagramProfileFull | ThreadsProfileFull | XProfileFull;

type EvidenceDraft = Omit<PreferenceEvidence, "id" | "signals" | "reason"> & {
  baseId: string;
  signals?: string[];
  reason?: string;
  externalLinks?: string[];
};

type KeywordSignal = {
  domain: PreferenceDomain;
  label: string;
  keywords: RegExp[];
  reason: string;
  sensitive?: boolean;
};

const PROFILE_VERSION: UserPreferenceProfile["version"] = "2026-06-17.social-preference-v1";
const RECENT_WINDOW_DAYS = 30;
const EVIDENCE_CAP = 2600;
const TOP_SIGNAL_CAP = 12;
const SIGNAL_EVIDENCE_CAP = 12;
const COLLAGE_CAP = 16;

const KEYWORD_SIGNALS: KeywordSignal[] = [
  {
    domain: "travel_stay",
    label: "seaside / beach-view places",
    keywords: [/\bsea\s*view\b/i, /\bbeach\b/i, /\bocean\b/i, /\bseaside\b/i, /\bgoa\b/i, /\bbalcony\b/i],
    reason: "Repeated sea, beach, ocean, or balcony-view language/media cues.",
  },
  {
    domain: "travel_stay",
    label: "hillside / mountain stays",
    keywords: [/\bhill(?:side)?\b/i, /\bmountain\b/i, /\bvalley\b/i, /\bhimalaya/i, /\btrek\b/i],
    reason: "Mountain, hill, valley, or trek signals appear in visible content.",
  },
  {
    domain: "travel_stay",
    label: "boutique / walkable urban stays",
    keywords: [/\bboutique\b/i, /\bwalkable\b/i, /\bcity\s*(stay|hotel|break)/i, /\bhostel\b/i, /\bairbnb\b/i],
    reason: "Stay and area language suggests compact, walkable, or boutique choices.",
  },
  {
    domain: "food_drinks",
    label: "coffee and cafes",
    keywords: [/\bcoffee\b/i, /\bcafe\b/i, /\bcappuccino\b/i, /\blatte\b/i, /\bespresso\b/i, /\bchai\b/i],
    reason: "Cafe, coffee, or tea signals recur in captions/posts/media text.",
  },
  {
    domain: "food_drinks",
    label: "restaurants and late-night dining",
    keywords: [/\bdinner\b/i, /\blunch\b/i, /\bbrunch\b/i, /\brestaurant\b/i, /\bfood\b/i, /\bmenu\b/i, /\blate[-\s]?night\b/i],
    reason: "Food, restaurant, menu, or dining-window signals are present.",
  },
  {
    domain: "food_drinks",
    label: "cocktails / social drinks",
    keywords: [/\bcocktail\b/i, /\bbar\b/i, /\bbeer\b/i, /\bwine\b/i, /\bwhisky\b/i, /\bdrink(s|ing)?\b/i],
    reason: "Visible self-posted drink or venue language appears.",
  },
  {
    domain: "colors_style",
    label: "black / blue / white minimal palette",
    keywords: [/\bblack\b/i, /\bblue\b/i, /\bwhite\b/i, /\bdark\b/i, /\bminimal\b/i, /\bclean\s*(ui|design|type|typography)?\b/i],
    reason: "Color or minimal-design language repeats in visible text or labels.",
  },
  {
    domain: "colors_style",
    label: "premium casual style",
    keywords: [/\boutfit\b/i, /\bfit check\b/i, /\bstreetwear\b/i, /\bsneakers?\b/i, /\bhoodie\b/i],
    reason: "Clothing/outfit terms suggest style preference when repeated.",
  },
  {
    domain: "brands_devices",
    label: "Apple / iPhone affinity",
    keywords: [/\biphone\b/i, /\bapple\b/i, /\bmacbook\b/i, /\bios\b/i, /\bairpods\b/i],
    reason: "Apple ecosystem or iPhone mentions appear in visible content.",
  },
  {
    domain: "brands_devices",
    label: "Google / Pixel / Android affinity",
    keywords: [/\bgoogle\b/i, /\bpixel\b/i, /\bandroid\b/i, /\bgemini\b/i],
    reason: "Google, Pixel, Android, or Gemini mentions appear in visible content.",
  },
  {
    domain: "brands_devices",
    label: "sportswear / casual fashion brands",
    keywords: [/\badidas\b/i, /\bnike\b/i, /\blevi'?s\b/i, /\bzara\b/i, /\bpuma\b/i, /\buniqlo\b/i],
    reason: "Wearable brand names appear in visible posts or OCR-style text.",
  },
  {
    domain: "work_interests",
    label: "AI, product, privacy, and startup building",
    keywords: [/\bai\b/i, /\bllm\b/i, /\bgemini\b/i, /\bproduct\b/i, /\bstartup\b/i, /\bfounder\b/i, /\bprivacy\b/i, /\bdesign\b/i],
    reason: "Professional-social content repeats product, AI, privacy, startup, or design themes.",
  },
  {
    domain: "communication_style",
    label: "direct high-energy communication",
    keywords: [/\blet'?s go\b/i, /\bship\b/i, /\bfast\b/i, /\bnow\b/i, /!{2,}/, /\bclear\b/i],
    reason: "Language shows directness, urgency, or energetic calls to action.",
  },
  {
    domain: "digital_wellbeing",
    label: "late-night activity signals",
    keywords: [/\blate night\b/i, /\b3\s?am\b/i, /\b2\s?am\b/i, /\bno sleep\b/i, /\binsomnia\b/i],
    reason: "Late-night or sleep-related language appears; this is non-diagnostic.",
  },
  {
    domain: "relationship_preferences",
    label: "relationship / attraction preferences",
    keywords: [/\bmy type\b/i, /\bideal partner\b/i, /\bcrush\b/i, /\bdate\b/i, /\bgirlfriend\b/i, /\bboyfriend\b/i],
    reason: "Only explicit self-declared relationship language is considered.",
    sensitive: true,
  },
];

function cleanText(value: unknown, max = 2200): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function firstUrl(values: Array<string | null | undefined>): string | null {
  return values.find((value) => typeof value === "string" && /^https?:\/\//i.test(value)) ?? null;
}

function evidenceId(base: string): string {
  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 16);
}

function evidenceReason(text: string, mediaUrl: string | null, platform: string): string {
  if (text && mediaUrl) return `${platform} visible text plus media context.`;
  if (text) return `${platform} visible text/caption.`;
  if (mediaUrl) return `${platform} visible media asset.`;
  return `${platform} visible profile context.`;
}

function addProfileEvidence(out: EvidenceDraft[], profile: SocialProfile) {
  const platform = profile.platform === "Instagram" ? "instagram" : profile.platform === "Threads" ? "threads" : "x";
  const username = profile.platform === "X" ? profile.username : profile.username;
  const text = [profile.displayName, profile.bio, profile.externalUrl, ...(profile.visibleProfileText ?? [])].map((item) => cleanText(item)).filter(Boolean).join(" · ");
  if (!text) return;
  out.push({
    baseId: `${platform}:profile:${username}`,
    platform,
    type: "profile",
    url: profile.profileUrl,
    text,
    mediaUrl: profile.avatarUrl ?? null,
    timestamp: profile.connectedAt ?? null,
  });
}

function addInstagramPost(out: EvidenceDraft[], post: InstagramPublicPost, index: number) {
  const text = [post.caption, post.alt, post.ariaLabel, post.visibleText].map((item) => cleanText(item)).filter(Boolean).join(" · ");
  const mediaUrl = firstUrl([post.thumbnailUrl, ...(post.cdnUrls ?? [])]);
  out.push({
    baseId: `instagram:${post.url || index}`,
    platform: "instagram",
    type: mediaUrl ? "media" : "post",
    url: post.url || null,
    text: text || null,
    mediaUrl,
    timestamp: post.timestamp ?? null,
    externalLinks: [],
  });
}

function addThreadsPost(out: EvidenceDraft[], post: ThreadsPost, index: number) {
  const text = [post.contentSeed, post.text, post.visibleText, ...(post.visibleLabels ?? [])].map((item) => cleanText(item)).filter(Boolean).join(" · ");
  const mediaUrl = firstUrl([post.feedPhotoUrl, post.thumbnailUrl, ...(post.mediaUrls ?? [])]);
  out.push({
    baseId: `threads:${post.url || index}`,
    platform: "threads",
    type: mediaUrl ? "media" : "post",
    url: post.url || null,
    text: text || null,
    mediaUrl,
    timestamp: post.timestamp ?? null,
    externalLinks: post.externalLinks ?? [],
  });
}

function addXItem(out: EvidenceDraft[], item: XTimelineItem, index: number) {
  const text = [item.text, item.visibleText, item.replyContext, ...(item.visibleLabels ?? [])].map((entry) => cleanText(entry)).filter(Boolean).join(" · ");
  const mediaUrl = firstUrl([item.primaryPhotoUrl, item.thumbnailUrl, ...(item.mediaUrls ?? [])]);
  out.push({
    baseId: `x:${item.url || item.id || index}`,
    platform: "x",
    type: item.isReply ? "reply" : mediaUrl ? "media" : "post",
    url: item.url || null,
    text: text || null,
    mediaUrl,
    timestamp: item.timestamp ?? null,
    externalLinks: item.externalLinks ?? [],
  });
}

function collectPreferenceEvidenceWithStats(params: {
  linkedinProfile?: LinkedInProfileFull | null;
  socialProfiles?: SocialProfile[];
}): { evidence: PreferenceEvidence[]; evidencePoolSize: number; droppedEvidenceCount: number } {
  const drafts: EvidenceDraft[] = [];
  for (const profile of params.socialProfiles ?? []) {
    addProfileEvidence(drafts, profile);
    if (profile.platform === "Instagram") {
      for (const [index, post] of (profile.recentPublicPosts ?? []).entries()) addInstagramPost(drafts, post, index);
    } else if (profile.platform === "Threads") {
      for (const [index, post] of (profile.recentThreads ?? []).entries()) addThreadsPost(drafts, post, index);
    } else if (profile.platform === "X") {
      for (const [index, item] of (profile.timelineItems ?? []).entries()) addXItem(drafts, item, index);
    }
  }
  const li = params.linkedinProfile;
  if (li) {
    const text = [li.headline, li.about, ...(li.skills ?? [])].map((entry) => cleanText(entry)).filter(Boolean).join(" · ");
    if (text) {
      drafts.push({
        baseId: `linkedin:${li.profileUrl || li.sub}`,
        platform: "linkedin",
        type: "profile",
        url: li.profileUrl ?? null,
        text,
        mediaUrl: li.pictureUrl ?? null,
        timestamp: null,
        reason: "LinkedIn career anchor used only for professional-interest context.",
      });
    }
  }
  const usable = drafts.filter((item) => item.text || item.mediaUrl);
  const evidence = usable.slice(0, EVIDENCE_CAP).map((item) => {
      const signals = KEYWORD_SIGNALS
        .filter((signal) => item.text && signal.keywords.some((keyword) => keyword.test(item.text as string)))
        .map((signal) => signal.label)
        .slice(0, 8);
      return {
        id: evidenceId(item.baseId),
        platform: item.platform,
        type: item.type,
        url: item.url,
        text: item.text,
        mediaUrl: item.mediaUrl,
        timestamp: item.timestamp,
        reason: item.reason || evidenceReason(item.text ?? "", item.mediaUrl, item.platform),
        signals,
      };
    });
  return {
    evidence,
    evidencePoolSize: usable.length,
    droppedEvidenceCount: Math.max(0, usable.length - evidence.length),
  };
}

export function collectPreferenceEvidence(params: {
  linkedinProfile?: LinkedInProfileFull | null;
  socialProfiles?: SocialProfile[];
}): PreferenceEvidence[] {
  return collectPreferenceEvidenceWithStats(params).evidence;
}

function signalScore(evidence: PreferenceEvidence[], signal: KeywordSignal): PreferenceSignal | null {
  const matches = evidence.filter((item) => item.text && signal.keywords.some((keyword) => keyword.test(item.text as string)));
  if (!matches.length) return null;
  const platformCount = new Set(matches.map((item) => item.platform)).size;
  const mediaCount = matches.filter((item) => item.mediaUrl).length;
  const selfDeclared = matches.some((item) => /\b(i love|i like|my favorite|favourite|need|prefer|again)\b/i.test(item.text || ""));
  const evidenceCount = matches.length;
  const rawStrength = Math.min(1, evidenceCount * 0.12 + platformCount * 0.14 + mediaCount * 0.05 + (selfDeclared ? 0.18 : 0));
  const confidence: PreferenceConfidence = signal.sensitive
    ? selfDeclared && evidenceCount >= 2
      ? "medium"
      : "low"
    : evidenceCount >= 5 || (evidenceCount >= 3 && platformCount >= 2)
      ? "high"
      : evidenceCount >= 2
        ? "medium"
        : "low";
  const needsConfirmation = signal.sensitive || confidence === "low";
  return {
    id: evidenceId(`${signal.domain}:${signal.label}`),
    domain: signal.domain,
    label: signal.label,
    confidence,
    strength: Number(rawStrength.toFixed(2)),
    source: selfDeclared ? "observed_plus_inferred" : "inferred",
    reason: signal.reason,
    evidenceIds: matches.map((item) => item.id).slice(0, SIGNAL_EVIDENCE_CAP),
    ...(needsConfirmation ? { needsConfirmation: true } : {}),
  };
}

function languageSignals(evidence: PreferenceEvidence[]): PreferenceSignal[] {
  const text = evidence.map((item) => item.text || "").join(" ");
  if (!text.trim()) return [];
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const hasHinglish = /\b(ki|hai|haan|bhai|karo|samj|nahi|acha|accha|kya|kaise|mujhe)\b/i.test(text);
  const englishTokens = (text.match(/[a-z]{3,}/gi) ?? []).length;
  const label = hasDevanagari
    ? "Hindi + English communication"
    : hasHinglish
      ? "Hinglish + English communication"
      : englishTokens > 20
        ? "English-primary communication"
        : "No reliable language signal yet";
  return [
    {
      id: evidenceId(`language:${label}`),
      domain: "language",
      label,
      confidence: label.startsWith("No reliable") ? "low" : hasHinglish || hasDevanagari ? "high" : "medium",
      strength: label.startsWith("No reliable") ? 0.15 : hasHinglish || hasDevanagari ? 0.82 : 0.58,
      source: "observed",
      reason: "Detected from the user's visible social text, not from identity assumptions.",
      evidenceIds: evidence.filter((item) => item.text).slice(0, 10).map((item) => item.id),
      ...(label.startsWith("No reliable") ? { needsConfirmation: true } : {}),
    },
  ];
}

function socialBehaviorSignals(evidence: PreferenceEvidence[], socialProfiles?: SocialProfile[]): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];
  const x = (socialProfiles ?? []).find((profile): profile is XProfileFull => profile.platform === "X");
  if (x?.timelineItems?.length) {
    const replies = x.timelineItems.filter((item) => item.isReply || item.tab === "replies").length;
    const total = x.timelineItems.length;
    if (total >= 5) {
      signals.push({
        id: evidenceId("social_behavior:x_reply_ratio"),
        domain: "social_behavior",
        label: replies / total > 0.35 ? "reply-heavy X behavior" : "post-led X behavior",
        confidence: total >= 20 ? "high" : "medium",
        strength: Number(Math.min(1, total / 80 + Math.abs(replies / total - 0.35)).toFixed(2)),
        source: "observed",
        reason: `X timeline includes ${replies} replies out of ${total} visible items.`,
        evidenceIds: evidence.filter((item) => item.platform === "x").slice(0, SIGNAL_EVIDENCE_CAP).map((item) => item.id),
      });
    }
  }
  const longForm = evidence.filter((item) => (item.text?.length ?? 0) > 240);
  if (longForm.length >= 3) {
    signals.push({
      id: evidenceId("communication_style:long_form"),
      domain: "communication_style",
      label: "long-form reflective posting",
      confidence: longForm.length >= 8 ? "high" : "medium",
      strength: Number(Math.min(1, longForm.length / 16).toFixed(2)),
      source: "observed",
      reason: "Multiple visible posts exceed short-caption length and carry developed thoughts.",
      evidenceIds: longForm.slice(0, SIGNAL_EVIDENCE_CAP).map((item) => item.id),
    });
  }
  return signals;
}

function emptyDomains(): Record<PreferenceDomain, PreferenceSignal[]> {
  return {
    travel_stay: [],
    food_drinks: [],
    colors_style: [],
    brands_devices: [],
    work_interests: [],
    language: [],
    communication_style: [],
    social_behavior: [],
    digital_wellbeing: [],
    relationship_preferences: [],
    unknowns: [],
  };
}

function buildCollage(evidence: PreferenceEvidence[], topSignals: PreferenceSignal[]): PreferenceCollageItem[] {
  const wanted = new Set(topSignals.flatMap((signal) => signal.evidenceIds));
  const ranked = [...evidence]
    .filter((item) => item.mediaUrl || wanted.has(item.id))
    .sort((a, b) => Number(Boolean(b.mediaUrl)) - Number(Boolean(a.mediaUrl)) || Number(wanted.has(b.id)) - Number(wanted.has(a.id)));
  return ranked.slice(0, COLLAGE_CAP).map((item) => ({
    evidenceId: item.id,
    platform: item.platform,
    imageUrl: item.mediaUrl,
    postUrl: item.url,
    caption: item.text ? item.text.slice(0, 180) : null,
    timestamp: item.timestamp,
    signals: item.signals.slice(0, 4),
    reason: item.reason,
  }));
}

function summaryFor(topSignals: PreferenceSignal[], evidenceCount: number): string {
  const strong = topSignals.filter((signal) => signal.confidence === "high").slice(0, 4);
  if (strong.length) {
    return `One found ${strong.map((signal) => signal.label).join(", ")} from ${evidenceCount} visible social evidence item${evidenceCount === 1 ? "" : "s"}.`;
  }
  if (topSignals.length) {
    return `One found early preference signals from ${evidenceCount} visible social evidence item${evidenceCount === 1 ? "" : "s"}.`;
  }
  return "One has not found enough visible social evidence to build strong preferences yet.";
}

function platformCounts(evidence: PreferenceEvidence[]): Record<PreferenceEvidence["platform"], number> {
  return evidence.reduce(
    (counts, item) => {
      counts[item.platform] += 1;
      return counts;
    },
    { instagram: 0, threads: 0, x: 0, linkedin: 0 },
  );
}

function domainCounts(signals: PreferenceSignal[]): Record<PreferenceDomain, number> {
  const counts = Object.fromEntries(Object.keys(emptyDomains()).map((domain) => [domain, 0])) as Record<PreferenceDomain, number>;
  return signals.reduce((out, signal) => {
    out[signal.domain] += 1;
    return out;
  }, counts);
}

function buildSelectionTracking(params: {
  evidence: PreferenceEvidence[];
  evidencePoolSize: number;
  droppedEvidenceCount: number;
  topSignals: PreferenceSignal[];
  collage: PreferenceCollageItem[];
  now: Date;
}): PreferenceSelectionTracking {
  const selectedEvidenceIds = [
    ...new Set([...params.topSignals.flatMap((signal) => signal.evidenceIds), ...params.collage.map((item) => item.evidenceId)]),
  ];
  const selectedEvidence = params.evidence.filter((item) => selectedEvidenceIds.includes(item.id));
  const counts = domainCounts(params.topSignals);
  return {
    selectedAt: params.now.toISOString(),
    evidencePoolSize: params.evidencePoolSize,
    selectedEvidenceCount: selectedEvidence.length,
    selectedEvidenceIds,
    selectedSignalCount: params.topSignals.length,
    selectedSignalIds: params.topSignals.map((signal) => signal.id),
    collageEvidenceIds: params.collage.map((item) => item.evidenceId),
    droppedEvidenceCount: params.droppedEvidenceCount,
    byPlatform: platformCounts(params.evidence),
    selectedByPlatform: platformCounts(selectedEvidence),
    byDomain: counts,
    selectionRules: {
      evidenceCap: EVIDENCE_CAP,
      topSignalCap: TOP_SIGNAL_CAP,
      signalEvidenceCap: SIGNAL_EVIDENCE_CAP,
      collageCap: COLLAGE_CAP,
      promptPostLimit: Number.isFinite(Number(process.env.SOCIAL_PROMPT_POST_LIMIT)) ? Number(process.env.SOCIAL_PROMPT_POST_LIMIT) : null,
    },
  };
}

export function buildUserPreferenceProfile(params: {
  linkedinProfile?: LinkedInProfileFull | null;
  socialProfiles?: SocialProfile[];
  now?: Date;
}): UserPreferenceProfile {
  const now = params.now ?? new Date();
  const { evidence, evidencePoolSize, droppedEvidenceCount } = collectPreferenceEvidenceWithStats(params);
  const keywordSignals = KEYWORD_SIGNALS
    .map((signal) => signalScore(evidence, signal))
    .filter((signal): signal is PreferenceSignal => Boolean(signal));
  const allSignals = [...keywordSignals, ...languageSignals(evidence), ...socialBehaviorSignals(evidence, params.socialProfiles)];
  const domains = emptyDomains();
  for (const signal of allSignals.sort((a, b) => b.strength - a.strength)) {
    domains[signal.domain].push(signal);
  }
  for (const domain of Object.keys(domains) as PreferenceDomain[]) {
    domains[domain] = domains[domain].slice(0, 6);
  }
  const topSignals = allSignals
    .filter((signal) => signal.domain !== "unknowns")
    .sort((a, b) => b.strength - a.strength)
    .slice(0, TOP_SIGNAL_CAP);
  const platforms = [...new Set(evidence.map((item) => item.platform).filter((platform) => platform !== "linkedin"))];
  const mediaAssets = evidence.filter((item) => item.mediaUrl).length;
  const externalLinks = (params.socialProfiles ?? []).reduce((sum, profile) => {
    if (profile.platform === "Instagram") return sum;
    if (profile.platform === "Threads") return sum + (profile.recentThreads ?? []).reduce((n, post) => n + (post.externalLinks?.length ?? 0), 0);
    return sum + (profile.timelineItems ?? []).reduce((n, item) => n + (item.externalLinks?.length ?? 0), 0);
  }, 0);
  const staleAfter = new Date(now.getTime() + 1000 * 60 * 60 * 24);
  const collage = buildCollage(evidence, topSignals);
  const selection = buildSelectionTracking({ evidence, evidencePoolSize, droppedEvidenceCount, topSignals, collage, now });
  return {
    version: PROFILE_VERSION,
    status: "completed",
    generatedAt: now.toISOString(),
    updatedFrom: {
      platforms,
      indexedItems: evidence.filter((item) => item.platform !== "linkedin").length,
      mediaAssets,
      ocrSignals: 0,
      externalLinks,
      recentWindowDays: RECENT_WINDOW_DAYS,
    },
    summary: summaryFor(topSignals, evidence.length),
    topSignals,
    domains,
    evidence,
    collage,
    selection,
    refresh: {
      lastIndexedAt: now.toISOString(),
      staleAfter: staleAfter.toISOString(),
      mode: "refresh_ready",
    },
    guardrails: {
      linkedinUntouched: true,
      noPrivateContent: true,
      sensitiveInferencePolicy: "self_declared_or_needs_confirmation",
    },
  };
}
