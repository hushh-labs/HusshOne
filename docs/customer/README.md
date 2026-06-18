# One Burst Compute — customer documentation

Plain-English docs for getting **One Burst Compute** working as a product — for the people who use it
and the people (or systems) who provision the cloud behind it.

| Doc | For | What it covers |
|---|---|---|
| [Getting started](./getting-started.md) | Everyone | Connect your cloud, your first burst, costs, privacy, troubleshooting, FAQ. |
| [Provisioning your cloud](../../provisioning/README.md) | Admins / automation | One-command script **or** Terraform to set up a least-privilege BYOC project (and the TPU bucket). |
| [In-app setup](../../src/app/burst/setup) | Everyone | The `/burst/setup` page that validates your key (auth, permissions, quota). |

For engineers operating or extending the system, continue to:
- Forward-deployed engineer playbook: `../runbooks/forward-deployed-engineer-playbook.md`
- Full specification set: `../specs/README.md`
- White paper: `../whitepaper-xtreme-compute-burst.md`

**Promise to the customer:** your keys and your data stay yours — bursts run in your own cloud, the key
lives on your device, and One only borrows a supercomputer when your Mac needs one.
