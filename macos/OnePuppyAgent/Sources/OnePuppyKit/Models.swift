//
//  Models.swift
//  OnePuppyKit
//
//  Codable mirrors of the control-plane contract:
//    • docs/specs/burst-control-plane.openapi.yaml  (authoritative schemas)
//    • src/lib/burst/types.ts                       (the TypeScript source of truth)
//    • the route shapes in src/app/api/one/burst/**  (the actual wire bytes)
//
//  Design notes:
//    • `result` blobs are arbitrary JSON (OpenAPI `{}` / TS `unknown`). We model them with
//      `JSONValue` so we can round-trip them losslessly without imposing a schema.
//    • The OpenAPI schema for a few frames is a subset of what the route actually sends
//      (e.g. the route adds `message` on `done`/`pending`). We decode tolerantly: every
//      extra field is optional, and unknown fields are simply ignored by JSONDecoder.
//    • Keys are the JSON wire names verbatim — no CodingKeys remapping is needed because
//      the control plane already speaks lowerCamelCase.
//

import Foundation

// MARK: - Accelerator

/// Accelerator family a workload asks for. GPU is fully implemented; TPU is a documented
/// contract that the real path answers with 501 (see placement-autoscale.md §5.2).
public enum AcceleratorKind: String, Codable, Sendable, CaseIterable {
    case gpu
    case tpu
}

// MARK: - WorkloadEstimate

/// A coarse resource estimate for a workload — drives the Puppy-vs-cloud decision.
/// All fields required per the OpenAPI `WorkloadEstimate`.
public struct WorkloadEstimate: Codable, Sendable, Equatable {
    /// Accelerator/unified memory the job needs, in GB.
    public var vramGb: Double
    /// Host RAM the job needs, in GB. Unified with VRAM on Apple Silicon.
    public var unifiedMemoryGb: Double
    public var vcpus: Double
    public var diskGb: Double
    public var estimatedMinutes: Double

    public init(
        vramGb: Double,
        unifiedMemoryGb: Double,
        vcpus: Double,
        diskGb: Double,
        estimatedMinutes: Double
    ) {
        self.vramGb = vramGb
        self.unifiedMemoryGb = unifiedMemoryGb
        self.vcpus = vcpus
        self.diskGb = diskGb
        self.estimatedMinutes = estimatedMinutes
    }
}

// MARK: - DeviceProfile

/// A snapshot of the local "One Puppy" Mac. The control plane fills any missing field from
/// its reference profile (`DEFAULT_PUPPY_PROFILE`), so every property is non-optional here:
/// the agent always reports a complete, honest snapshot it measured itself.
public struct DeviceProfile: Codable, Sendable, Equatable {
    /// Stable, privacy-preserving device id (a random UUID in Keychain — never a hardware serial).
    public var id: String
    /// Human model string, e.g. "Mac Studio (M3 Ultra)".
    public var label: String
    public var cpuCores: Int
    /// Apple GPU core count (informational; capacity is gated on unified memory).
    public var gpuCores: Int
    /// Unified memory in GB (e.g. 192 on a maxed M3 Ultra).
    public var unifiedMemoryGb: Double
    public var diskFreeGb: Double
    public var networkMbps: Double
    public var online: Bool

    public init(
        id: String,
        label: String,
        cpuCores: Int,
        gpuCores: Int,
        unifiedMemoryGb: Double,
        diskFreeGb: Double,
        networkMbps: Double,
        online: Bool
    ) {
        self.id = id
        self.label = label
        self.cpuCores = cpuCores
        self.gpuCores = gpuCores
        self.unifiedMemoryGb = unifiedMemoryGb
        self.diskFreeGb = diskFreeGb
        self.networkMbps = networkMbps
        self.online = online
    }
}

// MARK: - JobSpec

/// The workload to run: a container image + command, plus its accelerator ask.
/// Mirrors `JobSpec` in types.ts; serialized fields match `BurstRequest`'s top level
/// (the route reads `image`, `command`, `env`, `acceleratorKind`, … directly off the body).
public struct JobSpec: Codable, Sendable, Equatable {
    /// Container image reference, e.g. "us-docker.pkg.dev/proj/repo/trainer:latest".
    public var image: String
    public var command: [String]?
    public var env: [String: String]?
    public var acceleratorKind: AcceleratorKind
    /// Clamped to 1...8 by the control plane; we keep it honest on the way out.
    public var acceleratorCount: Int
    public var machineType: String?
    public var region: String?
    public var zone: String?
    public var estimate: WorkloadEstimate

    public init(
        image: String,
        command: [String]? = nil,
        env: [String: String]? = nil,
        acceleratorKind: AcceleratorKind,
        acceleratorCount: Int,
        machineType: String? = nil,
        region: String? = nil,
        zone: String? = nil,
        estimate: WorkloadEstimate
    ) {
        self.image = image
        self.command = command
        self.env = env
        self.acceleratorKind = acceleratorKind
        self.acceleratorCount = acceleratorCount
        self.machineType = machineType
        self.region = region
        self.zone = zone
        self.estimate = estimate
    }
}

// MARK: - ByocGcp

/// The caller's own GCP credentials. Held in memory only on the device and used in-memory
/// only on the control plane — never persisted on either side (byoc-security-privacy.md).
///
/// The `serviceAccountJson` here is the *raw JSON string* of the SA file, exactly as the
/// route expects (`parseByoc` reads `serviceAccountJson` as a string).
public struct ByocGcp: Codable, Sendable, Equatable {
    public var serviceAccountJson: String?
    public var projectId: String?
    public var region: String?

    public init(serviceAccountJson: String? = nil, projectId: String? = nil, region: String? = nil) {
        self.serviceAccountJson = serviceAccountJson
        self.projectId = projectId
        self.region = region
    }
}

// MARK: - BurstRequest

/// The POST /api/one/burst body. The `JobSpec` fields are flattened to the top level to
/// match the route's `normalizeSpec`, which reads them directly off the request body.
public struct BurstRequest: Codable, Sendable, Equatable {
    public var image: String
    public var command: [String]?
    public var env: [String: String]?
    public var acceleratorKind: AcceleratorKind
    public var acceleratorCount: Int
    public var machineType: String?
    public var region: String?
    public var zone: String?
    public var estimate: WorkloadEstimate
    public var deviceProfile: DeviceProfile?
    public var byoc: ByocGcp?

    public init(spec: JobSpec, deviceProfile: DeviceProfile?, byoc: ByocGcp?) {
        self.image = spec.image
        self.command = spec.command
        self.env = spec.env
        self.acceleratorKind = spec.acceleratorKind
        self.acceleratorCount = spec.acceleratorCount
        self.machineType = spec.machineType
        self.region = spec.region
        self.zone = spec.zone
        self.estimate = spec.estimate
        self.deviceProfile = deviceProfile
        self.byoc = byoc
    }
}

// MARK: - Headroom

/// Spare capacity on the Puppy under the safety budget (placement-autoscale.md §3.2).
/// Negative values are the binding deficit and are still reported.
public struct Headroom: Codable, Sendable, Equatable {
    public var memoryGb: Double
    public var diskGb: Double
}

// MARK: - PuppyHandshake (the application/json response)

/// The JSON returned for a Puppy placement. The device runs the workload locally, then
/// POSTs a `PuppyResult` to `handshake.reportResultEndpoint`.
public struct PuppyHandshake: Codable, Sendable, Equatable {
    public var ok: Bool
    public var placement: Placement
    public var reason: String
    /// The route also returns `headroom`; OpenAPI omits it, so it's optional here.
    public var headroom: Headroom?
    public var burstJobId: String?
    public var handshake: Handshake

    public enum Placement: String, Codable, Sendable { case puppy }

    public struct Handshake: Codable, Sendable, Equatable {
        public enum Target: String, Codable, Sendable { case puppy }
        public var target: Target
        public var jobId: String?
        /// The original spec, echoed back. Modeled as JSONValue (OpenAPI `object`).
        public var spec: JSONValue?
        public var reportResultEndpoint: String?
    }
}

// MARK: - BurstStreamFrame (one NDJSON line)

/// One NDJSON line from a cloud burst. `type` discriminates the frame:
/// `start → progress* → (done | error | pending)`.
///
/// We model it as a single struct with optional fields (rather than an enum) so a single
/// `JSONDecoder.decode` handles every line, and unknown/extra keys are ignored. Use
/// `frameType` to branch. Fields beyond the OpenAPI schema that the route actually emits
/// (`message` on done/pending) are included.
public struct BurstStreamFrame: Codable, Sendable, Equatable {
    public enum FrameType: String, Codable, Sendable {
        case start
        case progress
        case done
        case error
        case pending
    }

    public enum Placement: String, Codable, Sendable { case gcp }
    public enum Provider: String, Codable, Sendable { case gcp, mock }

    public var type: FrameType
    public var burstJobId: String?
    public var placement: Placement?
    public var provider: Provider?
    /// Human-readable progress line (the route's `scanning` field).
    public var scanning: String?
    public var elapsedMs: Int?
    /// Arbitrary result blob present on `done`.
    public var result: JSONValue?
    public var exitCode: Int?
    /// Set on `pending` (e.g. "deadline").
    public var reason: String?
    /// Set on `error`.
    public var error: String?
    public var ok: Bool?
    /// The route adds a friendly `message` on `pending`/`done`. Not in OpenAPI; optional.
    public var message: String?
}

// MARK: - BurstStatus (GET /api/one/burst/{id})

/// Current status of a burst, used to recover after a dropped stream or app restart.
public struct BurstStatus: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        case running
        case completed
        case failed
        case unknown
    }
    public enum Placement: String, Codable, Sendable {
        case puppy
        case gcp
    }

    public var ok: Bool
    public var status: Status
    public var placement: Placement?
    public var result: JSONValue?
    public var error: String?
    public var idempotent: Bool?

    /// A terminal status no longer needs polling. Used by the recovery loop.
    public var isTerminal: Bool { status == .completed || status == .failed }
}

// MARK: - PuppyResult (POST /api/one/burst/{id}/puppy-result body)

/// The outcome of an on-device (Puppy) run, reported back to close the contract.
public struct PuppyResult: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        case completed
        case failed
    }
    public var status: Status
    /// Arbitrary result blob on success.
    public var result: JSONValue?
    /// Failure message on failure. Never contains credentials (we control what we put here).
    public var error: String?
    /// On-device run duration in milliseconds.
    public var runMs: Int?

    public init(status: Status, result: JSONValue? = nil, error: String? = nil, runMs: Int? = nil) {
        self.status = status
        self.result = result
        self.error = error
        self.runMs = runMs
    }

    public static func completed(result: JSONValue?, runMs: Int?) -> PuppyResult {
        PuppyResult(status: .completed, result: result, runMs: runMs)
    }
    public static func failed(error: String, runMs: Int?) -> PuppyResult {
        PuppyResult(status: .failed, error: error, runMs: runMs)
    }
}

// MARK: - ErrorBody

/// The control plane's error envelope (`{ ok: false, error: string }`).
public struct ErrorBody: Codable, Sendable, Equatable {
    public var ok: Bool
    public var error: String
}

// MARK: - JSONValue

/// A lossless, schema-free JSON value. Used for `result`/`spec` blobs that the contract
/// types as `unknown`/`object`. Round-trips through Codable without imposing a shape.
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .number(let n): try container.encode(n)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    /// Convenience: pull a string at a top-level key (e.g. a result summary line).
    public func string(_ key: String) -> String? {
        if case .object(let o) = self, case .string(let s)? = o[key] { return s }
        return nil
    }
}
