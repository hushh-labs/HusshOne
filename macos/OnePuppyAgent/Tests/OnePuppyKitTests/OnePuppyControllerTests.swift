//
//  OnePuppyControllerTests.swift
//  OnePuppyKitTests
//
//  Orchestration tests: the puppy handshake path runs the LocalRunner and reports a result;
//  a runner failure reports `failed` so the ledger never lies (§8). Uses the URLProtocol stub
//  from BurstClientTests and injected fakes for the runner/token provider.
//

import XCTest
@testable import OnePuppyKit

private struct FakeTokenProvider: TokenProvider {
    let token: String
    func currentToken() async throws -> String { token }
}

private struct SuccessRunner: LocalRunner {
    func run(_ spec: JobSpec, onProgress: @Sendable @escaping (String) -> Void) async throws -> JSONValue {
        onProgress("running")
        return .object(["ranLocally": .bool(true)])
    }
}

private struct FailingRunner: LocalRunner {
    struct Boom: Error, CustomStringConvertible { var description: String { "local oom" } }
    func run(_ spec: JobSpec, onProgress: @Sendable @escaping (String) -> Void) async throws -> JSONValue {
        throw Boom()
    }
}

/// Thread-safe collectors so `@Sendable` closures can record observations without
/// `nonisolated(unsafe)` (a 5.10+ attribute). Safe under Swift 5.9 strict concurrency.
private final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [PuppyEvent] = []
    func append(_ e: PuppyEvent) { lock.lock(); events.append(e); lock.unlock() }
    func all() -> [PuppyEvent] { lock.lock(); defer { lock.unlock() }; return events }
}

private final class JSONCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [String: Any]?
    func set(_ v: [String: Any]?) { lock.lock(); value = v; lock.unlock() }
    func get() -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return value }
}

final class OnePuppyControllerTests: XCTestCase {
    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func tempLedgerDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("OnePuppyCtrlTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private let spec = JobSpec(
        image: "trainer:latest",
        acceleratorKind: .gpu,
        acceleratorCount: 1,
        estimate: WorkloadEstimate(vramGb: 10, unifiedMemoryGb: 10, vcpus: 8, diskGb: 50, estimatedMinutes: 5)
    )

    func testPuppyHandshakeRunsLocallyAndReportsCompleted() async throws {
        // First call: POST /burst → puppy handshake. Second: POST /puppy-result → 200.
        let puppyResultBody = JSONCapture()
        StubURLProtocol.state.handler = { req, body in
            if req.url?.path.hasSuffix("/puppy-result") == true {
                if let body { puppyResultBody.set((try? JSONSerialization.jsonObject(with: body)) as? [String: Any]) }
                return .init(status: 200, headers: ["Content-Type": "application/json"],
                             body: #"{"ok":true,"status":"completed"}"#.data(using: .utf8)!)
            }
            return .init(status: 200, headers: ["Content-Type": "application/json"],
                         body: #"{"ok":true,"placement":"puppy","reason":"fits","burstJobId":"job-7","handshake":{"target":"puppy","jobId":"job-7","spec":{},"reportResultEndpoint":"/api/one/burst/job-7/puppy-result"}}"#.data(using: .utf8)!)
        }

        let ledgerDir = tempLedgerDir()
        let controller = OnePuppyController(
            client: try BurstClient(baseURL: URL(string: "https://one.hushh.ai")!, session: makeSession()),
            profiler: DeviceProfiler(),
            vault: KeychainVault(service: "test.nokey", account: "none"),
            runner: SuccessRunner(),
            tokens: FakeTokenProvider(token: "T"),
            ledger: JobLedger(directory: ledgerDir)
        )

        let collector = EventCollector()
        await controller.submit(spec) { collector.append($0) }

        XCTAssertTrue(collector.all().contains(.localCompleted), "expected localCompleted, got \(collector.all())")
        XCTAssertEqual(puppyResultBody.get()?["status"] as? String, "completed")

        // Ledger entry removed after completion.
        let remaining = JobLedger(directory: ledgerDir)
        let all = await remaining.all()
        XCTAssertTrue(all.isEmpty, "ledger should be empty after a completed puppy run")
    }

    func testPuppyRunnerFailureReportsFailed() async throws {
        let puppyResult = JSONCapture()
        StubURLProtocol.state.handler = { req, body in
            if req.url?.path.hasSuffix("/puppy-result") == true {
                if let body, let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] {
                    puppyResult.set(obj)
                }
                return .init(status: 200, headers: ["Content-Type": "application/json"],
                             body: #"{"ok":true,"status":"failed"}"#.data(using: .utf8)!)
            }
            return .init(status: 200, headers: ["Content-Type": "application/json"],
                         body: #"{"ok":true,"placement":"puppy","reason":"fits","burstJobId":"job-8","handshake":{"target":"puppy","jobId":"job-8","spec":{},"reportResultEndpoint":"/api/one/burst/job-8/puppy-result"}}"#.data(using: .utf8)!)
        }

        let controller = OnePuppyController(
            client: try BurstClient(baseURL: URL(string: "https://one.hushh.ai")!, session: makeSession()),
            vault: KeychainVault(service: "test.nokey", account: "none"),
            runner: FailingRunner(),
            tokens: FakeTokenProvider(token: "T"),
            ledger: JobLedger(directory: tempLedgerDir())
        )

        let collector = EventCollector()
        await controller.submit(spec) { collector.append($0) }

        // A failed local run must report `failed` (the ledger never lies).
        XCTAssertEqual(puppyResult.get()?["status"] as? String, "failed")
        XCTAssertTrue(collector.all().contains { if case .localFailed = $0 { return true } else { return false } })
    }
}
