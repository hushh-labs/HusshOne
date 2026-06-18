//
//  PressureMonitor.swift
//  OnePuppyKit
//
//  The Puppy is the *sensor*; the control plane is the *decider* (one-puppy-macos-agent.md §3).
//  This monitor samples runtime distress on the Mac and computes a debounced "should burst"
//  signal that respects minimum local-dwell and a device-wide cooldown so it never flaps.
//
//  All thresholds, dwell windows, and the cooldown are taken verbatim from
//  placement-autoscale.md §4. The constants below cite their source rows.
//
//  Sources of truth on macOS:
//    • Memory pressure — DispatchSource.makeMemoryPressureSource (warn/critical levels)
//    • Thermal state   — ProcessInfo.processInfo.thermalState (serious/critical)
//  (Swap rate, GPU/CPU saturation and ETA overrun from §4.1 are additional inputs the
//   orchestrator can feed in via `ingest(sample:)`; this type owns the debounce/dwell math.)
//
//  Testability: time is injected via a `Clock` closure so the dwell/cooldown logic is fully
//  deterministic under XCTest with no real waiting.
//

import Foundation
import Dispatch

// MARK: - Spec constants (placement-autoscale.md §4)

public enum PressureSpec {
    /// §4.3 — Minimum local dwell: a freshly admitted local job cannot be promoted for its
    /// first 90s (absorbs warm-up spikes: model load, page-in).
    public static let minLocalDwell: TimeInterval = 90

    /// §4.3 — Cooldown: after any promotion, suppress *new* promotions device-wide for 5 min.
    public static let cooldown: TimeInterval = 300

    /// §4.3 — Confirmation hold: between PROMOTE and provisioning, re-sample for 10s; if all
    /// fire-conditions clear within H it was a pure transient — cancel. (thermal==critical skips H.)
    public static let confirmationHold: TimeInterval = 10

    /// §4.1 — Memory pressure dwell (the "for ≥ 30s" column) for both warn and fire.
    public static let memoryDwell: TimeInterval = 30

    /// §4.1 — Sample period.
    public static let samplePeriod: TimeInterval = 5
}

// MARK: - Inputs

/// The macOS memory-pressure level, mapped from DispatchSource memory-pressure events and the
/// §4.1 percentage bands. We treat the OS `critical` level as an immediate fire condition.
public enum MemoryPressureLevel: Int, Sendable, Comparable {
    case normal = 0
    case warning = 1   // OS DISPATCH_MEMORYPRESSURE_WARN  → §4.1 warn band (≥70%)
    case critical = 2  // OS DISPATCH_MEMORYPRESSURE_CRITICAL → §4.1 fire (level == "critical")

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// Thermal state, mapped from ProcessInfo.ThermalState (§4.1 thermal row).
public enum ThermalLevel: Int, Sendable, Comparable {
    case nominal = 0
    case fair = 1
    case serious = 2   // §4.1 warn
    case critical = 3  // §4.1 fire (and bypasses the confirmation hold, §4.3)

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }

    init(_ thermal: ProcessInfo.ThermalState) {
        switch thermal {
        case .nominal: self = .nominal
        case .fair: self = .fair
        case .serious: self = .serious
        case .critical: self = .critical
        @unknown default: self = .nominal
        }
    }
}

/// One sampled snapshot of runtime distress, fed in every `samplePeriod`.
public struct PressureSample: Sendable, Equatable {
    public var memory: MemoryPressureLevel
    public var thermal: ThermalLevel
    /// ETA overrun ratio = projectedMinutes / estimate.estimatedMinutes (§4.1 ETA row). 1.0 = on track.
    public var etaRatio: Double
    /// Projected remaining minutes — gates the ETA fire condition (§4.1: fire needs > 10 min remaining).
    public var projectedRemainingMinutes: Double

    public init(
        memory: MemoryPressureLevel = .normal,
        thermal: ThermalLevel = .nominal,
        etaRatio: Double = 1.0,
        projectedRemainingMinutes: Double = 0
    ) {
        self.memory = memory
        self.thermal = thermal
        self.etaRatio = etaRatio
        self.projectedRemainingMinutes = projectedRemainingMinutes
    }
}

// MARK: - Output

/// A debounced pressure verdict the orchestrator acts on.
public struct PressureScore: Sendable, Equatable {
    /// Normalized score in [0,1] = the max normalized fire/warn contribution. Informational.
    public var score: Double
    /// The promotion decision after dwell/cooldown/min-dwell are all satisfied (§4.2/§4.3).
    public var shouldBurst: Bool
    /// A short, secrets-free reason for telemetry/UX (e.g. "memory pressure", "thermal critical").
    public var reason: String
}

// MARK: - PressureMonitor

/// Owns the §4 debounce state machine. Drive it by calling `ingest(_:)` once per sample with a
/// fresh `PressureSample`; observe verdicts via the `scores` AsyncStream (or the `onScore` callback).
///
/// The actor is isolated, so dwell timers are race-free. `now` is injectable for tests.
public actor PressureMonitor {
    public typealias Clock = @Sendable () -> Date

    private let now: Clock

    // Live OS sources (no-ops in a headless test; the orchestrator can also push samples directly).
    private var memorySource: DispatchSourceMemoryPressure?

    // Continuous-cross tracking: the timestamp a signal first crossed its threshold, or nil if below.
    private var memoryWarnSince: Date?
    private var memoryFireSince: Date?
    private var thermalWarnSince: Date?
    private var etaWarnSince: Date?
    private var etaFireSince: Date?

    // §4.3 latches.
    /// When the local run was admitted — used for the min-dwell gate.
    private var admittedAt: Date?
    /// When the last promotion happened (device-wide cooldown).
    private var lastPromotionAt: Date?
    /// Promotion is one-way and latched: once promoted, stay promoted for this run.
    private var latchedPromoted = false

    private var continuation: AsyncStream<PressureScore>.Continuation?

    public init(now: @escaping Clock = { Date() }) {
        self.now = now
    }

    /// Mark the start of a fresh local run. Resets per-run latches and starts the min-dwell clock.
    public func admitLocalRun(at date: Date? = nil) {
        admittedAt = date ?? now()
        latchedPromoted = false
        memoryWarnSince = nil; memoryFireSince = nil
        thermalWarnSince = nil
        etaWarnSince = nil; etaFireSince = nil
    }

    /// An AsyncStream of debounced verdicts. Each `ingest` may emit at most one score.
    public func scores() -> AsyncStream<PressureScore> {
        AsyncStream { continuation in
            self.continuation = continuation
        }
    }

    /// Begin listening to the real OS memory-pressure source. Maps OS levels onto §4.1 bands.
    /// Each OS event becomes a `PressureSample` carrying only the memory dimension; callers that
    /// also track thermal/ETA should prefer `ingest(_:)` with a fully-populated sample.
    public func startOSMemoryPressureSource() {
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .global())
        source.setEventHandler { [weak self] in
            let data = source.data
            let level: MemoryPressureLevel = data.contains(.critical) ? .critical
                : data.contains(.warning) ? .warning : .normal
            Task { await self?.ingest(PressureSample(memory: level, thermal: ThermalLevel(ProcessInfo.processInfo.thermalState))) }
        }
        source.resume()
        memorySource = source
    }

    public func stop() {
        memorySource?.cancel()
        memorySource = nil
        continuation?.finish()
        continuation = nil
    }

    /// Ingest one sample, advance the dwell state machine, and (if a verdict changed) emit a score.
    /// Returns the computed score so tests can assert without consuming the stream.
    @discardableResult
    public func ingest(_ sample: PressureSample) -> PressureScore {
        let t = now()

        // --- Track continuous threshold crossings (reset to nil if the signal dips below). ---
        // Memory (§4.1: warn ≥70% for ≥30s; fire ≥85% for ≥30s OR level==critical).
        update(&memoryWarnSince, crossed: sample.memory >= .warning, at: t)
        update(&memoryFireSince, crossed: sample.memory >= .critical, at: t)
        // Thermal (§4.1: serious = warn; critical = fire).
        update(&thermalWarnSince, crossed: sample.thermal >= .serious, at: t)
        // ETA overrun (§4.1: warn ≥1.5; fire ≥2.0 AND remaining > 10 min).
        update(&etaWarnSince, crossed: sample.etaRatio >= 1.5, at: t)
        update(&etaFireSince, crossed: sample.etaRatio >= 2.0 && sample.projectedRemainingMinutes > 10, at: t)

        // --- Evaluate fire conditions (a signal fires only after its dwell holds). §4.2 ---
        let memoryFire = held(memoryFireSince, for: PressureSpec.memoryDwell, at: t)
        let thermalFire = sample.thermal >= .critical // thermal critical is immediate (§4.1/§4.3)
        // ETA has no explicit dwell column beyond "projectedRemaining" — require one sample window.
        let etaFire = held(etaFireSince, for: PressureSpec.samplePeriod, at: t)
        let anyFire = memoryFire || thermalFire || etaFire

        // --- Evaluate warn conditions (≥2 distinct sustained warns also promote). §4.2 ---
        let memoryWarn = held(memoryWarnSince, for: PressureSpec.memoryDwell, at: t)
        let thermalWarn = held(thermalWarnSince, for: PressureSpec.samplePeriod, at: t) && sample.thermal >= .serious
        let etaWarn = held(etaWarnSince, for: PressureSpec.samplePeriod, at: t)
        let warnCount = [memoryWarn, thermalWarn, etaWarn].filter { $0 }.count

        // Raw degradation signal before the anti-flap gates.
        let wantsPromotion = anyFire || warnCount >= 2

        // --- Anti-flap gates (§4.3): min local dwell, cooldown, latch. ---
        let pastMinDwell = admittedAt.map { t.timeIntervalSince($0) >= PressureSpec.minLocalDwell } ?? false
        let pastCooldown = lastPromotionAt.map { t.timeIntervalSince($0) >= PressureSpec.cooldown } ?? true

        let reason = Self.reasonFor(
            memoryFire: memoryFire, thermalFire: thermalFire, etaFire: etaFire,
            memoryWarn: memoryWarn, thermalWarn: thermalWarn, etaWarn: etaWarn, warnCount: warnCount
        )

        var shouldBurst = false
        if latchedPromoted {
            // Latched: stay promoted for the rest of this run regardless of subsiding pressure.
            shouldBurst = true
        } else if wantsPromotion && pastMinDwell && pastCooldown {
            shouldBurst = true
            latchedPromoted = true
            lastPromotionAt = t
        }

        let score = PressureScore(
            score: Self.normalizedScore(anyFire: anyFire, warnCount: warnCount),
            shouldBurst: shouldBurst,
            reason: reason
        )
        continuation?.yield(score)
        return score
    }

    /// True iff `since` is set and the gap to `t` meets `dwell` (continuous-hold check).
    private func held(_ since: Date?, for dwell: TimeInterval, at t: Date) -> Bool {
        guard let since else { return false }
        return t.timeIntervalSince(since) >= dwell
    }

    /// Start/clear a "crossed since" timestamp without resetting it while the signal stays high.
    private func update(_ since: inout Date?, crossed: Bool, at t: Date) {
        if crossed {
            if since == nil { since = t } // first crossing — start the dwell clock
        } else {
            since = nil // dipped below threshold — dwell resets (§4.3 "resets if it dips")
        }
    }

    private static func normalizedScore(anyFire: Bool, warnCount: Int) -> Double {
        if anyFire { return 1.0 }
        if warnCount >= 2 { return 0.8 }
        if warnCount == 1 { return 0.5 }
        return 0.0
    }

    private static func reasonFor(
        memoryFire: Bool, thermalFire: Bool, etaFire: Bool,
        memoryWarn: Bool, thermalWarn: Bool, etaWarn: Bool, warnCount: Int
    ) -> String {
        if thermalFire { return "thermal critical" }
        if memoryFire { return "memory pressure critical" }
        if etaFire { return "ETA overrun" }
        if warnCount >= 2 {
            var parts: [String] = []
            if memoryWarn { parts.append("memory pressure") }
            if thermalWarn { parts.append("thermal") }
            if etaWarn { parts.append("ETA overrun") }
            return "sustained: " + parts.joined(separator: " + ")
        }
        return "nominal"
    }
}
