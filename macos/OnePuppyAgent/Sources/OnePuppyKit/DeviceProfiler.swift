//
//  DeviceProfiler.swift
//  OnePuppyKit
//
//  Builds a `DeviceProfile` from live macOS APIs (one-puppy-macos-agent.md §2):
//    cpuCores          ProcessInfo.processorCount
//    unifiedMemoryGb   sysctl hw.memsize
//    gpuCores          Metal (MTLCreateSystemDefaultDevice + a core-count heuristic)
//    diskFreeGb        URL volumeAvailableCapacityForImportantUsageKey
//    networkMbps       a placeholder probe (NWPathMonitor + a periodic throughput probe is
//                      the eventual design; v1 ships a conservative placeholder, clearly marked)
//    online            NWPathMonitor reachability
//    id / label        a stable Keychain-backed UUID + the Mac model string
//
//  Privacy: the device id is a random UUID persisted in Keychain — never a hardware serial
//  (one-puppy-macos-agent.md §5). The model string is non-identifying ("Mac Studio (M3 Ultra)").
//

import Foundation
import Network
#if canImport(Metal)
import Metal
#endif

public actor DeviceProfiler {
    private let identity: DeviceIdentityProviding
    private let pathMonitor: NWPathMonitor
    private let monitorQueue = DispatchQueue(label: "ai.hushh.onepuppy.pathmonitor")

    /// Latest reachability from NWPathMonitor. Updated on the monitor queue, read under the actor.
    private var latestOnline: Bool = false

    public init(identity: DeviceIdentityProviding = KeychainDeviceIdentity()) {
        self.identity = identity
        self.pathMonitor = NWPathMonitor()
        startPathMonitor()
    }

    private func startPathMonitor() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { await self?.setOnline(satisfied) }
        }
        pathMonitor.start(queue: monitorQueue)
    }

    private func setOnline(_ value: Bool) { latestOnline = value }

    /// Build a complete, honest snapshot of this Mac. Cheap enough to call before each submit.
    public func currentProfile() -> DeviceProfile {
        DeviceProfile(
            id: identity.stableDeviceId(),
            label: Self.modelLabel(),
            cpuCores: ProcessInfo.processInfo.processorCount,
            gpuCores: Self.gpuCoreCount(),
            unifiedMemoryGb: Self.unifiedMemoryGb(),
            diskFreeGb: Self.diskFreeGb(),
            networkMbps: Self.networkMbpsPlaceholder(),
            online: latestOnline
        )
    }

    // MARK: - Memory (sysctl hw.memsize)

    /// Physical RAM in GB. On Apple Silicon this is the unified memory pool shared by CPU/GPU.
    static func unifiedMemoryGb() -> Double {
        var size: UInt64 = 0
        var len = MemoryLayout<UInt64>.size
        // hw.memsize returns total physical memory in bytes.
        let ok = sysctlbyname("hw.memsize", &size, &len, nil, 0) == 0
        guard ok, size > 0 else {
            // ProcessInfo is a safe fallback; it reports the same physical memory.
            return Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824.0
        }
        return Double(size) / 1_073_741_824.0 // bytes → GiB
    }

    // MARK: - Disk (volumeAvailableCapacityForImportantUsageKey)

    /// Free space "for important usage" on the boot volume, in GB. This key reflects the space
    /// the OS will actually let an app use (it accounts for purgeable space), which is the
    /// honest number for "can this workload's scratch fit locally".
    static func diskFreeGb() -> Double {
        let url = URL(fileURLWithPath: NSHomeDirectory() as String)
        do {
            let values = try url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            if let bytes = values.volumeAvailableCapacityForImportantUsage {
                return Double(bytes) / 1_073_741_824.0
            }
        } catch {
            // Fall through to a conservative 0 — better to under-report and burst than to
            // over-promise local disk and thrash.
        }
        return 0
    }

    // MARK: - GPU (Metal)

    /// Best-effort Apple GPU core count. Metal exposes no public core-count API, so we map the
    /// device name to the known core counts of shipping Apple Silicon, defaulting sensibly.
    /// This is informational only — placement gates on unified memory, not GPU cores.
    static func gpuCoreCount() -> Int {
        #if canImport(Metal)
        guard let device = MTLCreateSystemDefaultDevice() else { return 0 }
        return inferAppleGpuCores(fromDeviceName: device.name)
        #else
        return 0
        #endif
    }

    /// Maps a Metal device name → GPU core count for known Apple Silicon. Heuristic by design;
    /// kept in one place so it's easy to extend as new chips ship.
    static func inferAppleGpuCores(fromDeviceName name: String) -> Int {
        let n = name.lowercased()
        switch true {
        case n.contains("m3 ultra"): return 80
        case n.contains("m3 max"): return 40
        case n.contains("m3 pro"): return 18
        case n.contains("m3"): return 10
        case n.contains("m2 ultra"): return 76
        case n.contains("m2 max"): return 38
        case n.contains("m2 pro"): return 19
        case n.contains("m2"): return 10
        case n.contains("m1 ultra"): return 64
        case n.contains("m1 max"): return 32
        case n.contains("m1 pro"): return 16
        case n.contains("m1"): return 8
        default: return 0 // Unknown (e.g. Intel + discrete/eGPU): report 0 rather than guess.
        }
    }

    // MARK: - Network

    /// Placeholder throughput estimate, in Mbps. The eventual design pairs NWPathMonitor's
    /// interface type with a periodic throughput probe against the control plane; until that
    /// probe lands we report a conservative reference number. Clearly a placeholder — the
    /// control plane fills gaps from its reference profile anyway.
    static func networkMbpsPlaceholder() -> Double {
        return 1000 // conservative gigabit-class default
    }

    // MARK: - Model label

    /// A non-identifying human model string, e.g. "Mac Studio (M3 Ultra)" or "Mac15,14".
    /// We read `hw.model` (the marketing-adjacent identifier) — never the serial number.
    static func modelLabel() -> String {
        var len = 0
        guard sysctlbyname("hw.model", nil, &len, nil, 0) == 0, len > 0 else { return "Mac" }
        var buf = [CChar](repeating: 0, count: len)
        guard sysctlbyname("hw.model", &buf, &len, nil, 0) == 0 else { return "Mac" }
        let raw = String(cString: buf)
        return raw.isEmpty ? "Mac" : raw
    }
}

// MARK: - Device identity

/// A stable, privacy-preserving per-device id. Implementations MUST NOT use a hardware serial.
public protocol DeviceIdentityProviding: Sendable {
    func stableDeviceId() -> String
}

/// Stores a random UUID in the Keychain on first launch and returns it thereafter. The id
/// survives reinstalls (Keychain persists), is not a hardware identifier, and never leaves
/// the device except as the opaque `DeviceProfile.id` in telemetry correlation.
public struct KeychainDeviceIdentity: DeviceIdentityProviding {
    private let service: String
    private let account: String

    public init(service: String = "ai.hushh.onepuppy.deviceid", account: String = "device-uuid") {
        self.service = service
        self.account = account
    }

    public func stableDeviceId() -> String {
        if let existing = read() { return existing }
        let fresh = UUID().uuidString
        _ = store(fresh)
        return fresh
    }

    private func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let str = String(data: data, encoding: .utf8) else { return nil }
        return str
    }

    @discardableResult
    private func store(_ value: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(value.utf8),
            // Stable across locks but never synced — same posture as the credential vault.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemDelete(query as CFDictionary)
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }
}
