# One — Xtreme Compute Burst · Investor Demo (≈4 min)

**The line:** *One is personal supercomputing for your Mac. It runs on‑device, and when a job needs
real power it borrows a supercomputer from your **own** cloud, runs it, brings the result home, and
tears it down. Your keys, your data, your bill — we never own the compute.*

Everything below is **tested and runs locally right now** with no secrets and no database. This is the
real product UI, not slides.

---

## Run it live (≈2 min, on your laptop)

```bash
cd HusshOne
git checkout main && git pull
npm install            # first time only
npm run build && npm run start      # serves http://localhost:3000
```
Then open **http://localhost:3000/docs** and walk the four beats below.
*(Faster alt: `npm run build:kit && npm run dev` — same flow, compiles each page on first click.)*

---

## The 4 beats

**1 · The product — `/docs`**
“This is One. Two execution modes: on‑device for everything normal, and a **cloud burst** when a job
needs a supercomputer.” Point at the three doc sections. Click the blue **“Download the onboarding
kit”** card.

**2 · Self‑serve onboarding — `/docs/onboarding-kit`**
“A new customer onboards themselves in minutes — nobody from our team in the loop.” Click
**⬇ Download the kit**. A real `.tar.gz` lands. Open it — show `setup.sh`, the `terraform/` module,
and **`manifest.json`**. “One command *or* a Terraform module, both least‑privilege. The manifest is
machine‑readable, so a human **or** an automated provisioning system — or another agent — can do this.”

**3 · Provision their cloud (talk over the kit, ~20s)**
“They run `PROJECT_ID=acme ./setup.sh` (or `terraform apply`). That creates a **least‑privilege**
service account in **their** Google Cloud — only the handful of permissions a burst needs, nothing
more. The compute runs on their project, on their bill.”

**4 · It comes to life — `/burst/setup`**
“Back in One: **Connect your cloud** → paste the key → **Connect & check**.” That validation step
checks **auth, permissions, and quota** against their project in real time. “The moment that goes
green, One can burst — run the heavy job in their cloud and return the result on‑device.”

---

## What’s real today vs. what’s next (say this plainly)

- **Real & live in this demo:** the full onboarding journey — product docs, the downloadable kit
  (script + Terraform + machine‑readable manifest), and the connect‑&‑validate flow. All tested; full
  test suite green (298 passing).
- **The burst execution itself** (a job actually running in a connected cloud) needs a billing‑enabled
  GCP project wired in — narrate it, or demo from a pre‑connected account. Don’t click‑run it cold.
- **Hosting note (for your own awareness, not the pitch):** this is running locally. The public
  `one.hushh.ai` isn’t redeployed with these pages yet — a CI/billing setting on our GitHub org is
  blocking automated deploys. The local demo looks identical; just don’t point investors at the public
  URL expecting these exact pages until we deploy.

---

## If anything hiccups (fallback)
You have the actual artifacts attached to this message: the onboarding kit (`.tar.gz`) and its
`manifest.json`. Worst case, open `manifest.json` and the kit folder and tell the story from those —
they *are* the product’s onboarding contract.

**One‑sentence close:** *“A user goes from ‘install One’ to ‘my Mac just used a supercomputer in my own
cloud’ in minutes — self‑serve, least‑privilege, and automatable end to end.”*
