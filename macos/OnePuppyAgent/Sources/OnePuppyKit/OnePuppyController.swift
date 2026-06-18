//
//  OnePuppyController.swift
//  OnePuppyKit
//
//  The orchestrator (one-puppy-macos-agent.md §§5–8). It:
//    1. builds a DeviceProfile (DeviceProfiler),
//    2. submits the workload to the control plane (BurstClient), attaching the BYOC block
//       from the Keychain when a key is connected,
//    3. handles the handshake:
//         • puppy  → run the workload locally (LocalRunner) → reportPuppyResult,
//         • cloud  → consume the NDJSON stream and surface progress,
//    4. keeps a crash-safe ledger of in-flight burstJobIds (Application Support) so a relaunch
//       re-attaches via GET /api/one/burst/{id} (§8).
//
//  Auth tokens: the controller asks a `TokenProvider` for a fresh Firebase ID token per call
//  (the Firebase SDK lives in the app layer; the core stays dependency-free and testable).
//

import Foundation

// MARK: - LocalRunner (the on-device execution integration point)

/// Runs the containerized/native workload locally and returns a normalized result blob
/// (one-puppy-macos-agent.md §7). The result shape MUST match what the cloud path returns so
/// the UX is identical regardless of where the work ran.
///
/// This is the single integration point with the host's container runtime. The default
/// implementation below is a clearly-marked stub that shells out to a `container`-style CLI;
/// a production build swaps in a real runner (Apple's `container` framework, or a Metal/CoreML
/// native runner for accelerator tasks) behind this same protocol.
public protocol LocalRunner: Sendable {
    /// Run `spec` to completion locally. Throw to signal a failed run (the controller reports
    /// `failed` to puppy-result so the ledger never lies). `onProgress` surfaces live status.
    func run(
        _ spec: JobSpec,
        onProgress: @Sendable @escaping (String) -> Void
    ) async throws -> JSONValue
}

/// Default LocalRunner — the INTEGRATION POINT. It shells a container command as a placeholder
/// so the contract compiles end-to-end; replace `command`/parsing with the real runtime call.
///
/// IMPORTANT: this stub is intentionally inert about *what* it runs. It demonstrates the shape:
/// spawn the image's command, stream stdout as progress, and return a normalized result. Wire
/// this to the user's container runtime before shipping.
public struct ContainerCLILocalRunner: LocalRunner {
    /// The runtime binary to invoke (e.g. Apple's `container`, or `docker`/`podman` if present).
    public let runtimeBinary: String

    public init(runtimeBinary: String = "/usr/local/bin/container") {
        self.runtimeBinary = runtimeBinary
    }

    public func run(
        _ spec: JobSpec,
        onProgress: @Sendable @escaping (String) -> Void
    ) async throws -> JSONValue {
        // ── INTEGRATION POINT ──────────────────────────────────────────────────────────────
        // A production implementation builds the argument vector for the host container
        // runtime: `<runtimeBinary> run --rm <image> <command…>` plus resource limits derived
        // from `spec.estimate`, streams stdout/stderr to `onProgress`, enforces the estimate,
        // and aborts→bursts if the run blows past it (one-puppy-macos-agent.md §7).
        //
        // The stub below returns a normalized placeholder so the handshake path is exercisable
        // without a runtime installed. It does NOT actually execute the container.
        onProgress("Preparing \(spec.image) on this Mac…")
        onProgress("Running on this Mac…")
        return .object([
            "ranLocally": .bool(true),
            "image": .string(spec.image),
            "note": .string("ContainerCLILocalRunner stub — wire to the host container runtime."),
        ])
    }
}

// MARK: - TokenProvider

/// Supplies a fresh Firebase ID token. The app layer backs this with the Firebase SDK;
/// the core never depends on Firebase directly.
public protocol TokenProvider: Sendable {
    func currentToken() async throws -> String
}

// MARK: - Job ledger (crash-safe, in Application Support)

/// Persists in-flight burst job ids so the agent re-attaches after a restart (§8).
/// Stored as a tiny JSON file in Application Support — no secrets, only opaque job ids.
public actor JobLedger {
    public struct Entry: Codable, Sendable, Equatable {
        public let burstJobId: String
        public let placement: String   // "puppy" | "gcp"
        public let createdAt: Date
    }

    private let url: URL
    private var entries: [String: Entry] = [:]

    /// - Parameter directory: defaults to ~/Library/Application Support/OnePuppyAgent.
    public init(directory: URL? = nil, fileName: String = "in-flight-jobs.json") {
        let dir = directory ?? Self.defaultDirectory()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.url = dir.appendingPathComponent(fileName)
        load()
    }

    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("OnePuppyAgent", isDirectory: true)
    }

    private func load() {
        guard let data = try? Data(contentsOf: url),
              let list = try? JSONDecoder().decode([Entry].self, from: data) else { return }
        entries = Dictionary(uniqueKeysWithValues: list.map { ($0.burstJobId, $0) })
    }

    private func persist() {
        let list = Array(entries.values).sorted { $0.createdAt < $1.createdAt }
        if let data = try? JSONEncoder().encode(list) {
            try? data.write(to: url, options: .atomic)
        }
    }

    public func add(_ entry: Entry) {
        entries[entry.burstJobId] = entry
        persist()
    }

    public func remove(_ burstJobId: String) {
        entries.removeValue(forKey: burstJobId)
        persist()
    }

    public func all() -> [Entry] {
        Array(entries.values).sorted { $0.createdAt < $1.createdAt }
    }
}

// MARK: - Controller events (for the UI)

/// What the controller surfaces to the UI. Deliberately content-free beyond human progress text.
public enum PuppyEvent: Sendable, Equatable {
    case decidedLocal(reason: String)
    case localProgress(String)
    case localCompleted
    case localFailed(String)

    case bursting(reason: String)
    case burstProgress(line: String, elapsedMs: Int?)
    case burstCompleted(result: JSONValue?)
    case burstPending(reason: String, message: String?)   // deadline handoff (§6 of UX spec)
    case burstFailed(String)

    case recovered(BurstStatus)
}

// MARK: - Controller

public actor OnePuppyController {
    private let client: BurstClient
    private let profiler: DeviceProfiler
    private let vault: KeychainVault
    private let runner: LocalRunner
    private let tokens: TokenProvider
    private let ledger: JobLedger

    public init(
        client: BurstClient,
        profiler: DeviceProfiler = DeviceProfiler(),
        vault: KeychainVault = KeychainVault(),
        runner: LocalRunner = ContainerCLILocalRunner(),
        tokens: TokenProvider,
        ledger: JobLedger = JobLedger()
    ) {
        self.client = client
        self.profiler = profiler
        self.vault = vault
        self.runner = runner
        self.tokens = tokens
        self.ledger = ledger
    }

    // MARK: Submit + handshake

    /// Submit a workload and drive it to completion, emitting `PuppyEvent`s via `emit`.
    /// `regionPreference` is an optional BYOC region hint; the project id comes from the SA JSON.
    public func submit(
        _ spec: JobSpec,
        regionPreference: String? = nil,
        emit: @Sendable @escaping (PuppyEvent) -> Void
    ) async {
        do {
            let token = try await tokens.currentToken()
            let profile = await profiler.currentProfile()
            // Attach the BYOC block only if a key is connected; otherwise we run local-only.
            let byoc = vault.makeByocBlock(region: regionPreference)
            let request = BurstRequest(spec: spec, deviceProfile: profile, byoc: byoc)

            let outcome = try await client.submitBurst(request, firebaseToken: token)
            switch outcome {
            case .puppy(let handshake):
                await handlePuppy(handshake, spec: spec, token: token, emit: emit)
            case .cloud(let stream):
                await consumeCloud(stream, emit: emit)
            }
        } catch {
            emit(.burstFailed(userFacing(error)))
        }
    }

    /// Puppy placement: record the job, run locally, then report the result (idempotent).
    private func handlePuppy(
        _ handshake: PuppyHandshake,
        spec: JobSpec,
        token: String,
        emit: @Sendable @escaping (PuppyEvent) -> Void
    ) async {
        emit(.decidedLocal(reason: handshake.reason))
        guard let jobId = handshake.handshake.jobId ?? handshake.burstJobId else {
            // No id to report against — nothing to track; run locally as a courtesy and stop.
            emit(.localFailed("The control plane didn't return a job id."))
            return
        }
        await ledger.add(.init(burstJobId: jobId, placement: "puppy", createdAt: Date()))

        let startedAt = Date()
        do {
            let result = try await runner.run(spec) { line in emit(.localProgress(line)) }
            let runMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            _ = try await client.reportPuppyResult(
                jobId: jobId, .completed(result: result, runMs: runMs), firebaseToken: token
            )
            await ledger.remove(jobId)
            emit(.localCompleted)
        } catch {
            // No orphaned local work: a run we abandon reports `failed` so the ledger never lies (§8).
            let runMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            let message = userFacing(error)
            // Best-effort failure report; even if it fails, we still drop the ledger entry on relaunch.
            _ = try? await client.reportPuppyResult(
                jobId: jobId, .failed(error: message, runMs: runMs), firebaseToken: token
            )
            await ledger.remove(jobId)
            emit(.localFailed(message))
        }
    }

    /// Cloud burst: consume the NDJSON stream and surface progress until a terminal frame.
    private func consumeCloud(
        _ stream: BurstFrameStream,
        emit: @Sendable @escaping (PuppyEvent) -> Void
    ) async {
        var trackedJobId: String?
        do {
            for try await frame in stream {
                if let id = frame.burstJobId, trackedJobId == nil {
                    trackedJobId = id
                    await ledger.add(.init(burstJobId: id, placement: "gcp", createdAt: Date()))
                }
                switch frame.type {
                case .start:
                    emit(.bursting(reason: frame.scanning ?? "Borrowing a supercomputer to finish this faster."))
                case .progress:
                    if let line = frame.scanning { emit(.burstProgress(line: line, elapsedMs: frame.elapsedMs)) }
                case .done:
                    if let id = trackedJobId { await ledger.remove(id) }
                    emit(.burstCompleted(result: frame.result))
                case .pending:
                    // Deadline handoff: the work continues server-side and we'll be notified.
                    // Keep the ledger entry so a relaunch recovers it.
                    emit(.burstPending(reason: frame.reason ?? "deadline", message: frame.message))
                case .error:
                    if let id = trackedJobId { await ledger.remove(id) }
                    emit(.burstFailed(frame.error ?? "That job didn't finish."))
                }
            }
        } catch {
            // Stream dropped mid-flight. The burst keeps running server-side; recover on the
            // tracked id (§8). If we never saw an id, surface a calm failure.
            if let id = trackedJobId {
                await recoverUntilTerminal(jobId: id, emit: emit)
            } else {
                emit(.burstFailed(userFacing(error)))
            }
        }
    }

    // MARK: Recovery (§8)

    /// On launch, re-attach to any in-flight jobs the ledger remembers. Cloud jobs are polled
    /// to terminal; puppy jobs simply remain (the control plane reports them out-of-band, and a
    /// puppy GET returns `running` — we leave the entry and let a fresh run reconcile).
    public func reattachInFlightJobs(emit: @Sendable @escaping (PuppyEvent) -> Void) async {
        let entries = await ledger.all()
        for entry in entries where entry.placement == "gcp" {
            await recoverUntilTerminal(jobId: entry.burstJobId, emit: emit)
        }
    }

    /// Poll GET /api/one/burst/{id} until terminal, then emit and drop the ledger entry.
    /// Bounded retries with a fixed delay; the control plane self-heals stale rows.
    private func recoverUntilTerminal(
        jobId: String,
        maxAttempts: Int = 120,
        delay: Duration = .seconds(5),
        emit: @Sendable @escaping (PuppyEvent) -> Void
    ) async {
        for _ in 0..<maxAttempts {
            do {
                let token = try await tokens.currentToken()
                let status = try await client.recover(jobId: jobId, firebaseToken: token)
                if status.isTerminal || status.status == .unknown {
                    await ledger.remove(jobId)
                    emit(.recovered(status))
                    return
                }
            } catch {
                // Transient — keep trying; the burst is safe server-side.
            }
            try? await Task.sleep(for: delay)
        }
        // Gave up waiting inline; leave the ledger entry for the next launch to retry.
    }

    // MARK: - Helpers

    /// Map any error to a calm, secrets-free string. We never echo a token or the SA JSON; the
    /// errors we raise here are already user-safe (BurstClientError surfaces only the control
    /// plane's own error text).
    private nonisolated func userFacing(_ error: Error) -> String {
        if let e = error as? BurstClientError {
            if case .http(_, let body) = e { return body }
            return e.description
        }
        return (error as? CustomStringConvertible)?.description ?? "Something went wrong."
    }
}
