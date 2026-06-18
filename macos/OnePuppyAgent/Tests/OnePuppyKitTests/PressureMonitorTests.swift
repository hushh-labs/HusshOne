//
//  PressureMonitorTests.swift
//  OnePuppyKitTests
//
//  Debounce / dwell / cooldown logic with an injected clock (placement-autoscale.md §4).
//  No real waiting — `now` is a mutable closure we advance by hand.
//

import XCTest
@testable import OnePuppyKit

final class PressureMonitorTests: XCTestCase {

    /// A deterministic, advanceable clock shared with the monitor.
    private final class TestClock: @unchecked Sendable {
        private let lock = NSLock()
        private var t: Date
        init(_ start: Date = Date(timeIntervalSince1970: 1_000_000)) { self.t = start }
        func now() -> Date { lock.lock(); defer { lock.unlock() }; return t }
        func advance(_ seconds: TimeInterval) { lock.lock(); t = t.addingTimeInterval(seconds); lock.unlock() }
    }

    private func makeMonitor(_ clock: TestClock) -> PressureMonitor {
        PressureMonitor(now: { clock.now() })
    }

    // MARK: Min local dwell (§4.3 D_local = 90s)

    func testMinLocalDwellBlocksPromotionInFirst90s() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)
        await monitor.admitLocalRun()

        // Immediately critical memory — but inside the 90s min-dwell, no promotion.
        clock.advance(40) // 40s in
        let s1 = await monitor.ingest(PressureSample(memory: .critical))
        XCTAssertFalse(s1.shouldBurst, "must not promote inside the 90s min local dwell")

        // Sustain critical past the per-signal dwell AND past 90s → promote.
        clock.advance(60) // now 100s in, memory critical held continuously since 40s (60s ≥ 30s dwell)
        let s2 = await monitor.ingest(PressureSample(memory: .critical))
        XCTAssertTrue(s2.shouldBurst, "should promote after min dwell + signal dwell")
    }

    // MARK: Single fire signal promotes after dwell

    func testSingleFireSignalPromotesAfterDwell() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)
        await monitor.admitLocalRun()
        clock.advance(95) // past min dwell

        // First crossing starts the dwell clock; not yet held 30s.
        let a = await monitor.ingest(PressureSample(memory: .critical))
        XCTAssertFalse(a.shouldBurst)

        clock.advance(31) // held > 30s
        let b = await monitor.ingest(PressureSample(memory: .critical))
        XCTAssertTrue(b.shouldBurst)
    }

    // MARK: A single warn alone does NOT promote

    func testSingleWarnAloneDoesNotPromote() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)
        await monitor.admitLocalRun()
        clock.advance(95)

        _ = await monitor.ingest(PressureSample(memory: .warning))
        clock.advance(40)
        let s = await monitor.ingest(PressureSample(memory: .warning))
        XCTAssertFalse(s.shouldBurst, "a single sustained warn must not promote")
    }

    // MARK: Two sustained warns promote (§4.2)

    func testTwoSustainedWarnsPromote() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)
        await monitor.admitLocalRun()
        clock.advance(95)

        // Memory warn + ETA overrun warn, both sustained.
        _ = await monitor.ingest(PressureSample(memory: .warning, etaRatio: 1.6))
        clock.advance(35)
        let s = await monitor.ingest(PressureSample(memory: .warning, etaRatio: 1.6))
        XCTAssertTrue(s.shouldBurst, "two distinct sustained warns must promote")
    }

    // MARK: Per-signal dwell resets on a sub-threshold dip (§4.3)

    func testDwellResetsOnDip() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)
        await monitor.admitLocalRun()
        clock.advance(95)

        _ = await monitor.ingest(PressureSample(memory: .critical)) // start dwell
        clock.advance(20)
        _ = await monitor.ingest(PressureSample(memory: .normal))   // dip → reset
        clock.advance(20)
        let s = await monitor.ingest(PressureSample(memory: .critical)) // only 20s held now
        XCTAssertFalse(s.shouldBurst, "dwell must restart after dipping below threshold")
    }

    // MARK: Thermal critical fires immediately (no dwell, bypasses hold) (§4.1/§4.3)

    func testThermalCriticalFiresImmediately() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)
        await monitor.admitLocalRun()
        clock.advance(95) // past min dwell (min dwell still applies)

        let s = await monitor.ingest(PressureSample(thermal: .critical))
        XCTAssertTrue(s.shouldBurst, "thermal critical is an immediate fire condition")
        XCTAssertEqual(s.reason, "thermal critical")
    }

    // MARK: Promotion is latched — no demotion after pressure clears (§4.3)

    func testPromotionIsLatched() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)
        await monitor.admitLocalRun()
        clock.advance(95)

        _ = await monitor.ingest(PressureSample(memory: .critical))
        clock.advance(31)
        let promoted = await monitor.ingest(PressureSample(memory: .critical))
        XCTAssertTrue(promoted.shouldBurst)

        // Pressure fully clears — must stay promoted (latched, one-way).
        clock.advance(10)
        let stillPromoted = await monitor.ingest(PressureSample(memory: .normal, thermal: .nominal))
        XCTAssertTrue(stillPromoted.shouldBurst, "promotion is one-way and latched")
    }

    // MARK: Cooldown suppresses a subsequent NEW run's promotion (§4.3 C = 300s)

    func testCooldownSuppressesSubsequentPromotion() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)

        // First run promotes.
        await monitor.admitLocalRun()
        clock.advance(95)
        _ = await monitor.ingest(PressureSample(memory: .critical))
        clock.advance(31)
        let first = await monitor.ingest(PressureSample(memory: .critical))
        XCTAssertTrue(first.shouldBurst)

        // A new run admitted shortly after — within the 300s device cooldown.
        clock.advance(100) // 100s after the promotion < 300s cooldown
        await monitor.admitLocalRun()
        clock.advance(95) // past its own min dwell
        _ = await monitor.ingest(PressureSample(memory: .critical))
        clock.advance(31)
        let second = await monitor.ingest(PressureSample(memory: .critical))
        XCTAssertFalse(second.shouldBurst, "device-wide cooldown must suppress the next promotion")

        // After the cooldown fully elapses, promotion is allowed again.
        clock.advance(200) // total > 300s since the first promotion
        let third = await monitor.ingest(PressureSample(memory: .critical))
        XCTAssertTrue(third.shouldBurst, "promotion resumes once cooldown elapses")
    }

    // MARK: ETA fire gating on remaining minutes (§4.1)

    func testEtaFireRequiresRemainingOverTenMinutes() async {
        let clock = TestClock()
        let monitor = makeMonitor(clock)
        await monitor.admitLocalRun()
        clock.advance(95)

        // etaRatio ≥ 2.0 but only 5 min remaining → must NOT fire.
        _ = await monitor.ingest(PressureSample(etaRatio: 2.5, projectedRemainingMinutes: 5))
        clock.advance(10)
        let s1 = await monitor.ingest(PressureSample(etaRatio: 2.5, projectedRemainingMinutes: 5))
        XCTAssertFalse(s1.shouldBurst, "ETA fire needs > 10 min remaining")

        // Same ratio but 20 min remaining → fires.
        _ = await monitor.ingest(PressureSample(etaRatio: 2.5, projectedRemainingMinutes: 20))
        clock.advance(10)
        let s2 = await monitor.ingest(PressureSample(etaRatio: 2.5, projectedRemainingMinutes: 20))
        XCTAssertTrue(s2.shouldBurst)
    }
}
