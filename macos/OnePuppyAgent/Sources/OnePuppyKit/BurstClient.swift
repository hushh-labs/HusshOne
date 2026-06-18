//
//  BurstClient.swift
//  OnePuppyKit
//
//  The HTTP client to the Hushh One control plane (burst-control-plane.openapi.yaml).
//  Implements the exact handshake in one-puppy-macos-agent.md §6:
//
//    1. submitBurst(...)  POST /api/one/burst
//         → 200 application/json   ⇒ a PuppyHandshake (run locally)
//         → 200 application/x-ndjson ⇒ a stream of BurstStreamFrame (cloud burst)
//    2. reportPuppyResult(...) POST /api/one/burst/{id}/puppy-result
//    3. recover(...)      GET  /api/one/burst/{id}  → BurstStatus
//
//  Security posture:
//    • TLS only — the client refuses any non-https base URL.
//    • Sends Authorization: Bearer <Firebase ID token> on every call (hushhSession).
//    • Sends X-BYOC-Provider: gcp when a byoc block is attached (the securityScheme marker).
//    • The byoc block (which contains the SA JSON) only ever travels in the request body
//      over TLS. Nothing here logs the request body or the token.
//

import Foundation

// MARK: - Errors

public enum BurstClientError: Error, CustomStringConvertible {
    case insecureBaseURL                 // refused: non-https
    case invalidURL
    case http(status: Int, body: String) // body is the control plane's `{ ok:false, error }` — safe to show
    case unexpectedContentType(String)
    case decoding(String)
    case transport(String)

    public var description: String {
        switch self {
        case .insecureBaseURL: return "The control-plane URL must use HTTPS."
        case .invalidURL: return "Invalid control-plane URL."
        case .http(let status, let body): return "Control plane returned \(status): \(body)"
        case .unexpectedContentType(let ct): return "Unexpected response type: \(ct)"
        case .decoding(let why): return "Couldn't read the control-plane response: \(why)"
        case .transport(let why): return "Couldn't reach the control plane: \(why)"
        }
    }
}

// MARK: - Submit outcome

/// The two faces of POST /api/one/burst, discriminated by Content-Type.
public enum SubmitOutcome: Sendable {
    /// 200 application/json — run the workload on-device, then report the result.
    case puppy(PuppyHandshake)
    /// 200 application/x-ndjson — a live stream of decoded frames to surface as progress.
    case cloud(BurstFrameStream)
}

/// An async sequence of decoded NDJSON frames from a cloud burst. Iterating it consumes the
/// response stream line by line; it finishes when the body ends or throws on transport error.
public struct BurstFrameStream: AsyncSequence, Sendable {
    public typealias Element = BurstStreamFrame
    /// `URLSession.AsyncBytes.lines` is an `AsyncLineSequence<URLSession.AsyncBytes>`.
    let lines: AsyncLineSequence<URLSession.AsyncBytes>
    let decoder: JSONDecoder

    public func makeAsyncIterator() -> Iterator { Iterator(lines: lines.makeAsyncIterator(), decoder: decoder) }

    public struct Iterator: AsyncIteratorProtocol {
        var lines: AsyncLineSequence<URLSession.AsyncBytes>.AsyncIterator
        let decoder: JSONDecoder

        public mutating func next() async throws -> BurstStreamFrame? {
            // NDJSON: one JSON object per line. Skip blank keep-alive lines defensively.
            while let line = try await lines.next() {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                guard let data = trimmed.data(using: .utf8) else { continue }
                do {
                    return try decoder.decode(BurstStreamFrame.self, from: data)
                } catch {
                    // A malformed line shouldn't kill the whole burst; skip and keep reading.
                    continue
                }
            }
            return nil
        }
    }
}

// MARK: - Client

public struct BurstClient: Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// - Parameters:
    ///   - baseURL: defaults to the production control plane. Must be https.
    ///   - session: injectable so tests can stub via URLProtocol.
    public init(
        baseURL: URL = URL(string: "https://one.hushh.ai")!,
        session: URLSession = .shared
    ) throws {
        guard baseURL.scheme?.lowercased() == "https" else { throw BurstClientError.insecureBaseURL }
        self.baseURL = baseURL
        self.session = session
        let enc = JSONEncoder()
        // Stable, compact bodies. Omit nils naturally (Swift Optional encodes absent by default).
        self.encoder = enc
        self.decoder = JSONDecoder()
    }

    // MARK: 1) Submit

    /// POST /api/one/burst. Branches on the response Content-Type into the puppy/cloud outcome.
    public func submitBurst(_ request: BurstRequest, firebaseToken: String) async throws -> SubmitOutcome {
        var req = try makeRequest(path: "/api/one/burst", method: "POST", firebaseToken: firebaseToken)
        // Accept both faces so the server can choose; it keys off placement, not Accept.
        req.setValue("application/json, application/x-ndjson", forHTTPHeaderField: "Accept")
        if request.byoc != nil {
            // The securityScheme marker: "the caller supplies their own GCP credentials in body".
            req.setValue("gcp", forHTTPHeaderField: "X-BYOC-Provider")
        }
        req.httpBody = try encoder.encode(request)

        let (bytes, response) = try await session.bytes(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw BurstClientError.transport("No HTTP response")
        }
        let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()

        // Non-2xx: drain a bounded amount of the body to surface the control plane's calm error.
        guard (200...299).contains(http.statusCode) else {
            let body = try await Self.collect(bytes)
            throw BurstClientError.http(status: http.statusCode, body: Self.errorMessage(from: body))
        }

        if contentType.contains("application/x-ndjson") {
            // Stream face: hand back a lazily-iterated frame sequence backed by the live body.
            return .cloud(BurstFrameStream(lines: bytes.lines, decoder: decoder))
        }

        if contentType.contains("application/json") {
            let body = try await Self.collect(bytes)
            do {
                let handshake = try decoder.decode(PuppyHandshake.self, from: body)
                return .puppy(handshake)
            } catch {
                throw BurstClientError.decoding(String(describing: error))
            }
        }

        throw BurstClientError.unexpectedContentType(contentType.isEmpty ? "unknown" : contentType)
    }

    // MARK: 2) Report puppy result

    /// POST /api/one/burst/{id}/puppy-result. Idempotent on the server; safe to retry.
    @discardableResult
    public func reportPuppyResult(
        jobId: String,
        _ result: PuppyResult,
        firebaseToken: String
    ) async throws -> BurstStatus {
        var req = try makeRequest(
            path: "/api/one/burst/\(Self.pathEscaped(jobId))/puppy-result",
            method: "POST",
            firebaseToken: firebaseToken
        )
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try encoder.encode(result)

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw BurstClientError.transport("No HTTP response")
        }
        guard (200...299).contains(http.statusCode) else {
            throw BurstClientError.http(status: http.statusCode, body: Self.errorMessage(from: data))
        }
        do {
            return try decoder.decode(BurstStatus.self, from: data)
        } catch {
            throw BurstClientError.decoding(String(describing: error))
        }
    }

    // MARK: 3) Recover

    /// GET /api/one/burst/{id} — poll a burst whose stream dropped until it reaches a terminal state.
    public func recover(jobId: String, firebaseToken: String) async throws -> BurstStatus {
        let req = try makeRequest(
            path: "/api/one/burst/\(Self.pathEscaped(jobId))",
            method: "GET",
            firebaseToken: firebaseToken
        )
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw BurstClientError.transport("No HTTP response")
        }
        // 404 returns a BurstStatus-shaped body ({ok:false,status:"unknown"}); decode it rather
        // than treating it as a hard error so the caller can branch on `.unknown`.
        if http.statusCode == 404, let status = try? decoder.decode(BurstStatus.self, from: data) {
            return status
        }
        guard (200...299).contains(http.statusCode) else {
            throw BurstClientError.http(status: http.statusCode, body: Self.errorMessage(from: data))
        }
        do {
            return try decoder.decode(BurstStatus.self, from: data)
        } catch {
            throw BurstClientError.decoding(String(describing: error))
        }
    }

    // MARK: - Helpers

    private func makeRequest(path: String, method: String, firebaseToken: String) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw BurstClientError.invalidURL }
        guard url.scheme?.lowercased() == "https" else { throw BurstClientError.insecureBaseURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // hushhSession: the Firebase ID token. Never logged.
        req.setValue("Bearer \(firebaseToken)", forHTTPHeaderField: "Authorization")
        return req
    }

    /// Percent-escape a single path segment (job ids are UUIDs, but be defensive).
    private static func pathEscaped(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? segment
    }

    /// Collect a (bounded) byte stream into Data for one-shot JSON bodies.
    private static func collect(_ bytes: URLSession.AsyncBytes) async throws -> Data {
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > 8 * 1024 * 1024 { break } // bound: handshakes/errors are tiny
        }
        return data
    }

    /// Extract the control plane's user-safe error string, falling back to the raw text.
    private static func errorMessage(from data: Data) -> String {
        if let err = try? JSONDecoder().decode(ErrorBody.self, from: data) { return err.error }
        return String(data: data, encoding: .utf8) ?? "Unknown error"
    }
}
