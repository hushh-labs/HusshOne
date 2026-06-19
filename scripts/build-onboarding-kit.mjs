#!/usr/bin/env node
/* Packages the BYOC onboarding kit into public/downloads/ at build time (runs as the
   `prebuild` step, so it's regenerated on every `npm run build` and baked into the
   standalone image). Single source of truth: the repo's provisioning/ + customer docs —
   the download can never drift from what we ship.

   Outputs:
     public/downloads/onboarding/                  individually browsable kit files
     public/downloads/onboarding/manifest.json     machine-readable contract (inputs/outputs/steps)
     public/downloads/one-burst-onboarding-kit.tar.gz[.sha256]

   Dependency-free: tar (POSIX ustar) + gzip are built with node stdlib only. */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const OUT = join(ROOT, "public", "downloads");
const KIT_DIR = join(OUT, "onboarding");
const KIT_NAME = "one-burst-onboarding-kit";
const VERSION = "1.0.0";
const SITE = "https://one.hushh.ai";

/* Files to ship in the kit: [repo source, path inside the kit, unix mode]. */
const FILES = [
  ["provisioning/README.md", "README.md", 0o644],
  ["provisioning/setup.sh", "setup.sh", 0o755],
  ["provisioning/terraform/main.tf", "terraform/main.tf", 0o644],
  ["provisioning/terraform/variables.tf", "terraform/variables.tf", 0o644],
  ["provisioning/terraform/outputs.tf", "terraform/outputs.tf", 0o644],
  ["provisioning/terraform/versions.tf", "terraform/versions.tf", 0o644],
  ["docs/customer/getting-started.md", "GETTING-STARTED.md", 0o644],
  ["docs/specs/byoc-security-privacy.md", "SECURITY-AND-PRIVACY.md", 0o644],
  ["docs/specs/burst-control-plane.openapi.yaml", "burst-control-plane.openapi.yaml", 0o644],
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/* The machine-readable contract a human OR an IaC system reads to complete onboarding. */
function buildManifest(fileEntries) {
  return {
    name: KIT_NAME,
    version: VERSION,
    product: "One — Xtreme Compute Burst",
    generatedAt: new Date().toISOString().slice(0, 10),
    summary:
      "Provision a customer's own Google Cloud project (BYOC) so One can burst into it: enables APIs, creates a least-privilege service account + custom role, and (optionally) a TPU result bucket. One never owns the compute — bursts run in your project, on your bill, under your credential.",
    cloud: "gcp",
    methods: [
      {
        id: "script",
        title: "One command (humans / quick start)",
        tool: "bash + gcloud",
        entrypoint: "setup.sh",
        run: "PROJECT_ID=your-project REGION=us-central1 CREATE_KEY=true ./setup.sh",
        idempotent: true,
        inputs: [
          { name: "PROJECT_ID", required: true, description: "Target GCP project (BYOC)." },
          { name: "REGION", required: false, default: "us-central1", description: "Region for bursts and the TPU bucket." },
          { name: "CREATE_KEY", required: false, default: "false", description: "Also emit one-burst-key.json to paste into One. Prefer keyless WIF." },
          { name: "ENABLE_TPU", required: false, default: "false", description: "Also provision the Cloud TPU path + result bucket." },
          { name: "TPU_BUCKET", required: false, default: "<project>-one-burst-tpu", description: "TPU result bucket name." },
          { name: "SA_NAME", required: false, default: "hushh-burst", description: "Service-account id." },
          { name: "ROLE_ID", required: false, default: "oneBurst", description: "Custom role id." },
        ],
      },
      {
        id: "terraform",
        title: "Terraform (standard IaC / automation systems)",
        tool: "terraform >= 1.5",
        module: "terraform/",
        run: "terraform init && terraform apply -var project_id=your-project -var region=us-central1",
        idempotent: true,
        inputs: [
          { name: "project_id", required: true, description: "Target GCP project (BYOC)." },
          { name: "region", required: false, default: "us-central1" },
          { name: "service_account_id", required: false, default: "hushh-burst" },
          { name: "custom_role_id", required: false, default: "oneBurst" },
          { name: "enable_tpu", required: false, default: "false" },
          { name: "tpu_result_bucket", required: false, default: "<project>-one-burst-tpu" },
          { name: "create_key", required: false, default: "false", description: "Emit a SA key (sensitive). Prefer keyless WIF." },
        ],
        outputs: [
          { name: "service_account_email", description: "The least-privilege burst identity. Hand this to One (or bind via WIF)." },
          { name: "custom_role_id", description: "The least-privilege custom role bound to the SA." },
          { name: "tpu_result_bucket", description: "Set ONE_BURST_TPU_RESULT_BUCKET to this when running TPU bursts." },
          { name: "service_account_key_json", sensitive: true, description: "Only when create_key=true. Paste into One; never commit." },
        ],
      },
    ],
    /* What the operator hands back to One once provisioning completes. */
    handBack: {
      where: "One → Settings → Connect your cloud (or the /burst/setup page)",
      values: ["service_account_email or one-burst-key.json", "region", "tpu_result_bucket (if ENABLE_TPU)"],
    },
    /* How either party confirms the job is actually done. */
    verify: {
      ui: `${SITE}/burst/setup`,
      api: "POST /api/one/burst/setup/validate",
      checks: ["auth", "permissions", "quota"],
      description: "Validates the credential against the project: auth works, the least-privilege permissions are present, and GPU/TPU quota exists in the region.",
    },
    docs: {
      gettingStarted: `${SITE}/docs/getting-started`,
      provisioning: `${SITE}/docs/provisioning`,
      security: `${SITE}/docs/security`,
      whitepaper: `${SITE}/docs/whitepaper`,
      openapi: "burst-control-plane.openapi.yaml",
    },
    files: fileEntries,
  };
}

/* --- minimal POSIX ustar + gzip (no deps) --- */
function tarHeader(name, mode, size, mtime) {
  const buf = Buffer.alloc(512);
  const put = (str, off, len) => buf.write(str.slice(0, len), off, "ascii");
  const oct = (n, off, len) => buf.write(n.toString(8).padStart(len - 1, "0") + "\0", off, "ascii");
  put(name, 0, 100);
  oct(mode & 0o7777, 100, 8);
  oct(0, 108, 8); // uid
  oct(0, 116, 8); // gid
  oct(size, 124, 12);
  oct(Math.floor(mtime), 136, 12);
  put("        ", 148, 8); // checksum placeholder (spaces)
  put("0", 156, 1); // typeflag: normal file
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return buf;
}

function makeTarGz(entries) {
  const mtime = Date.now() / 1000;
  const chunks = [];
  for (const e of entries) {
    const body = Buffer.from(e.body);
    chunks.push(tarHeader(`${KIT_NAME}/${e.name}`, e.mode, body.length, mtime));
    chunks.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(chunks));
}

// --- build ---
rmSync(OUT, { recursive: true, force: true });
mkdirSync(KIT_DIR, { recursive: true });

const tarEntries = [];
const fileEntries = [];
for (const [src, dest, mode] of FILES) {
  const abs = join(ROOT, src);
  if (!existsSync(abs)) throw new Error(`onboarding kit: missing source ${src}`);
  const body = readFileSync(abs);
  // write the browsable copy
  const destAbs = join(KIT_DIR, dest);
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, body);
  tarEntries.push({ name: dest, body, mode });
  fileEntries.push({ path: dest, bytes: body.length, sha256: sha256(body) });
}

// manifest references the file list (with hashes) and is itself shipped in the tarball
const manifest = buildManifest(fileEntries);
const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
writeFileSync(join(KIT_DIR, "manifest.json"), manifestBuf);
tarEntries.unshift({ name: "manifest.json", body: manifestBuf, mode: 0o644 });

const tarGz = makeTarGz(tarEntries);
const tarPath = join(OUT, `${KIT_NAME}.tar.gz`);
writeFileSync(tarPath, tarGz);
writeFileSync(`${tarPath}.sha256`, `${sha256(tarGz)}  ${KIT_NAME}.tar.gz\n`);

console.log(
  `onboarding kit: ${tarEntries.length} files -> public/downloads/${KIT_NAME}.tar.gz ` +
    `(${(tarGz.length / 1024).toFixed(1)} KiB, sha256 ${sha256(tarGz).slice(0, 12)}…)`
);
