# One-time setup for `deploy-prod.yml`

The deploy workflow authenticates to Google Cloud with **Workload Identity Federation**
(no long-lived JSON keys). Run this once, from a shell with `gcloud` authed as an owner of
`hushone-app`. After it's done, every push to `main` deploys to `one.hushh.ai`.

```bash
PROJECT=hushone-app
REPO=hushh-labs/HusshOne
SA=gh-deploy-one
SA_EMAIL="$SA@$PROJECT.iam.gserviceaccount.com"

# 1. A dedicated deploy service account.
gcloud iam service-accounts create "$SA" --project "$PROJECT" \
  --display-name="GitHub Actions deploy (one)"

# 2. Roles needed to build (Cloud Build) and deploy (Cloud Run) via `gcloud run deploy --source`.
for role in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.writer \
  roles/storage.admin \
  roles/iam.serviceAccountUser ; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA_EMAIL" --role="$role" --condition=None
done

# 3. A Workload Identity pool + GitHub OIDC provider, locked to THIS repo.
gcloud iam workload-identity-pools create github \
  --project "$PROJECT" --location global --display-name "GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --project "$PROJECT" --location global --workload-identity-pool github \
  --display-name "GitHub OIDC" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com"

POOL_ID=$(gcloud iam workload-identity-pools describe github \
  --project "$PROJECT" --location global --format="value(name)")

# 4. Let runs from this repo impersonate the deploy service account.
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project "$PROJECT" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${REPO}"

# 5. Print the two values to paste into GitHub repo secrets.
echo "GCP_DEPLOY_SERVICE_ACCOUNT = $SA_EMAIL"
echo -n "GCP_WORKLOAD_IDENTITY_PROVIDER = "
gcloud iam workload-identity-pools providers describe github \
  --project "$PROJECT" --location global --workload-identity-pool github \
  --format="value(name)"
```

Then add the two repo secrets (Settings → Secrets and variables → Actions, or via `gh`):

```bash
gh secret set GCP_DEPLOY_SERVICE_ACCOUNT      --repo "$REPO" --body "$SA_EMAIL"
gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER  --repo "$REPO" --body "<value from step 5>"
```

That's it. Trigger a first run from the **Actions → deploy-prod → Run workflow** button (or
push any commit to `main`). The workflow gates on `npm run build`, deploys to **service `one`
/ project `hushone-app`**, then verifies `https://one.hushh.ai/docs` returns `200` and runs the
production smoke test.

**Notes**
- The OIDC provider is restricted to `hushh-labs/HusshOne` (`attribute-condition`), so no other
  repo can assume the deploy identity.
- `roles/iam.serviceAccountUser` is granted at project level for simplicity; to tighten, grant it
  only on the Cloud Run runtime service account `one` uses.
