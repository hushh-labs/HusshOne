/* ─────────────────────────────────────────────────────────────────────────
   EXPERIMENT (standalone, NOT production): Phase-1-only at depth:"fast" with a
   LinkedIn identity anchor — does the raw Phase-1 report come back pointed enough
   that Phase-2 (Opus synthesis/structuring) can be dropped on the fast tier?

   Reuses the REAL production prompt (buildPersonDossierQuestion, with the
   "PRIMARY ANCHOR — LinkedIn" block) + the REAL Deep Research client. Touches
   nothing in prod: no DB write, no email, no INTELLIGENCE_VERSION change. All
   output lands in exp-output/ (gitignored, PII-safe). The API token is read from
   env and NEVER printed.

   Run (from repo root):
     npx tsx --require tsconfig-paths/register scripts/exp/phase1-fast.ts \
       --linkedin "https://www.linkedin.com/in/ankit-kumar-singh-69305a22a/"
   Flags:
     --control    also run a no-LinkedIn arm with the SAME new prompt (isolates the
                  LinkedIn effect cleanly; one extra fast DR run)
     --no-synth   skip the Phase-2 synthesis A/B pass
   ───────────────────────────────────────────────────────────────────────── */

import { config } from "dotenv";
// Load .env.local FIRST — a plain tsx script does not get Next.js's env loading,
// and the client reads process.env at call time.
config({ path: ".env.local" });

// This is a real experiment: never let local mock mode short-circuit the DR call.
if (process.env.ONE_ENABLE_MOCK_RESEARCH === "true") {
  process.env.ONE_ENABLE_MOCK_RESEARCH = "false";
  console.log("[exp] ONE_ENABLE_MOCK_RESEARCH was 'true' → forced off so we hit the live DR API");
}

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  startResearch,
  pollResearch,
  synthesizeReport,
  type ResearchDepth,
  type SynthIdentity,
} from "@/lib/research/client";
import { buildPersonDossierQuestion } from "@/lib/research/dossier";
import { normalizeLinkedInUrl, linkedinHandleFromUrl } from "@/lib/auth/identity";
import type { OneSubjectInput, ConfirmedProfile } from "@/lib/ria/types";

// ── CLI ─────────────────────────────────────────────────────────────────────
const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (flag: string) => process.argv.includes(flag);

const linkedinRaw = argValue("--linkedin");
const runControl = hasFlag("--control");
const runSynth = !hasFlag("--no-synth");

if (!linkedinRaw) {
  console.error(
    'Usage: npx tsx --require tsconfig-paths/register scripts/exp/phase1-fast.ts --linkedin "<url>" [--control] [--no-synth]',
  );
  process.exit(1);
}
const linkedinUrl = normalizeLinkedInUrl(linkedinRaw);
if (!linkedinUrl) {
  console.error(`[exp] Not a valid LinkedIn personal-profile URL: ${linkedinRaw}`);
  process.exit(1);
}
if (!process.env.DEEP_RESEARCH_API_TOKEN?.trim()) {
  console.error("[exp] DEEP_RESEARCH_API_TOKEN missing in .env.local — cannot hit the DR API. Aborting.");
  process.exit(1);
}

// ── Subject (Ankit, identical to the 2026-06-08 baseline so the comparison is fair) ──
const BASE_SUBJECT: Omit<OneSubjectInput, "confirmedProfiles"> = {
  name: "Ankit Kumar Singh",
  email: "ankitkumarsingh97593@gmail.com",
  phone: "+91 8004482372",
  latitude: 18.564393,
  longitude: 73.739665,
  consentAttestation: true,
  purpose: "self_audit",
};
const locationLabel = `lat ${BASE_SUBJECT.latitude}, lon ${BASE_SUBJECT.longitude}`;

const linkedinAnchor: ConfirmedProfile = {
  platform: "LinkedIn",
  handle: linkedinHandleFromUrl(linkedinUrl),
  url: linkedinUrl,
  category: "Professional",
};

// ── output ───────────────────────────────────────────────────────────────────
const OUT_DIR = join(process.cwd(), "exp-output");
mkdirSync(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");

const save = (name: string, content: string): string => {
  const p = join(OUT_DIR, name);
  writeFileSync(p, content, "utf8");
  console.log(`[exp] wrote ${p} (${content.length} chars)`);
  return p;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (ms: number) => Math.round(ms / 1000);

const POLL_MS = 8_000;
const CAP_MS = 20 * 60 * 1000; // per-arm hard cap. Fast tier + the heavy LinkedIn-anchor prompt ran >10 min and was still in_progress; give real headroom (prod hands off at 840s).

type ArmResult = { report: string; citations: unknown[]; ms: number };

async function runArm(label: string, input: OneSubjectInput, depth: ResearchDepth): Promise<ArmResult> {
  const question = buildPersonDossierQuestion(input);
  save(`${label}-prompt-${ts}.txt`, question);
  console.log(`[exp] [${label}] start depth=${depth} · prompt ${question.length} chars · anchors=${input.confirmedProfiles?.length ?? 0}`);

  const startedAt = Date.now();
  const { jobId } = await startResearch(question, depth);
  console.log(`[exp] [${label}] job started, polling every ${secs(POLL_MS)}s…`);

  let lastProgress = "";
  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > CAP_MS) throw new Error(`[${label}] poll cap exceeded at ${secs(elapsed)}s`);
    const dr = await pollResearch(jobId);
    const tag = `${secs(elapsed)}s · ${dr.status}`;
    if (dr.progress && dr.progress !== lastProgress) {
      lastProgress = dr.progress;
      console.log(`[exp] [${label}] ${tag} · ${dr.progress}`);
    } else {
      console.log(`[exp] [${label}] ${tag}`);
    }
    if (dr.status === "completed" && dr.report) {
      console.log(`[exp] [${label}] ✓ completed in ${secs(elapsed)}s · ${dr.report.length} chars · ${dr.citations.length} citations`);
      return { report: dr.report, citations: dr.citations, ms: elapsed };
    }
    if (dr.status === "failed") throw new Error(`[${label}] DR failed: ${dr.error ?? "unknown"}`);
    await sleep(POLL_MS);
  }
}

const countHeadings = (md: string) => (md.match(/^#{1,6}\s/gm) || []).length;
const countCites = (md: string) => (md.match(/\[cite:\s*\d+\]/gi) || []).length;

async function main() {
  console.log(
    `[exp] subject="${BASE_SUBJECT.name}" · linkedin=${linkedinUrl} · synth=${runSynth} · control=${runControl}`,
  );

  // Arm A — WITH the LinkedIn anchor (the hypothesis arm)
  const a = await runArm(
    "A-linkedin-fast",
    { ...BASE_SUBJECT, confirmedProfiles: [linkedinAnchor] },
    "fast",
  );
  save(`A-linkedin-fast-raw-${ts}.md`, a.report);
  save(
    `A-linkedin-fast-meta-${ts}.json`,
    JSON.stringify({ ms: a.ms, chars: a.report.length, citationCount: a.citations.length, citations: a.citations }, null, 2),
  );

  // Phase-2 synthesis A/B on Arm A's raw (so we can judge what synth adds). Fail-soft:
  // a synth error must not lose the Arm A data we already have.
  let synth: { report: string; ms: number } | null = null;
  let synthError: string | null = null;
  if (runSynth) {
    console.log("[exp] [synth] running Phase-2 (Opus on Vertex) on Arm A raw…");
    const sStart = Date.now();
    const identity: SynthIdentity = {
      name: BASE_SUBJECT.name,
      email: BASE_SUBJECT.email,
      phone: BASE_SUBJECT.phone,
      location: locationLabel,
      confirmedProfiles: [linkedinAnchor],
    };
    try {
      const report = await synthesizeReport(a.report, identity, a.citations);
      synth = { report, ms: Date.now() - sStart };
      save(`B-synth-on-A-${ts}.md`, report);
      console.log(`[exp] [synth] ✓ done in ${secs(synth.ms)}s · ${report.length} chars`);
    } catch (e) {
      synthError = e instanceof Error ? e.message : String(e);
      console.warn(`[exp] [synth] FAILED (non-fatal): ${synthError}`);
    }
  }

  // Optional control — SAME new prompt, NO LinkedIn anchor (isolates the LinkedIn effect)
  let control: ArmResult | null = null;
  if (runControl) {
    control = await runArm("C-control-nolinkedin-fast", { ...BASE_SUBJECT }, "fast");
    save(`C-control-nolinkedin-fast-raw-${ts}.md`, control.report);
    save(
      `C-control-nolinkedin-fast-meta-${ts}.json`,
      JSON.stringify({ ms: control.ms, chars: control.report.length, citationCount: control.citations.length, citations: control.citations }, null, 2),
    );
  }

  // Compare stub for a manual read
  const row = (name: string, depth: string, ms: number | null, md: string | null, cites: number | null) =>
    `| ${name} | ${depth} | ${ms === null ? "—" : secs(ms)} | ${md ? md.length : "—"} | ${md ? countHeadings(md) : "—"} | ${md ? countCites(md) : "—"} | ${cites === null ? "—" : cites} |`;

  const compare = [
    `# Experiment compare — ${ts}`,
    ``,
    `Subject: ${BASE_SUBJECT.name} · LinkedIn anchor: ${linkedinUrl}`,
    `Hypothesis: raw Phase-1 (fast) + LinkedIn anchor is pointed enough to DROP Phase-2 on the fast tier.`,
    ``,
    `| Arm | depth | time (s) | chars | headings | [cite:N] | citations[] |`,
    `|---|---|---|---|---|---|---|`,
    row("A raw (with LinkedIn)", "fast", a.ms, a.report, a.citations.length),
    synth
      ? row("B synth on A", "opus", synth.ms, synth.report, null)
      : `| B synth on A | opus | ${runSynth ? `FAILED: ${synthError}` : "skipped (--no-synth)"} | — | — | — | — |`,
    control
      ? row("C raw (no LinkedIn)", "fast", control.ms, control.report, control.citations.length)
      : `| C raw (no LinkedIn) | fast | skipped (pass --control) | — | — | — | — |`,
    ``,
    `Baseline reference (2026-06-08 · OLD prompt · NO LinkedIn · partial "resumed" export):`,
    `  ~/Documents/hushh-deep-research-api/exports/ankit-intelligence-final-fast-resumed-20260608-210618.md`,
    `  (that run needed a whole section to exclude 8 same-name "Ankit Kumar Singh" people)`,
    ``,
    `## Decision checklist`,
    `- [ ] Identity locked to the RIGHT Ankit via the LinkedIn anchor? same-name noise gone vs baseline's 8 false-positives?`,
    `- [ ] Sections populated + citations real (not hallucinated)?`,
    `- [ ] Does raw-fast (A) already deliver what synth (B) adds — structure, confidence-ranking, readability?`,
    `- [ ] => Can Phase-2 be DROPPED on the fast tier? (latency + Opus-cost win with no quality loss)`,
    ``,
  ].join("\n");
  save(`compare-${ts}.md`, compare);

  console.log(`\n[exp] DONE — outputs in exp-output/ (prefix ${ts})`);
}

main().catch((e) => {
  // message only — never dump the error object (could carry request context/headers)
  console.error(`[exp] ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
