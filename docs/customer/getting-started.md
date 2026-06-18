# Getting started with One Burst Compute

**Personal supercomputing for your Mac.** One runs your work on your Mac by default. When a job needs
more power than your Mac can give, One borrows a supercomputer from **your own** Google Cloud, finishes
the job, brings the result back, and cleans up — automatically. You stay in control of your keys and
your data the whole time.

This guide gets you from zero to your first burst. Two paths:

- **Just use it** (most people) — connect your cloud once in the app; One does the rest.
- **Set up the cloud for a team** (admins / automation) — provision the cloud project with a script or
  Terraform, then hand the key to users or the service.

---

## What you'll need

- A Mac (Apple Silicon recommended) with the **One** app.
- A **Google Cloud project** you own. (New to Google Cloud? You can create one free; bursts run on
  your bill, and One only uses the cloud when your Mac can't keep up.)
- About **2 minutes**.

---

## Path 1 — Just use it (in the app)

1. **Open One → Settings → Connect your cloud** (or go to the `/burst/setup` page).
2. **Paste your Google Cloud key.** Don't have one yet? One links you to a 2-minute, copy-paste setup,
   or your admin can hand you a key (see Path 2).
3. **One checks it for you.** It verifies, in plain language:
   - ✅ One can sign in to your cloud
   - ✅ It has just the permissions it needs (and nothing more)
   - ⚠️/✅ You have GPU capacity in your region (One will tell you if you need to request it)
4. **You're set.** One keeps work on your Mac and only bursts when it has to — and always shuts the
   cloud machine down when it's done.

Your key is checked against your project, then **kept on your Mac** (in the Secure Enclave). Hushh
never stores it, and your data runs only in your own cloud.

---

## Path 2 — Set up the cloud (admins & automation)

Provision the project once; it creates a **least-privilege** identity One can use. Pick one:

**A. One command**
```bash
PROJECT_ID=your-project REGION=us-central1 CREATE_KEY=true ./provisioning/setup.sh
# add ENABLE_TPU=true for the TPU path
```

**B. Terraform** (drop into any IaC pipeline)
```bash
cd provisioning/terraform
terraform init
terraform apply -var project_id=your-project -var region=us-central1 -var create_key=true
```

Both produce a service account with only the permissions a burst needs, optionally a TPU result
bucket, and optionally a key to paste into One. Full details and the keyless (Workload Identity
Federation) option: `provisioning/README.md`.

---

## What "a burst" looks like

1. You run something heavy. Your Mac starts to strain (out of memory, thermal throttling, or it'd just
   be slow).
2. One says, briefly: *"This one needs more power — borrowing a supercomputer to finish it faster."*
3. It runs the job on a GPU (or TPU) in **your** cloud, showing live progress and an honest cost
   estimate.
4. The result lands exactly as if it ran locally. One adds: *"Done. Borrowed a supercomputer and
   cleaned it up. Cost: $0.62, billed to your cloud."*
5. The cloud machine is gone. Nothing left running, nothing to manage.

If you step away mid-job, One keeps working and notifies you when it's done — you never lose a job, and
nothing is left running.

---

## Your control, your privacy

- **Your keys stay yours.** The cloud key lives on your device; Hushh never stores it.
- **Your data stays yours.** Workloads run in **your** Google Cloud project. Hushh keeps none of your
  workload content.
- **Least privilege.** One asks only for permission to start and stop machines — nothing else.
- **No surprises.** One tells you when it uses the cloud, whose cloud (yours), and what it cost. Cost
  caps are on by default.
- **Disconnect anytime.** Removing the key instantly stops all bursting — One simply runs on your Mac.

---

## Costs

Bursts are billed by **Google Cloud to your project**, not by Hushh. One shows a live estimate during a
burst and a one-line summary after, keeps sensible **per-burst and per-day caps** on by default, and
asks before any unusually large job. You can review a simple history of what ran where and what it cost.

---

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| "Your cloud doesn't have GPU capacity here yet." | No GPU quota in that region. | One-tap link to request quota, or let One keep the job on your Mac. |
| "One couldn't reach your cloud." | The key may be wrong, expired, or revoked. | Re-paste a current key (Settings → Connect your cloud). |
| "That job didn't finish." | The burst failed. | Nothing was left running and you weren't charged for the result. Try again, or run locally. |
| TPU jobs won't start | TPU needs a result bucket. | Re-run provisioning with `ENABLE_TPU=true` and set `ONE_BURST_TPU_RESULT_BUCKET`. |

---

## FAQ

**Do I need to be a cloud expert?** No. If you can paste a key, you're done. The setup flow checks
everything for you.

**Where does my data go?** Into your own Google Cloud project, only when a burst is needed. Hushh keeps
none of it.

**What if I never connect a cloud?** One still works — it just runs everything on your Mac and asks to
connect only the first time a burst would genuinely help.

**GPU or TPU?** One picks the right accelerator for the job. GPU is the default; TPU is available once
you've enabled it (a result bucket + TPU quota).

**How do I stop using it?** Remove the key in Settings — bursting stops immediately.

---

## More

- Provision your cloud: `provisioning/README.md`
- Operate/deploy (for engineers): `docs/runbooks/forward-deployed-engineer-playbook.md`
- How it works (technical): `docs/whitepaper-xtreme-compute-burst.md`
- Privacy & security details: `docs/specs/byoc-security-privacy.md`
