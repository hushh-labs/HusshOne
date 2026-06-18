import crypto from "node:crypto";
import type { InstagramProfileFull, InstagramPublicPost } from "@/lib/instagram/profile";
import type { ThreadsPost, ThreadsProfileFull } from "@/lib/threads/profile";
import type { XProfileFull, XTimelineItem } from "@/lib/x/profile";
import type { LinkedInProfileFull } from "@/lib/linkedin/profile";

export const PROFILE_VERSION = "2026-06-18.social-preference-questions-v2" as const;
export const QUESTION_REGISTRY_VERSION = "2026-06-18.preference-30q-v1" as const;

export type PreferenceConfidence = "low" | "medium" | "high";
export type PreferenceSource = "observed" | "inferred" | "observed_plus_inferred" | "self_declared";
export type PreferenceAnswerStatus = "answered" | "inferred" | "needs_confirmation" | "unknown" | "blocked_by_access";

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

export type PreferenceQuestionSectionId =
  | "style_brands_color"
  | "travel_wanderlust"
  | "food_culinary"
  | "partner_romance"
  | "deep_likes_dislikes"
  | "mental_models";

export interface PreferenceQuestionDefinition {
  id: string;
  sectionId: PreferenceQuestionSectionId;
  sectionTitle: string;
  category: PreferenceDomain;
  prompt: string;
  sensitive?: boolean;
}

export interface PreferenceQuestionAnswer {
  questionId: string;
  sectionId: PreferenceQuestionSectionId;
  sectionTitle: string;
  category: PreferenceDomain;
  prompt: string;
  status: PreferenceAnswerStatus;
  answer: string | null;
  normalizedValue?: string | string[] | number | null;
  confidence: {
    score: number;
    level: PreferenceConfidence;
    rationale: string;
  };
  sourceMode: "self_declared" | "observed" | "inferred" | "aggregate" | "not_available";
  evidenceIds: string[];
  unknownReason?: "no_evidence" | "insufficient_sample" | "ambiguous" | "private_or_protected" | "unsafe_to_infer";
  needsUserConfirmation: boolean;
  updatedFrom: "fast_text_pass" | "media_pass";
}

export interface PreferenceQuestionCoverage {
  total: number;
  answered: number;
  inferred: number;
  needsConfirmation: number;
  unknown: number;
  blockedByAccess: number;
  bySection: Record<PreferenceQuestionSectionId, {
    total: number;
    answered: number;
    inferred: number;
    needsConfirmation: number;
    unknown: number;
    blockedByAccess: number;
  }>;
}

export interface PreferenceSectionSummary {
  sectionId: PreferenceQuestionSectionId;
  title: string;
  summary: string;
  answeredCount: number;
  totalCount: number;
  confidence: PreferenceConfidence;
}

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
  version: typeof PROFILE_VERSION;
  status: "completed";
  generatedAt: string;
  questionRegistryVersion: typeof QUESTION_REGISTRY_VERSION;
  questionAnswers: PreferenceQuestionAnswer[];
  questionCoverage: PreferenceQuestionCoverage;
  sectionSummaries: PreferenceSectionSummary[];
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
  mediaIntelligence: {
    status: "pending" | "completed" | "not_configured";
    provider: "vertex_gemini_cloud_vision";
    queuedAssets: number;
    note: string;
  };
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

const RECENT_WINDOW_DAYS = 30;
const EVIDENCE_CAP = 2600;
const TOP_SIGNAL_CAP = 12;
const SIGNAL_EVIDENCE_CAP = 12;
const COLLAGE_CAP = 16;

export const PREFERENCE_QUESTIONS: PreferenceQuestionDefinition[] = [
  {
    id: "style_brands_three",
    sectionId: "style_brands_color",
    sectionTitle: "Style, Brands & Color",
    category: "brands_devices",
    prompt: "If you had to wear only three clothing brands for the rest of your life, which ones would you choose and why?",
  },
  {
    id: "style_power_color",
    sectionId: "style_brands_color",
    sectionTitle: "Style, Brands & Color",
    category: "colors_style",
    prompt: "What is your Power Color?",
  },
  {
    id: "style_logo_visibility",
    sectionId: "style_brands_color",
    sectionTitle: "Style, Brands & Color",
    category: "colors_style",
    prompt: "When you splurge, do you prefer visible logos or quiet luxury?",
  },
  {
    id: "style_disliked_pattern",
    sectionId: "style_brands_color",
    sectionTitle: "Style, Brands & Color",
    category: "colors_style",
    prompt: "Is there a color or design pattern you cannot stand?",
  },
  {
    id: "style_made_for_me_brand",
    sectionId: "style_brands_color",
    sectionTitle: "Style, Brands & Color",
    category: "brands_devices",
    prompt: "Name one brand whose aesthetic feels made for you.",
  },
  {
    id: "travel_perfect_escape",
    sectionId: "travel_wanderlust",
    sectionTitle: "Travel & Wanderlust",
    category: "travel_stay",
    prompt: "What does your perfect escape look like?",
  },
  {
    id: "travel_unlimited_destination",
    sectionId: "travel_wanderlust",
    sectionTitle: "Travel & Wanderlust",
    category: "travel_stay",
    prompt: "With unlimited flight and hotel budget, where are you flying tomorrow and what do you do first?",
  },
  {
    id: "travel_dealbreaker",
    sectionId: "travel_wanderlust",
    sectionTitle: "Travel & Wanderlust",
    category: "travel_stay",
    prompt: "What is your biggest travel dealbreaker?",
  },
  {
    id: "travel_itinerary_style",
    sectionId: "travel_wanderlust",
    sectionTitle: "Travel & Wanderlust",
    category: "travel_stay",
    prompt: "Are you a strict itinerary traveler or a figure-it-out traveler?",
  },
  {
    id: "travel_luxury_vs_local",
    sectionId: "travel_wanderlust",
    sectionTitle: "Travel & Wanderlust",
    category: "travel_stay",
    prompt: "When you travel, what matters more: luxury or authentic local experience?",
  },
  {
    id: "food_death_row_meal",
    sectionId: "food_culinary",
    sectionTitle: "Food & Culinary",
    category: "food_drinks",
    prompt: "What is your ultimate full-menu comfort meal?",
  },
  {
    id: "food_late_night",
    sectionId: "food_culinary",
    sectionTitle: "Food & Culinary",
    category: "food_drinks",
    prompt: "At 2 AM, do you order something specific or cook something yourself?",
  },
  {
    id: "food_ambience_vs_taste",
    sectionId: "food_culinary",
    sectionTitle: "Food & Culinary",
    category: "food_drinks",
    prompt: "When dining out, does ambience matter more or taste?",
  },
  {
    id: "food_overrated_dish",
    sectionId: "food_culinary",
    sectionTitle: "Food & Culinary",
    category: "food_drinks",
    prompt: "What famous dish do you think is overrated?",
  },
  {
    id: "food_first_date",
    sectionId: "food_culinary",
    sectionTitle: "Food & Culinary",
    category: "food_drinks",
    prompt: "For a first date, would you pick fine dining or a cozy cafe plus street food?",
  },
  {
    id: "romance_non_negotiables",
    sectionId: "partner_romance",
    sectionTitle: "Partner & Romance",
    category: "relationship_preferences",
    prompt: "What are your top three non-negotiable qualities in a partner?",
    sensitive: true,
  },
  {
    id: "romance_attractive_trait",
    sectionId: "partner_romance",
    sectionTitle: "Partner & Romance",
    category: "relationship_preferences",
    prompt: "What subtle habit or personality trait do you find instantly attractive?",
    sensitive: true,
  },
  {
    id: "romance_red_flag",
    sectionId: "partner_romance",
    sectionTitle: "Partner & Romance",
    category: "relationship_preferences",
    prompt: "What is your biggest red flag?",
    sensitive: true,
  },
  {
    id: "romance_love_language",
    sectionId: "partner_romance",
    sectionTitle: "Partner & Romance",
    category: "relationship_preferences",
    prompt: "How do you naturally express love?",
    sensitive: true,
  },
  {
    id: "romance_weekend",
    sectionId: "partner_romance",
    sectionTitle: "Partner & Romance",
    category: "relationship_preferences",
    prompt: "What is your perfect romantic weekend?",
    sensitive: true,
  },
  {
    id: "daily_pet_peeve",
    sectionId: "deep_likes_dislikes",
    sectionTitle: "Deep Likes & Dislikes",
    category: "communication_style",
    prompt: "What is your biggest daily-life pet peeve?",
  },
  {
    id: "daily_recharge_style",
    sectionId: "deep_likes_dislikes",
    sectionTitle: "Deep Likes & Dislikes",
    category: "social_behavior",
    prompt: "How do you recharge in free time: alone or surrounded by friends?",
  },
  {
    id: "daily_morning_first",
    sectionId: "deep_likes_dislikes",
    sectionTitle: "Deep Likes & Dislikes",
    category: "digital_wellbeing",
    prompt: "What is the first thing you do when you wake up?",
  },
  {
    id: "daily_social_gathering",
    sectionId: "deep_likes_dislikes",
    sectionTitle: "Deep Likes & Dislikes",
    category: "social_behavior",
    prompt: "At a large gathering, are you center-stage or observing with one good friend?",
  },
  {
    id: "daily_cringe_trend",
    sectionId: "deep_likes_dislikes",
    sectionTitle: "Deep Likes & Dislikes",
    category: "communication_style",
    prompt: "What current trend makes you cringe?",
  },
  {
    id: "mental_big_purchase",
    sectionId: "mental_models",
    sectionTitle: "Mental Models & Decision Making",
    category: "brands_devices",
    prompt: "For a big purchase, do you read reviews deeply or buy what catches your eye?",
  },
  {
    id: "mental_satisfaction",
    sectionId: "mental_models",
    sectionTitle: "Mental Models & Decision Making",
    category: "work_interests",
    prompt: "What gives you most satisfaction right now: money, respect, freedom, or creative expression?",
  },
  {
    id: "mental_music",
    sectionId: "mental_models",
    sectionTitle: "Mental Models & Decision Making",
    category: "social_behavior",
    prompt: "What is your go-to music genre or song for this life phase?",
  },
  {
    id: "mental_friend_group_role",
    sectionId: "mental_models",
    sectionTitle: "Mental Models & Decision Making",
    category: "social_behavior",
    prompt: "Who are you in your friend group?",
  },
  {
    id: "mental_misconception",
    sectionId: "mental_models",
    sectionTitle: "Mental Models & Decision Making",
    category: "communication_style",
    prompt: "What is the biggest misconception people have about you?",
  },
];

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

type TermPattern = { label: string; value: string; patterns: RegExp[] };

const BRAND_TERMS: TermPattern[] = [
  { label: "Apple / iPhone", value: "apple", patterns: [/\bapple\b/i, /\biphone\b/i, /\bmacbook\b/i, /\bairpods?\b/i, /\bios\b/i] },
  { label: "Google / Pixel", value: "google", patterns: [/\bgoogle\b/i, /\bpixel\b/i, /\bandroid\b/i, /\bgemini\b/i] },
  { label: "Nike", value: "nike", patterns: [/\bnike\b/i, /\bair\s*jordan\b/i] },
  { label: "Adidas", value: "adidas", patterns: [/\badidas\b/i, /\bsambas?\b/i] },
  { label: "Levi's", value: "levis", patterns: [/\blevi'?s\b/i] },
  { label: "Zara", value: "zara", patterns: [/\bzara\b/i] },
  { label: "Uniqlo", value: "uniqlo", patterns: [/\buniqlo\b/i] },
  { label: "Puma", value: "puma", patterns: [/\bpuma\b/i] },
];

const COLOR_TERMS: TermPattern[] = [
  { label: "black", value: "black", patterns: [/\bblack\b/i, /\bdark\b/i, /\bmonochrome\b/i] },
  { label: "blue", value: "blue", patterns: [/\bblue\b/i, /\bnavy\b/i] },
  { label: "white", value: "white", patterns: [/\bwhite\b/i, /\bclean\b/i] },
  { label: "green", value: "green", patterns: [/\bgreen\b/i] },
  { label: "red", value: "red", patterns: [/\bred\b/i] },
  { label: "pink", value: "pink", patterns: [/\bpink\b/i] },
  { label: "beige", value: "beige", patterns: [/\bbeige\b/i, /\bcream\b/i, /\bsand\b/i] },
  { label: "purple", value: "purple", patterns: [/\bpurple\b/i, /\blavender\b/i] },
];

const FOOD_TERMS: TermPattern[] = [
  { label: "coffee/cafe", value: "coffee", patterns: [/\bcoffee\b/i, /\bcafe\b/i, /\blatte\b/i, /\bespresso\b/i, /\bcappuccino\b/i] },
  { label: "chai", value: "chai", patterns: [/\bchai\b/i, /\btea\b/i] },
  { label: "street food", value: "street_food", patterns: [/\bstreet\s*food\b/i, /\bchaat\b/i, /\bvada\s*pav\b/i, /\bmomos?\b/i] },
  { label: "pizza", value: "pizza", patterns: [/\bpizza\b/i] },
  { label: "fine dining", value: "fine_dining", patterns: [/\bfine[-\s]?dining\b/i, /\bchef'?s?\s*table\b/i, /\bMichelin\b/i] },
  { label: "cocktails/drinks", value: "drinks", patterns: [/\bcocktails?\b/i, /\bbar\b/i, /\bwine\b/i, /\bbeer\b/i, /\bwhisky\b/i, /\bdrinks?\b/i] },
];

const TRAVEL_TERMS: TermPattern[] = [
  { label: "beach / sea view", value: "beach", patterns: [/\bbeach\b/i, /\bsea\s*view\b/i, /\bocean\b/i, /\bseaside\b/i, /\bgoa\b/i] },
  { label: "mountains / hills", value: "mountains", patterns: [/\bmountains?\b/i, /\bhills?\b/i, /\bvalley\b/i, /\bhimalaya/i, /\btrek\b/i] },
  { label: "foreign city wandering", value: "city", patterns: [/\bcity\b/i, /\bwalkable\b/i, /\bwander(?:ing)?\b/i, /\bstreets?\b/i, /\bforeign\b/i] },
  { label: "luxury resort", value: "luxury", patterns: [/\bluxury\b/i, /\bresort\b/i, /\b5[-\s]?star\b/i, /\bprivate\s*cab\b/i] },
  { label: "authentic local travel", value: "local", patterns: [/\blocal\b/i, /\bauthentic\b/i, /\bhomestay\b/i, /\bstreet\s*food\b/i, /\bwalking\b/i] },
];

const SELF_DECLARED_RE = /\b(i|i'm|i am|my|me|we|we're|we are)\b/i;

function evidenceText(item: PreferenceEvidence): string {
  return [item.text, item.reason, item.signals.join(" ")].filter(Boolean).join(" · ");
}

function matchEvidence(
  evidence: PreferenceEvidence[],
  patterns: RegExp[],
  options: { requireSelfDeclared?: boolean; excludeLinkedIn?: boolean } = {},
): PreferenceEvidence[] {
  return evidence.filter((item) => {
    if (options.excludeLinkedIn && item.platform === "linkedin") return false;
    const text = evidenceText(item);
    if (!text) return false;
    if (options.requireSelfDeclared && !SELF_DECLARED_RE.test(text)) return false;
    return patterns.some((pattern) => pattern.test(text));
  });
}

function rankedTerms(evidence: PreferenceEvidence[], terms: TermPattern[], options: { excludeLinkedIn?: boolean } = {}) {
  return terms
    .map((term) => {
      const matches = matchEvidence(evidence, term.patterns, options);
      const platforms = new Set(matches.map((item) => item.platform));
      const selfDeclared = matches.some((item) => SELF_DECLARED_RE.test(evidenceText(item)));
      return { ...term, matches, platforms, selfDeclared, count: matches.length };
    })
    .filter((term) => term.count > 0)
    .sort((a, b) => b.count - a.count || b.platforms.size - a.platforms.size);
}

function confidenceFrom(matches: PreferenceEvidence[], selfDeclared = false): { score: number; level: PreferenceConfidence; rationale: string } {
  const platforms = new Set(matches.map((item) => item.platform)).size;
  const media = matches.filter((item) => item.mediaUrl).length;
  const score = Math.min(0.94, matches.length * 0.12 + platforms * 0.16 + media * 0.05 + (selfDeclared ? 0.22 : 0.02));
  const level: PreferenceConfidence = score >= 0.72 ? "high" : score >= 0.42 ? "medium" : "low";
  return {
    score: Number(score.toFixed(2)),
    level,
    rationale: `${matches.length} visible evidence item${matches.length === 1 ? "" : "s"} across ${platforms || 1} platform${platforms === 1 ? "" : "s"}${selfDeclared ? ", including self-declared language" : ""}.`,
  };
}

function unknownAnswer(question: PreferenceQuestionDefinition, reason: PreferenceQuestionAnswer["unknownReason"] = "no_evidence"): PreferenceQuestionAnswer {
  return {
    questionId: question.id,
    sectionId: question.sectionId,
    sectionTitle: question.sectionTitle,
    category: question.category,
    prompt: question.prompt,
    status: question.sensitive ? "needs_confirmation" : "unknown",
    answer: null,
    normalizedValue: null,
    confidence: {
      score: 0,
      level: "low",
      rationale: question.sensitive
        ? "Sensitive preference: One needs explicit self-declared evidence or the user's confirmation."
        : "No reliable visible evidence found yet.",
    },
    sourceMode: "not_available",
    evidenceIds: [],
    unknownReason: question.sensitive ? "unsafe_to_infer" : reason,
    needsUserConfirmation: true,
    updatedFrom: "fast_text_pass",
  };
}

function makeAnswer(params: {
  question: PreferenceQuestionDefinition;
  status: Exclude<PreferenceAnswerStatus, "unknown" | "blocked_by_access">;
  answer: string;
  normalizedValue?: string | string[] | number | null;
  matches: PreferenceEvidence[];
  sourceMode: PreferenceQuestionAnswer["sourceMode"];
  selfDeclared?: boolean;
  needsUserConfirmation?: boolean;
}): PreferenceQuestionAnswer {
  const confidence = confidenceFrom(params.matches, params.selfDeclared);
  const needsUserConfirmation =
    params.needsUserConfirmation ?? (params.question.sensitive || params.status === "needs_confirmation" || confidence.level === "low");
  return {
    questionId: params.question.id,
    sectionId: params.question.sectionId,
    sectionTitle: params.question.sectionTitle,
    category: params.question.category,
    prompt: params.question.prompt,
    status: needsUserConfirmation ? "needs_confirmation" : params.status,
    answer: params.answer,
    normalizedValue: params.normalizedValue ?? null,
    confidence,
    sourceMode: params.sourceMode,
    evidenceIds: params.matches.map((item) => item.id).slice(0, SIGNAL_EVIDENCE_CAP),
    needsUserConfirmation,
    updatedFrom: "fast_text_pass",
  };
}

function textSnippet(matches: PreferenceEvidence[], fallback: string): string {
  const text = matches.map((item) => cleanText(item.text, 180)).find(Boolean);
  return text ? `"${text}"` : fallback;
}

function simpleQuestionAnswer(question: PreferenceQuestionDefinition, evidence: PreferenceEvidence[]): PreferenceQuestionAnswer {
  const brandTerms = rankedTerms(evidence, BRAND_TERMS, { excludeLinkedIn: true });
  const colorTerms = rankedTerms(evidence, COLOR_TERMS, { excludeLinkedIn: true });
  const foodTerms = rankedTerms(evidence, FOOD_TERMS, { excludeLinkedIn: true });
  const travelTerms = rankedTerms(evidence, TRAVEL_TERMS, { excludeLinkedIn: true });
  const allTextEvidence = evidence.filter((item) => item.text);

  switch (question.id) {
    case "style_brands_three": {
      if (!brandTerms.length) return unknownAnswer(question);
      const top = brandTerms.slice(0, 3);
      return makeAnswer({
        question,
        status: "inferred",
        answer: `Likely brand/device affinities: ${top.map((term) => term.label).join(", ")}. This is observed from social mentions, not a direct wardrobe declaration.`,
        normalizedValue: top.map((term) => term.value),
        matches: top.flatMap((term) => term.matches),
        sourceMode: "aggregate",
        selfDeclared: top.some((term) => term.selfDeclared),
        needsUserConfirmation: true,
      });
    }
    case "style_power_color": {
      if (!colorTerms.length) return unknownAnswer(question);
      const top = colorTerms.slice(0, 3);
      return makeAnswer({
        question,
        status: "inferred",
        answer: `Visible color/style cues lean toward ${top.map((term) => term.label).join(", ")}.`,
        normalizedValue: top.map((term) => term.value),
        matches: top.flatMap((term) => term.matches),
        sourceMode: "aggregate",
        selfDeclared: top.some((term) => term.selfDeclared),
      });
    }
    case "style_logo_visibility": {
      const quiet = matchEvidence(evidence, [/\bquiet\s*luxury\b/i, /\bminimal\b/i, /\bclean\b/i, /\bsubtle\b/i, /\bno\s*logo\b/i], { excludeLinkedIn: true });
      const loud = matchEvidence(evidence, [/\bbig\s*logo\b/i, /\bshow\s*off\b/i, /\blogo\b/i, /\bbranded\b/i], { excludeLinkedIn: true });
      const matches = quiet.length >= loud.length ? quiet : loud;
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({
        question,
        status: "inferred",
        answer: quiet.length >= loud.length ? "Leans toward minimal or quiet-luxury presentation." : "Shows some interest in visible branding/logos.",
        normalizedValue: quiet.length >= loud.length ? "quiet_luxury" : "visible_logo",
        matches,
        sourceMode: "inferred",
        needsUserConfirmation: true,
      });
    }
    case "style_disliked_pattern": {
      const matches = matchEvidence(evidence, [/\b(hate|can't stand|cannot stand|dislike|avoid)\b.{0,50}\b(color|pattern|design|print|logo)\b/i], { requireSelfDeclared: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "answered", answer: textSnippet(matches, "Explicit dislike found in visible content."), matches, sourceMode: "self_declared", selfDeclared: true });
    }
    case "style_made_for_me_brand": {
      const explicit = matchEvidence(evidence, [/\b(made for me|my brand|favorite brand|favourite brand|love)\b.{0,40}\b(apple|google|nike|adidas|zara|uniqlo|levi'?s|puma)\b/i], { requireSelfDeclared: true });
      if (explicit.length) return makeAnswer({ question, status: "answered", answer: textSnippet(explicit, "Explicit brand affinity found."), matches: explicit, sourceMode: "self_declared", selfDeclared: true });
      if (!brandTerms.length) return unknownAnswer(question);
      return makeAnswer({
        question,
        status: "needs_confirmation",
        answer: `${brandTerms[0].label} is the strongest visible brand signal, but it needs confirmation before calling it made-for-me.`,
        normalizedValue: brandTerms[0].value,
        matches: brandTerms[0].matches,
        sourceMode: "inferred",
        needsUserConfirmation: true,
      });
    }
    case "travel_perfect_escape": {
      if (!travelTerms.length) return unknownAnswer(question);
      const top = travelTerms[0];
      const map: Record<string, string> = {
        beach: "a beach or sea-view escape",
        mountains: "a mountain/hillside reset",
        city: "wandering a city on foot",
        luxury: "a comfort-led resort stay",
        local: "an authentic local trip",
      };
      return makeAnswer({ question, status: "inferred", answer: `Best current read: ${map[top.value] || top.label}.`, normalizedValue: top.value, matches: top.matches, sourceMode: "aggregate", selfDeclared: top.selfDeclared });
    }
    case "travel_unlimited_destination": {
      const matches = matchEvidence(evidence, [/\b(fly|travel|go|visit|trip|vacation)\b.{0,80}\b(goa|paris|tokyo|london|bali|dubai|new york|himalaya|maldives|beach|mountain)\b/i], { excludeLinkedIn: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "needs_confirmation", answer: textSnippet(matches, "A destination-style travel cue appears, but the exact unlimited-budget answer needs confirmation."), matches, sourceMode: "observed", needsUserConfirmation: true });
    }
    case "travel_dealbreaker": {
      const matches = matchEvidence(evidence, [/\b(hate|avoid|dealbreaker|pet peeve|can't stand)\b.{0,60}\b(crowd|dirty|washroom|delay|traffic|strict schedule|queue|transit)\b/i], { requireSelfDeclared: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "answered", answer: textSnippet(matches, "Explicit travel dealbreaker found."), matches, sourceMode: "self_declared", selfDeclared: true });
    }
    case "travel_itinerary_style": {
      const planned = matchEvidence(evidence, [/\bitinerary\b/i, /\bplanned\b/i, /\bschedule\b/i, /\bplanner\b/i], { excludeLinkedIn: true });
      const spontaneous = matchEvidence(evidence, [/\bspontaneous\b/i, /\bfigure it out\b/i, /\bwander\b/i, /\bno plan\b/i], { excludeLinkedIn: true });
      const matches = planned.length >= spontaneous.length ? planned : spontaneous;
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "inferred", answer: planned.length >= spontaneous.length ? "Leans more planned/itinerary-aware." : "Leans spontaneous and exploratory.", normalizedValue: planned.length >= spontaneous.length ? "planned" : "spontaneous", matches, sourceMode: "inferred", needsUserConfirmation: matches.length < 2 });
    }
    case "travel_luxury_vs_local": {
      const luxury = travelTerms.find((term) => term.value === "luxury");
      const local = travelTerms.find((term) => term.value === "local");
      const winner = (local?.count ?? 0) >= (luxury?.count ?? 0) ? local : luxury;
      if (!winner) return unknownAnswer(question);
      return makeAnswer({ question, status: "inferred", answer: winner.value === "local" ? "Leans toward authentic/local experience." : "Leans toward comfort/luxury travel.", normalizedValue: winner.value, matches: winner.matches, sourceMode: "aggregate", selfDeclared: winner.selfDeclared });
    }
    case "food_death_row_meal": {
      const explicit = matchEvidence(evidence, [/\b(death row meal|last meal|favorite meal|favourite meal|comfort meal)\b/i], { requireSelfDeclared: true });
      if (explicit.length) return makeAnswer({ question, status: "answered", answer: textSnippet(explicit, "Explicit meal preference found."), matches: explicit, sourceMode: "self_declared", selfDeclared: true });
      if (!foodTerms.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "needs_confirmation", answer: `Food signals include ${foodTerms.slice(0, 3).map((term) => term.label).join(", ")}, but not a full death-row menu.`, normalizedValue: foodTerms.slice(0, 3).map((term) => term.value), matches: foodTerms.flatMap((term) => term.matches), sourceMode: "aggregate", needsUserConfirmation: true });
    }
    case "food_late_night": {
      const matches = matchEvidence(evidence, [/\b(2\s?am|3\s?am|late[-\s]?night|midnight)\b.{0,80}\b(food|order|cook|kitchen|pizza|coffee|chai)\b/i], { excludeLinkedIn: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "inferred", answer: textSnippet(matches, "Late-night food cue found."), matches, sourceMode: "observed", needsUserConfirmation: true });
    }
    case "food_ambience_vs_taste": {
      const ambience = matchEvidence(evidence, [/\baesthetic\b/i, /\bambien[ct]e\b/i, /\bcafe\b/i, /\bfine[-\s]?dining\b/i], { excludeLinkedIn: true });
      const taste = matchEvidence(evidence, [/\bstreet\s*food\b/i, /\btaste\b/i, /\bflavour\b/i, /\bvendor\b/i], { excludeLinkedIn: true });
      const matches = ambience.length >= taste.length ? ambience : taste;
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "inferred", answer: ambience.length >= taste.length ? "Ambience/aesthetic places show up more clearly." : "Taste/local food cues show up more clearly.", normalizedValue: ambience.length >= taste.length ? "ambience" : "taste", matches, sourceMode: "aggregate", needsUserConfirmation: true });
    }
    case "food_overrated_dish": {
      const matches = matchEvidence(evidence, [/\b(overrated|not worth it|don't like|hate)\b.{0,60}\b(food|dish|pizza|burger|sushi|biryani|pasta|coffee)\b/i], { requireSelfDeclared: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "answered", answer: textSnippet(matches, "Explicit overrated-dish opinion found."), matches, sourceMode: "self_declared", selfDeclared: true });
    }
    case "food_first_date": {
      const explicit = matchEvidence(evidence, [/\b(date|first date)\b.{0,80}\b(cafe|street food|fine[-\s]?dining|dinner|long drive)\b/i], { requireSelfDeclared: true });
      if (explicit.length) return makeAnswer({ question, status: "answered", answer: textSnippet(explicit, "Explicit date preference found."), matches: explicit, sourceMode: "self_declared", selfDeclared: true });
      if (!foodTerms.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "needs_confirmation", answer: `Visible food/venue cues suggest ${foodTerms[0].label}, but first-date preference needs confirmation.`, normalizedValue: foodTerms[0].value, matches: foodTerms[0].matches, sourceMode: "inferred", needsUserConfirmation: true });
    }
    case "daily_pet_peeve": {
      const matches = matchEvidence(evidence, [/\b(pet peeve|annoying|irritates?|hate|can't stand)\b/i], { requireSelfDeclared: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "answered", answer: textSnippet(matches, "Explicit pet peeve found."), matches, sourceMode: "self_declared", selfDeclared: true });
    }
    case "daily_recharge_style": {
      const solo = matchEvidence(evidence, [/\balone\b/i, /\bsolo\b/i, /\bquiet\b/i, /\brecharge\b/i, /\breset\b/i], { excludeLinkedIn: true });
      const social = matchEvidence(evidence, [/\bfriends?\b/i, /\bparty\b/i, /\bsocial\b/i, /\bmeetup\b/i, /\bhigh energy\b/i], { excludeLinkedIn: true });
      const matches = solo.length >= social.length ? solo : social;
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "inferred", answer: solo.length >= social.length ? "Visible cues lean toward quiet/solo reset." : "Visible cues lean toward social/high-energy recharge.", normalizedValue: solo.length >= social.length ? "solo" : "social", matches, sourceMode: "aggregate", needsUserConfirmation: true });
    }
    case "daily_morning_first": {
      const matches = matchEvidence(evidence, [/\bmorning\b.{0,80}\b(phone|coffee|chai|water|snooze|run|gym|meditat)\b/i], { requireSelfDeclared: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "answered", answer: textSnippet(matches, "Explicit morning routine found."), matches, sourceMode: "self_declared", selfDeclared: true });
    }
    case "daily_social_gathering": {
      const observe = matchEvidence(evidence, [/\bobserv(?:e|ing|er)\b/i, /\bcorner\b/i, /\bone good friend\b/i, /\bsilent\b/i], { excludeLinkedIn: true });
      const center = matchEvidence(evidence, [/\bdance floor\b/i, /\bcenter of attention\b/i, /\bhost\b/i, /\bparty\b/i], { excludeLinkedIn: true });
      const matches = observe.length >= center.length ? observe : center;
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "inferred", answer: observe.length >= center.length ? "Leans observer/one-close-friend in big gatherings." : "Leans more visible/high-energy in gatherings.", normalizedValue: observe.length >= center.length ? "observer" : "center_stage", matches, sourceMode: "inferred", needsUserConfirmation: true });
    }
    case "daily_cringe_trend": {
      const matches = matchEvidence(evidence, [/\b(cringe|trend|overrated|npc|ick)\b/i], { requireSelfDeclared: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "answered", answer: textSnippet(matches, "Explicit trend dislike found."), matches, sourceMode: "self_declared", selfDeclared: true });
    }
    case "mental_big_purchase": {
      const research = matchEvidence(evidence, [/\breviews?\b/i, /\bresearch\b/i, /\bcompare\b/i, /\bspecs?\b/i], { excludeLinkedIn: true });
      const impulse = matchEvidence(evidence, [/\bimpulse\b/i, /\bjust bought\b/i, /\binstantly bought\b/i], { excludeLinkedIn: true });
      const matches = research.length >= impulse.length ? research : impulse;
      if (!matches.length && !brandTerms.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "inferred", answer: research.length >= impulse.length ? "Leans research/review-driven for big purchases." : "Some impulse-purchase language appears.", normalizedValue: research.length >= impulse.length ? "research_driven" : "impulse_led", matches: matches.length ? matches : brandTerms.flatMap((term) => term.matches), sourceMode: "inferred", needsUserConfirmation: true });
    }
    case "mental_satisfaction": {
      const matches = matchEvidence(evidence, [/\b(freedom|creative expression|respect|money|impact|build|ship|founder|product)\b/i]);
      if (!matches.length) return unknownAnswer(question);
      const text = matches.map(evidenceText).join(" ");
      const normalized = /\bcreative|design\b/i.test(text) ? "creative_expression" : /\bfreedom\b/i.test(text) ? "freedom" : /\brespect\b/i.test(text) ? "respect" : /\bmoney\b/i.test(text) ? "money" : "building_impact";
      return makeAnswer({ question, status: "inferred", answer: `Visible work/life language points most toward ${normalized.replace(/_/g, " ")}.`, normalizedValue: normalized, matches, sourceMode: "aggregate", needsUserConfirmation: true });
    }
    case "mental_music": {
      const matches = matchEvidence(evidence, [/\bmusic\b/i, /\bsong\b/i, /\bplaylist\b/i, /\bhip[-\s]?hop\b/i, /\bbollywood\b/i, /\blofi\b/i, /\brock\b/i, /\bpop\b/i], { excludeLinkedIn: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "needs_confirmation", answer: textSnippet(matches, "Music signal found, but current life-phase song needs confirmation."), matches, sourceMode: "observed", needsUserConfirmation: true });
    }
    case "mental_friend_group_role": {
      const matches = matchEvidence(evidence, [/\b(planner|comedian|therapist|silent observer|organizer|listener)\b/i], { requireSelfDeclared: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "answered", answer: textSnippet(matches, "Explicit friend-group role found."), matches, sourceMode: "self_declared", selfDeclared: true });
    }
    case "mental_misconception": {
      const matches = matchEvidence(evidence, [/\b(misconception|people think|actually wrong|they think)\b/i], { requireSelfDeclared: true });
      if (!matches.length) return unknownAnswer(question);
      return makeAnswer({ question, status: "answered", answer: textSnippet(matches, "Explicit misconception statement found."), matches, sourceMode: "self_declared", selfDeclared: true });
    }
    default:
      if (question.sensitive) {
        const explicit = matchEvidence(allTextEvidence, [new RegExp(question.id.split("_").slice(1).join("|"), "i")], { requireSelfDeclared: true });
        return explicit.length
          ? makeAnswer({ question, status: "answered", answer: textSnippet(explicit, "Explicit sensitive preference found."), matches: explicit, sourceMode: "self_declared", selfDeclared: true })
          : unknownAnswer(question, "unsafe_to_infer");
      }
      return unknownAnswer(question);
  }
}

function sensitiveQuestionAnswer(question: PreferenceQuestionDefinition, evidence: PreferenceEvidence[]): PreferenceQuestionAnswer {
  const patternsById: Record<string, RegExp[]> = {
    romance_non_negotiables: [/\b(non[-\s]?negotiable|ideal partner|partner should|green flag)\b/i],
    romance_attractive_trait: [/\b(attractive|my type|turns me on|cute habit|trait)\b/i],
    romance_red_flag: [/\b(red flag|dealbreaker|toxic|instant distance)\b/i],
    romance_love_language: [/\b(love language|quality time|physical touch|acts of service|gift(?:s|ing)|words of affirmation)\b/i],
    romance_weekend: [/\b(romantic weekend|date weekend|long drive|netflix|fancy dinner)\b/i],
  };
  const matches = matchEvidence(evidence, patternsById[question.id] ?? [], { requireSelfDeclared: true, excludeLinkedIn: true });
  if (!matches.length) return unknownAnswer(question, "unsafe_to_infer");
  return makeAnswer({
    question,
    status: "answered",
    answer: textSnippet(matches, "Explicit relationship preference found."),
    matches,
    sourceMode: "self_declared",
    selfDeclared: true,
    needsUserConfirmation: true,
  });
}

function buildQuestionAnswers(evidence: PreferenceEvidence[]): PreferenceQuestionAnswer[] {
  return PREFERENCE_QUESTIONS.map((question) => (question.sensitive ? sensitiveQuestionAnswer(question, evidence) : simpleQuestionAnswer(question, evidence)));
}

function emptySectionCounts(): PreferenceQuestionCoverage["bySection"] {
  return PREFERENCE_QUESTIONS.reduce((out, question) => {
    out[question.sectionId] ??= {
      total: 0,
      answered: 0,
      inferred: 0,
      needsConfirmation: 0,
      unknown: 0,
      blockedByAccess: 0,
    };
    out[question.sectionId].total += 1;
    return out;
  }, {} as PreferenceQuestionCoverage["bySection"]);
}

function buildQuestionCoverage(answers: PreferenceQuestionAnswer[]): PreferenceQuestionCoverage {
  const bySection = emptySectionCounts();
  const coverage: PreferenceQuestionCoverage = {
    total: answers.length,
    answered: 0,
    inferred: 0,
    needsConfirmation: 0,
    unknown: 0,
    blockedByAccess: 0,
    bySection,
  };
  for (const answer of answers) {
    const section = coverage.bySection[answer.sectionId];
    if (answer.status === "answered") {
      coverage.answered += 1;
      section.answered += 1;
    } else if (answer.status === "inferred") {
      coverage.inferred += 1;
      section.inferred += 1;
    } else if (answer.status === "needs_confirmation") {
      coverage.needsConfirmation += 1;
      section.needsConfirmation += 1;
    } else if (answer.status === "blocked_by_access") {
      coverage.blockedByAccess += 1;
      section.blockedByAccess += 1;
    } else {
      coverage.unknown += 1;
      section.unknown += 1;
    }
  }
  return coverage;
}

function buildSectionSummaries(answers: PreferenceQuestionAnswer[]): PreferenceSectionSummary[] {
  const sections = PREFERENCE_QUESTIONS.reduce((out, question) => {
    out.set(question.sectionId, question.sectionTitle);
    return out;
  }, new Map<PreferenceQuestionSectionId, string>());
  return [...sections.entries()].map(([sectionId, title]) => {
    const rows = answers.filter((answer) => answer.sectionId === sectionId);
    const answerish = rows.filter((answer) => answer.status === "answered" || answer.status === "inferred").length;
    const confirm = rows.filter((answer) => answer.status === "needs_confirmation").length;
    const high = rows.filter((answer) => answer.confidence.level === "high").length;
    const confidence: PreferenceConfidence = high >= 2 ? "high" : answerish >= 2 ? "medium" : "low";
    return {
      sectionId,
      title,
      summary: answerish
        ? `${answerish} of ${rows.length} answers have evidence-backed signals${confirm ? `; ${confirm} need confirmation` : ""}.`
        : `${confirm ? `${confirm} sensitive or weak signals need confirmation; ` : ""}not enough reliable evidence yet.`,
      answeredCount: answerish,
      totalCount: rows.length,
      confidence,
    };
  });
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
  const questionAnswers = buildQuestionAnswers(evidence);
  const questionCoverage = buildQuestionCoverage(questionAnswers);
  const sectionSummaries = buildSectionSummaries(questionAnswers);
  return {
    version: PROFILE_VERSION,
    status: "completed",
    generatedAt: now.toISOString(),
    questionRegistryVersion: QUESTION_REGISTRY_VERSION,
    questionAnswers,
    questionCoverage,
    sectionSummaries,
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
    mediaIntelligence: {
      status: mediaAssets ? "pending" : "not_configured",
      provider: "vertex_gemini_cloud_vision",
      queuedAssets: mediaAssets,
      note: mediaAssets
        ? "Fast text/caption pass is ready. Media OCR, colors, logos, and multimodal synthesis can improve these answers asynchronously."
        : "No visible media assets were available for OCR or multimodal enrichment in this run.",
    },
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
