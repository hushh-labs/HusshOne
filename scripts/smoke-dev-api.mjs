#!/usr/bin/env node
/* Live post-deploy smoke test for the One Developer API (Sundar Pichai, a public figure).
   POSTs a scan, then consumes the SSE stream to a terminal event, printing the transcript as proof.

   Usage:
     ONE_API_KEY=sk_... node scripts/smoke-dev-api.mjs [baseUrl]
   Defaults: baseUrl = https://one.hushh.ai
*/
const BASE = process.argv[2] || process.env.ONE_API_BASE || "https://one.hushh.ai";
const KEY = process.env.ONE_API_KEY;
if (!KEY) {
  console.error("Set ONE_API_KEY (a hushh developer API key).");
  process.exit(2);
}
const auth = { Authorization: `Bearer ${KEY}` };

const SUBJECT = {
  name: "Sundar Pichai",
  email: "sundar.smoke@example.com",
  zipCode: "94040",
  linkedinUrl: "https://www.linkedin.com/in/sundarpichai/",
  xUrl: "https://x.com/sundarpichai",
};

async function main() {
  console.log(`→ POST ${BASE}/api/v1/scan  (Sundar Pichai)`);
  const started = await fetch(`${BASE}/api/v1/scan`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(SUBJECT),
  });
  const startBody = await started.json();
  console.log(`  status ${started.status}`, JSON.stringify(startBody).slice(0, 300));
  if (!started.ok || !startBody.scanId) throw new Error(`scan did not start: ${started.status}`);
  const scanId = startBody.scanId;

  console.log(`→ GET ${BASE}/api/v1/scan/${scanId}/stream  (SSE)`);
  const res = await fetch(`${BASE}/api/v1/scan/${scanId}/stream`, { headers: auth });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const seen = new Set();
  let gotDossier = false;
  let gotPreferences = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (!event) continue;
      if (!seen.has(event) || event === "progress" || event === "ping") {
        seen.add(event);
        const preview = event === "ping" ? "" : ` ${String(data).slice(0, 160)}`;
        console.log(`  ⟵ ${event}${preview}`);
      }
      if (event === "dossier") gotDossier = true;
      if (event === "preferences") gotPreferences = true;
      if (event === "done" || event === "error" || event === "pending") {
        reader.cancel().catch(() => {});
        console.log(`\nterminal: ${event}`);
        console.log(`dossier frame seen: ${gotDossier} · preferences frame seen: ${gotPreferences}`);
        if (event === "error") process.exit(1);
        process.exit(gotDossier ? 0 : 1);
      }
    }
  }
  console.log("stream ended without a terminal event");
  process.exit(1);
}

main().catch((error) => {
  console.error("smoke failed:", error?.message || error);
  process.exit(1);
});
