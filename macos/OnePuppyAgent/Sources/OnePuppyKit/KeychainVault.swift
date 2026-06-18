//
//  KeychainVault.swift
//  OnePuppyKit
//
//  The BYOC credential vault (one-puppy-macos-agent.md §4, byoc-security-privacy.md).
//
//  Stores the user's GCP service-account JSON as a Keychain generic-password item with
//  kSecAttrAccessibleWhenUnlockedThisDeviceOnly — so it is:
//    • never synced to iCloud (…ThisDeviceOnly),
//    • only readable while the Mac is unlocked (…WhenUnlocked),
//    • Secure-Enclave-protected on hardware that supports it.
//
//  Hard rules enforced here:
//    • The JSON is validated locally before it is ever stored — it must parse and carry
//      client_email, private_key, and project_id (§4 "validate locally").
//    • The key material is NEVER logged. This file contains no print/os_log of the secret,
//      and error paths never echo the JSON. (Telemetry lives elsewhere and is non-credential.)
//

import Foundation
import Security

// MARK: - Validation

/// The minimal, non-secret fields we extract to confirm a well-formed SA JSON and to populate
/// the `ByocGcp` block's `projectId`. We deliberately do NOT keep the private key in a Swift
/// String beyond what's needed; the raw JSON lives in the Keychain, not in app memory at rest.
public struct ServiceAccountInfo: Sendable, Equatable {
    public let clientEmail: String
    public let projectId: String
    /// True iff a non-empty `private_key` was present. We never expose the key itself.
    public let hasPrivateKey: Bool
}

public enum KeychainVaultError: Error, Equatable, CustomStringConvertible {
    case malformedJson
    case missingField(String)
    case keychainStatus(OSStatus)
    case notFound

    public var description: String {
        switch self {
        case .malformedJson:
            return "That doesn't look like a Google Cloud key file."
        case .missingField(let field):
            // Field NAMES are safe to surface; the values never are.
            return "The key file is missing \(field)."
        case .keychainStatus:
            // Never leak OSStatus specifics into user-facing copy; the UX layer maps this to
            // a calm message. We keep the raw status only for developer diagnostics.
            return "Couldn't access the secure keychain."
        case .notFound:
            return "No cloud key is connected."
        }
    }
}

// MARK: - Vault

public struct KeychainVault: Sendable {
    private let service: String
    private let account: String

    public init(
        service: String = "ai.hushh.onepuppy.byoc.gcp",
        account: String = "service-account-json"
    ) {
        self.service = service
        self.account = account
    }

    // MARK: Validate

    /// Validate that `json` is a well-formed GCP service-account file. Pure; does no I/O and
    /// never logs. Returns the non-secret identifying fields on success.
    public func validate(serviceAccountJson json: String) throws -> ServiceAccountInfo {
        guard
            let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data),
            let dict = obj as? [String: Any]
        else {
            throw KeychainVaultError.malformedJson
        }

        func nonEmptyString(_ key: String) throws -> String {
            guard let s = dict[key] as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw KeychainVaultError.missingField(key)
            }
            return s
        }

        let clientEmail = try nonEmptyString("client_email")
        let projectId = try nonEmptyString("project_id")
        let privateKey = try nonEmptyString("private_key")

        return ServiceAccountInfo(
            clientEmail: clientEmail,
            projectId: projectId,
            hasPrivateKey: !privateKey.isEmpty
        )
    }

    // MARK: Store

    /// Validate, then store the raw JSON in the Keychain (replacing any existing item).
    /// Returns the non-secret info so the caller can show "Connected: project-x" without
    /// reading the secret back.
    @discardableResult
    public func store(serviceAccountJson json: String) throws -> ServiceAccountInfo {
        let info = try validate(serviceAccountJson: json) // never store an invalid key

        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // Replace-on-write: delete any prior item so rotation is clean.
        SecItemDelete(base as CFDictionary)

        var add = base
        add[kSecValueData as String] = Data(json.utf8)
        // The exact accessibility class the spec mandates: on-device only, unlocked only.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainVaultError.keychainStatus(status) }
        return info
    }

    // MARK: Read

    /// Read the raw SA JSON back (used only to assemble the `byoc` block for a TLS request).
    /// The caller must not log the return value.
    public func readServiceAccountJson() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { throw KeychainVaultError.notFound }
        guard status == errSecSuccess else { throw KeychainVaultError.keychainStatus(status) }
        guard let data = item as? Data, let json = String(data: data, encoding: .utf8) else {
            throw KeychainVaultError.malformedJson
        }
        return json
    }

    /// Whether a key is currently connected, without materializing the secret.
    public func hasKey() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    /// The non-secret identifying info for a connected key (for "Connected: <project>" UI).
    /// Reads the JSON, extracts only the safe fields, and lets the JSON fall out of scope.
    public func connectedInfo() -> ServiceAccountInfo? {
        guard let json = try? readServiceAccountJson() else { return nil }
        return try? validate(serviceAccountJson: json)
    }

    // MARK: Delete (revoke)

    /// Fully remove the key from the device. This is the "disconnect your cloud" action and
    /// must leave nothing behind (acceptance criterion §11.5).
    public func delete() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainVaultError.keychainStatus(status)
        }
    }

    // MARK: Assemble the request block

    /// Build the `ByocGcp` block to attach to a burst request, reading the secret from the
    /// Keychain just-in-time. Returns nil if no key is connected (the agent still runs locally).
    /// `region` is an optional caller-supplied preference; `projectId` comes from the SA JSON.
    public func makeByocBlock(region: String? = nil) -> ByocGcp? {
        guard let json = try? readServiceAccountJson(),
              let info = try? validate(serviceAccountJson: json) else { return nil }
        return ByocGcp(serviceAccountJson: json, projectId: info.projectId, region: region)
    }
}
