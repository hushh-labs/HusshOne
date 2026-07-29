---
name: gcp-owner
description: >-
  Owner-mode GCP provisioning protocol. Use whenever a task needs cloud infra on
  the hushh projects — creating/rotating Secret Manager secrets, Cloud SQL
  databases/users/passwords, enabling PostGIS, granting IAM, or provisioning /
  deploying Compute VMs. Ankit has granted full owner access: provision directly
  with gcloud, then report — do NOT bounce a permission-excuse back to him.
  Contains battle-tested idempotent recipes for the `directories` fleet.
---

# gcp-owner — provision like a team owner

## Standing authorization (read this first)

Ankit has **explicitly and repeatedly granted full GCP owner access** and is
annoyed by permission-excuses for routine infra ("i have given u full acess over
gcp", "act like a team owner", "excuse mtt do", "jbb complete acess diya hai toh
use krro"). See memory [[gcp-owner-mode]].

**Default action: when a task needs cloud infra, create it with `gcloud`, then
report what you did.** Do not stop to ask "may I create secret X / instance Y".
The blanket owner grant covers routine creation on:

- **`hushh-tech-prod`** — scraper fleet, `hushh-directories-db`, gmail secrets.
- **`hushone-app`** — the One app's API-key secrets.

`gcloud` is authed as `ankit@hushh.ai`. Confirm with
`gcloud config get-value project account`.

## Boundaries that STILL hold (these are safety, not excuses)

1. **Never print a secret VALUE.** Generate server-side, pipe straight into
   `gcloud secrets versions add --data-file=-`, then `unset`. Only secret/env
   **names** may appear in chat or code.
2. **Confirm ONCE** before the **first real human-facing email blast** (the daily
   reports to ankit@/manish@/kushal@). Dry-runs need no confirmation.
3. **Confirm before destructive/irreversible ops on data that already exists** —
   dropping a DB/table, deleting a secret, deleting/resetting a VM that holds
   state. **Creating new infra is not destructive → just do it.**
4. Prefer **transient, self-reverting** changes for admin access (e.g. open an IP
   allowlist for one op, then close it) over mutating shared global state (e.g.
   the machine's ADC quota project).

## The `directories` fleet — current infra map

| Thing | Value |
|---|---|
| Cloud SQL instance | `hushh-directories-db` (POSTGRES_16, ENTERPRISE, `db-custom-1-3840`, `us-central1`) |
| Connection name | `hushh-tech-prod:us-central1:hushh-directories-db` |
| Public IP | `35.226.154.131` (allowlist empty by default; `requireSsl=false`, `ALLOW_UNENCRYPTED_AND_ENCRYPTED`) |
| Databases (one per vertical) | `hotel_scraper`, `healthcare`, `ria`, `insurance`, `social` |
| App DB user | `directories` (password in secret `directories-db-password`) |
| PostGIS | 3.6, enabled in **all 5** DBs; `directories` has `CREATE` on `public` in each |
| Admin user | `postgres` (password NOT stored — reset on demand for admin ops) |
| Gmail SMTP secrets | `hushh-tech-gmail-user`, `hushh-tech-gmail-app-password` |

Deploy env per service overrides `PGDATABASE` / `PGUSER=directories` /
`SECRET_DB_PASSWORD=directories-db-password`. See memory [[directories-5-verticals]]
and [[scraper-infra-map]].

## Local tooling reality (this machine)

- `gcloud` ✅ · `cloud-sql-proxy` ✅ (`~/google-cloud-sdk/bin/cloud-sql-proxy`)
- `psql` ❌ · `docker` ❌ → run SQL via **node + the `pg` module** already
  installed at `services/hotel-scraper/node_modules/pg`. Put the throwaway
  `.mjs` inside a `services/*` dir so `import pg from "pg"` resolves, and delete
  it after.
- **⚠️ cloud-sql-proxy gotcha:** it authorizes via ADC and uses ADC's **quota
  project**, which on this machine defaults to `pocketfm-hackathon` (not ours) →
  proxy dial fails `Error 403 ... sqladmin ... project pocketfm-hackathon`.
  Don't repoint global ADC. Use the **direct public-IP recipe** below instead.

## Recipes (all idempotent)

### 1. Create / rotate a secret (value never printed)

```bash
PROJ=hushh-tech-prod; NAME=<secret-name>
PW=$(openssl rand -hex 24)
gcloud secrets describe "$NAME" --project="$PROJ" >/dev/null 2>&1 \
  || gcloud secrets create "$NAME" --replication-policy=automatic --project="$PROJ"
printf '%s' "$PW" | gcloud secrets versions add "$NAME" --data-file=- --project="$PROJ"
unset PW
```

### 2. Cloud SQL database / user

```bash
INST=hushh-directories-db; PROJ=hushh-tech-prod
gcloud sql databases create <db> --instance="$INST" --project="$PROJ"      # per vertical
# app user, password sourced from the secret (never inline on the CLI in logs):
PW=$(gcloud secrets versions access latest --secret=directories-db-password --project="$PROJ")
gcloud sql users create directories --instance="$INST" --project="$PROJ" --password="$PW"
unset PW
```

### 3. PostGIS + schema grants — direct public-IP (the one that works here)

Because of the ADC-quota gotcha, connect straight to the public IP: allowlist
only your IP + SSL, run as `postgres`, then close the allowlist.

```bash
PROJ=hushh-tech-prod; INST=hushh-directories-db
IP=35.226.154.131; MYIP=$(curl -s https://ifconfig.me)
gcloud sql instances patch "$INST" --project="$PROJ" --authorized-networks="${MYIP}/32" -q
PGPW=$(openssl rand -hex 24)
gcloud sql users set-password postgres --instance="$INST" --project="$PROJ" --password="$PGPW" -q
# node pg script (in a services/* dir): connect { host:IP, user:'postgres', password:PGPW,
#   database:<each db>, ssl:{rejectUnauthorized:false} } with a retry loop (~2 min for the
#   patch to propagate), then per DB:
#     CREATE EXTENSION IF NOT EXISTS postgis;
#     GRANT ALL ON SCHEMA public TO directories;
#     GRANT SELECT ON TABLE spatial_ref_sys TO directories;
PGHOST="$IP" PGADMPW="$PGPW" node ./_grants.mjs
gcloud sql instances patch "$INST" --project="$PROJ" --clear-authorized-networks -q   # ALWAYS close
rm -f ./_grants.mjs; unset PGPW
```

Preferred alternative (no IP exposure) if you're willing to touch ADC:
`gcloud auth application-default set-quota-project hushh-tech-prod`, then
`cloud-sql-proxy --port 6543 <conn>` + node pg on `127.0.0.1:6543`. Only do this
if repointing the ADC quota project is acceptable.

### 4. VM service-account IAM (for deploys)

```bash
PROJ=hushh-tech-prod; SA=<vm-service-account-email>
for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJ" --member="serviceAccount:$SA" --role="$ROLE" -q
done
```

### 5. Reauth if the token expired (FIFO, no browser handoff)

```bash
mkfifo /tmp/gc_fifo
gcloud auth login ankit@hushh.ai --no-launch-browser 0<>/tmp/gc_fifo &
# paste the code Ankit returns:
printf '%s\n' 'CODE' > /tmp/gc_fifo; rm -f /tmp/gc_fifo
```

## Verify

```bash
gcloud sql instances describe hushh-directories-db --project=hushh-tech-prod \
  --format="value(state, ipAddresses[0].ipAddress)"
gcloud sql databases list --instance=hushh-directories-db --project=hushh-tech-prod
gcloud secrets list --project=hushh-tech-prod --filter="name~directories OR name~gmail"
```

## When genuinely blocked (rare)

Only a hard IAM denial (a resource Ankit's owner grant truly doesn't cover, or an
org-policy block) is a real block. Then follow [[always-handoff-when-blocked]]:
give the plain Hinglish "kya hua / tumhe kya karna hai / phir main kya karunga"
handoff — never a vague permission-excuse.
