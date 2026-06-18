/* The productized "2-minute GCP setup" flow for Xtreme Compute Burst.
   Two halves:
   - SETUP_STEPS: the plain-English, copy-paste guide One shows a user to connect their
     own GCP project (the FDE playbook, productized).
   - validateByocSetup(): actually probes the user's project with their credential and
     returns a pass/fail checklist (auth works, required permissions present, GPU quota),
     so onboarding can say "you're set" or point at the exact gap — no guesswork. */
import { callGcp, mintAccessToken } from "./providers/gcp-common";
import { resolveGcpCreds } from "./credentials";
import type { RequestByocCreds } from "./types";

const RESOURCE_MANAGER_BASE = "https://cloudresourcemanager.googleapis.com/v1";
const COMPUTE_BASE = "https://compute.googleapis.com/compute/v1";

/** Minimal IAM permissions a GPU burst needs in the user's project. */
export const REQUIRED_PERMISSIONS = [
  "compute.instances.create",
  "compute.instances.get",
  "compute.instances.delete",
  "compute.instances.setMetadata",
  "compute.disks.create",
  "compute.zoneOperations.get",
] as const;

export interface SetupStep {
  id: string;
  title: string;
  description: string;
  commands?: string[];
  docUrl?: string;
}

/** The guided flow. Kept to the few steps a non-expert can do in ~2 minutes. */
export function setupSteps(region = "us-central1"): SetupStep[] {
  const role = "compute.instances.{create,get,delete,setMetadata} + compute.disks.create + compute.zoneOperations.get";
  return [
    {
      id: "project",
      title: "Pick your Google Cloud project",
      description:
        "Use any Google Cloud project you own. Bursts run here, on your bill, under your control — One never owns the compute.",
      docUrl: "https://console.cloud.google.com/projectselector2/home/dashboard",
    },
    {
      id: "enable-api",
      title: "Turn on Compute Engine",
      description: "One borrows GPU machines through Compute Engine. Enabling it takes one click.",
      commands: ["gcloud config set project YOUR_PROJECT", "gcloud services enable compute.googleapis.com"],
      docUrl: "https://console.cloud.google.com/apis/library/compute.googleapis.com",
    },
    {
      id: "create-key",
      title: "Create a least-privilege key for One",
      description: `Make a dedicated key that can only start and stop machines (${role}). One never asks for more.`,
      commands: [
        "gcloud iam service-accounts create hushh-burst --display-name='Hushh One Burst'",
        "# Grant the minimal permissions (see the FDE playbook for the exact custom role), then:",
        "gcloud iam service-accounts keys create one-burst-key.json \\",
        "  --iam-account=hushh-burst@YOUR_PROJECT.iam.gserviceaccount.com",
      ],
      docUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    },
    {
      id: "gpu-quota",
      title: "Check you have GPU capacity (optional)",
      description: `If you've never used GPUs in ${region}, request quota once — One will tell you if it's missing.`,
      docUrl: "https://console.cloud.google.com/iam-admin/quotas",
    },
    {
      id: "connect",
      title: "Paste the key into One",
      description: "Drop the key file's contents into One. It's stored in your Mac's Keychain and never leaves your device except to your own cloud.",
    },
  ];
}

export type CheckStatus = "pass" | "fail" | "warn";
export interface SetupCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}
export interface SetupValidation {
  ready: boolean;
  projectId: string | null;
  region: string;
  checks: SetupCheck[];
}

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if ("upstreamStatus" in error && typeof error.upstreamStatus === "number") return error.upstreamStatus;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  return null;
}

/**
 * Probe the user's project with their credential and return a checklist. Never throws —
 * every failure becomes a check the UI can render and explain.
 */
export async function validateByocSetup(req?: RequestByocCreds): Promise<SetupValidation> {
  const checks: SetupCheck[] = [];

  // 1) Credential is well-formed and names a project.
  let creds;
  try {
    creds = resolveGcpCreds(req);
    checks.push({ id: "credential", label: "Credential", status: "pass", detail: `Project ${creds.projectId} (${creds.source}).` });
  } catch (error) {
    return {
      ready: false,
      projectId: null,
      region: req?.region || "us-central1",
      checks: [
        { id: "credential", label: "Credential", status: "fail", detail: error instanceof Error ? error.message : "Invalid credential." },
      ],
    };
  }

  // 2) Auth: the credential can mint an access token.
  let token: string;
  try {
    token = await mintAccessToken(creds);
    checks.push({ id: "auth", label: "Sign-in to Google Cloud", status: "pass", detail: "One can authenticate with your key." });
  } catch {
    checks.push({
      id: "auth",
      label: "Sign-in to Google Cloud",
      status: "fail",
      detail: "One couldn't authenticate — the key may be wrong or revoked.",
    });
    return { ready: false, projectId: creds.projectId, region: creds.region, checks };
  }

  // 3) Permissions: ask GCP which of the required permissions the key actually holds.
  try {
    const res = await callGcp<{ permissions?: string[] }>(
      token,
      "POST",
      `${RESOURCE_MANAGER_BASE}/projects/${creds.projectId}:testIamPermissions`,
      { permissions: REQUIRED_PERMISSIONS },
    );
    const granted = new Set(res.permissions ?? []);
    const missing = REQUIRED_PERMISSIONS.filter((p) => !granted.has(p));
    checks.push(
      missing.length === 0
        ? { id: "permissions", label: "Permission to run machines", status: "pass", detail: "Your key has exactly what One needs." }
        : { id: "permissions", label: "Permission to run machines", status: "fail", detail: `Missing: ${missing.join(", ")}.` },
    );
  } catch (error) {
    const code = statusOf(error);
    checks.push({
      id: "permissions",
      label: "Permission to run machines",
      status: "fail",
      detail:
        code === 403
          ? "Compute Engine isn't enabled, or the key can't read the project. Enable it and try again."
          : "Couldn't check permissions — make sure Compute Engine is enabled.",
    });
  }

  // 4) GPU quota (advisory — a warn, never a hard fail; One can still try smaller machines).
  try {
    const region = await callGcp<{ quotas?: Array<{ metric?: string; limit?: number }> }>(
      token,
      "GET",
      `${COMPUTE_BASE}/projects/${creds.projectId}/regions/${creds.region}`,
      undefined,
      { fast: true },
    );
    const gpu = (region.quotas ?? []).find((q) => /GPU/i.test(q.metric || "") && (q.limit ?? 0) > 0);
    checks.push(
      gpu
        ? { id: "gpu-quota", label: `GPU capacity in ${creds.region}`, status: "pass", detail: `Quota available (${gpu.metric}).` }
        : {
            id: "gpu-quota",
            label: `GPU capacity in ${creds.region}`,
            status: "warn",
            detail: "No GPU quota detected yet — request it once, or One will keep work on your Mac.",
          },
    );
  } catch {
    checks.push({
      id: "gpu-quota",
      label: `GPU capacity in ${creds.region}`,
      status: "warn",
      detail: "Couldn't read GPU quota — you can request it in the Console if a burst is ever blocked.",
    });
  }

  // Ready when every REQUIRED check passes (quota is advisory).
  const ready = checks.filter((c) => c.id !== "gpu-quota").every((c) => c.status === "pass");
  return { ready, projectId: creds.projectId, region: creds.region, checks };
}
