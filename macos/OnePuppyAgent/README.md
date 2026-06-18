# One Puppy — macOS On-Device Agent

The native macOS agent for Hushh One **Xtreme Compute Burst**. It turns a Mac into a personal
supercomputer that *knows when to ask for help*: it runs workloads on-device, senses when the
Mac can't keep up, and hands off to the control plane to burst into the user's own cloud — then
brings the result home.

This is the deliverable described in **`docs/specs/one-puppy-macos-agent.md`**, built to the UX
bar in **`docs/specs/macos-experience.md`**, against the API contract in
**`docs/specs/burst-control-plane.openapi.yaml`** (threshold/hysteresis constants come from
**`docs/specs/placement-autoscale.md`**, credential rules from
**`docs/specs/byoc-security-privacy.md`**).

> **The device talks only to the documented HTTP control plane.** It never calls GCP directly.
> All cloud complexity (provisioning, accelerator choice, teardown, recovery) lives server-side.
> The BYOC key only ever goes to the Keychain and to the control plane over TLS for the user's
> own burst — it is never logged, never synced, never sent anywhere else.

---

## Architecture

```
┌──────────────────────────── OnePuppyAgent (SwiftUI app) ────────────────────────────┐
│  OnePuppyApp  ──  MenuBarExtra  ──  AppModel (UI state)                              │
│       │                                   │                                          │
│  OnboardingView (3 screens)         MenuBarView (idle / local / bursting / fail)     │
└───────────────────────────────────────────┬────────────────────────────────────────┘
                                             │  uses
┌──────────────────────────────── OnePuppyKit (testable core) ─────────────────────────┐
│  OnePuppyController   orchestrates: profile → submit → handshake → run/stream → ledger │
│     ├─ DeviceProfiler   cpu/mem/gpu/disk/net/online → DeviceProfile                    │
│     ├─ PressureMonitor  memory-pressure + thermal + ETA → debounced "should burst"     │
│     ├─ KeychainVault     validate + store/read/delete the BYOC GCP SA JSON             │
│     ├─ BurstClient       POST /burst (JSON puppy | NDJSON cloud), puppy-result, recover │
│     ├─ LocalRunner       protocol; ContainerCLILocalRunner stub = the integration point │
│     └─ JobLedger         crash-safe in-flight burstJobIds in Application Support        │
│  Models   Codable mirrors of the control-plane contract                                │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **OnePuppyKit** is pure Foundation/Network/Security/Metal/IOKit — no UI, no third-party deps —
  so it is fully unit-testable on CI.
- **OnePuppyAgent** is a deliberately thin SwiftUI menu-bar app that renders `OnePuppyKit`'s
  events. No business logic lives in the UI layer.

### The control-plane handshake (implemented exactly)

```
POST /api/one/burst   (Authorization: Bearer <Firebase ID token>;  X-BYOC-Provider: gcp when a key is attached)
  → 200 application/json     PuppyHandshake → run locally → POST /api/one/burst/{id}/puppy-result
  → 200 application/x-ndjson  start → progress* → (done | error | pending)   → surface progress
Recover (stream dropped / app restart):  GET /api/one/burst/{id} → BurstStatus  until terminal
```

---

## Build / test / run on a Mac

> This package is **source built to spec**. It is compiled, tested, and notarized on a Mac —
> not in the authoring environment. Requires **Xcode 15+ / Swift 5.9+**, **macOS 14 (Sonoma)+**.

### Command line (SwiftPM)

```bash
cd macos/OnePuppyAgent

# Build everything (library + app + tests).
swift build

# Run the unit suites (Models round-trips, KeychainVault validation, PressureMonitor
# dwell/cooldown, BurstClient request shaping + NDJSON decode, JobLedger, controller).
swift test

# Run the menu-bar app from the CLI (a MenuBarExtra app has no Dock icon by default;
# look for the paw glyph in the menu bar).
swift run OnePuppyAgent
```

The Keychain *validation* tests run anywhere. Tests that *write* to the real Keychain need a
signed, entitled host, so the suites here exercise the pure `validate(...)` path and stub the
network via `URLProtocol` — everything in `swift test` is hermetic and CI-safe.

### Xcode / archive / notarize

1. **Open** the package in Xcode (`File ▸ Open…` the `macos/OnePuppyAgent` folder) or generate
   an app project/workspace around it. The `OnePuppyAgent` executable target is the app.
2. **Signing & Capabilities:** set your Team, enable **Hardened Runtime**, add **App Sandbox**,
   **Network ▸ Outgoing Connections (Client)**, and **Keychain Sharing** (group
   `ai.hushh.onepuppy`). Attach `OnePuppyAgent.entitlements`.
3. **Archive:** `Product ▸ Archive` (or `xcodebuild -scheme OnePuppyAgent archive`).
4. **Notarize:**
   ```bash
   xcrun notarytool submit OnePuppyAgent.zip \
     --apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APP_SPECIFIC_PASSWORD" --wait
   xcrun stapler staple OnePuppyAgent.app
   ```
5. **Distribute** via Developer ID (signed update channel) or the App Store (§9).

---

## Entitlements (least privilege — §9)

See `OnePuppyAgent.entitlements`. Summary:

| Entitlement | Why |
|---|---|
| `com.apple.security.app-sandbox` | Sandbox on where feasible. |
| `com.apple.security.network.client` | Outbound **TLS to the control plane only** — no server, no inbound. |
| `keychain-access-groups` (`ai.hushh.onepuppy`) | The BYOC SA JSON + the stable device-id UUID (both `…WhenUnlockedThisDeviceOnly`, never synced). |
| Hardened Runtime | Required for notarization; **no** `cs.*` exceptions added. |

**Container runtime:** on-device execution (§7) shells the host container runtime via the
`LocalRunner` protocol (default `ContainerCLILocalRunner` — the **integration point**, currently
a clearly-marked stub). A real runtime that needs privilege should run in a **separate signed,
notarized helper** (XPC/launchd), entitled narrowly — not by broadening this app. Running
arbitrary containers in-process is generally incompatible with a strict App Sandbox; if a build
needs that, disable the sandbox for that build and **document the exception** for review rather
than silently weakening it.

---

## Privacy manifest — `PrivacyInfo.xcprivacy`

Add this file to the app target (truthful per §9/§10 — no workload content leaves the device
except to the user's own cloud; the key never leaves the device except to the control plane over
TLS for the user's own burst; telemetry is non-content, non-credential):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- We do not track users across apps/sites. -->
  <key>NSPrivacyTracking</key>
  <false/>
  <key>NSPrivacyTrackingDomains</key>
  <array/>

  <!-- Data collected: only non-content, non-credential operational telemetry (§10):
       placement decisions, burst counts/durations/outcomes, pressure-trigger reasons,
       correlated only on an opaque burstJobId. No workload payload, no key, no file contents. -->
  <key>NSPrivacyCollectedDataTypes</key>
  <array>
    <dict>
      <key>NSPrivacyCollectedDataType</key>
      <string>NSPrivacyCollectedDataTypeProductInteraction</string>
      <key>NSPrivacyCollectedDataTypeLinked</key>
      <false/>
      <key>NSPrivacyCollectedDataTypeTracking</key>
      <false/>
      <key>NSPrivacyCollectedDataTypePurposes</key>
      <array>
        <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
      </array>
    </dict>
  </array>

  <!-- Required-reason APIs we use. -->
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <!-- Free disk space via volumeAvailableCapacityForImportantUsage (DeviceProfiler). -->
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryDiskSpace</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>E174.1</string></array>
    </dict>
    <dict>
      <!-- Application Support file timestamps (JobLedger atomic writes). -->
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>C617.1</string></array>
    </dict>
    <dict>
      <!-- sysctl for hw.memsize / hw.model (system info; non-identifying). -->
      <key>NSPrivacyAccessedAPIType</key>
      <string>NSPrivacyAccessedAPICategorySystemBootTime</string>
      <key>NSPrivacyAccessedAPITypeReasons</key>
      <array><string>35F9.1</string></array>
    </dict>
  </array>
</dict>
</plist>
```

> Verify the exact required-reason codes against Apple's current list at notarization time; the
> set above maps DiskSpace / FileTimestamp / system-info usage to their App-Functionality reasons.

---

## Security posture (enforced in code)

- **TLS only.** `BurstClient` refuses any non-`https` base URL.
- **Token + key never logged.** No `print`/`os_log` of the Authorization token or the SA JSON
  anywhere in the codebase; error strings surface only the control plane's own user-safe text.
- **Key at rest:** Keychain generic password, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
  (Secure-Enclave-protected on capable hardware), validated (`client_email`/`private_key`/
  `project_id`) before storing, deleted on disconnect — leaving nothing behind (§11.5).
- **Device id:** a random Keychain UUID, never a hardware serial (§5).
- **Crash-safe:** in-flight `burstJobId`s persist to Application Support; relaunch re-attaches
  via `GET /api/one/burst/{id}` (§8).

## What's a stub vs. real

Everything is real, compilable Swift built to the contract, **except** the single, clearly-marked
on-device execution boundary: `ContainerCLILocalRunner.run(...)` returns a normalized placeholder
instead of actually spawning a container. Swap in the host container runtime (Apple's `container`
framework, or a Metal/CoreML native runner) behind the `LocalRunner` protocol — that's the only
integration point. The Firebase ID token is supplied by a `TokenProvider` the app wires to the
Firebase Auth SDK (kept out of the core so the core stays dependency-free and testable).

## Related specs

- `docs/specs/one-puppy-macos-agent.md` — agent responsibilities, handshake, packaging
- `docs/specs/macos-experience.md` — the UX bar (onboarding, menu bar, failure states)
- `docs/specs/burst-control-plane.openapi.yaml` — the HTTP contract
- `docs/specs/placement-autoscale.md` — pressure thresholds, dwell, cooldown
- `docs/specs/byoc-security-privacy.md` — BYOC key handling rules
