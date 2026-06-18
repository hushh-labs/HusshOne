/* A2A (Agent2Agent) Agent Card for the Hussh One — Xtreme Compute Burst agent.
   Served at /.well-known/agent.json so the Gemini Enterprise Agent Platform (Agent
   Engine / Cloud API Registry) and any A2A client can discover the agent, its skills,
   its endpoint, and how to authenticate. Schema: A2A protocol v0.3.0 AgentCard.

   The card is built from the request origin so the published URL is always correct in
   dev, preview, and prod without hardcoding. */

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: string;
  provider: { organization: string; url: string };
  version: string;
  iconUrl?: string;
  documentationUrl?: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  securitySchemes: Record<string, unknown>;
  security: Array<Record<string, string[]>>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
  }>;
}

// Bumped when the agent's contract (skills, endpoints, auth) changes.
export const AGENT_CARD_VERSION = "1.0.0";
export const A2A_PROTOCOL_VERSION = "0.3.0";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Build the Agent Card for a given public origin (e.g. https://one.hushh.ai). */
export function buildAgentCard(origin: string): AgentCard {
  const base = trimTrailingSlash(origin);
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Hushh One — Xtreme Compute Burst",
    description:
      "Personal supercomputing for Apple Silicon. When your Mac (“One Puppy”) runs out of " +
      "headroom, One transparently bursts the workload to your own GCP project (GPU today, TPU next) " +
      "and brings the result home — no cloud expertise required, your keys never leave your control.",
    url: `${base}/api/one/burst`,
    preferredTransport: "HTTP+JSON",
    provider: { organization: "Hushh", url: "https://hushh.ai" },
    version: AGENT_CARD_VERSION,
    iconUrl: `${base}/icon.png`,
    documentationUrl: `${base}/docs/xtreme-compute-burst`,
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    // Two complementary credentials: the user's Hushh session (who is asking) and the
    // user's own BYOC cloud key (whose cloud the work runs in). Both are required.
    securitySchemes: {
      hushhSession: { type: "http", scheme: "bearer", bearerFormat: "Firebase ID token" },
      byocGcp: {
        type: "apiKey",
        in: "header",
        name: "X-BYOC-Provider",
        description:
          "The caller supplies their own GCP service-account credential in the request body (byoc). " +
          "It is used in-memory only and is never persisted by Hushh.",
      },
    },
    security: [{ hushhSession: [], byocGcp: [] }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json", "application/x-ndjson"],
    skills: [
      {
        id: "burst-compute",
        name: "Burst a workload to the cloud",
        description:
          "Decide where a workload should run (on-device vs cloud) and, when it exceeds local " +
          "capacity, provision an accelerator-backed instance in the caller's GCP project, run the " +
          "containerized workload, return the result, and tear the instance down.",
        tags: ["compute", "gpu", "tpu", "autoscale", "byoc", "apple-silicon", "supercomputing"],
        examples: [
          "My Mac is out of memory for this 70B fine-tune — burst it to a GPU.",
          "Run this rendering job where it finishes fastest and bring back the output.",
          "Offload this batch to my GCP project and tear it down when done.",
        ],
      },
      {
        id: "placement-advice",
        name: "Recommend a placement",
        description:
          "Given a workload's resource estimate and the device profile, return whether it should run " +
          "on the local Mac (“One Puppy”) or burst to the cloud, with the reason.",
        tags: ["placement", "scheduling", "cost", "advice"],
        examples: ["Should this job run on my Mac or in the cloud?"],
      },
    ],
  };
}
