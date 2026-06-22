#!/usr/bin/env bash
# Gated manual production deploy → Cloud Run service `one` (project hushone-app, region us-central1 —
# the service one.hushh.ai actually maps to). Use this until the Cloud Build auto-deploy trigger is
# connected (see cloudbuild.yaml). Mirrors the CI pipeline: gate → deploy → smoke.
#
# Usage:  npm run deploy:prod   (or)  bash scripts/deploy-prod.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Gate: tsc --noEmit"
npx tsc --noEmit
echo "▶ Gate: vitest run"
npx vitest run
echo "▶ Gate: next build"
npm run build

echo "▶ Deploy → one / hushone-app / us-central1 (preserves env, secrets, scaling, timeout)"
gcloud run deploy one --source . --region us-central1 --project hushone-app --quiet

echo "▶ Smoke (one.hushh.ai hits the service directly — new revision is live immediately)"
for path in / /docs; do
  code=$(curl -s -m 30 -o /dev/null -w "%{http_code}" "https://one.hushh.ai${path}")
  echo "GET https://one.hushh.ai${path} -> ${code}"
  test "${code}" = "200"
done
echo "✅ Production deploy verified."
