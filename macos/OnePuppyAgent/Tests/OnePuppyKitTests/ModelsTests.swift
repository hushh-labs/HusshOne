//
//  ModelsTests.swift
//  OnePuppyKitTests
//
//  JSON round-trips and contract conformance against burst-control-plane.openapi.yaml and the
//  real route shapes in src/app/api/one/burst/**. Covers every NDJSON frame type and the puppy
//  handshake decode.
//

import XCTest
@testable import OnePuppyKit

final class ModelsTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: Round-trips

    func testWorkloadEstimateRoundTrip() throws {
        let original = WorkloadEstimate(vramGb: 50, unifiedMemoryGb: 50, vcpus: 8, diskGb: 100, estimatedMinutes: 12)
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(WorkloadEstimate.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func testBurstRequestFlattensSpecAndEncodesByoc() throws {
        let spec = JobSpec(
            image: "us-docker.pkg.dev/p/r/trainer:latest",
            command: ["python", "train.py"],
            env: ["MODE": "fast"],
            acceleratorKind: .gpu,
            acceleratorCount: 2,
            estimate: WorkloadEstimate(vramGb: 40, unifiedMemoryGb: 40, vcpus: 8, diskGb: 100, estimatedMinutes: 30)
        )
        let req = BurstRequest(
            spec: spec,
            deviceProfile: DeviceProfile(id: "dev-1", label: "Mac Studio", cpuCores: 32, gpuCores: 80, unifiedMemoryGb: 192, diskFreeGb: 2048, networkMbps: 10000, online: true),
            byoc: ByocGcp(serviceAccountJson: "{\"x\":1}", projectId: "proj-x", region: "us-central1")
        )
        let data = try encoder.encode(req)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])

        // Top-level (flattened) spec fields — matches the route's normalizeSpec.
        XCTAssertEqual(json["image"] as? String, spec.image)
        XCTAssertEqual(json["acceleratorKind"] as? String, "gpu")
        XCTAssertEqual(json["acceleratorCount"] as? Int, 2)
        XCTAssertNotNil(json["estimate"])
        XCTAssertNotNil(json["deviceProfile"])
        let byoc = try XCTUnwrap(json["byoc"] as? [String: Any])
        XCTAssertEqual(byoc["projectId"] as? String, "proj-x")
    }

    // MARK: Puppy handshake (application/json)

    func testDecodePuppyHandshake() throws {
        // Exactly the body src/app/api/one/burst/route.ts returns for a puppy placement.
        let json = """
        {
          "ok": true,
          "placement": "puppy",
          "reason": "Fits on Mac Studio with ~103.6GB memory headroom — running on-device.",
          "headroom": { "memoryGb": 103.6, "diskGb": 1538.4 },
          "burstJobId": "11111111-1111-1111-1111-111111111111",
          "handshake": {
            "target": "puppy",
            "jobId": "11111111-1111-1111-1111-111111111111",
            "spec": { "image": "trainer:latest" },
            "reportResultEndpoint": "/api/one/burst/11111111-1111-1111-1111-111111111111/puppy-result"
          }
        }
        """.data(using: .utf8)!

        let handshake = try decoder.decode(PuppyHandshake.self, from: json)
        XCTAssertTrue(handshake.ok)
        XCTAssertEqual(handshake.placement, .puppy)
        XCTAssertEqual(handshake.headroom?.memoryGb, 103.6)
        XCTAssertEqual(handshake.handshake.target, .puppy)
        XCTAssertEqual(handshake.handshake.jobId, "11111111-1111-1111-1111-111111111111")
        XCTAssertEqual(handshake.handshake.reportResultEndpoint, "/api/one/burst/11111111-1111-1111-1111-111111111111/puppy-result")
        XCTAssertEqual(handshake.handshake.spec?.string("image"), "trainer:latest")
    }

    // MARK: NDJSON frames — one test per type

    func testDecodeStartFrame() throws {
        let json = #"{"type":"start","burstJobId":"abc","placement":"gcp","provider":"gcp","scanning":"Provisioning burst instance…","elapsedMs":0}"#.data(using: .utf8)!
        let frame = try decoder.decode(BurstStreamFrame.self, from: json)
        XCTAssertEqual(frame.type, .start)
        XCTAssertEqual(frame.placement, .gcp)
        XCTAssertEqual(frame.provider, .gcp)
        XCTAssertEqual(frame.elapsedMs, 0)
        XCTAssertEqual(frame.scanning, "Provisioning burst instance…")
    }

    func testDecodeProgressFrame() throws {
        let json = #"{"type":"progress","scanning":"Running on an A100 in your cloud","elapsedMs":42000}"#.data(using: .utf8)!
        let frame = try decoder.decode(BurstStreamFrame.self, from: json)
        XCTAssertEqual(frame.type, .progress)
        XCTAssertEqual(frame.elapsedMs, 42000)
    }

    func testDecodeDoneFrame() throws {
        // The route emits done with ok/result/exitCode (and route may add message).
        let json = #"{"type":"done","ok":true,"burstJobId":"abc","result":{"summary":"trained","loss":0.12},"exitCode":0}"#.data(using: .utf8)!
        let frame = try decoder.decode(BurstStreamFrame.self, from: json)
        XCTAssertEqual(frame.type, .done)
        XCTAssertEqual(frame.ok, true)
        XCTAssertEqual(frame.exitCode, 0)
        XCTAssertEqual(frame.result?.string("summary"), "trained")
    }

    func testDecodeErrorFrame() throws {
        let json = #"{"type":"error","ok":false,"error":"Burst workload failed"}"#.data(using: .utf8)!
        let frame = try decoder.decode(BurstStreamFrame.self, from: json)
        XCTAssertEqual(frame.type, .error)
        XCTAssertEqual(frame.ok, false)
        XCTAssertEqual(frame.error, "Burst workload failed")
    }

    func testDecodePendingFrame() throws {
        // pending(reason:"deadline") carries the route's friendly `message`.
        let json = #"{"type":"pending","reason":"deadline","burstJobId":"abc","message":"Burst is taking longer than usual — it was stopped to avoid runaway cost."}"#.data(using: .utf8)!
        let frame = try decoder.decode(BurstStreamFrame.self, from: json)
        XCTAssertEqual(frame.type, .pending)
        XCTAssertEqual(frame.reason, "deadline")
        XCTAssertEqual(frame.message, "Burst is taking longer than usual — it was stopped to avoid runaway cost.")
    }

    func testFrameIgnoresUnknownFields() throws {
        // Forward-compat: extra keys must not break decoding.
        let json = #"{"type":"progress","scanning":"x","futureField":123,"nested":{"a":1}}"#.data(using: .utf8)!
        let frame = try decoder.decode(BurstStreamFrame.self, from: json)
        XCTAssertEqual(frame.type, .progress)
    }

    // MARK: BurstStatus + PuppyResult

    func testDecodeBurstStatusCompleted() throws {
        let json = #"{"ok":true,"status":"completed","placement":"gcp","result":{"k":"v"}}"#.data(using: .utf8)!
        let status = try decoder.decode(BurstStatus.self, from: json)
        XCTAssertEqual(status.status, .completed)
        XCTAssertTrue(status.isTerminal)
        XCTAssertEqual(status.placement, .gcp)
    }

    func testDecodeBurstStatusRunningIsNotTerminal() throws {
        let json = #"{"ok":false,"status":"running","result":null}"#.data(using: .utf8)!
        let status = try decoder.decode(BurstStatus.self, from: json)
        XCTAssertEqual(status.status, .running)
        XCTAssertFalse(status.isTerminal)
    }

    func testPuppyResultEncodesContract() throws {
        let result = PuppyResult.completed(result: .object(["ok": .bool(true)]), runMs: 4200)
        let data = try encoder.encode(result)
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["status"] as? String, "completed")
        XCTAssertEqual(obj["runMs"] as? Int, 4200)
        XCTAssertNotNil(obj["result"])

        let failed = PuppyResult.failed(error: "oom", runMs: 100)
        let fdata = try encoder.encode(failed)
        let fobj = try XCTUnwrap(try JSONSerialization.jsonObject(with: fdata) as? [String: Any])
        XCTAssertEqual(fobj["status"] as? String, "failed")
        XCTAssertEqual(fobj["error"] as? String, "oom")
    }
}
