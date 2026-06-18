//
//  BurstClientTests.swift
//  OnePuppyKitTests
//
//  Request-shaping and response-decoding tests for BurstClient, using a URLProtocol stub so
//  no network is touched. Asserts:
//    • the Authorization: Bearer header,
//    • the X-BYOC-Provider marker + byoc body when a key is attached,
//    • puppy-handshake (application/json) decoding,
//    • NDJSON (application/x-ndjson) streaming frame-by-frame decode,
//    • the puppy-result POST shape,
//    • https-only enforcement.
//

import XCTest
@testable import OnePuppyKit

// MARK: - URLProtocol stub

/// A tiny lock-protected box so the stub's shared state is concurrency-safe under Swift's
/// strict checks without resorting to `nonisolated(unsafe)` (which only exists in 5.10+).
final class StubState: @unchecked Sendable {
    private let lock = NSLock()
    private var _handler: (@Sendable (URLRequest, Data?) -> StubURLProtocol.Stub)?
    private var _lastRequest: URLRequest?
    private var _lastBody: Data?

    var handler: (@Sendable (URLRequest, Data?) -> StubURLProtocol.Stub)? {
        get { lock.lock(); defer { lock.unlock() }; return _handler }
        set { lock.lock(); _handler = newValue; lock.unlock() }
    }
    var lastRequest: URLRequest? {
        get { lock.lock(); defer { lock.unlock() }; return _lastRequest }
        set { lock.lock(); _lastRequest = newValue; lock.unlock() }
    }
    var lastBody: Data? {
        get { lock.lock(); defer { lock.unlock() }; return _lastBody }
        set { lock.lock(); _lastBody = newValue; lock.unlock() }
    }
    func reset() { lock.lock(); _handler = nil; _lastRequest = nil; _lastBody = nil; lock.unlock() }
}

/// Routes requests to a per-test handler. Supports both one-shot bodies and chunked NDJSON
/// (by sending the whole body at once — URLSession.bytes.lines splits on newlines regardless).
final class StubURLProtocol: URLProtocol {
    struct Stub {
        let status: Int
        let headers: [String: String]
        let body: Data
    }

    /// Shared, lock-protected state set per test.
    static let state = StubState()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // URLSession strips httpBody into a stream for upload tasks; recover it via the handle.
        let body = Self.bodyData(from: request)
        Self.state.lastRequest = request
        Self.state.lastBody = body

        guard let handler = Self.state.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        let stub = handler(request, body)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: stub.status,
            httpVersion: "HTTP/1.1",
            headerFields: stub.headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func bodyData(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data()
        let bufSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

// MARK: - Tests

final class BurstClientTests: XCTestCase {
    private var session: URLSession!
    private var client: BurstClient!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        session = URLSession(configuration: config)
        client = try! BurstClient(baseURL: URL(string: "https://one.hushh.ai")!, session: session)
        StubURLProtocol.state.handler = nil
        StubURLProtocol.state.lastRequest = nil
        StubURLProtocol.state.lastBody = nil
    }

    override func tearDown() {
        StubURLProtocol.state.handler = nil
        session = nil
        client = nil
        super.tearDown()
    }

    // MARK: https-only

    func testRejectsNonHttpsBaseURL() {
        XCTAssertThrowsError(try BurstClient(baseURL: URL(string: "http://insecure.example")!))
    }

    // MARK: Submit → puppy handshake, header + byoc assertions

    func testSubmitPuppyHandshakeAndRequestShaping() async throws {
        let handshakeJSON = """
        {"ok":true,"placement":"puppy","reason":"Fits on Mac Studio — running on-device.",
         "burstJobId":"job-1","handshake":{"target":"puppy","jobId":"job-1","spec":{},
         "reportResultEndpoint":"/api/one/burst/job-1/puppy-result"}}
        """.data(using: .utf8)!

        StubURLProtocol.state.handler = { _, _ in
            .init(status: 200, headers: ["Content-Type": "application/json"], body: handshakeJSON)
        }

        let spec = JobSpec(
            image: "trainer:latest",
            acceleratorKind: .gpu,
            acceleratorCount: 1,
            estimate: WorkloadEstimate(vramGb: 10, unifiedMemoryGb: 10, vcpus: 8, diskGb: 50, estimatedMinutes: 5)
        )
        let request = BurstRequest(
            spec: spec,
            deviceProfile: nil,
            byoc: ByocGcp(serviceAccountJson: "{\"client_email\":\"a\",\"private_key\":\"b\",\"project_id\":\"p\"}", projectId: "p", region: "us-central1")
        )

        let outcome = try await client.submitBurst(request, firebaseToken: "TOKEN123")
        guard case .puppy(let handshake) = outcome else { return XCTFail("expected puppy outcome") }
        XCTAssertEqual(handshake.burstJobId, "job-1")
        XCTAssertEqual(handshake.handshake.reportResultEndpoint, "/api/one/burst/job-1/puppy-result")

        // Assert request shaping.
        let req = try XCTUnwrap(StubURLProtocol.state.lastRequest)
        XCTAssertEqual(req.url?.absoluteString, "https://one.hushh.ai/api/one/burst")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer TOKEN123")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        // BYOC marker present because a byoc block was attached.
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-BYOC-Provider"), "gcp")

        // Assert the byoc block is in the body.
        let body = try XCTUnwrap(StubURLProtocol.state.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["image"] as? String, "trainer:latest")
        let byoc = try XCTUnwrap(json["byoc"] as? [String: Any])
        XCTAssertEqual(byoc["projectId"] as? String, "p")
        XCTAssertNotNil(byoc["serviceAccountJson"])
    }

    // MARK: No byoc → no marker header

    func testSubmitWithoutByocOmitsMarkerHeader() async throws {
        StubURLProtocol.state.handler = { _, _ in
            .init(status: 200, headers: ["Content-Type": "application/json"],
                  body: #"{"ok":true,"placement":"puppy","reason":"r","handshake":{"target":"puppy"}}"#.data(using: .utf8)!)
        }
        let request = BurstRequest(
            spec: JobSpec(image: "x", acceleratorKind: .gpu, acceleratorCount: 1,
                          estimate: WorkloadEstimate(vramGb: 1, unifiedMemoryGb: 1, vcpus: 1, diskGb: 1, estimatedMinutes: 1)),
            deviceProfile: nil, byoc: nil
        )
        _ = try await client.submitBurst(request, firebaseToken: "T")
        let req = try XCTUnwrap(StubURLProtocol.state.lastRequest)
        XCTAssertNil(req.value(forHTTPHeaderField: "X-BYOC-Provider"))
    }

    // MARK: Submit → NDJSON stream, frame-by-frame decode

    func testSubmitCloudStreamDecodesFrames() async throws {
        let ndjson = [
            #"{"type":"start","burstJobId":"b1","placement":"gcp","provider":"gcp","scanning":"Provisioning…","elapsedMs":0}"#,
            #"{"type":"progress","scanning":"Running on an A100 in your cloud","elapsedMs":7000}"#,
            #"{"type":"done","ok":true,"burstJobId":"b1","result":{"summary":"ok"},"exitCode":0}"#,
        ].joined(separator: "\n") + "\n"

        StubURLProtocol.state.handler = { _, _ in
            .init(status: 200, headers: ["Content-Type": "application/x-ndjson; charset=utf-8"],
                  body: ndjson.data(using: .utf8)!)
        }

        let request = BurstRequest(
            spec: JobSpec(image: "x", acceleratorKind: .gpu, acceleratorCount: 1,
                          estimate: WorkloadEstimate(vramGb: 200, unifiedMemoryGb: 200, vcpus: 8, diskGb: 50, estimatedMinutes: 5)),
            deviceProfile: nil, byoc: nil
        )

        let outcome = try await client.submitBurst(request, firebaseToken: "T")
        guard case .cloud(let stream) = outcome else { return XCTFail("expected cloud stream") }

        var types: [BurstStreamFrame.FrameType] = []
        var doneResultSummary: String?
        for try await frame in stream {
            types.append(frame.type)
            if frame.type == .done { doneResultSummary = frame.result?.string("summary") }
        }
        XCTAssertEqual(types, [.start, .progress, .done])
        XCTAssertEqual(doneResultSummary, "ok")
    }

    // MARK: Submit error → calm http error with the control plane's message

    func testSubmitErrorSurfacesControlPlaneMessage() async {
        StubURLProtocol.state.handler = { _, _ in
            .init(status: 503, headers: ["Content-Type": "application/json"],
                  body: #"{"ok":false,"error":"No project configured for your account."}"#.data(using: .utf8)!)
        }
        let request = BurstRequest(
            spec: JobSpec(image: "x", acceleratorKind: .gpu, acceleratorCount: 1,
                          estimate: WorkloadEstimate(vramGb: 1, unifiedMemoryGb: 1, vcpus: 1, diskGb: 1, estimatedMinutes: 1)),
            deviceProfile: nil, byoc: nil
        )
        do {
            _ = try await client.submitBurst(request, firebaseToken: "T")
            XCTFail("expected throw")
        } catch let BurstClientError.http(status, body) {
            XCTAssertEqual(status, 503)
            XCTAssertEqual(body, "No project configured for your account.")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: reportPuppyResult POST shape

    func testReportPuppyResultShape() async throws {
        StubURLProtocol.state.handler = { _, _ in
            .init(status: 200, headers: ["Content-Type": "application/json"],
                  body: #"{"ok":true,"status":"completed"}"#.data(using: .utf8)!)
        }

        let status = try await client.reportPuppyResult(
            jobId: "job-9",
            .completed(result: .object(["k": .string("v")]), runMs: 1234),
            firebaseToken: "TOK"
        )
        XCTAssertEqual(status.status, .completed)

        let req = try XCTUnwrap(StubURLProtocol.state.lastRequest)
        XCTAssertEqual(req.url?.absoluteString, "https://one.hushh.ai/api/one/burst/job-9/puppy-result")
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer TOK")

        let body = try XCTUnwrap(StubURLProtocol.state.lastBody)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["status"] as? String, "completed")
        XCTAssertEqual(json["runMs"] as? Int, 1234)
        XCTAssertNotNil(json["result"])
    }

    // MARK: recover GET → BurstStatus

    func testRecoverDecodesStatus() async throws {
        StubURLProtocol.state.handler = { _, _ in
            .init(status: 200, headers: ["Content-Type": "application/json"],
                  body: #"{"ok":true,"status":"completed","placement":"gcp","result":{"x":1}}"#.data(using: .utf8)!)
        }
        let status = try await client.recover(jobId: "abc", firebaseToken: "T")
        XCTAssertEqual(status.status, .completed)
        XCTAssertTrue(status.isTerminal)

        let req = try XCTUnwrap(StubURLProtocol.state.lastRequest)
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.absoluteString, "https://one.hushh.ai/api/one/burst/abc")
    }

    func testRecover404DecodesUnknown() async throws {
        StubURLProtocol.state.handler = { _, _ in
            .init(status: 404, headers: ["Content-Type": "application/json"],
                  body: #"{"ok":false,"status":"unknown","result":null}"#.data(using: .utf8)!)
        }
        let status = try await client.recover(jobId: "missing", firebaseToken: "T")
        XCTAssertEqual(status.status, .unknown)
    }
}
